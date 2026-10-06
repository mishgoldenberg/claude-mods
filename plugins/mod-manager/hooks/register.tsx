import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register, RenderChildren } from 'claude-code'

import type { ModRow, ModStatus } from '../types'

// ── claude-mods kit v1 (docs/design.md): identical in every mod ──
const TONE = { accent: 'claude', ok: 'success', warn: 'warning', bad: 'error', dim: 'inactive' } as const
const GLYPH = { on: '●', off: '○', warn: '▲', ok: '✓', fail: '✗' } as const
type Kit = Pick<ElementTable, 'Box' | 'Text'>

/** Pane header: state glyph, mod name, one-line live status. */
function header({ Box, Text }: Kit, glyph: string, tone: string, name: string, status: string) {
  return (
    <Box gap={1}>
      <Text color={tone}>{glyph}</Text>
      <Text bold>{name}</Text>
      <Text dimColor wrap="truncate-end">{status}</Text>
    </Box>
  )
}

/** A section: a dim label (with optional small controls beside it), then its rows. */
function section({ Box, Text }: Kit, label: string, rows: RenderChildren, aside?: RenderChildren) {
  return (
    <Box flexDirection="column">
      <Box gap={1}>
        <Text dimColor>{label}</Text>
        {aside}
      </Box>
      {rows}
    </Box>
  )
}

/** A number right-aligned in a fixed-width cell. */
function num({ Box, Text }: Kit, value: string, width: number, color?: string) {
  return (
    <Box width={width} flexShrink={0} justifyContent="flex-end">
      <Text color={color}>{value}</Text>
    </Box>
  )
}

/** Empty state: what will show up here, and how to get it. */
function empty({ Text }: Kit, text: string) {
  return <Text dimColor>{text}</Text>
}
// ── end kit ──

const PANE = 'mod-manager'
const MARKETPLACE = 'claude-mods'
const rows = atom({ plugin: 'mod-manager', key: 'rows' } as const, [])
const busy = atom({ plugin: 'mod-manager', key: 'busy' } as const, null)
const message = atom({ plugin: 'mod-manager', key: 'message' } as const, '')
const needsRestart = atom({ plugin: 'mod-manager', key: 'needsRestart' } as const, false)
const self = atom({ plugin: 'mod-manager', key: 'self' } as const, null as ModRow | null)

/** The mods this manager knows how to describe; anything else in the marketplace is listed with its own description. */
const CATALOG: { name: string; blurb: string; usesTokens: boolean }[] = [
  { name: 'guardrails', blurb: 'Safety rules and presets: block rm -rf, mass deletes, force-push, secrets, installs, network; or lock Claude to the project.', usesTokens: false },
  { name: 'activity', blurb: 'Live panel: what Claude is running right now and what it is waiting on.', usesTokens: false },
  { name: 'notify', blurb: 'OS notifications when a long task finishes or an approval is waiting.', usesTokens: false },
  { name: 'context-keeper', blurb: 'What fills your context window, plus checkpoints that survive /compact.', usesTokens: true },
  { name: 'usage-meter', blurb: '5h/7d plan limits with burn rate and cache hit ratio.', usesTokens: false },
  { name: 'prompt-coach', blurb: 'Suggests a sharper prompt before sending; you choose which one goes.', usesTokens: true },
  { name: 'command-hub', blurb: 'The built-in slash commands explained, plus a form to make your own.', usesTokens: false },
  { name: 'toolbox', blurb: 'Every tool Claude can use, how often it used them, and tips for this project.', usesTokens: false },
  { name: 'changes', blurb: 'Files Claude changed this session with +/- counts, and one-click why, summary or self-review.', usesTokens: false },
  { name: 'loop-breaker', blurb: 'Notices Claude going in circles (same failing command, same file patched again) and nudges it to rethink.', usesTokens: false },
  { name: 'quickbar', blurb: 'A one-line launcher above the prompt: live context % and buttons for every claude-mods panel.', usesTokens: false },
]

const PRESETS: { id: string; label: string; mods: string[] }[] = [
  { id: 'safety', label: 'Safety only', mods: ['guardrails', 'notify'] },
  { id: 'essentials', label: 'Essentials', mods: ['guardrails', 'activity', 'notify', 'context-keeper', 'usage-meter'] },
  { id: 'zero', label: 'Zero tokens', mods: CATALOG.filter(m => !m.usesTokens).map(m => m.name) },
  { id: 'all', label: 'Everything', mods: CATALOG.map(m => m.name) },
]

let cliPath = 'claude'

type Action = 'install' | 'enable' | 'disable' | 'uninstall' | 'update'

type Listing = {
  installed?: { id: string; version?: string; scope?: string; enabled?: boolean; projectPath?: string }[]
  available?: { name: string; description?: string; marketplaceName?: string }[]
}

/** Runs `claude plugin …`; through cmd on Windows so an npm-installed claude.cmd resolves too. */
async function cli($: EngineInterface, args: string[], timeoutMs = 120000, cwd?: string) {
  const argv = (await $.env.get('OS')) === 'Windows_NT' ? ['cmd', '/d', '/c', cliPath, ...args] : [cliPath, ...args]

  return $.process.run(argv, cwd === undefined ? { timeoutMs } : { timeoutMs, cwd })
}

const normPath = (path: string) => path.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()

/** True when `dir` is `root` or inside it. */
const isWithin = (dir: string, root: string) => {
  const d = normPath(dir)
  const r = normPath(root)

  return d === r || d.startsWith(`${r}/`)
}

/** True when version `a` is newer than `b` (dotted numbers; anything else compares as 0). */
const isNewer = (a: string, b: string) => {
  const pa = a.split('.').map(n => Number.parseInt(n, 10) || 0)
  const pb = b.split('.').map(n => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d > 0
  }

  return false
}

/**
 * The version each mod has in the marketplace, read from the marketplace's local copy, which is what
 * `claude plugin update` installs. (`plugin list --available` lists only mods that aren't installed.)
 */
async function marketplaceVersions($: EngineInterface) {
  const versions = new Map<string, string>()
  try {
    const isWindows = (await $.env.get('OS')) === 'Windows_NT'
    const home = (isWindows ? await $.env.get('USERPROFILE') : undefined) ?? (await $.env.get('HOME')) ?? ''
    const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`
    const known = JSON.parse(await $.fs.read(`${configDir}/plugins/known_marketplaces.json`)) as Record<string, { installLocation?: string }>
    const location = known[MARKETPLACE]?.installLocation
    if (location === undefined) return versions
    const manifest = JSON.parse(await $.fs.read(`${location}/.claude-plugin/marketplace.json`)) as { plugins?: { name: string; source?: unknown; version?: string }[] }
    for (const entry of manifest.plugins ?? []) {
      if (typeof entry.version === 'string') {
        versions.set(entry.name, entry.version)
        continue
      }
      if (typeof entry.source !== 'string') continue
      const plugin = JSON.parse(await $.fs.read(`${location}/${entry.source}/.claude-plugin/plugin.json`).catch(() => '{}')) as { version?: unknown }
      if (typeof plugin.version === 'string') versions.set(entry.name, plugin.version)
    }
  } catch (error) {
    $.ui.log(`mod-manager: could not read marketplace versions: ${String(error)}`, { to: 'debug' })
  }

  return versions
}

async function readListing($: EngineInterface, cwd?: string) {
  const result = await cli($, ['plugin', 'list', '--available', '--json'], 60000, cwd)
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `exit ${result.exitCode}`)

  return JSON.parse(result.stdout) as Listing
}

/** Reads what is installed and what the marketplace offers, and merges it with the catalog. */
async function refresh($: EngineInterface) {
  let listing: Listing
  // Local and project installs belong to the folder they were made in, and the CLI only sees them
  // from there. A session in a subfolder asks from the project folder instead.
  let root: string | undefined
  try {
    const here = await $.session.cwd()
    listing = await readListing($)
    root = (listing.installed ?? [])
      .map(p => p.projectPath)
      .filter((path): path is string => path !== undefined && path !== '' && isWithin(here, path))
      .sort((a, b) => b.length - a.length)[0]
    if (root !== undefined && normPath(root) !== normPath(here)) listing = await readListing($, root)
  } catch (error) {
    await update($, message, () => `Couldn't run "${cliPath} plugin list" (${String(error).slice(0, 160)}). Set the Claude Code command in /config if claude isn't on your PATH.`)
    return
  }

  const mine = (listing.installed ?? []).filter(p => p.id.endsWith(`@${MARKETPLACE}`))
  // Another project's local install is not this session's; leave it out.
  const visible = mine.filter(p => p.projectPath === undefined || p.projectPath === '' || (root !== undefined && normPath(p.projectPath) === normPath(root)))
  const installed = new Map(visible.map(p => [p.id.split('@')[0] ?? '', p]))
  const offered = new Map((listing.available ?? []).filter(p => p.marketplaceName === MARKETPLACE).map(p => [p.name, p]))
  if (installed.size === 0 && offered.size === 0) {
    await update($, message, () => `The ${MARKETPLACE} marketplace isn't added yet. Run: ${cliPath} plugin marketplace add mishgoldenberg/claude-mods`)
  }

  const latest = await marketplaceVersions($)
  const newer = (name: string, version: string | undefined) => {
    const v = latest.get(name)

    return v !== undefined && version !== undefined && isNewer(v, version) ? v : undefined
  }
  const manager = installed.get('mod-manager')
  await update($, self, (): ModRow | null =>
    manager === undefined
      ? null
      : { name: 'mod-manager', blurb: '', usesTokens: false, status: manager.enabled === false ? 'off' : 'on', version: manager.version, latest: newer('mod-manager', manager.version), scope: manager.scope, projectPath: manager.projectPath || undefined },
  )

  const known = new Set(CATALOG.map(m => m.name))
  const extra = [...new Set([...installed.keys(), ...offered.keys()])].filter(n => n !== 'mod-manager' && !known.has(n))
  const next: ModRow[] = [
    ...CATALOG,
    ...extra.map(name => ({ name, blurb: offered.get(name)?.description ?? '', usesTokens: false })),
  ].map(m => {
    const own = installed.get(m.name)
    const status: ModStatus = own === undefined ? 'available' : own.enabled === false ? 'off' : 'on'

    return { ...m, status, version: own?.version, latest: newer(m.name, own?.version), scope: own?.scope, projectPath: own?.projectPath || undefined }
  })
  await update($, rows, () => next)
}

/** Installs, enables, disables, updates or removes one mod; returns false when the CLI refused. */
async function change($: EngineInterface, row: ModRow, action: Action) {
  const id = `${row.name}@${MARKETPLACE}`
  const scope = row.scope !== undefined && action !== 'install' ? ['--scope', row.scope] : []
  const cwd = action === 'install' ? undefined : row.projectPath
  const result = await cli($, ['plugin', action, id, ...scope], 120000, cwd).catch((error: unknown) => ({ exitCode: 1, stdout: '', stderr: String(error) }))
  if (result.exitCode !== 0) {
    await update($, message, () => `${action} ${row.name} failed: ${(result.stderr || result.stdout).trim().split('\n').at(-1)?.slice(0, 200) ?? 'unknown error'}`)
    return false
  }

  return true
}

async function act($: EngineInterface, row: ModRow, action: Action) {
  if ((await read($, busy)) !== null) return
  if (action === 'uninstall') {
    const answer = await $.ui.ask(`Remove ${row.name}? Its settings stay saved; you can install it again any time.`, { header: 'Mods', options: ['Remove', 'Keep it'] }).catch(() => 'Keep it')
    if (answer !== 'Remove') return
  }
  await update($, busy, () => row.name)
  await update($, message, () => '')
  try {
    if (await change($, row, action)) {
      await update($, needsRestart, () => true)
      const done = { uninstall: 'removed', install: 'installed', enable: 'turned on', disable: 'turned off', update: `updated to ${row.latest ?? 'the latest version'}` }[action]
      $.ui.toast(`${GLYPH.ok} ${row.name}: ${done}. Applies in your next session.`)
    }
    await refresh($)
  } finally {
    await update($, busy, () => null)
  }
}

/** Updates every mod that has a newer version in the marketplace. */
async function updateAll($: EngineInterface) {
  const outdated = [...(await read($, rows)), ...[await read($, self)].filter((r): r is ModRow => r !== null)].filter(r => r.latest !== undefined)
  if (outdated.length === 0 || (await read($, busy)) !== null) return
  await update($, busy, () => `${outdated.length} update${outdated.length === 1 ? '' : 's'}`)
  await update($, message, () => '')
  let changed = 0
  try {
    for (const row of outdated) if (await change($, row, 'update')) changed++
    if (changed > 0) {
      await update($, needsRestart, () => true)
      $.ui.toast(`${GLYPH.ok} Updated ${changed} mod${changed === 1 ? '' : 's'}. Applies in your next session.`)
    }
    await refresh($)
  } finally {
    await update($, busy, () => null)
  }
}

/** Fetches the marketplace's latest catalog, then re-reads what is installed, so "update available" is current. */
async function checkForUpdates($: EngineInterface) {
  if ((await read($, busy)) !== null) return
  await update($, busy, () => 'checking for updates')
  try {
    const result = await cli($, ['plugin', 'marketplace', 'update', MARKETPLACE], 120000).catch((error: unknown) => ({ exitCode: 1, stdout: '', stderr: String(error) }))
    if (result.exitCode !== 0) {
      await update($, message, () => `Couldn't check for updates: ${(result.stderr || result.stdout).trim().split('\n').at(-1)?.slice(0, 200) ?? 'unknown error'}`)
    }
    await refresh($)
  } finally {
    await update($, busy, () => null)
  }
}

/** Makes the installed set match a preset: installs or turns on what it lists, turns off the rest (nothing is removed). */
async function applyPreset($: EngineInterface, presetId: string) {
  const preset = PRESETS.find(p => p.id === presetId)
  if (preset === undefined || (await read($, busy)) !== null) return
  await update($, busy, () => preset.label)
  await update($, message, () => '')
  let changed = 0
  try {
    for (const row of await read($, rows)) {
      const wanted = preset.mods.includes(row.name)
      const action = wanted ? (row.status === 'available' ? 'install' : row.status === 'off' ? 'enable' : null) : row.status === 'on' ? 'disable' : null
      if (action === null) continue
      if (await change($, row, action)) changed++
    }
    if (changed > 0) {
      await update($, needsRestart, () => true)
      $.ui.toast(`${preset.label}: ${changed} change${changed === 1 ? '' : 's'}. Applies in your next session.`)
    } else {
      $.ui.toast(`${preset.label} is already what you have.`)
    }
    await refresh($)
  } finally {
    await update($, busy, () => null)
  }
}

export const register: Register = (on, options) => {
  cliPath = typeof options.cliPath === 'string' && options.cliPath.trim() !== '' ? options.cliPath.trim() : 'claude'

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'mods', description: 'Choose which claude-mods to install and turn on' })
    // One hello on the very first session after install; never again.
    if ((await $.store.get('welcomed')) !== true) {
      await $.store.set('welcomed', true)
      $.ui.toast('claude-mods ready: /mods to pick your set. Useful? A star on GitHub helps others find it.', { timeoutMs: 10000 })
    }

    return next(e)
  })

  on('command.run', { command: 'mods' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Mods' })
    // Offline: compares with the marketplace copy Claude Code keeps. Fetching news is the Check for updates button.
    void refresh($)

    return { text: 'Mod manager opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const kit = { Box, Text }
    const list = await read($, rows)
    const me = await read($, self)
    const working = await read($, busy)
    const note = await read($, message)
    const restart = await read($, needsRestart)
    const onCount = list.filter(r => r.status === 'on').length
    const updates = [...list, ...(me !== null ? [me] : [])].filter(r => r.latest !== undefined).length
    const icon: Record<ModStatus, string> = { on: GLYPH.on, off: GLYPH.off, available: GLYPH.off }
    const color: Record<ModStatus, string> = { on: TONE.accent, off: TONE.dim, available: TONE.dim }
    const status =
      working !== null
        ? `working on ${working}…`
        : list.length === 0
          ? 'reading what is installed…'
          : `${onCount} on of ${list.length}${updates > 0 ? ` · ${updates} update${updates === 1 ? '' : 's'} available` : ''}`
    const version = (r: ModRow) =>
      r.version === undefined ? null : r.latest !== undefined ? <Text color={TONE.accent}>{`${r.version} → ${r.latest}`}</Text> : <Text dimColor>{r.version}</Text>

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          {header(kit, note !== '' ? GLYPH.fail : updates > 0 ? GLYPH.warn : GLYPH.on, note !== '' ? TONE.bad : updates > 0 ? TONE.warn : TONE.accent, 'mod-manager', status)}
          {restart && (
            <Text color={TONE.warn}>
              {GLYPH.warn} Changes apply in your next session (start a new chat or restart Claude Code).
            </Text>
          )}
          {note !== '' && (
            <Text color={TONE.bad}>
              {GLYPH.fail} {note}
            </Text>
          )}
          {list.length === 0 && note === '' && empty(kit, 'Asking Claude Code which mods are installed… this takes a few seconds.')}
        </Box>

        {updates > 0 && (
          <Box gap={1}>
            <Button key="update-all" hotkey="u" variant="primary" label={`Update ${updates === 1 ? '1 mod' : `all ${updates}`}`} onPress={() => void updateAll($)} />
            <Text dimColor>Takes effect in your next session.</Text>
          </Box>
        )}

        {section(
          kit,
          "Presets (turns off what isn't listed, removes nothing)",
          <Box gap={1} flexWrap="wrap">
            {PRESETS.map((p, i) => (
              <Button key={`preset-${p.id}`} plain hotkey={String(i + 1)} label={p.label} onPress={() => void applyPreset($, p.id)} />
            ))}
          </Box>,
        )}

        {me !== null && me.latest !== undefined &&
          section(
            kit,
            'This manager',
            <Box gap={1}>
              <Text color={TONE.accent}>{GLYPH.on}</Text>
              <Text bold>mod-manager</Text>
              {version(me)}
              <Button key="update-mod-manager" plain label="Update" onPress={() => void act($, me, 'update')} />
            </Box>,
          )}

        {list.length > 0 &&
          section(
            kit,
            'Mods',
            list.map(r => (
              <Box flexDirection="column">
                <Box gap={1}>
                  <Text color={color[r.status]}>{icon[r.status]}</Text>
                  <Text bold>{r.name}</Text>
                  {version(r)}
                  {r.usesTokens && <Text color={TONE.warn}>uses tokens</Text>}
                  {r.latest !== undefined && <Button key={`update-${r.name}`} plain label="Update" onPress={() => void act($, r, 'update')} />}
                  {r.status === 'available' && <Button key={`install-${r.name}`} plain label="Install" onPress={() => void act($, r, 'install')} />}
                  {r.status === 'off' && <Button key={`enable-${r.name}`} plain label="Turn on" onPress={() => void act($, r, 'enable')} />}
                  {r.status === 'on' && <Button key={`disable-${r.name}`} plain label="Turn off" onPress={() => void act($, r, 'disable')} />}
                  {r.status !== 'available' && <Button key={`remove-${r.name}`} plain label="Remove" onPress={() => void act($, r, 'uninstall')} />}
                </Box>
                {r.blurb !== '' && (
                  <Box paddingLeft={2}>
                    <Text dimColor wrap="truncate-end">
                      {r.blurb}
                    </Text>
                  </Box>
                )}
              </Box>
            )),
          )}

        <Box gap={1}>
          <Button key="refresh" hotkey="r" label="Refresh" onPress={() => void refresh($)} />
          <Button key="check" label="Check for updates" onPress={() => void checkForUpdates($)} />
        </Box>
      </Box>
    )
  })
}

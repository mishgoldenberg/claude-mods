import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ModRow, ModStatus } from '../types'

const PANE = 'mod-manager'
const MARKETPLACE = 'claude-mods'
const rows = atom({ plugin: 'mod-manager', key: 'rows' } as const, [])
const busy = atom({ plugin: 'mod-manager', key: 'busy' } as const, null)
const message = atom({ plugin: 'mod-manager', key: 'message' } as const, '')
const needsRestart = atom({ plugin: 'mod-manager', key: 'needsRestart' } as const, false)

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

  const known = new Set(CATALOG.map(m => m.name))
  const extra = [...new Set([...installed.keys(), ...offered.keys()])].filter(n => n !== 'mod-manager' && !known.has(n))
  const next: ModRow[] = [
    ...CATALOG,
    ...extra.map(name => ({ name, blurb: offered.get(name)?.description ?? '', usesTokens: false })),
  ].map(m => {
    const own = installed.get(m.name)
    const status: ModStatus = own === undefined ? 'available' : own.enabled === false ? 'off' : 'on'

    return { ...m, status, version: own?.version, scope: own?.scope, projectPath: own?.projectPath || undefined }
  })
  await update($, rows, () => next)
}

/** Installs, enables, disables or removes one mod; returns false when the CLI refused. */
async function change($: EngineInterface, row: ModRow, action: 'install' | 'enable' | 'disable' | 'uninstall') {
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

async function act($: EngineInterface, row: ModRow, action: 'install' | 'enable' | 'disable' | 'uninstall') {
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
      $.ui.toast(`${row.name}: ${action === 'uninstall' ? 'removed' : action === 'install' ? 'installed' : action === 'enable' ? 'turned on' : 'turned off'}. Applies in your next session.`)
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

    return next(e)
  })

  on('command.run', { command: 'mods' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Mods' })
    void refresh($)

    return { text: 'Mod manager opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, rows)
    const working = await read($, busy)
    const note = await read($, message)
    const restart = await read($, needsRestart)
    const onCount = list.filter(r => r.status === 'on').length
    const icon: Record<ModStatus, string> = { on: '●', off: '○', available: '+' }
    const color: Record<ModStatus, string> = { on: 'green', off: 'yellow', available: 'gray' }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>
            Mods: {onCount} on{list.length > 0 ? ` of ${list.length}` : ''}
            {working !== null ? <Text color="cyan">  working on {working}…</Text> : null}
          </Text>
          {restart && <Text color="yellow">Changes apply in your next session (start a new chat or restart Claude Code).</Text>}
          {note !== '' && <Text color="red">{note}</Text>}
          {list.length === 0 && note === '' && <Text dimColor>Loading the list…</Text>}
        </Box>

        <Box flexDirection="column">
          <Text dimColor>Presets (turns off what isn't listed, removes nothing):</Text>
          <Box gap={1}>
            {PRESETS.map((p, i) => (
              <Button key={`preset-${p.id}`} plain hotkey={String(i + 1)} label={p.label} onPress={() => void applyPreset($, p.id)} />
            ))}
          </Box>
        </Box>

        {list.map(r => (
          <Box flexDirection="column">
            <Box gap={1}>
              <Text color={color[r.status]}>{icon[r.status]}</Text>
              <Text bold>{r.name}</Text>
              {r.version !== undefined && <Text dimColor>{r.version}</Text>}
              {r.usesTokens && <Text color="yellow">uses tokens</Text>}
              {r.status === 'available' && <Button key={`install-${r.name}`} plain label="Install" onPress={() => void act($, r, 'install')} />}
              {r.status === 'off' && <Button key={`enable-${r.name}`} plain label="Turn on" onPress={() => void act($, r, 'enable')} />}
              {r.status === 'on' && <Button key={`disable-${r.name}`} plain label="Turn off" onPress={() => void act($, r, 'disable')} />}
              {r.status !== 'available' && <Button key={`remove-${r.name}`} plain label="Remove" onPress={() => void act($, r, 'uninstall')} />}
            </Box>
            {r.blurb !== '' && <Text dimColor wrap="truncate-end">  {r.blurb}</Text>}
          </Box>
        ))}

        <Button key="refresh" hotkey="r" label="Refresh" onPress={() => void refresh($)} />
      </Box>
    )
  })
}

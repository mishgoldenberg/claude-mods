import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register, RenderChildren } from 'claude-code'

import type { DiffStat, FileChange } from '../types'

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

const PANE = 'changes'
const files = atom({ plugin: 'changes', key: 'files' } as const, [])
const diff = atom({ plugin: 'changes', key: 'diff' } as const, [])
const isGit = atom({ plugin: 'changes', key: 'isGit' } as const, false)

const WRITERS = new Set(['Write', 'Edit', 'NotebookEdit'])
const rel = (p: string, root: string) => {
  const a = p.replace(/\\/g, '/')
  const r = root.replace(/\\/g, '/')

  return a.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? a.slice(r.length + 1) : a
}

async function refreshDiff($: EngineInterface) {
  const root = await $.session.root()
  const res = await $.process.run(['git', '-C', root, 'diff', '--numstat', 'HEAD']).catch(() => undefined)
  if (res === undefined || res.exitCode !== 0) {
    await update($, isGit, () => false)
    return
  }
  const stats: DiffStat[] = res.stdout
    .split('\n')
    .map(line => line.split('\t'))
    .filter(parts => parts.length === 3)
    .map(([a, r, path]) => ({ path: path ?? '', added: Number(a) || 0, removed: Number(r) || 0 }))
  await update($, isGit, () => true)
  await update($, diff, () => stats)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'changes', description: 'Files Claude changed this session, with line counts and quick actions' })

    return next(e)
  })

  on('command.run', { command: 'changes' }, async $ => {
    await refreshDiff($)
    await $.ui.open({ id: PANE, title: 'Changes' })

    return { text: 'Changes panel opened.' }
  })

  on('tool.call', { tool: ['Write', 'Edit', 'NotebookEdit'] }, async ($, e, next) => {
    const input = e as unknown as { tool: string; file_path?: string; notebook_path?: string }
    const path = input.file_path ?? input.notebook_path
    const existed = path !== undefined && input.tool === 'Write' ? await $.fs.exists(path).catch(() => true) : true
    const ran = await next(e)
    if (path === undefined || ran.deny !== undefined || ran.isError === true || !WRITERS.has(input.tool)) return ran

    const root = await $.session.root()
    const at = await $.clock.now()
    const key = rel(path, root)
    await update($, files, list => {
      const found = list.find(f => f.path === key)
      const change: FileChange = found
        ? { ...found, edits: found.edits + 1, lastAt: at, lastTool: input.tool }
        : { path: key, edits: 1, created: !existed, lastAt: at, lastTool: input.tool }

      return [change, ...list.filter(f => f.path !== key)]
    })

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && (await read($, files)).length > 0) void refreshDiff($)

    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, files)
    const stats = await read($, diff)
    const git = await read($, isGit)
    const statOf = (p: string) => stats.find(s => s.path === p || p.endsWith(`/${s.path}`))
    const totals = list.reduce((t, f) => {
      const s = statOf(f.path)

      return { added: t.added + (s?.added ?? 0), removed: t.removed + (s?.removed ?? 0) }
    }, { added: 0, removed: 0 })

    const kit = { Box, Text }
    const status = list.length === 0 ? 'no edits yet' : `${list.length} file${list.length === 1 ? '' : 's'} changed${git ? ` · +${totals.added} -${totals.removed}` : ''}`

    return (
      <Box flexDirection="column" gap={1}>
        {header(kit, list.length > 0 ? GLYPH.on : GLYPH.off, list.length > 0 ? TONE.accent : TONE.dim, 'changes', status)}
        {section(
          kit,
          'Files',
          <Box flexDirection="column">
            {list.length === 0 && empty(kit, 'No edits yet. Files Claude creates or edits this session show up here, with +/- line counts.')}
            {list.map((f, i) => {
              const s = statOf(f.path)

              return (
                <Box gap={1}>
                  <Box flexGrow={1} flexShrink={1}>
                    <Text wrap="truncate-start">
                      {f.created ? <Text color={TONE.ok}>new </Text> : ''}
                      {f.path}
                    </Text>
                  </Box>
                  {s !== undefined && num(kit, `+${s.added}`, 6, TONE.ok)}
                  {s !== undefined && num(kit, `-${s.removed}`, 6, TONE.bad)}
                  {num(kit, `${f.edits}×`, 4)}
                  <Button key={`why-${i}`} plain label="why?" onPress={() => void $.prompt.fill({ text: `Briefly explain what you changed in ${f.path} and why.` })} />
                </Box>
              )
            })}
          </Box>,
        )}
        {list.length > 0 && (
          <Box gap={1} flexWrap="wrap">
            <Button key="summary" hotkey="s" variant="primary" label="Summarize all changes" onPress={() => void $.prompt.submit({ text: `Summarize every change you made this session, file by file (${list.map(f => f.path).join(', ')}): what and why, and anything I should double-check.` })} />
            <Button key="review" hotkey="v" label="Self-review" onPress={() => void $.prompt.submit({ text: `Review your own changes this session (${list.map(f => f.path).join(', ')}) like a strict code reviewer: bugs, leftovers, missing tests. Do not change anything yet.` })} />
            {git && <Button key="refresh" hotkey="r" label="Refresh diff" onPress={() => void refreshDiff($)} />}
          </Box>
        )}
        {git && <Text dimColor>Line counts are vs. last commit (git diff HEAD), so they include your own edits too.</Text>}
      </Box>
    )
  })
}

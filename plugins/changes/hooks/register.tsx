import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DiffStat, FileChange } from '../types'

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

    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>
          {list.length} file{list.length === 1 ? '' : 's'} changed by Claude
          {git && (
            <Text>
              {' '}
              <Text color="green">+{totals.added}</Text> <Text color="red">-{totals.removed}</Text>
            </Text>
          )}
        </Text>
        {list.length === 0 && <Text dimColor>No edits yet this session.</Text>}
        {list.map((f, i) => {
          const s = statOf(f.path)

          return (
            <Box gap={1}>
              <Text wrap="truncate-start">
                {f.created ? <Text color="green">new </Text> : <Text dimColor>{'    '}</Text>}
                {f.path}
              </Text>
              {s !== undefined && (
                <Text>
                  <Text color="green">+{s.added}</Text> <Text color="red">-{s.removed}</Text>
                </Text>
              )}
              <Text dimColor>{f.edits}×</Text>
              <Button key={`why-${i}`} plain label="why?" onPress={() => void $.prompt.fill({ text: `Briefly explain what you changed in ${f.path} and why.` })} />
            </Box>
          )
        })}
        {list.length > 0 && (
          <Box gap={1} flexWrap="wrap">
            <Button key="summary" hotkey="s" label="Summarize all changes" onPress={() => void $.prompt.submit({ text: `Summarize every change you made this session, file by file (${list.map(f => f.path).join(', ')}): what and why, and anything I should double-check.` })} />
            <Button key="review" hotkey="v" label="Self-review" onPress={() => void $.prompt.submit({ text: `Review your own changes this session (${list.map(f => f.path).join(', ')}) like a strict code reviewer: bugs, leftovers, missing tests. Do not change anything yet.` })} />
            {git && <Button key="refresh" hotkey="r" label="Refresh diff" onPress={() => void refreshDiff($)} />}
          </Box>
        )}
        {git && <Text dimColor>Line counts are vs. last commit (git diff HEAD), so they include your own edits too.</Text>}
      </Box>
    )
  })
}

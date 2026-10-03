import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ActivityCall, CallStatus, Phase, Todo } from '../types'

const PANE = 'activity'
const calls = atom({ plugin: 'activity', key: 'calls' } as const, [])
const phase = atom({ plugin: 'activity', key: 'phase' } as const, { kind: 'idle', since: 0, prompt: '' } as Phase)
const todos = atom({ plugin: 'activity', key: 'todos' } as const, [])
const showAll = atom({ plugin: 'activity', key: 'showAll' } as const, false)

const STATUS: Record<CallStatus, { icon: string; color: string; label: string }> = {
  running: { icon: '◐', color: 'cyan', label: 'running' },
  approval: { icon: '⏸', color: 'yellow', label: 'waiting for YOUR approval' },
  done: { icon: '✔', color: 'green', label: 'done' },
  failed: { icon: '✘', color: 'red', label: 'failed' },
  denied: { icon: '⊘', color: 'magenta', label: 'denied' },
}

const TODO_ICON: Record<string, string> = { completed: '☑', in_progress: '▶', pending: '☐' }

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const base = (p: string) => p.split(/[\\/]/).at(-1) ?? p
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** One human line per tool call: what it is actually doing. */
function describe(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return `$ ${str(input.command).replace(/\s+/g, ' ')}`
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return base(str(input.file_path) || str(input.notebook_path))
    case 'Grep':
      return `/${str(input.pattern)}/${input.path ? ` in ${base(str(input.path))}` : ''}`
    case 'Glob':
      return str(input.pattern)
    case 'WebFetch':
      return str(input.url)
    case 'WebSearch':
      return `"${str(input.query)}"`
    case 'Agent':
    case 'Task':
      return `${str(input.subagent_type) || 'agent'}: ${str(input.description)}`
    case 'TodoWrite':
      return `${Array.isArray(input.todos) ? input.todos.length : 0} todos`
    default: {
      const first = Object.values(input).find(v => typeof v === 'string')

      return typeof first === 'string' ? first : ''
    }
  }
}

const secs = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))

  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`
}

async function setStatus($: EngineInterface, id: string, status: CallStatus, endedAt?: number) {
  await update($, calls, list => list.map(c => (c.id === id ? { ...c, status, endedAt: endedAt ?? c.endedAt } : c)))
}

let ticker: { cancel: () => void } | null = null

/** Redraws once a second while something runs, so the timers count up. */
function startTicking($: EngineInterface) {
  ticker ??= $.clock.every(1000, () => $.ui.invalidate('ui.render'))
}

function stopTicking() {
  ticker?.cancel()
  ticker = null
}

export const register: Register = (on, options) => {

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'activity', description: 'Live view: what Claude is running and waiting for right now' })
    if (options.autoOpen === true) void $.ui.open({ id: PANE, title: 'Activity' })

    return next(e)
  })

  on('command.run', { command: 'activity' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Activity' })

    return { text: 'Activity panel opened.' }
  })

  on('turn.start', async ($, e, next) => {
    const since = await $.clock.now()
    await update($, phase, (): Phase => ({ kind: 'thinking', since, prompt: e.text }))
    startTicking($)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      const since = await $.clock.now()
      await update($, phase, (p): Phase => ({ ...p, kind: 'idle', since }))
      stopTicking()
    }

    return result
  })

  on('tool.call', async ($, e, next) => {
    const { tool, tool_use_id, agentId, ...input } = e as unknown as { tool: string; tool_use_id: string; agentId?: string } & Record<string, unknown>
    const call: ActivityCall = {
      id: tool_use_id,
      tool,
      summary: describe(tool, input),
      agentId,
      isBackground: input.run_in_background === true,
      startedAt: await $.clock.now(),
      status: 'running',
    }
    if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
      await update($, todos, () => (input.todos as Todo[]).map(t => ({ content: t.content, status: t.status, activeForm: t.activeForm })))
    }
    await update($, calls, list => [...list, call].slice(-300))
    if (agentId === undefined) await update($, phase, (p): Phase => ({ ...p, kind: 'tools' }))
    startTicking($)

    try {
      const check = await $.tool.check({ tool, input })
      if (check.decision === 'ask') await setStatus($, tool_use_id, 'approval')
    } catch {
      // no verdict available
    }

    let status: CallStatus = 'failed'
    try {
      const ran = await next(e)
      status = ran.deny !== undefined ? 'denied' : ran.isError === true ? 'failed' : 'done'

      return ran
    } finally {
      await setStatus($, tool_use_id, status, await $.clock.now())
      const stillRunning = (await read($, calls)).some(c => c.agentId === undefined && (c.status === 'running' || c.status === 'approval'))
      if (agentId === undefined && !stillRunning) await update($, phase, (p): Phase => (p.kind === 'tools' ? { ...p, kind: 'thinking' } : p))
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, calls)
    const now = await $.clock.now()
    const p = await read($, phase)
    const plan = await read($, todos)
    const all = await read($, showAll)
    const cols = e.props.bodyColumns ?? 40
    const rows = e.viewport?.rows ?? 30

    const live = list.filter(c => c.status === 'running' || c.status === 'approval')
    const waitingOnYou = live.filter(c => c.status === 'approval')
    const agents = await $.agent.list().catch(() => [])
    const runningAgents = agents.filter(a => a.status === 'running')
    const recent = list.filter(c => !live.includes(c) && (all || c.agentId === undefined)).slice(-Math.max(3, rows - 18 - live.length - plan.length))

    const headline =
      waitingOnYou.length > 0
        ? { color: 'yellow', text: `⏸ Waiting for you: approve ${waitingOnYou.map(c => c.tool).join(', ')}` }
        : p.kind === 'idle'
          ? { color: 'gray', text: '○ Idle: waiting for your next prompt' }
          : p.kind === 'tools'
            ? { color: 'cyan', text: `◐ Running ${live.length} tool${live.length === 1 ? '' : 's'} · turn ${secs(now - p.since)}` }
            : { color: 'cyan', text: `◐ Thinking / writing · turn ${secs(now - p.since)}` }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold color={headline.color}>
            {headline.text}
          </Text>
          {p.kind !== 'idle' && p.prompt !== '' && <Text dimColor>for: {clip(p.prompt.replace(/\s+/g, ' '), cols - 6)}</Text>}
        </Box>

        {live.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Now</Text>
            {live.map(c => (
              <Text color={STATUS[c.status].color} wrap="truncate-end">
                {STATUS[c.status].icon} {c.tool} {secs(now - c.startedAt)}
                {c.agentId ? ' [subagent]' : ''}
                {c.isBackground ? ' [background]' : ''} <Text dimColor>{c.summary}</Text>
              </Text>
            ))}
          </Box>
        )}

        {runningAgents.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Subagents</Text>
            {runningAgents.map(a => (
              <Text wrap="truncate-end">
                ◆ {a.type} <Text dimColor>{a.description}</Text>
              </Text>
            ))}
          </Box>
        )}

        {plan.length > 0 && (
          <Box flexDirection="column">
            <Text bold>
              Plan ({plan.filter(t => t.status === 'completed').length}/{plan.length})
            </Text>
            {plan.map(t => (
              <Text dimColor={t.status === 'completed'} bold={t.status === 'in_progress'} wrap="truncate-end">
                {TODO_ICON[t.status] ?? '•'} {t.status === 'in_progress' ? (t.activeForm ?? t.content) : t.content}
              </Text>
            ))}
          </Box>
        )}

        <Box flexDirection="column">
          <Box gap={1}>
            <Text bold>History</Text>
            <Button key="all" plain hotkey="a" label={all ? 'main only' : 'incl. subagents'} onPress={() => void update($, showAll, v => !v)} />
            <Button key="clear" plain hotkey="c" label="clear" onPress={() => void update($, calls, l => l.filter(c => c.status === 'running' || c.status === 'approval'))} />
          </Box>
          {recent.length === 0 && <Text dimColor>No tool calls yet.</Text>}
          {recent.map(c => (
            <Text wrap="truncate-end">
              <Text color={STATUS[c.status].color}>{STATUS[c.status].icon}</Text> {c.tool.padEnd(6)} <Text dimColor>{secs((c.endedAt ?? now) - c.startedAt).padStart(5)}</Text> <Text dimColor>{c.summary}</Text>
            </Text>
          ))}
        </Box>
      </Box>
    )
  })
}

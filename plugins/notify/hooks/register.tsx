import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { NotifyEntry, NotifyKind } from '../types'

const PANE = 'notify'
const entries = atom({ plugin: 'notify', key: 'entries' } as const, [])
const isMuted = atom({ plugin: 'notify', key: 'isMuted' } as const, false)

const ICON: Record<NotifyKind, string> = { turn: '✔', agent: '◆', task: '▶', approval: '⏸', question: '?', error: '✘' }

const firstLine = (text: string, max = 90) => {
  const line = text.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? ''

  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

const took = (ms: number) => {
  const s = Math.round(ms / 1000)

  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`
}

/** Best-effort native notification so you hear about it when the window is in the background. */
async function osNotify($: EngineInterface, title: string, body: string) {
  const safe = (s: string) => s.replace(/["'`$\\]/g, ' ').slice(0, 200)
  try {
    if ((await $.env.get('OS')) === 'Windows_NT') {
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$n = New-Object System.Windows.Forms.NotifyIcon',
        '$n.Icon = [System.Drawing.SystemIcons]::Information',
        '$n.Visible = $true',
        `$n.ShowBalloonTip(6000, '${safe(title)}', '${safe(body) || ' '}', 'Info')`,
        'Start-Sleep -Seconds 7',
        '$n.Dispose()',
      ].join('; ')
      void $.process.run(['powershell', '-NoProfile', '-WindowStyle', 'Hidden', '-Command', script])
      return
    }
    const uname = await $.process.run(['uname'])
    if (uname.stdout.trim() === 'Darwin') {
      await $.process.run(['osascript', '-e', `display notification "${safe(body)}" with title "${safe(title)}" sound name "Glass"`])
    } else {
      await $.process.run(['notify-send', safe(title), safe(body)])
    }
  } catch (error) {
    $.ui.log(`notify: native notification failed: ${String(error)}`, { to: 'debug' })
  }
}

let useOs = true

/** Records a notification in the inbox, toasts it, and (when `native`) raises an OS notification. */
async function push($: EngineInterface, kind: NotifyKind, title: string, body: string, native: boolean) {
  const entry: NotifyEntry = { at: await $.clock.now(), kind, title, body, isRead: false }
  await update($, entries, list => [entry, ...list].slice(0, 100))
  if (await read($, isMuted)) return
  $.ui.toast(`${ICON[kind]} ${title}${body ? `: ${body}` : ''}`, { timeoutMs: 7000 })
  if (native && useOs) await osNotify($, `Claude Code · ${title}`, body)
}

export const register: Register = (on, options) => {
  const minSeconds = Number(options.minSeconds ?? 30)
  useOs = options.osNotify !== false
  const approvalWaitSeconds = Number(options.approvalWaitSeconds ?? 15)
  const pendingApprovals = new Map<string, () => void>()

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'notifications', description: 'Open the notification inbox' })
    await $.command.register({ name: 'mute', description: 'Mute or unmute claude-mods notifications', argumentHint: '[on|off]' })

    return next(e)
  })

  on('command.run', { command: 'notifications' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Notifications' })
    await update($, entries, list => list.map(n => ({ ...n, isRead: true })))

    return { text: 'Notification inbox opened.' }
  })

  on('command.run', { command: 'mute' }, async ($, e) => {
    const muted = e.args.trim() === 'off' ? false : e.args.trim() === 'on' ? true : !(await read($, isMuted))
    await update($, isMuted, () => muted)

    return { text: muted ? 'Notifications muted.' : 'Notifications on.' }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    if (e.agentId !== undefined) {
      const agent = (await $.agent.list()).find(a => a.id === e.agentId)
      const name = agent?.description ?? agent?.type ?? 'Subagent'
      await push($, 'agent', `${name} finished (${took(e.durationMs)})`, firstLine(e.answer), e.durationMs >= minSeconds * 1000)
      return result
    }

    if (e.reason === 'error') {
      await push($, 'error', 'Turn failed', firstLine(e.answer), true)
    } else if (e.reason === 'refusal') {
      await push($, 'error', 'Turn refused', e.refusal.explanation ?? '', true)
    } else if (!e.isAborted && e.durationMs >= minSeconds * 1000) {
      await push($, 'turn', `Done in ${took(e.durationMs)}`, firstLine(e.answer), true)
    }

    return result
  })

  on('session.receive', async ($, e, next) => {
    if (e.origin.kind === 'task-notification') {
      const status = /<status>([^<]+)<\/status>/.exec(e.text)?.[1]
      const summary = /<summary>([^<]+)<\/summary>/.exec(e.text)?.[1]
      await push($, 'task', `Background task ${status ?? 'update'}`, firstLine(summary ?? e.text), true)
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool === 'AskUserQuestion') {
      // Only when Claude asks. A plugin's $.ui.ask (prompt-coach's suggestion) also arrives here,
      // raised by that plugin while you are right at the prompt.
      if (e.agentId === undefined && next.origin.plugin === 'engine') await push($, 'question', 'Claude has a question for you', '', true)
      return next(e)
    }

    // Find out whether this call will stop for your approval; if it sits there, ping you.
    const { tool, tool_use_id, agentId, ...input } = e as unknown as { tool: string; tool_use_id: string; agentId?: string } & Record<string, unknown>
    let check: { decision: string } = { decision: 'allow' }
    try {
      check = await $.tool.check({ tool, input })
    } catch {
      // no verdict available; treat as allow
    }

    if (check.decision === 'ask' && approvalWaitSeconds >= 0) {
      const timer = $.clock.after(approvalWaitSeconds * 1000, () => {
        void push($, 'approval', `Waiting for your approval${agentId ? ' (subagent)' : ''}`, `${tool}`, true)
      })
      pendingApprovals.set(tool_use_id, () => timer.cancel())
    }

    try {
      return await next(e)
    } finally {
      pendingApprovals.get(tool_use_id)?.()
      pendingApprovals.delete(tool_use_id)
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, entries)
    const muted = await read($, isMuted)
    const room = Math.max(3, Math.floor(((e.viewport?.rows ?? 30) - 6) / 2))

    return (
      <Box flexDirection="column" gap={1}>
        <Box gap={1}>
          <Button key="mute" hotkey="m" label={muted ? 'Unmute' : 'Mute'} onPress={() => void update($, isMuted, m => !m)} />
          <Button key="clear" hotkey="c" label="Clear" onPress={() => void update($, entries, () => [])} />
          <Button key="test" hotkey="t" label="Test" onPress={() => void push($, 'turn', 'Test notification', 'If you see this, notify works.', true)} />
        </Box>
        {list.length === 0 && <Text dimColor>Nothing yet. Long turns, finished subagents, background tasks and pending approvals show up here.</Text>}
        {list.slice(0, room).map(n => (
          <Box flexDirection="column">
            <Text bold={!n.isRead}>
              {ICON[n.kind]} {n.title} <Text dimColor>{new Date(n.at).toLocaleTimeString()}</Text>
            </Text>
            {n.body !== '' && <Text dimColor wrap="truncate-end">   {n.body}</Text>}
          </Box>
        ))}
      </Box>
    )
  })
}

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Checkpoint, ContextSnapshot } from '../types'

const PANE = 'context-keeper'
const snapshot = atom({ plugin: 'context-keeper', key: 'snapshot' } as const, null)
const checkpoints = atom({ plugin: 'context-keeper', key: 'checkpoints' } as const, [])
const busy = atom({ plugin: 'context-keeper', key: 'busy' } as const, null)

const HANDOFF_PROMPT = `Write a compact handoff note for this session so a fresh session can continue with no loss.
Use these markdown sections, terse bullets, no preamble:
## Goal
## Decisions made (and why)
## Files touched (path: what changed)
## Current state (what works, what is broken)
## Open TODOs / next steps
## Gotchas (things that were tried and failed)`

const TIPS: Record<string, string> = {
  'MCP tools': 'Disable MCP servers you are not using this session.',
  'Memory files': 'Trim CLAUDE.md / memory files, or split rarely-needed parts into skills.',
  'Custom agents': 'Remove agent definitions you never call.',
  Skills: 'Skills are cheap until loaded; uninstall ones you never use.',
  Messages: 'Most of the window is conversation: checkpoint, then /compact or /clear.',
  'System tools': 'Built-in tool schemas are fixed cost; nothing to do here.',
}

const bar = (percent: number, width: number) => {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))

  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

const stamp = (ms: number) => new Date(ms).toISOString().replace(/[:.]/g, '-').slice(0, 19)

const join = (...parts: string[]) => parts.join('/').replace(/\\/g, '/').replace(/\/+/g, '/')

async function refresh($: EngineInterface): Promise<ContextSnapshot | null> {
  const usage = await $.session.usage({ breakdown: 'summary' })
  const ctx = usage.context
  const breakdown = ctx.breakdown
  const next: ContextSnapshot = {
    percent: ctx.percent ?? breakdown?.percentage ?? 0,
    tokens: ctx.tokens ?? breakdown?.totalTokens ?? 0,
    window: ctx.window,
    categories: (breakdown?.categories ?? [])
      .filter(c => c.tokens > 0 && !c.isDeferred)
      .map(c => ({ name: c.name, tokens: c.tokens }))
      .sort((a, b) => b.tokens - a.tokens),
    memoryFiles: (breakdown?.memoryFiles ?? [])
      .map(f => ({ path: f.path, tokens: f.tokens }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 5),
    updatedAt: await $.clock.now(),
  }
  await update($, snapshot, () => next)

  return next
}

async function remember($: EngineInterface, cp: Checkpoint) {
  await update($, checkpoints, list => [cp, ...list].slice(0, 10))
  const saved = ((await $.store.get('checkpoints')) as Checkpoint[] | undefined) ?? []
  await $.store.set('checkpoints', [cp, ...saved].slice(0, 30))
}

/** Asks the model (over the cached transcript) for a handoff note and saves it. */
async function writeHandoff($: EngineInterface, why: string) {
  if ((await read($, busy)) !== null) return
  await update($, busy, () => 'Writing handoff note…')
  try {
    const result = await $.model.fork({ prompt: HANDOFF_PROMPT })
    if (!result.isAnswered) {
      $.ui.toast(`Checkpoint skipped: ${result.reason}`)
      return
    }
    const now = await $.clock.now()
    const percent = (await read($, snapshot))?.percent ?? 0
    const path = join(await $.session.root(), '.claude', 'checkpoints', `${stamp(now)}-handoff.md`)
    const header = `<!-- context-keeper handoff · ${why} · context ${Math.round(percent)}% · session ${await $.session.id()} -->\n\n`
    await $.fs.write(path, header + result.text)
    await remember($, { path, at: now, percent, kind: 'handoff' })
    $.ui.toast(`Checkpoint saved: .claude/checkpoints/${stamp(now)}-handoff.md`)
  } catch (error) {
    $.ui.toast(`Checkpoint failed: ${String(error).slice(0, 80)}`)
  } finally {
    await update($, busy, () => null)
  }
}

/** Zero-token archive: dumps the raw conversation text to disk before it is compacted away. */
async function archive($: EngineInterface, messages: readonly { role: string; text: string; toolUses: readonly { tool: string }[] }[]) {
  const now = await $.clock.now()
  const lines = messages.map(m => {
    const tools = m.toolUses.length > 0 ? `\n_tools: ${m.toolUses.map(t => t.tool).join(', ')}_` : ''

    return `### ${m.role}\n\n${m.text.trim()}${tools}\n`
  })
  const path = join(await $.session.root(), '.claude', 'checkpoints', `${stamp(now)}-archive.md`)
  await $.fs.write(path, `# Transcript archived before compaction\n\n${lines.join('\n')}`)
  await remember($, { path, at: now, percent: (await read($, snapshot))?.percent ?? 0, kind: 'archive' })
}

export const register: Register = (on, options) => {
  const warnAt = Number(options.warnAt ?? 70)
  const checkpointAt = Number(options.checkpointAt ?? 85)
  let warned = false
  let checkpointed = false

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'ctx', description: 'Open the context-keeper panel' })
    await $.command.register({ name: 'checkpoint', description: 'Save a handoff note of this session to .claude/checkpoints' })
    await $.command.register({ name: 'resume-checkpoint', description: 'Load the latest checkpoint into the prompt box (use after /clear)' })
    const saved = ((await $.store.get('checkpoints')) as Checkpoint[] | undefined) ?? []
    const root = (await $.session.root()).replace(/\\/g, '/')
    await update($, checkpoints, () => saved.filter(cp => cp.path.startsWith(root)).slice(0, 10))

    return next(e)
  })

  on('command.run', { command: 'ctx' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: 'Context' })

    return { text: 'Context panel opened.' }
  })

  on('command.run', { command: 'checkpoint' }, async $ => {
    await refresh($)
    await writeHandoff($, 'manual')

    return { text: 'Checkpoint written (see .claude/checkpoints).' }
  })

  on('command.run', { command: 'resume-checkpoint' }, async $ => {
    const latest = (await read($, checkpoints)).find(cp => cp.kind === 'handoff')
    if (latest === undefined) return { text: 'No checkpoint yet. Run /checkpoint first.' }
    await $.prompt.fill({ text: `Read ${latest.path} and continue the work from where it left off. Confirm the next step before acting.` })

    return { text: `Prompt box loaded with ${latest.path}` }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    const snap = await refresh($)
    if (snap === null) return result

    if (snap.percent >= warnAt && !warned) {
      warned = true
      const top = snap.categories[0]
      $.ui.toast(`Context ${Math.round(snap.percent)}% full${top ? ` (biggest: ${top.name} ${k(top.tokens)})` : ''}. /ctx for details.`, { timeoutMs: 8000 })
    }
    if (checkpointAt > 0 && snap.percent >= checkpointAt && !checkpointed) {
      checkpointed = true
      void writeHandoff($, `auto at ${checkpointAt}%`)
      void $.prompt.suggest({ text: '/compact' })
    }
    $.ui.status(snap.percent >= warnAt ? `ctx ${Math.round(snap.percent)}%` : undefined)

    return result
  })

  on('session.compact', async ($, e, next) => {
    if (e.agentId === undefined && e.messages.length > 0) {
      try {
        await archive($, e.messages)
      } catch (error) {
        $.ui.log(`context-keeper: archive failed: ${String(error)}`, { to: 'debug' })
      }
    }
    const result = await next(e)
    warned = false
    checkpointed = false
    void refresh($)

    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Input = 'Input' in els ? els.Input : undefined
    const snap = await read($, snapshot)
    const cps = await read($, checkpoints)
    const working = await read($, busy)
    const width = Math.max(10, Math.min(40, (e.props.bodyColumns ?? 40) - 12))

    if (snap === null) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No reading yet.</Text>
          <Button key="refresh" label="Measure now" onPress={() => void refresh($)} />
        </Box>
      )
    }

    const color = snap.percent >= checkpointAt ? 'red' : snap.percent >= warnAt ? 'yellow' : 'green'
    const tips = snap.categories.map(c => TIPS[c.name]).filter((t): t is string => t !== undefined).slice(0, 2)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>
            Context <Text color={color}>{Math.round(snap.percent)}%</Text>
          </Text>
          <Text color={color}>{bar(snap.percent, width)}</Text>
          <Text dimColor>
            {k(snap.tokens)} of {k(snap.window)} tokens · {k(Math.max(0, snap.window - snap.tokens))} left
          </Text>
        </Box>

        <Box flexDirection="column">
          <Text bold>What fills it</Text>
          {snap.categories.slice(0, 7).map(c => (
            <Text>
              {c.name.padEnd(16).slice(0, 16)} {k(c.tokens).padStart(6)} <Text dimColor>{bar((c.tokens / Math.max(1, snap.window)) * 100, 12)}</Text>
            </Text>
          ))}
          {snap.memoryFiles.length > 0 && <Text dimColor>Largest memory file: {snap.memoryFiles[0]?.path.split(/[\\/]/).at(-1)} ({k(snap.memoryFiles[0]?.tokens ?? 0)})</Text>}
        </Box>

        {tips.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Tips</Text>
            {tips.map(t => (
              <Text dimColor>• {t}</Text>
            ))}
          </Box>
        )}

        <Box flexDirection="column">
          <Text bold>Actions</Text>
          {working !== null && <Text color="cyan">{working}</Text>}
          <Box gap={1} flexWrap="wrap">
            <Button key="refresh" hotkey="r" label="Refresh" onPress={() => void refresh($)} />
            <Button key="checkpoint" hotkey="c" variant="primary" label="Checkpoint" onPress={() => void writeHandoff($, 'manual')} />
            <Button key="compact" hotkey="k" label="Checkpoint + compact" onPress={() => void writeHandoff($, 'before compact').then(() => $.command.run({ command: 'compact' }))} />
          </Box>
          {Input !== undefined && (<Input
            key="focus"
            label="Compact, keeping:"
            placeholder="e.g. the auth refactor and failing tests"
            submitLabel="Compact"
            onSubmit={(value: string) => void $.command.run({ command: 'compact', args: value })}
          />)}
        </Box>

        <Box flexDirection="column">
          <Text bold>Checkpoints</Text>
          {cps.length === 0 && <Text dimColor>None yet. A checkpoint is a handoff note you can reload after /clear.</Text>}
          {cps.slice(0, 4).map((cp, i) => (
            <Box gap={1}>
              <Text dimColor>
                {new Date(cp.at).toLocaleTimeString()} {cp.kind} @{Math.round(cp.percent)}%
              </Text>
              <Button
                key={`load-${i}`}
                plain
                label="load"
                onPress={() => void $.prompt.fill({ text: `Read ${cp.path} and continue the work from where it left off. Confirm the next step before acting.` })}
              />
            </Box>
          ))}
        </Box>
      </Box>
    )
  })
}

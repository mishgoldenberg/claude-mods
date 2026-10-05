import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { QuickButton } from '../types'

// ── claude-mods kit v1 (docs/design.md): identical in every mod ──
const TONE = { accent: 'claude', ok: 'success', warn: 'warning', bad: 'error', dim: 'inactive' } as const
const GLYPH = { on: '●', off: '○', warn: '▲', ok: '✓', fail: '✗' } as const
// ── end kit ──

const buttons = atom({ plugin: 'quickbar', key: 'buttons' } as const, [])
const contextPercent = atom({ plugin: 'quickbar', key: 'contextPercent' } as const, null as number | null)
const isHidden = atom({ plugin: 'quickbar', key: 'isHidden' } as const, false)

/** The claude-mods panels, in bar order. Only the ones installed show up. */
const KNOWN: QuickButton[] = [
  { command: 'ctx', label: 'Context' },
  { command: 'meter', label: 'Usage' },
  { command: 'activity', label: 'Activity' },
  { command: 'changes', label: 'Changes' },
  { command: 'guard', label: 'Guard' },
  { command: 'tools', label: 'Tools' },
  { command: 'cmds', label: 'Commands' },
  { command: 'notifications', label: 'Inbox' },
  { command: 'mods', label: 'Mods' },
]

async function refreshButtons($: EngineInterface) {
  const names = new Set((await $.command.list()).map(c => c.name))
  await update($, buttons, () => KNOWN.filter(b => names.has(b.command)))
}

async function readContext($: EngineInterface) {
  const { context } = await $.session.usage()
  await update($, contextPercent, () => (context.percent === undefined ? null : Math.round(context.percent)))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'quickbar', description: 'Show or hide the claude-mods launcher above the prompt' })
    const hidden = await $.store.get('isHidden')
    await update($, isHidden, () => hidden === true)
    // other mods register their commands in their own session.start; look a moment later
    $.clock.after(1500, () => void refreshButtons($).then(() => readContext($)))

    return next(e)
  })

  on('command.run', { command: 'quickbar' }, async $ => {
    const hidden = await update($, isHidden, h => !h)
    await $.store.set('isHidden', hidden)
    await refreshButtons($)

    return { text: hidden ? 'Quickbar hidden (/quickbar to bring it back).' : 'Quickbar shown.' }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) await readContext($)

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)
    const list = await read($, buttons)
    const pct = await read($, contextPercent)
    if (list.length === 0 && pct === null) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const color = pct === null ? undefined : pct >= 85 ? TONE.bad : pct >= 70 ? TONE.warn : TONE.accent

    return (
      <Box gap={1} flexWrap="wrap">
        {pct !== null && (
          <Text color={color}>
            {pct >= 70 ? GLYPH.warn : GLYPH.on} ctx {pct}%
          </Text>
        )}
        {list.map(b => (
          <Button key={`qb-${b.command}`} plain dimColor label={b.label} onPress={() => void $.command.run({ command: b.command })} />
        ))}
        <Button key="qb-hide" plain dimColor role="dismiss" label="×" onPress={() => void update($, isHidden, () => true).then(() => $.store.set('isHidden', true))} />
      </Box>
    )
  })
}

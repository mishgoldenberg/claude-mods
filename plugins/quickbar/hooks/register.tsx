import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { QuickButton } from '../types'

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
]

async function refreshButtons($: EngineInterface) {
  const names = new Set((await $.command.list()).map(c => c.name))
  await update($, buttons, () => KNOWN.filter(b => names.has(b.command)))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'quickbar', description: 'Show or hide the claude-mods launcher above the prompt' })
    const hidden = await $.store.get('isHidden')
    await update($, isHidden, () => hidden === true)
    // other mods register their commands in their own session.start; look a moment later
    $.clock.after(1500, () => void refreshButtons($))

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
    if (e.agentId === undefined) {
      const { context } = await $.session.usage()
      await update($, contextPercent, () => (context.percent === undefined ? null : Math.round(context.percent)))
    }

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)
    const list = await read($, buttons)
    if (list.length === 0) return next(e)
    const pct = await read($, contextPercent)
    const { Box, Text, Button } = $.ui.resolve(e)
    const color = pct === null ? undefined : pct >= 85 ? 'red' : pct >= 70 ? 'yellow' : 'green'

    return (
      <Box gap={1} flexWrap="wrap">
        {pct !== null && <Text color={color}>ctx {pct}%</Text>}
        {list.map(b => (
          <Button key={`qb-${b.command}`} plain dimColor label={b.label} onPress={() => void $.command.run({ command: b.command })} />
        ))}
        <Button key="qb-hide" plain dimColor label="×" onPress={() => void update($, isHidden, () => true).then(() => $.store.set('isHidden', true))} />
      </Box>
    )
  })
}

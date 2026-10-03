import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { UsageSnapshot, UsageTurn, UsageWindow } from '../types'

const PANE = 'usage-meter'
const snapshot = atom({ plugin: 'usage-meter', key: 'snapshot' } as const, null)
const turns = atom({ plugin: 'usage-meter', key: 'turns' } as const, [])
const baseline = atom({ plugin: 'usage-meter', key: 'baseline' } as const, null)

const LABELS: Record<string, string> = { five_hour: '5-hour', seven_day: '7-day', spend_limit: 'Spend limit' }
const SPARK = '▁▂▃▄▅▆▇█'

const bar = (percent: number, width: number) => {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))

  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

const k = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)))

const spark = (values: number[]) => {
  const max = Math.max(1, ...values)

  return values.map(v => SPARK[Math.min(7, Math.floor((v / max) * 7.999))]).join('')
}

const until = (iso: string | undefined, now: number) => {
  if (iso === undefined) return ''
  const minutes = Math.max(0, Math.round((Date.parse(iso) - now) / 60000))

  return minutes >= 60 * 24 ? `resets in ${Math.round(minutes / 60 / 24)}d` : minutes >= 60 ? `resets in ${Math.floor(minutes / 60)}h${minutes % 60}m` : `resets in ${minutes}m`
}

async function refresh($: EngineInterface) {
  const usage = await $.session.usage()
  const now = await $.clock.now()
  const windows: UsageWindow[] = usage.rateLimits.map(w => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt }))
  const snap: UsageSnapshot = { windows, costUsd: usage.cost?.usd ?? null, startedAt: usage.startedAt, updatedAt: now }
  await update($, snapshot, () => snap)
  await update($, baseline, b => b ?? { at: now, windows })

  return snap
}

/** Percent-per-hour burn of a window since this session's first reading, and when it would hit 100. */
function burn(window: UsageWindow, base: { at: number; windows: UsageWindow[] } | null, now: number) {
  const start = base?.windows.find(w => w.kind === window.kind)
  if (start === undefined || base === null) return null
  const hours = (now - base.at) / 3_600_000
  const used = window.percentUsed - start.percentUsed
  if (hours < 0.05 || used <= 0) return null
  const perHour = used / hours
  const hoursLeft = (100 - window.percentUsed) / perHour

  return { perHour, hoursLeft }
}

export const register: Register = (on, options) => {
  const warnAt = Number(options.warnAt ?? 80)
  const warned = new Set<string>()

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'meter', description: 'Open the usage meter (rate limits, cost, tokens per turn)' })
    void refresh($)
    $.clock.every(60_000, () => void refresh($))

    return next(e)
  })

  on('command.run', { command: 'meter' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: 'Usage' })

    return { text: 'Usage meter opened.' }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const usage = e.usage
    if (usage !== undefined) {
      const turn: UsageTurn = {
        at: await $.clock.now(),
        durationMs: e.durationMs,
        input: usage.input_tokens,
        output: usage.output_tokens,
        cacheRead: usage.cache_read_input_tokens,
        cacheWrite: usage.cache_creation_input_tokens,
        model: usage.model,
      }
      await update($, turns, list => [...list, turn].slice(-60))
    }
    if (e.agentId !== undefined) return result

    const snap = await refresh($)
    for (const w of snap.windows) {
      for (const level of [warnAt, 95]) {
        const id = `${w.kind}:${level}`
        if (w.percentUsed >= level && !warned.has(id)) {
          warned.add(id)
          $.ui.toast(`${LABELS[w.kind] ?? w.kind} limit at ${Math.round(w.percentUsed)}% (${until(w.resetsAt, snap.updatedAt)})`, { timeoutMs: 10000 })
        }
      }
    }
    const five = snap.windows.find(w => w.kind === 'five_hour')
    const parts = [five ? `5h ${Math.round(five.percentUsed)}%` : '', snap.costUsd !== null ? `$${snap.costUsd.toFixed(2)}` : ''].filter(Boolean)
    $.ui.status(parts.length > 0 ? parts.join(' · ') : undefined)

    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const list = await read($, turns)
    const base = await read($, baseline)
    const width = Math.max(10, Math.min(30, (e.props.bodyColumns ?? 40) - 16))

    if (snap === null) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No reading yet.</Text>
          <Button key="refresh" label="Read usage" onPress={() => void refresh($)} />
        </Box>
      )
    }

    const now = snap.updatedAt
    const totals = list.reduce((s, t) => ({ input: s.input + t.input, output: s.output + t.output, cacheRead: s.cacheRead + t.cacheRead, cacheWrite: s.cacheWrite + t.cacheWrite }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    const prompted = totals.input + totals.cacheRead + totals.cacheWrite
    const cacheHit = prompted > 0 ? Math.round((totals.cacheRead / prompted) * 100) : null
    const minutes = Math.round((now - snap.startedAt) / 60000)
    const perTurn = list.map(t => t.input + t.output + t.cacheWrite)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>Plan limits</Text>
          {snap.windows.length === 0 && <Text dimColor>No rate-limit windows reported (API key or no plan limits).</Text>}
          {snap.windows.map(w => {
            const b = burn(w, base, now)
            const color = w.percentUsed >= 95 ? 'red' : w.percentUsed >= warnAt ? 'yellow' : 'green'

            return (
              <Box flexDirection="column">
                <Text>
                  {(LABELS[w.kind] ?? w.kind).padEnd(11)} <Text color={color}>{bar(w.percentUsed, width)}</Text> {Math.round(w.percentUsed)}%
                </Text>
                <Text dimColor>
                  {'            '}
                  {until(w.resetsAt, now)}
                  {b !== null && ` · +${b.perHour.toFixed(1)}%/h this session · full in ~${b.hoursLeft < 1 ? `${Math.round(b.hoursLeft * 60)}m` : `${b.hoursLeft.toFixed(1)}h`}`}
                </Text>
              </Box>
            )
          })}
        </Box>

        <Box flexDirection="column">
          <Text bold>This session</Text>
          <Text>
            {snap.costUsd !== null ? `$${snap.costUsd.toFixed(2)}` : 'cost n/a'} · {minutes}m · {list.length} turns
          </Text>
          <Text dimColor>
            in {k(totals.input)} · out {k(totals.output)} · cache read {k(totals.cacheRead)} · cache write {k(totals.cacheWrite)}
          </Text>
          {cacheHit !== null && (
            <Text color={cacheHit >= 70 ? 'green' : cacheHit >= 40 ? 'yellow' : 'red'}>
              Cache hit {cacheHit}%{cacheHit < 40 ? ' (low: long pauses or edits to early context break the cache)' : ''}
            </Text>
          )}
        </Box>

        {perTurn.length > 1 && (
          <Box flexDirection="column">
            <Text bold>Tokens per turn (new, uncached)</Text>
            <Text color="cyan">{spark(perTurn.slice(-Math.max(8, (e.props.bodyColumns ?? 40) - 4)))}</Text>
            <Text dimColor>
              last {k(perTurn.at(-1) ?? 0)} · avg {k(perTurn.reduce((a, b) => a + b, 0) / perTurn.length)} · max {k(Math.max(...perTurn))}
            </Text>
          </Box>
        )}

        <Box gap={1}>
          <Button key="refresh" hotkey="r" label="Refresh" onPress={() => void refresh($)} />
          <Button key="reset" label="Reset burn baseline" onPress={() => void update($, baseline, () => null).then(() => refresh($))} />
        </Box>
      </Box>
    )
  })
}

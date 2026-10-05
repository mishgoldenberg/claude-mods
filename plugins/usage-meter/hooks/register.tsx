import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register, RenderChildren } from 'claude-code'

import type { UsageSnapshot, UsageTurn, UsageWindow } from '../types'

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

/** Svg is drawn as an isolated image and can't read the theme: the accent's fixed value and a neutral track (docs/design.md). */
const SVG_ACCENT = 'rgb(215,119,87)'
const SVG_TRACK = 'rgb(127,127,127)'

/** A limit bar for the surfaces that draw Svg (desktop, VS Code, mobile). */
const svgBar = (percent: number) => {
  const w = 240
  const filled = Math.max(0, Math.min(w, Math.round((percent / 100) * w)))

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="10" viewBox="0 0 ${w} 10"><rect width="${w}" height="10" rx="3" fill="${SVG_TRACK}" fill-opacity="0.25"/><rect width="${filled}" height="10" rx="3" fill="${SVG_ACCENT}"/></svg>`
}

/** Tokens per turn as a small bar chart, for the surfaces that draw Svg. */
const svgSpark = (values: number[]) => {
  const max = Math.max(1, ...values)
  const step = 6
  const h = 32
  const bars = values.map((v, i) => {
    const bh = Math.max(1, Math.round((v / max) * h))

    return `<rect x="${i * step}" y="${h - bh}" width="${step - 2}" height="${bh}" rx="1" fill="${SVG_ACCENT}"/>`
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${values.length * step}" height="${h}" viewBox="0 0 ${values.length * step} ${h}">${bars.join('')}</svg>`
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
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Svg = 'Svg' in els ? els.Svg : undefined
    const kit = { Box, Text }
    const snap = await read($, snapshot)
    const list = await read($, turns)
    const base = await read($, baseline)
    const cols = e.props.bodyColumns ?? 40
    const width = Math.max(10, Math.min(30, cols - 20))

    if (snap === null) {
      return (
        <Box flexDirection="column" gap={1}>
          {header(kit, GLYPH.off, TONE.dim, 'usage-meter', 'no reading yet')}
          {empty(kit, 'Plan limits and cost update after every turn and once a minute. Read them now to see where you stand.')}
          <Box>
            <Button key="refresh" hotkey="r" variant="primary" label="Read usage" onPress={() => void refresh($)} />
          </Box>
        </Box>
      )
    }

    const now = snap.updatedAt
    const totals = list.reduce((s, t) => ({ input: s.input + t.input, output: s.output + t.output, cacheRead: s.cacheRead + t.cacheRead, cacheWrite: s.cacheWrite + t.cacheWrite }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    const prompted = totals.input + totals.cacheRead + totals.cacheWrite
    const cacheHit = prompted > 0 ? Math.round((totals.cacheRead / prompted) * 100) : null
    const minutes = Math.round((now - snap.startedAt) / 60000)
    const perTurn = list.map(t => t.input + t.output + t.cacheWrite)
    const toneOf = (pct: number) => (pct >= 95 ? TONE.bad : pct >= warnAt ? TONE.warn : undefined)
    const worst = Math.max(0, ...snap.windows.map(w => w.percentUsed))
    const five = snap.windows.find(w => w.kind === 'five_hour')
    const status = [five ? `5h ${Math.round(five.percentUsed)}%` : '', snap.costUsd !== null ? `$${snap.costUsd.toFixed(2)}` : '', `${list.length} turns`].filter(Boolean).join(' · ')
    const stat = (label: string, value: string, color?: string) => (
      <Box gap={1}>
        <Box flexGrow={1} flexShrink={1}>
          <Text dimColor wrap="truncate-end">
            {label}
          </Text>
        </Box>
        {num(kit, value, 9, color)}
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        {header(kit, worst >= warnAt ? GLYPH.warn : GLYPH.on, toneOf(worst) ?? TONE.accent, 'usage-meter', status)}

        {section(
          kit,
          'Plan limits',
          <Box flexDirection="column">
            {snap.windows.length === 0 && empty(kit, 'No rate-limit windows reported (API key, or a plan without limits).')}
            {snap.windows.map(w => {
              const b = burn(w, base, now)
              const pct = Math.round(w.percentUsed)

              return (
                <Box flexDirection="column">
                  <Box gap={1}>
                    <Box width={11} flexShrink={0}>
                      <Text wrap="truncate-end">{LABELS[w.kind] ?? w.kind}</Text>
                    </Box>
                    {Svg !== undefined ? (
                      <Box flexGrow={1} flexShrink={1}>
                        <Svg alt={`${LABELS[w.kind] ?? w.kind} ${pct}% used`} source={svgBar(w.percentUsed)} />
                      </Box>
                    ) : (
                      <Text color={TONE.accent}>{bar(w.percentUsed, width)}</Text>
                    )}
                    {num(kit, `${w.percentUsed >= warnAt ? `${GLYPH.warn} ` : ''}${pct}%`, 6, toneOf(w.percentUsed))}
                  </Box>
                  <Box paddingLeft={12}>
                    <Text dimColor wrap="truncate-end">
                      {until(w.resetsAt, now)}
                      {b !== null && ` · +${b.perHour.toFixed(1)}%/h this session · full in ~${b.hoursLeft < 1 ? `${Math.round(b.hoursLeft * 60)}m` : `${b.hoursLeft.toFixed(1)}h`}`}
                    </Text>
                  </Box>
                </Box>
              )
            })}
          </Box>,
        )}

        {section(
          kit,
          'This session',
          <Box flexDirection="column">
            {stat('Cost', snap.costUsd !== null ? `$${snap.costUsd.toFixed(2)}` : 'n/a')}
            {stat('Time', `${minutes}m`)}
            {stat('Turns', String(list.length))}
            {stat('Input', k(totals.input))}
            {stat('Output', k(totals.output))}
            {stat('Cache read', k(totals.cacheRead))}
            {stat('Cache write', k(totals.cacheWrite))}
            {cacheHit !== null && stat('Cache hit', `${cacheHit < 40 ? `${GLYPH.warn} ` : ''}${cacheHit}%`, cacheHit >= 70 ? TONE.ok : cacheHit >= 40 ? undefined : TONE.warn)}
            {cacheHit !== null && cacheHit < 40 && <Text dimColor>Low cache hit: long pauses or edits to early context break the cache.</Text>}
          </Box>,
        )}

        {section(
          kit,
          'Tokens per turn (new, uncached)',
          perTurn.length < 2 ? (
            empty(kit, 'The chart starts after two turns.')
          ) : (
            <Box flexDirection="column">
              {Svg !== undefined ? (
                <Svg alt={`Tokens per turn over the last ${Math.min(perTurn.length, 60)} turns`} source={svgSpark(perTurn.slice(-60))} />
              ) : (
                <Text color={TONE.accent}>{spark(perTurn.slice(-Math.max(8, cols - 4)))}</Text>
              )}
              {stat('Last', k(perTurn.at(-1) ?? 0))}
              {stat('Average', k(perTurn.reduce((a, b) => a + b, 0) / perTurn.length))}
              {stat('Max', k(Math.max(...perTurn)))}
            </Box>
          ),
        )}

        <Box gap={1}>
          <Button key="refresh" hotkey="r" variant="primary" label="Refresh" onPress={() => void refresh($)} />
          <Button key="reset" label="Reset burn baseline" onPress={() => void update($, baseline, () => null).then(() => refresh($))} />
        </Box>
      </Box>
    )
  })
}

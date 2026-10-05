# claude-mods design spec

Twelve mods, one product. Every pane, band and toast follows these rules so the set looks and feels the same in the terminal, the desktop app, VS Code and on mobile, in every theme (dark, light, colorblind, ANSI).

Plugins can't share code at runtime, so each mod carries its own copy of the **kit** below. The copies are identical: change one, change all twelve in the same PR.

## Color: theme keys only

Never use a raw color name (`cyan`, `green`, `red`…) or a hex value in a `Text`/`Box`. Use a theme key, so the user's theme picks the actual color. These are the keys we use (all exist in every Claude Code theme):

| Token | Theme key | Use for |
|---|---|---|
| `TONE.accent` | `claude` | The one accent (Claude orange): the header glyph of a live mod, the one number that matters most. Nothing else. |
| `TONE.ok` | `success` | Something finished or is healthy (✓). |
| `TONE.warn` | `warning` | Needs attention soon (▲). |
| `TONE.bad` | `error` | Failed, blocked, or about to hit a limit (✗). |
| `TONE.dim` | `inactive` | Off or idle glyphs (○). For dim text, prefer `dimColor`. |

Colorblind themes remap `success`/`error`, so **never let color carry meaning alone**: always pair it with a glyph or a word.

Primary buttons get the accent from the surface itself (`variant="primary"`); don't color buttons.

`Svg` (desktop, VS Code, mobile) is drawn as an isolated image and can't read the theme. Use the accent's fixed value `rgb(215,119,87)` for marks and `rgb(127,127,127)` at low opacity for tracks. Both read on light and dark backgrounds. Text values next to the chart carry the theme color.

## Glyphs

| Glyph | Means |
|---|---|
| `●` | on, live, running |
| `○` | off, idle, nothing yet |
| `▲` | warning, waiting for you |
| `✓` | ok, done |
| `✗` | failed, denied, blocked |

No other status glyphs (`◐ ✔ ✘ ⊘ ⏸ ◆ ☑ ☐ ↻ ★`).

## Pane layout

```
● activity  Running 2 tools · turn 0m14s       ← header: glyph · mod name · one-line live status
                                               ← gap={1} between sections
Now                                            ← dim section label
● Bash 3s  $ npm test
                                               
History  [a] incl. subagents  [c] clear        ← label row may carry its small controls
✓ Read     0s  design.md
```

- **Header** is the first row of every pane: `header(kit, glyph, tone, name, status)`. The name is the mod's name as installed (`usage-meter`, not "Usage"). The status is one line that changes with the data. It is never a static description.
- **Sections** are separated by `gap={1}` on the pane's column Box, and each starts with a dim label: `section(kit, label, rows, aside?)`.
- **Empty states** say what will show up and how to get it, not just "nothing": `empty(kit, 'No edits yet. Files Claude writes or edits this session show up here.')`.
- **Long lines** (paths, commands, descriptions, blurbs) use `wrap="truncate-end"` so a narrow docked pane never wraps into a mess. Paths where the end matters use `truncate-start`. Prose that *is* the content (a tip, an explanation of a command) may wrap; it never sits in a row beside other cells.
- **Numbers** in columns (counts, tokens, percentages, +/-) are right-aligned in a fixed-width cell: `num(kit, text, width, color?)`. Don't pad with spaces; the desktop font isn't monospaced.

## Buttons and hotkeys

- `variant="primary"` on the **one main action** of a pane (Summarize, Checkpoint, Save, Update). A segmented control (tabs, presets) may also use `primary` to mark the active choice, because Button has no "selected" state. Never two primaries for actions.
- `role="dismiss"` on a Button that closes its site (the quickbar's ×).
- Reserved hotkeys, the same in every mod: **`r` refresh** (or rescan), **`c` clear**. Digits `1`–`9` pick a tab or preset in order. Everything else keeps its mnemonic letter.
- `?` for help is not possible: `Button.hotkey` takes one digit or one lowercase letter only.

## Toasts

- A toast starts with a glyph from the table when it reports a state (`▲ Same command failed 3×…`, `✓ Done in 1m 4s`).
- No toast on a routine session start. The only start-up toast is mod-manager's first-run hello, shown once ever.

## The kit

Copy this block verbatim (it sits after the imports; `ElementTable` and `RenderChildren` are type imports from `claude-code`). A mod without a pane that still shows glyphs or colors (quickbar's band, loop-breaker's toast) keeps only the first three lines and the end marker. `npm test` (tests/design-kit.test.mjs) fails when a copy drifts.

```tsx
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
```

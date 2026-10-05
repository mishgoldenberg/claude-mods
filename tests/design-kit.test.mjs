// Checks the design spec (docs/design.md) holds in every mod: one identical kit, theme colors only.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const spec = readFileSync(join(root, 'docs/design.md'), 'utf8')
const kit = /```tsx\n([\s\S]*?)```/.exec(spec.slice(spec.indexOf('## The kit')))?.[1]?.trim()
if (!kit) throw new Error('docs/design.md: no kit block under "## The kit"')
const tokens = kit.split('\n').slice(0, 3).join('\n')

const RAW = /color[=:]\s*[{'"]*\s*['"](black|red|green|yellow|blue|magenta|cyan|white|gray|grey|#[0-9a-f]{3,8}|rgb\()/i
let failed = 0
let passed = 0
const check = (ok, what) => {
  if (ok) passed++
  else {
    failed++
    console.error(`FAIL ${what}`)
  }
}

for (const mod of readdirSync(join(root, 'plugins'))) {
  const src = readFileSync(join(root, 'plugins', mod, 'hooks/register.tsx'), 'utf8')
  const start = src.indexOf('// ── claude-mods kit')
  const end = src.indexOf('// ── end kit ──')
  const draws = src.includes("on('ui.render'")
  if (start === -1) {
    check(!draws && !/GLYPH\.|TONE\./.test(src), `${mod}: draws or uses tokens but has no kit block`)
    continue
  }
  const block = src.slice(start, end + '// ── end kit ──'.length).trim()
  const wanted = src.includes("on('ui.render', { component: 'Pane'") ? kit : `${tokens}\n// ── end kit ──`
  check(block === wanted, `${mod}: kit block differs from docs/design.md`)
  check(!RAW.test(src), `${mod}: raw color name in a color prop (use a TONE theme key)`)
  check(!/[◐✔✘⊘⏸◆☑☐↻★]/u.test(src), `${mod}: glyph outside the spec set (● ○ ▲ ✓ ✗)`)
}

console.log(`${passed}/${passed + failed} passed`)
if (failed > 0) process.exit(1)

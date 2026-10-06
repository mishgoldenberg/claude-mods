import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register, RenderChildren } from 'claude-code'

import type { GuardBlock, GuardConfig } from '../types'

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

const PANE = 'guardrails'
const STORE_KEY = 'config'
const config = atom({ plugin: 'guardrails', key: 'config' } as const, { enabled: [], custom: [] } as GuardConfig)
const blocks = atom({ plugin: 'guardrails', key: 'blocks' } as const, [])

const scripts = atom({ plugin: 'guardrails', key: 'scripts' } as const, {})
/** the 30-day block log: loaded from the store at session start, saved back on every block */
const weekLog = atom({ plugin: 'guardrails', key: 'log' } as const, [])
const LOG_KEY = 'log'
const DAY = 86_400_000

/** `raw`: the command is a script's own code, so quoted strings are not prose */
type Call = { tool: string; input: Record<string, unknown>; root: string; cwd: string; raw?: boolean }

type Rule = {
  id: string
  title: string
  explain: string
  /** returns the offending thing when the call breaks the rule */
  test: (call: Call) => string | undefined
}

const SHELLS = new Set(['Bash', 'PowerShell'])
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'NotebookEdit', 'Grep', 'Glob'])
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit'])

const cmd = (c: Call) => (SHELLS.has(c.tool) && typeof c.input.command === 'string' ? c.input.command : '')

/** The command hands quoted text or a heredoc to a shell that will run it as code. */
const RUNS_INLINE_SHELL = /(^|[;&|(]\s*)(bash|sh|zsh|dash|eval|source)\b|\b(powershell|pwsh)(\.exe)?\b.*\s-(c|Command|EncodedCommand)\b|\bcmd(\.exe)?\s+\/[ck]\b|\|\s*(bash|sh|zsh|iex|Invoke-Expression)\b/i

/**
 * The command as a shell would act on it: quoted prose (a commit message, a
 * `node -e "..."` string, text written to a file) and heredoc bodies are blanked,
 * so mentioning `rm -rf` is not running it. Short quoted tokens (".env",
 * "my dir") stay, and nothing is blanked when the text is fed to a shell as code.
 */
export function shellText(command: string) {
  if (RUNS_INLINE_SHELL.test(command)) return command
  let text = command.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(\n|$)/g, '<<HEREDOC\n')

  text = text.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, quoted => (/\s/.test(quoted) ? '""' : quoted))

  return text
}

const shellHit = (c: Call, re: RegExp) => {
  const m = re.exec(c.raw ? cmd(c) : shellText(cmd(c)))

  return m ? m[0].trim() : undefined
}
const pathOf = (c: Call) => {
  const p = c.input.file_path ?? c.input.notebook_path ?? c.input.path

  return typeof p === 'string' && p !== '' ? p : undefined
}

/** Lexical normalization: absolute, forward slashes, `..` collapsed, lower-cased on Windows drives. */
function normalize(p: string, cwd: string) {
  let full = p.replace(/\\/g, '/')
  if (!/^([a-zA-Z]:)?\//.test(full)) full = `${cwd.replace(/\\/g, '/')}/${full}`
  const out: string[] = []
  for (const part of full.split('/')) {
    if (part === '..') out.pop()
    else if (part !== '.' && part !== '') out.push(part)
  }
  const joined = (/^[a-zA-Z]:/.test(out[0] ?? '') ? '' : '/') + out.join('/')

  return /^[a-zA-Z]:/.test(joined) ? joined.toLowerCase() : joined
}

const outside = (c: Call, p: string) => {
  const root = normalize(c.root, c.root)
  const target = normalize(p, c.cwd)

  return target !== root && !target.startsWith(`${root}/`)
}

const SECRET = /(^|[\\/])(\.env(\.[\w.-]+)?|[\w.-]*\.pem|[\w.-]*\.key|id_(rsa|ed25519|ecdsa)|\.npmrc|\.pypirc|credentials(\.json)?|secrets?\.(json|ya?ml|toml))$/i
const READ_ONLY_SHELL = /^\s*(ls|dir|cat|type|head|tail|wc|pwd|echo|grep|rg|find|tree|which|where|stat|du|df|file|less|more|sort|uniq|diff|Get-ChildItem|Get-Content|Select-String|git\s+(status|log|diff|show|branch|blame|remote|rev-parse|ls-files))\b[^>|;&]*$/i

export const RULES: Rule[] = [
  {
    id: 'no-rm-rf',
    title: 'Block recursive force-delete',
    explain: 'rm -rf, rm -fr, Remove-Item -Recurse -Force, rmdir /s, del /s',
    test: c => shellHit(c, /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|-r\s+-f|-f\s+-r|--recursive\s+--force|--force\s+--recursive)\b.*|Remove-Item\b(?=.*-Recurse)(?=.*-Force).*|\brmdir\s+\/s\b.*|\bdel\s+\/s\b.*/i),
  },
  {
    id: 'no-mass-delete',
    title: 'Block mass deletes in clusters & infra',
    explain: 'kubectl/oc delete --all or -A, delete namespace/project, helm uninstall, terraform destroy',
    test: c =>
      shellHit(
        c,
        /\b(kubectl|oc)\b[^;&|]*\sdelete\b[^;&|]*(\s--all\b|\s-A\b|\s--all-namespaces\b)[^;&|]*|\b(kubectl|oc)\b[^;&|]*\sdelete\s+(ns|namespaces?|projects?)\b[^;&|]*|\boc\s+delete-project\b.*|\bhelm\s+(uninstall|delete|del|un)\b[^;&|]*|\bterraform\s+(destroy\b|apply\b[^;&|]*\s-destroy\b)[^;&|]*|\bterragrunt\s+(destroy|run-all\s+destroy)\b[^;&|]*/i,
      ),
  },
  {
    id: 'no-force-push',
    title: 'Block force-push',
    explain: 'git push --force / -f (--force-with-lease still allowed)',
    test: c => shellHit(c, /\bgit\s+push\b(?=.*(\s--force(?!-with-lease)\b|\s-f\b|\s\+\w)).*/),
  },
  {
    id: 'no-history-rewrite',
    title: 'Block destructive git',
    explain: 'git reset --hard, git clean -f, git checkout -- ., git restore ., git branch -D, git stash drop/clear, git fetch/pull --prune, git remote prune',
    test: c => shellHit(c, /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f[a-zA-Z]*|checkout\s+--\s+\.|restore\s+\.|branch\s+-D|stash\s+(drop|clear)|(fetch|pull)\b[^;&|]*\s(--prune|-p)|remote\s+prune)\b.*/),
  },
  {
    id: 'protect-secrets',
    title: 'Protect secrets',
    explain: 'no reading/writing .env*, *.pem, *.key, id_rsa, credentials files',
    test: c => {
      const p = pathOf(c)
      if (p !== undefined && FILE_TOOLS.has(c.tool) && SECRET.test(p)) return p

      return shellHit(c, /\b(cat|type|less|more|head|tail|Get-Content|cp|scp|curl\b.*-d\s*@)\s+[^|;&]*(\.env\b[\w.]*|\.pem\b|id_rsa\b|credentials\b)/i)
    },
  },
  {
    id: 'no-sudo',
    title: 'No sudo / admin',
    explain: 'sudo, su -, runas, Start-Process -Verb RunAs',
    test: c => shellHit(c, /(^|[;&|]\s*)(sudo|su\s+-|runas)\b.*|Start-Process\b.*-Verb\s+RunAs.*/i),
  },
  {
    id: 'no-installs',
    title: 'No package installs',
    explain: 'npm/pnpm/yarn/bun add|install, pip install, cargo install, brew/apt/winget/choco install',
    test: c => shellHit(c, /\b(npm\s+(i|install|add)|pnpm\s+(i|install|add)|yarn\s+add|bun\s+(add|install)|pip3?\s+install|uv\s+(add|pip\s+install)|cargo\s+(add|install)|go\s+install|brew\s+install|apt(-get)?\s+install|winget\s+install|choco\s+install|gem\s+install)\b.*/),
  },
  {
    id: 'no-network',
    title: 'No network',
    explain: 'WebFetch, WebSearch, curl, wget, Invoke-WebRequest',
    test: c => (c.tool === 'WebFetch' || c.tool === 'WebSearch' ? c.tool : shellHit(c, /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b.*/i)),
  },
  {
    id: 'jail-writes',
    title: 'Writes only inside project',
    explain: 'Write/Edit outside the project folder are blocked',
    test: c => {
      const p = pathOf(c)

      return p !== undefined && WRITE_TOOLS.has(c.tool) && outside(c, p) ? p : undefined
    },
  },
  {
    id: 'jail-all',
    title: 'Stay inside project (read + write)',
    explain: 'file tools may not touch anything outside the project folder; shell may not cd out of it',
    test: c => {
      const p = pathOf(c)
      if (p !== undefined && FILE_TOOLS.has(c.tool) && outside(c, p)) return p
      const cd = /(?:^|[;&|]\s*)(?:cd|Set-Location|pushd)\s+("[^"]+"|'[^']+'|\S+)/i.exec(cmd(c))?.[1]?.replace(/^["']|["']$/g, '')

      return cd !== undefined && !cd.startsWith('$') && cd !== '~' && outside(c, cd) ? `cd ${cd}` : undefined
    },
  },
  {
    id: 'read-only',
    title: 'Read-only mode',
    explain: 'no file edits; shell limited to look-only commands (ls, cat, grep, git status/log/diff…)',
    test: c => {
      if (WRITE_TOOLS.has(c.tool)) return `${c.tool} ${pathOf(c) ?? ''}`
      const command = cmd(c)
      if (command === '') return undefined

      return command.split(/&&|\|\||;/).every(part => READ_ONLY_SHELL.test(part)) ? undefined : command.slice(0, 80)
    },
  },
]

// ── always on: the agent may not rewrite guardrails' own settings ──
// They live in the plugin store, a JSON file under the Claude Code config dir (~/.claude).
const OWN_CONFIG = /[\\/]\.claude[\\/](?:[^\s"'`;&|<>]*[\\/])?[^\s"'`;&|<>\\/]*guardrails[^\s"'`;&|<>]*/i
/** the same settings, spelled the way a shell reaches the home folder */
const HOME = String.raw`(~|\$HOME|\$env:USERPROFILE|%USERPROFILE%|[a-zA-Z]:[\\/]Users[\\/][^\\/\s"']+|/home/[^/\s"']+|/Users/[^/\s"']+|/root)[\\/]\.claude[\\/][^\s"';&|<>]*guardrails`
const HOME_CONFIG = new RegExp(HOME, 'i')
const SHELL_WRITE = /\bsed\b[^;&|]*\s-i\b|\btee\b|\b(cp|mv|rm|del|Copy-Item|Move-Item|Remove-Item|Set-Content|Add-Content|Out-File)\b/i
const REDIRECT_TO_OWN = new RegExp(String.raw`(^|[^\d&])>>?\s*["']?` + HOME, 'i')
export const SELF_RULE = 'Protect guardrails settings'

/** The call would write to guardrails' own settings: returns what it touched. A repo's own .claude folder doesn't count. */
export function protectSelf(c: Call): string | undefined {
  const p = pathOf(c)
  if (p !== undefined && WRITE_TOOLS.has(c.tool) && OWN_CONFIG.test(`/${p.replace(/\\/g, '/')}`) && outside(c, p)) return p
  for (const part of cmd(c).split(/&&|\|\||[;\n]/)) {
    if (REDIRECT_TO_OWN.test(part) || (HOME_CONFIG.test(part) && SHELL_WRITE.test(part))) return part.trim()
  }

  return undefined
}

// ── scripts the agent wrote this session are checked before they run ──
const INTERPRETER = /^(bash|sh|zsh|dash|source|\.|python3?|py|node|bun|deno|ruby|perl|pwsh|powershell(\.exe)?)$/i
const SCRIPT_MAX = 200_000

/** Files a shell command executes: `bash x.sh`, `python tools/x.py`, `./run`, `node a.mjs` (normalized paths). */
export function scriptRuns(command: string, cwd: string): string[] {
  const out: string[] = []
  for (const seg of command.split(/&&|\|\||[;|\n]/)) {
    const words = seg.trim().split(/\s+/).map(w => w.replace(/^["']|["']$/g, ''))
    let i = 0
    while (i < words.length && /^\w+=/.test(words[i] ?? '')) i++
    const first = words[i]
    if (first === undefined || first === '') continue
    if (INTERPRETER.test(first)) {
      let j = i + 1
      while (j < words.length && (/^-/.test(words[j] ?? '') || words[j] === 'run')) j++
      const target = words[j]
      if (target !== undefined && target !== '' && !/^-/.test(target)) out.push(normalize(target, cwd))
    } else if (/[\\/]/.test(first)) out.push(normalize(first, cwd))
  }

  return out
}

/** A script's code checked against the enabled rules, as if each line were a shell command. */
export function scanScript(code: string, c: Pick<Call, 'root' | 'cwd'>, enabled: string[], custom: GuardConfig['custom'] = []) {
  const call: Call = { tool: 'Bash', input: { command: code.replace(/\r?\n/g, ' ; ') }, root: c.root, cwd: c.cwd, raw: true }
  for (const rule of RULES) {
    if (!enabled.includes(rule.id)) continue
    const what = rule.test(call)
    if (what !== undefined) return { rule: rule.title, what }
  }
  for (const p of custom) {
    try {
      const m = new RegExp(p.pattern, 'i').exec(cmd(call))
      if (m) return { rule: p.note || `custom /${p.pattern}/`, what: m[0] }
    } catch {
      // invalid regex: ignored
    }
  }

  return undefined
}

/** The file's content after an Edit, when we know what it was before. */
export function applyEdit(before: string, input: Record<string, unknown>) {
  const from = input.old_string, to = input.new_string
  if (typeof from !== 'string' || typeof to !== 'string' || from === '') return before

  return input.replace_all === true ? before.split(from).join(to) : before.replace(from, () => to)
}

/** Block counts for the last `days` days: total, per rule, per project, newest first. */
export function summarize(log: GuardBlock[], now: number, days = 7) {
  const recent = log.filter(b => now - b.at < days * DAY)
  const tally = (key: (b: GuardBlock) => string) =>
    [...recent.reduce((m, b) => m.set(key(b), (m.get(key(b)) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1])

  return { total: recent.length, byRule: tally(b => b.rule), byProject: tally(b => b.project ?? '?'), latest: recent.slice(0, 5) }
}

const PRESETS: { id: string; title: string; rules: string[] }[] = [
  { id: 'safe', title: 'Safe defaults', rules: ['no-rm-rf', 'no-mass-delete', 'no-force-push', 'no-history-rewrite', 'protect-secrets', 'no-sudo'] },
  { id: 'locked', title: 'Locked to project', rules: ['no-rm-rf', 'no-mass-delete', 'no-force-push', 'no-history-rewrite', 'protect-secrets', 'no-sudo', 'jail-all'] },
  { id: 'review', title: 'Read-only review', rules: ['no-mass-delete', 'protect-secrets', 'no-sudo', 'no-installs', 'read-only'] },
  { id: 'off', title: 'All off', rules: [] },
]

/**
 * A saved config from an older version: rules added since then switch on when
 * the person is on a preset that now includes them; hand-picked sets stay as they are.
 */
export function upgrade(cfg: GuardConfig): GuardConfig {
  const known = new Set(cfg.known ?? ['no-rm-rf', 'no-force-push', 'no-history-rewrite', 'protect-secrets', 'no-sudo', 'no-installs', 'no-network', 'jail-writes', 'jail-all', 'read-only'])
  const added = RULES.map(r => r.id).filter(id => !known.has(id))
  const mine = new Set(cfg.enabled)
  const preset = PRESETS.find(p => {
    const before = p.rules.filter(id => !added.includes(id))

    return before.length === mine.size && before.every(id => mine.has(id))
  })

  return { ...cfg, enabled: preset ? [...preset.rules] : cfg.enabled, known: RULES.map(r => r.id) }
}

async function logBlock($: EngineInterface, block: GuardBlock) {
  const log = await update($, weekLog, list => [block, ...list].filter(b => block.at - b.at < 30 * DAY).slice(0, 500))
  await $.store.set(LOG_KEY, log)
}

async function clearLog($: EngineInterface) {
  await update($, weekLog, () => [])
  await $.store.set(LOG_KEY, [])
}

async function save($: EngineInterface,change: (c: GuardConfig) => GuardConfig) {
  const next = await update($, config, change)
  await $.store.set(STORE_KEY, next)
  const count = next.enabled.length + next.custom.length
  $.ui.status(count > 0 ? `guard ${count} rules` : undefined)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'guard', description: 'Open guardrails: toggle safety rules and presets' })
    await $.command.register({ name: 'guard-preset', description: 'Apply a guardrail preset', argumentHint: 'safe | locked | review | off' })
    await $.command.register({ name: 'guard-log', description: 'What guardrails blocked in the last 7 days', argumentHint: '[json]' })
    const stored = (await $.store.get(STORE_KEY)) as GuardConfig | undefined
    await save($, () => (stored === undefined ? { enabled: PRESETS[0]?.rules ?? [], custom: [], known: RULES.map(r => r.id) } : upgrade(stored)))
    const savedLog = ((await $.store.get(LOG_KEY)) as GuardBlock[] | undefined) ?? []
    await update($, weekLog, () => savedLog)

    return next(e)
  })

  on('command.run', { command: 'guard' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Guardrails' })

    return { text: 'Guardrails panel opened.' }
  })

  on('command.run', { command: 'guard-preset' }, async ($, e) => {
    const preset = PRESETS.find(p => p.id === e.args.trim())
    if (preset === undefined) return { text: `Unknown preset. Use one of: ${PRESETS.map(p => p.id).join(', ')}` }
    await save($, c => ({ ...c, enabled: preset.rules }))

    return { text: `Guardrails: ${preset.title} (${preset.rules.length} rules).` }
  })

  on('command.run', { command: 'guard-log' }, async ($, e) => {
    const log = await read($, weekLog)
    const now = await $.clock.now()
    if (e.args.trim() === 'json') return { text: JSON.stringify(log.filter(b => now - b.at < 7 * DAY), null, 2) }
    const s = summarize(log, now)
    if (s.total === 0) return { text: 'Guardrails blocked nothing in the last 7 days.' }

    return {
      text: [
        `Guardrails blocked ${s.total} call${s.total === 1 ? '' : 's'} in the last 7 days.`,
        `By rule: ${s.byRule.map(([r, n]) => `${r} (${n})`).join(', ')}`,
        `By project: ${s.byProject.map(([p, n]) => `${p} (${n})`).join(', ')}`,
        'Latest:',
        ...s.latest.map(b => `  ${new Date(b.at).toISOString().slice(0, 16).replace('T', ' ')}  ${b.project ?? ''}  ${b.rule}: ${b.what}`),
        'Stored only on this machine. /guard-log json for the raw list; clear it in /guard.',
      ].join('\n'),
    }
  })

  on('tool.call', async ($, e, next) => {
    const { tool, tool_use_id: _id, agentId: _agent, ...input } = e as unknown as { tool: string; tool_use_id: string; agentId?: string } & Record<string, unknown>
    const cfg = await read($, config)
    if (cfg.enabled.length === 0 && cfg.custom.length === 0) return next(e)

    const call: Call = { tool, input, root: await $.session.root(), cwd: await $.session.cwd() }
    let broken: { rule: string; what: string } | undefined

    const own = protectSelf(call)
    if (own !== undefined) broken = { rule: SELF_RULE, what: own }

    for (const rule of broken === undefined ? RULES : []) {
      if (!cfg.enabled.includes(rule.id)) continue
      const what = rule.test(call)
      if (what !== undefined) {
        broken = { rule: rule.title, what }
        break
      }
    }
    if (broken === undefined && SHELLS.has(tool)) {
      for (const custom of cfg.custom) {
        try {
          const m = new RegExp(custom.pattern, 'i').exec(cmd(call))
          if (m) {
            broken = { rule: custom.note || `custom /${custom.pattern}/`, what: m[0] }
            break
          }
        } catch {
          // invalid regex: ignored
        }
      }
    }
    if (broken === undefined && SHELLS.has(tool)) {
      const known = await read($, scripts)
      for (const file of scriptRuns(cmd(call), call.cwd)) {
        const code = known[file]
        const hit = code === undefined ? undefined : scanScript(code, call, cfg.enabled, cfg.custom)
        if (hit !== undefined) {
          broken = { rule: hit.rule, what: `${hit.what} (inside ${file.split('/').pop()}, written this session)` }
          break
        }
      }
    }
    if (broken === undefined) {
      // remember what the agent writes, so running it later can be checked
      const p = pathOf(call)
      if (p !== undefined && (tool === 'Write' || tool === 'Edit')) {
        const file = normalize(p, call.cwd)
        await update($, scripts, known => {
          const code = tool === 'Write' ? (typeof input.content === 'string' ? input.content : undefined) : known[file] === undefined ? undefined : applyEdit(known[file], input)
          if (code === undefined || code.length > SCRIPT_MAX) return known
          const rest = Object.entries(known).filter(([k]) => k !== file).slice(-29)

          return Object.fromEntries([...rest, [file, code]])
        })
      }

      return next(e)
    }

    const block: GuardBlock = { at: await $.clock.now(), rule: broken.rule, tool, what: broken.what.slice(0, 200), project: call.root.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '' }
    await update($, blocks, list => [block, ...list].slice(0, 50))
    await logBlock($, block)
    $.ui.toast(`Blocked ${tool}: ${broken.rule}`)

    return {
      deny: `Blocked by the user's guardrails (rule: "${broken.rule}", matched: ${broken.what.slice(0, 120)}). Do not try to work around this rule with a different command; ask the user if you believe this action is needed.`,
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Input = 'Input' in els ? els.Input : undefined
    const cfg = await read($, config)
    const recent = await read($, blocks)
    const week = summarize(await read($, weekLog), await $.clock.now())

    const kit = { Box, Text }
    const isActive = (p: (typeof PRESETS)[number]) => p.rules.length === cfg.enabled.length && p.rules.every(r => cfg.enabled.includes(r))
    const active = PRESETS.find(isActive)
    const count = cfg.enabled.length + cfg.custom.length
    const status =
      count === 0
        ? 'all rules off'
        : `${active?.title ?? 'custom set'} · ${count} rule${count === 1 ? '' : 's'} on${recent.length > 0 ? ` · ${recent.length} blocked` : ''}`

    return (
      <Box flexDirection="column" gap={1}>
        {header(kit, count > 0 ? GLYPH.on : GLYPH.off, count > 0 ? TONE.accent : TONE.dim, 'guardrails', status)}

        {section(
          kit,
          'Presets',
          <Box gap={1} flexWrap="wrap">
            {PRESETS.map((p, i) => (
              <Button key={`preset-${p.id}`} hotkey={String(i + 1)} variant={isActive(p) ? 'primary' : 'secondary'} label={p.title} onPress={() => void save($, c => ({ ...c, enabled: p.rules }))} />
            ))}
          </Box>,
        )}

        {section(
          kit,
          'Rules',
          RULES.map(rule => {
            const isOn = cfg.enabled.includes(rule.id)

            return (
              <Box flexDirection="column">
                <Box gap={1}>
                  <Text color={isOn ? TONE.accent : TONE.dim}>{isOn ? GLYPH.on : GLYPH.off}</Text>
                  <Button
                    key={`rule-${rule.id}`}
                    plain
                    label={rule.title}
                    onPress={() => void save($, c => ({ ...c, enabled: isOn ? c.enabled.filter(id => id !== rule.id) : [...c.enabled, rule.id] }))}
                  />
                </Box>
                <Box paddingLeft={2}>
                  <Text dimColor wrap="truncate-end">
                    {rule.explain}
                  </Text>
                </Box>
              </Box>
            )
          }),
        )}

        {section(
          kit,
          'Your own block patterns (regex on shell commands)',
          <Box flexDirection="column">
            {cfg.custom.length === 0 && empty(kit, String.raw`None yet. Example: terraform\s+destroy  or  kubectl\s+delete`)}
            {cfg.custom.map((c, i) => (
              <Box gap={1}>
                <Text color={TONE.accent}>{GLYPH.on}</Text>
                <Text wrap="truncate-end">/{c.pattern}/</Text>
                <Button key={`del-${i}`} plain label="remove" onPress={() => void save($, cur => ({ ...cur, custom: cur.custom.filter((_, j) => j !== i) }))} />
              </Box>
            ))}
            {Input !== undefined && (
              <Input
                key="add"
                placeholder="regex, e.g. docker\s+system\s+prune"
                submitLabel="Add"
                onSubmit={(value: string) => {
                  const pattern = value.trim()
                  if (pattern === '') return
                  try {
                    new RegExp(pattern)
                  } catch {
                    $.ui.toast('That is not a valid regular expression.')
                    return
                  }
                  void save($, c => ({ ...c, custom: [...c.custom, { pattern, note: '' }] }))
                }}
              />
            )}
          </Box>,
        )}

        {section(
          kit,
          `Blocked this session (${recent.length})`,
          <Box flexDirection="column">
            {recent.length === 0 && empty(kit, 'Nothing blocked yet. When a rule stops a command, it shows up here with the rule that caught it.')}
            {recent.slice(0, 6).map(b => (
              <Text wrap="truncate-end">
                <Text color={TONE.bad}>{GLYPH.fail}</Text> {b.tool} <Text dimColor>{b.rule}: {b.what}</Text>
              </Text>
            ))}
          </Box>,
        )}

        {section(
          kit,
          `Last 7 days (${week.total})`,
          <Box flexDirection="column">
            {week.total === 0 && empty(kit, 'Nothing blocked this week. Blocks from every session and project add up here; /guard-log prints a summary.')}
            {week.byRule.slice(0, 5).map(([rule, n]) => (
              <Box gap={1}>
                {num(kit, String(n), 4, TONE.bad)}
                <Text wrap="truncate-end">{rule}</Text>
              </Box>
            ))}
          </Box>,
          week.total > 0 ? <Button key="clear-log" plain label="clear" onPress={() => void clearLog($)} /> : undefined,
        )}
        <Text dimColor>Rules are best-effort pattern checks, a seatbelt, not a sandbox. Scripts the agent writes are checked before they run, and the agent can't edit these settings. Everything stays on this machine.</Text>
      </Box>
    )
  })
}

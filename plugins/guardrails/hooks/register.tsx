import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { GuardBlock, GuardConfig } from '../types'

const PANE = 'guardrails'
const STORE_KEY = 'config'
const config = atom({ plugin: 'guardrails', key: 'config' } as const, { enabled: [], custom: [] } as GuardConfig)
const blocks = atom({ plugin: 'guardrails', key: 'blocks' } as const, [])

type Call = { tool: string; input: Record<string, unknown>; root: string; cwd: string }

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
const shellHit = (c: Call, re: RegExp) => {
  const m = re.exec(cmd(c))

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
    id: 'no-force-push',
    title: 'Block force-push',
    explain: 'git push --force / -f (--force-with-lease still allowed)',
    test: c => shellHit(c, /\bgit\s+push\b(?=.*(\s--force(?!-with-lease)\b|\s-f\b|\s\+\w)).*/),
  },
  {
    id: 'no-history-rewrite',
    title: 'Block destructive git',
    explain: 'git reset --hard, git clean -f, git checkout -- ., git restore ., git branch -D, git stash drop/clear',
    test: c => shellHit(c, /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f[a-zA-Z]*|checkout\s+--\s+\.|restore\s+\.|branch\s+-D|stash\s+(drop|clear))\b.*/),
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

const PRESETS: { id: string; title: string; rules: string[] }[] = [
  { id: 'safe', title: 'Safe defaults', rules: ['no-rm-rf', 'no-force-push', 'no-history-rewrite', 'protect-secrets', 'no-sudo'] },
  { id: 'locked', title: 'Locked to project', rules: ['no-rm-rf', 'no-force-push', 'no-history-rewrite', 'protect-secrets', 'no-sudo', 'jail-all'] },
  { id: 'review', title: 'Read-only review', rules: ['protect-secrets', 'no-sudo', 'no-installs', 'read-only'] },
  { id: 'off', title: 'All off', rules: [] },
]

async function save($: EngineInterface, change: (c: GuardConfig) => GuardConfig) {
  const next = await update($, config, change)
  await $.store.set(STORE_KEY, next)
  const count = next.enabled.length + next.custom.length
  $.ui.status(count > 0 ? `guard ${count} rules` : undefined)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'guard', description: 'Open guardrails: toggle safety rules and presets' })
    await $.command.register({ name: 'guard-preset', description: 'Apply a guardrail preset', argumentHint: 'safe | locked | review | off' })
    const stored = (await $.store.get(STORE_KEY)) as GuardConfig | undefined
    await save($, () => stored ?? { enabled: PRESETS[0]?.rules ?? [], custom: [] })

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

  on('tool.call', async ($, e, next) => {
    const { tool, tool_use_id: _id, agentId: _agent, ...input } = e as unknown as { tool: string; tool_use_id: string; agentId?: string } & Record<string, unknown>
    const cfg = await read($, config)
    if (cfg.enabled.length === 0 && cfg.custom.length === 0) return next(e)

    const call: Call = { tool, input, root: await $.session.root(), cwd: await $.session.cwd() }
    let broken: { rule: string; what: string } | undefined

    for (const rule of RULES) {
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
    if (broken === undefined) return next(e)

    const block: GuardBlock = { at: await $.clock.now(), rule: broken.rule, tool, what: broken.what }
    await update($, blocks, list => [block, ...list].slice(0, 50))
    $.ui.toast(`🛡 Blocked ${tool}: ${broken.rule}`)

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

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>Presets</Text>
          <Box gap={1} flexWrap="wrap">
            {PRESETS.map((p, i) => {
              const active = p.rules.length === cfg.enabled.length && p.rules.every(r => cfg.enabled.includes(r))

              return <Button key={`preset-${p.id}`} hotkey={String(i + 1)} variant={active ? 'primary' : 'secondary'} label={p.title} onPress={() => void save($, c => ({ ...c, enabled: p.rules }))} />
            })}
          </Box>
        </Box>

        <Box flexDirection="column">
          <Text bold>Rules</Text>
          {RULES.map(rule => {
            const isOn = cfg.enabled.includes(rule.id)

            return (
              <Box flexDirection="column">
                <Button
                  key={`rule-${rule.id}`}
                  plain
                  label={`${isOn ? '[x]' : '[ ]'} ${rule.title}`}
                  onPress={() => void save($, c => ({ ...c, enabled: isOn ? c.enabled.filter(id => id !== rule.id) : [...c.enabled, rule.id] }))}
                />
                <Text dimColor>      {rule.explain}</Text>
              </Box>
            )
          })}
        </Box>

        <Box flexDirection="column">
          <Text bold>Your own block patterns (regex on shell commands)</Text>
          {cfg.custom.length === 0 && <Text dimColor>None. Example: terraform\s+destroy  or  kubectl\s+delete</Text>}
          {cfg.custom.map((c, i) => (
            <Box gap={1}>
              <Text>/{c.pattern}/</Text>
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
        </Box>

        <Box flexDirection="column">
          <Text bold>Blocked this session ({recent.length})</Text>
          {recent.length === 0 && <Text dimColor>Nothing blocked yet.</Text>}
          {recent.slice(0, 6).map(b => (
            <Text wrap="truncate-end">
              <Text color="red">⊘</Text> {b.tool} <Text dimColor>{b.rule}: {b.what}</Text>
            </Text>
          ))}
        </Box>
        <Text dimColor>Rules are best-effort pattern checks, a seatbelt, not a sandbox. Saved for all your sessions.</Text>
      </Box>
    )
  })
}

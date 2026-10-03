import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Suggestion, ToolRow } from '../types'

const PANE = 'toolbox'
const tools = atom({ plugin: 'toolbox', key: 'tools' } as const, [])
const counts = atom({ plugin: 'toolbox', key: 'counts' } as const, {} as Record<string, number>)
const suggestions = atom({ plugin: 'toolbox', key: 'suggestions' } as const, [])
const stack = atom({ plugin: 'toolbox', key: 'stack' } as const, [])
const filter = atom({ plugin: 'toolbox', key: 'filter' } as const, 'all')

/** Plain-language explanations of the built-in tools, for people new to Claude Code. */
const EXPLAIN: Record<string, string> = {
  Bash: 'Runs shell commands (builds, tests, git…)',
  PowerShell: 'Runs PowerShell commands on Windows',
  Read: 'Reads files, images, PDFs and notebooks',
  Write: 'Creates or overwrites a file',
  Edit: 'Makes exact find-and-replace edits in a file',
  NotebookEdit: 'Edits Jupyter notebook cells',
  Glob: 'Finds files by name pattern',
  Grep: 'Searches file contents (ripgrep)',
  WebFetch: 'Downloads and reads a web page',
  WebSearch: 'Searches the web',
  Agent: 'Starts a subagent for a side task (keeps main context clean)',
  Task: 'Starts a subagent for a side task (keeps main context clean)',
  TodoWrite: 'Keeps a visible todo plan for multi-step work',
  AskUserQuestion: 'Asks you a multiple-choice question',
  Skill: 'Loads a packaged skill (instructions for a kind of task)',
  ToolSearch: 'Loads the schemas of deferred tools on demand',
  EnterPlanMode: 'Switches to plan-first mode',
  ExitPlanMode: 'Presents a plan for your approval',
  Monitor: 'Watches a background process for a condition',
}

const firstSentence = (s: string) => {
  const line = s.split('\n').find(l => l.trim() !== '')?.trim() ?? ''
  const cut = line.split(/(?<=\.)\s/)[0] ?? line

  return cut.length > 90 ? `${cut.slice(0, 89)}…` : cut
}

async function loadTools($: EngineInterface) {
  const list = await $.tool.list()
  const rows: ToolRow[] = list.map(t => {
    const mcp = /^mcp__(.+?)__(.+)$/.exec(t.name)
    const server = mcp?.[1] ?? ''

    return {
      name: t.name,
      group: t.mcp || mcp ? `MCP: ${/^[0-9a-f-]{20,}$/.test(server) ? 'connector' : server}` : 'Built-in',
      short: EXPLAIN[t.name] ?? firstSentence(t.description),
      isMcp: t.mcp,
    }
  })
  await update($, tools, () => rows)
}

async function exists($: EngineInterface, root: string, rel: string) {
  return $.fs.exists(`${root}/${rel}`).catch(() => false)
}

/** Looks at the project folder and proposes tools, MCP servers and habits that fit it. */
async function scan($: EngineInterface) {
  const root = (await $.session.root()).replace(/\\/g, '/')
  const has = (rel: string) => exists($, root, rel)
  const found: string[] = []
  const out: Suggestion[] = []
  const toolNames = (await read($, tools)).map(t => t.name.toLowerCase()).join(' ')

  let deps: Record<string, unknown> = {}
  let scripts: Record<string, unknown> = {}
  if (await has('package.json')) {
    found.push('Node')
    try {
      const pkg = JSON.parse(await $.fs.read(`${root}/package.json`)) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown>; scripts?: Record<string, unknown> }
      deps = { ...pkg.dependencies, ...pkg.devDependencies }
      scripts = pkg.scripts ?? {}
    } catch {
      // unreadable package.json
    }
  }
  const dep = (name: string) => Object.keys(deps).some(d => d === name || d.startsWith(`${name}/`) || d.startsWith(`@${name}/`))

  if (dep('react') || dep('next') || dep('vue') || dep('svelte') || dep('vite') || dep('@angular/core')) found.push('Web UI')
  if (dep('typescript')) found.push('TypeScript')
  if ((await has('pyproject.toml')) || (await has('requirements.txt'))) found.push('Python')
  if (await has('Cargo.toml')) found.push('Rust')
  if (await has('go.mod')) found.push('Go')
  if ((await has('Dockerfile')) || (await has('docker-compose.yml')) || (await has('compose.yaml'))) found.push('Docker')
  if (dep('prisma') || dep('drizzle-orm') || dep('pg') || dep('mongoose') || (await has('prisma/schema.prisma'))) found.push('Database')
  if (await has('.github/workflows')) found.push('GitHub Actions')
  const isGit = await has('.git')
  if (isGit) found.push('git')

  if (!(await has('CLAUDE.md')) && !(await has('.claude/CLAUDE.md'))) {
    out.push({ id: 'init', title: 'Give Claude a project memory', why: 'No CLAUDE.md here. /init writes one with your build/test commands and conventions, so you stop repeating them.', action: { kind: 'command', value: 'init', label: 'Run /init' } })
  }
  if (found.includes('Web UI') && !/browser|playwright|puppeteer|chrome/.test(toolNames)) {
    out.push({ id: 'browser', title: 'Let Claude see your UI', why: 'Web frontend detected but no browser tool. A browser/Playwright MCP lets Claude click through the app and check its own changes.', action: { kind: 'fill', value: 'Help me set up a browser automation MCP server (e.g. Playwright) for this project so you can check UI changes yourself.', label: 'Ask Claude to set it up' } })
  }
  if (found.includes('Database') && !/postgres|sql|supabase|mongo|prisma|neon/.test(toolNames)) {
    out.push({ id: 'db', title: 'Database access for Claude', why: 'An ORM/DB driver is in this project. A read-only database MCP lets Claude check the real schema and data instead of guessing.', action: { kind: 'fill', value: 'Which database MCP server fits this project? Set up a read-only connection for local development.', label: 'Ask Claude' } })
  }
  if (isGit) {
    const gh = await $.process.run(['gh', '--version']).catch(() => undefined)
    if (gh === undefined || gh.exitCode !== 0) {
      out.push({ id: 'gh', title: 'Install the GitHub CLI', why: 'With `gh` Claude can open PRs, read issues and check CI from the terminal.' })
    }
  }
  const testScript = Object.keys(scripts).find(s => /^test/.test(s))
  if (testScript !== undefined || (await has('pytest.ini')) || (await has('Cargo.toml')) || (await has('go.mod'))) {
    out.push({ id: 'verify', title: 'Make Claude verify its work', why: 'Tests exist. Telling Claude how to verify (in CLAUDE.md) catches mistakes before you see them.', action: { kind: 'fill', value: `Add a "How to verify changes" section to CLAUDE.md with the exact test${testScript ? ` (npm run ${testScript})` : ''}, lint and type-check commands for this project.`, label: 'Add to CLAUDE.md' } })
  }
  if (!(await has('.claude/settings.json'))) {
    out.push({ id: 'perms', title: 'Fewer permission prompts', why: 'No project settings yet. Allow-listing safe read-only commands (git status, tests) saves a lot of clicking.', action: { kind: 'command', value: 'fewer-permission-prompts', label: 'Scan & suggest' } })
  }
  out.push({ id: 'ask', title: 'Ask Claude for a tailored tool review', why: 'Claude reads this project and the tool list above and tells you what is missing or unused.', action: { kind: 'submit', value: 'Look at this project (stack, scripts, CI) and at the tools, MCP servers and skills you currently have. Suggest the 3 most useful additions for this project and anything I have that is unused noise. Be concrete, no setup yet.', label: 'Ask now' } })

  await update($, stack, () => found)
  await update($, suggestions, () => out)
}

async function act($: EngineInterface, s: Suggestion) {
  const action = s.action
  if (action === undefined) return
  if (action.kind === 'command') {
    const available = (await $.command.list()).some(c => c.name === action.value)
    if (!available) {
      $.ui.toast(`/${action.value} is not available in this session.`)
      return
    }
    await $.command.run({ command: action.value })
  } else if (action.kind === 'fill') {
    await $.prompt.fill({ text: action.value })
  } else {
    await $.prompt.submit({ text: action.value })
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'tools', description: 'See every tool Claude can use, how often it used them, and suggestions for this project' })
    void loadTools($)

    return next(e)
  })

  on('command.run', { command: 'tools' }, async $ => {
    await loadTools($)
    void scan($)
    await $.ui.open({ id: PANE, title: 'Tools' })

    return { text: 'Tools panel opened.' }
  })

  on('tool.call', async ($, e, next) => {
    await update($, counts, c => ({ ...c, [e.tool]: (c[e.tool] ?? 0) + 1 }))

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const rows = await read($, tools)
    const used = await read($, counts)
    const tips = await read($, suggestions)
    const found = await read($, stack)
    const view = await read($, filter)

    const groups = new Map<string, ToolRow[]>()
    for (const row of rows) {
      if (view === 'used' && (used[row.name] ?? 0) === 0) continue
      if (view === 'mcp' && !row.isMcp) continue
      groups.set(row.group, [...(groups.get(row.group) ?? []), row])
    }
    const shortName = (n: string) => n.replace(/^mcp__.+?__/, '')

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>For this project{found.length > 0 ? ` (${found.join(', ')})` : ''}</Text>
          {tips.length === 0 && <Text dimColor>Scanning…</Text>}
          {tips.map(s => (
            <Box flexDirection="column">
              <Box gap={1}>
                <Text color="cyan">★ {s.title}</Text>
                {s.action !== undefined && <Button key={`act-${s.id}`} plain label={s.action.label} onPress={() => void act($, s)} />}
              </Box>
              <Text dimColor>  {s.why}</Text>
            </Box>
          ))}
        </Box>

        <Box flexDirection="column">
          <Box gap={1}>
            <Text bold>
              Tools ({rows.length}, {Object.keys(used).length} used)
            </Text>
            {(['all', 'used', 'mcp'] as const).map((v, i) => (
              <Button key={`f-${v}`} plain hotkey={String(i + 1)} label={view === v ? `[${v}]` : v} onPress={() => void update($, filter, () => v)} />
            ))}
          </Box>
          {[...groups.entries()].map(([group, list]) => (
            <Box flexDirection="column">
              <Text color="magenta">
                {group} ({list.length})
              </Text>
              {list.map(t => (
                <Text wrap="truncate-end">
                  {'  '}
                  {(used[t.name] ?? 0) > 0 ? <Text color="green">{String(used[t.name]).padStart(3)}×</Text> : <Text dimColor>{'   ·'}</Text>} {shortName(t.name)} <Text dimColor>{t.short}</Text>
                </Text>
              ))}
            </Box>
          ))}
        </Box>
        <Button key="rescan" hotkey="r" label="Rescan" onPress={() => void loadTools($).then(() => scan($))} />
      </Box>
    )
  })
}

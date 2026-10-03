import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CommandDraft, CommandRow } from '../types'

const PANE = 'command-hub'
const commands = atom({ plugin: 'command-hub', key: 'commands' } as const, [])
const query = atom({ plugin: 'command-hub', key: 'query' } as const, '')
const tab = atom({ plugin: 'command-hub', key: 'tab' } as const, 'essentials' as 'essentials' | 'all' | 'create')
const draft = atom({ plugin: 'command-hub', key: 'draft' } as const, { name: '', description: '', body: '', scope: 'project' } as CommandDraft)

/** The built-in commands people most often don't know about, and when to reach for them. Shown only if present. */
const ESSENTIALS: { name: string; when: string }[] = [
  { name: 'compact', when: 'Context getting full? Summarizes the chat to free space. Add text to say what to keep: /compact keep the API design' },
  { name: 'clear', when: 'Switching to an unrelated task: fresh context, same window. Cheaper and sharper than one endless chat.' },
  { name: 'context', when: 'See exactly what is eating your context window (files, MCP tools, messages).' },
  { name: 'rewind', when: 'Undo: roll code and/or conversation back to an earlier message (also Esc Esc).' },
  { name: 'resume', when: 'Reopen an earlier session with its full history.' },
  { name: 'btw', when: 'Ask a quick side question without derailing the main task.' },
  { name: 'init', when: 'New project? Generates CLAUDE.md so Claude knows your build/test commands and conventions.' },
  { name: 'memory', when: 'Edit the CLAUDE.md files loaded every session: put "always do X" rules here.' },
  { name: 'model', when: 'Switch model: bigger for hard design/debugging, smaller for quick edits.' },
  { name: 'effort', when: 'Trade speed for depth of thinking.' },
  { name: 'plan', when: 'Make Claude propose a plan before touching code.' },
  { name: 'permissions', when: 'Tired of approving the same command? Allow-list it (or deny things forever).' },
  { name: 'add-dir', when: 'Let Claude work in another folder too (e.g. a shared library repo).' },
  { name: 'agents', when: 'Create specialised subagents (reviewer, tester…) with their own prompts and tools.' },
  { name: 'mcp', when: 'Connect or debug MCP servers (databases, browsers, issue trackers…).' },
  { name: 'hooks', when: 'Run your own scripts automatically: format after edit, block commands, notify…' },
  { name: 'review', when: 'Have Claude review a pull request or your local changes.' },
  { name: 'code-review', when: 'Review the current diff for bugs at an effort level you choose.' },
  { name: 'security-review', when: 'Security pass over your pending changes.' },
  { name: 'export', when: 'Save the conversation to a file or the clipboard.' },
  { name: 'usage', when: 'Your plan limits and when they reset.' },
  { name: 'plugin', when: 'Browse and install plugins and mod collections like this one.' },
  { name: 'statusline', when: 'Customise the line under the prompt (branch, cost, context…).' },
  { name: 'doctor', when: 'Something broken? Diagnoses your install and settings.' },
]

/** Phrases in a prompt that mean a built-in command would do the job better. */
const HINTS: { re: RegExp; name: string; tip: string }[] = [
  { re: /\b(undo|revert|go back|roll ?back)\b/i, name: 'rewind', tip: '/rewind (or Esc Esc) restores code and chat to an earlier point.' },
  { re: /\b(remember|from now on|always (use|do)|every time)\b/i, name: 'memory', tip: 'For rules that should stick across sessions, put them in CLAUDE.md via /memory.' },
  { re: /\b(new task|unrelated|different (topic|thing)|start over)\b/i, name: 'clear', tip: 'Switching topics? /clear gives a fresh, cheaper context.' },
  { re: /\b(yesterday|last session|previous session|earlier session)\b/i, name: 'resume', tip: '/resume reopens an earlier session with its full history.' },
  { re: /\b(another|other|second) (folder|directory|repo)\b/i, name: 'add-dir', tip: '/add-dir gives Claude access to another folder.' },
  { re: /\b(stop asking|keeps asking|approve every)\b/i, name: 'permissions', tip: '/permissions lets you allow-list commands you trust.' },
  { re: /\bsecurity\b|\bvulnerab/i, name: 'security-review', tip: '/security-review runs a dedicated security pass on your changes.' },
  { re: /\breview (my|the|this) (pr|pull request|changes|diff|code)\b/i, name: 'review', tip: '/review is built for exactly this.' },
]

const NAME_OK = /^[a-z0-9][a-z0-9-]{0,40}$/

async function loadCommands($: EngineInterface) {
  const list = await $.command.list()
  await update($, commands, () => list.map(c => ({ name: c.name, description: c.description, source: c.plugin ? `plugin: ${c.plugin}` : c.source })))
}

async function saveDraft($: EngineInterface) {
  const d = await read($, draft)
  const name = d.name.trim().replace(/^\//, '')
  if (!NAME_OK.test(name)) {
    $.ui.toast('Name: lowercase letters, digits and dashes only.')
    return
  }
  if (d.body.trim() === '') {
    $.ui.toast('Write what the command should tell Claude to do.')
    return
  }
  if ((await read($, commands)).some(c => c.name === name)) {
    $.ui.toast(`/${name} already exists; pick another name.`)
    return
  }
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
  const dir = d.scope === 'user' ? `${home}/.claude/commands` : `${await $.session.root()}/.claude/commands`
  const path = `${dir}/${name}.md`.replace(/\\/g, '/')
  if (await $.fs.exists(path)) {
    $.ui.toast(`${path} exists already.`)
    return
  }
  const hasArgs = d.body.includes('$ARGUMENTS')
  const front = [`description: ${d.description.trim() || name}`, ...(hasArgs ? ['argument-hint: <details>'] : [])].join('\n')
  await $.fs.write(path, `---\n${front}\n---\n\n${d.body.trim()}\n`)
  await update($, draft, (): CommandDraft => ({ name: '', description: '', body: '', scope: d.scope }))
  $.ui.toast(`Saved /${name} → ${path}. It shows in the / menu (restart if it doesn't yet).`, { timeoutMs: 9000 })
}

async function open($: EngineInterface, view: 'essentials' | 'all' | 'create') {
  await loadCommands($)
  await update($, tab, () => view)
  await $.ui.open({ id: PANE, title: 'Commands' })
}

export const register: Register = on => {
  const tipped = new Set<string>()

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'cmds', description: 'Command hub: discover, search and create slash commands' })
    await $.command.register({ name: 'new-command', description: 'Create your own slash command (opens the form)' })
    void loadCommands($)

    return next(e)
  })

  on('command.run', { command: 'cmds' }, async $ => {
    await open($, 'essentials')

    return { text: 'Command hub opened.' }
  })

  on('command.run', { command: 'new-command' }, async $ => {
    await open($, 'create')

    return { text: 'Command creator opened.' }
  })

  on('prompt.submit', async ($, e, next) => {
    const available = new Set((await read($, commands)).map(c => c.name))
    for (const hint of HINTS) {
      if (!tipped.has(hint.name) && available.has(hint.name) && hint.re.test(e.text)) {
        tipped.add(hint.name)
        $.ui.toast(`Tip: ${hint.tip}`, { timeoutMs: 9000 })
        break
      }
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Input = 'Input' in els ? els.Input : undefined
    const Select = 'Select' in els ? els.Select : undefined
    const list = await read($, commands)
    const view = await read($, tab)
    const q = (await read($, query)).toLowerCase()
    const d = await read($, draft)
    const names = new Set(list.map(c => c.name))
    const use = (name: string) => () => void $.prompt.fill({ text: `/${name} ` })

    const tabs = (
      <Box gap={1}>
        {(['essentials', 'all', 'create'] as const).map((v, i) => (
          <Button key={`tab-${v}`} hotkey={String(i + 1)} variant={view === v ? 'primary' : 'secondary'} label={v === 'create' ? '+ create' : v} onPress={() => void update($, tab, () => v)} />
        ))}
      </Box>
    )

    if (view === 'essentials') {
      const shown = ESSENTIALS.filter(x => names.has(x.name))

      return (
        <Box flexDirection="column" gap={1}>
          {tabs}
          <Text dimColor>Built-ins worth knowing. Click a name to put it in the prompt box.</Text>
          {shown.map(x => (
            <Box flexDirection="column">
              <Button key={`use-${x.name}`} plain label={`/${x.name}`} onPress={use(x.name)} />
              <Text dimColor>   {x.when}</Text>
            </Box>
          ))}
        </Box>
      )
    }

    if (view === 'all') {
      const filtered = list.filter(c => q === '' || c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
      const bySource = new Map<string, CommandRow[]>()
      for (const c of filtered) bySource.set(c.source, [...(bySource.get(c.source) ?? []), c])

      return (
        <Box flexDirection="column" gap={1}>
          {tabs}
          {Input !== undefined && <Input key="search" placeholder="search commands…" value={q} onInput={(v: string) => void update($, query, () => v)} onSubmit={(v: string) => void update($, query, () => v)} />}
          <Text dimColor>
            {filtered.length} of {list.length} commands
          </Text>
          {[...bySource.entries()].map(([source, rows]) => (
            <Box flexDirection="column">
              <Text color="magenta">{source}</Text>
              {rows.map(c => (
                <Box gap={1}>
                  <Button key={`all-${c.name}`} plain label={`/${c.name}`} onPress={use(c.name)} />
                  <Text dimColor wrap="truncate-end">
                    {c.description}
                  </Text>
                </Box>
              ))}
            </Box>
          ))}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {tabs}
        <Text dimColor>A slash command is a saved prompt. Use $ARGUMENTS where text typed after the command should go.</Text>
        {Input === undefined ? (
          <Text>This surface has no text input; use /new-command in the terminal or desktop app.</Text>
        ) : (
          <Box flexDirection="column" gap={1}>
            <Input key="name" label="Name  /" placeholder="e.g. ship" value={d.name} onInput={(v: string) => void update($, draft, x => ({ ...x, name: v }))} onSubmit={(v: string) => void update($, draft, x => ({ ...x, name: v }))} />
            <Input key="desc" label="Shown in menu" placeholder="e.g. Run tests, then commit and push" value={d.description} onInput={(v: string) => void update($, draft, x => ({ ...x, description: v }))} onSubmit={(v: string) => void update($, draft, x => ({ ...x, description: v }))} />
            <Input
              key="body"
              label="Prompt"
              placeholder="e.g. Run the test suite. If green, commit with a good message and push. Focus: $ARGUMENTS"
              value={d.body}
              onInput={(v: string) => void update($, draft, x => ({ ...x, body: v }))}
              onSubmit={(v: string) => void update($, draft, x => ({ ...x, body: v }))}
            />
            {Select !== undefined && (
              <Select
                key="scope"
                label="Save for"
                value={d.scope}
                options={[
                  { value: 'project', label: 'This project (.claude/commands, shareable via git)' },
                  { value: 'user', label: 'Me, everywhere (~/.claude/commands)' },
                ]}
                onSelect={(v: string) => void update($, draft, (x): CommandDraft => ({ ...x, scope: v === 'user' ? 'user' : 'project' }))}
              />
            )}
            <Box gap={1}>
              <Button key="save" variant="primary" label="Save command" onPress={() => void saveDraft($)} />
              <Button
                key="help"
                label="Draft it with Claude"
                onPress={() => void $.prompt.fill({ text: `Help me write a Claude Code slash command (a markdown file in .claude/commands) that ${d.description || d.body || '…'}. Ask me anything you need, then create it.` })}
              />
            </Box>
          </Box>
        )}
      </Box>
    )
  })
}

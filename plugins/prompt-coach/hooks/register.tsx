import type { EngineInterface, Register } from 'claude-code'

const SYSTEM = `You review a developer's prompt to an AI coding agent (Claude Code) BEFORE it is sent.
Decide if a rewrite would clearly get a better result. Most prompts are fine: only flag real problems:
vague goal, missing success criteria, ambiguous target ("fix it", "make it better"), several unrelated asks jammed together,
missing constraints the agent will need (which file/area, what not to touch, how to verify).
Never change the user's intent, never add requirements they did not imply, keep their voice and language, keep it short.
Keep the KIND of message: a bug report stays a bug report (don't turn "X doesn't work" into a question like "which file handles X?"),
a request stays a request, a question stays a question. Never add a new ask, deliverable or question the user didn't make.
Keep their scoping words ("for now", "just", "only", "first") and any constraints or preferences they stated.
If the prompt is a reply in an ongoing conversation (yes/no, "go ahead", answering a question), it is fine.
If the agent's previous message gives the missing context, the prompt is fine as it is.
Answer ONLY with JSON: {"verdict":"fine"} or {"verdict":"improve","why":"<max 12 words>","rewrite":"<the improved prompt>"}`

type Verdict = { verdict: 'fine' } | { verdict: 'improve'; why: string; rewrite: string }

const SKIP = /^\s*([\/!#]|(y|yes|no|n|ok|okay|sure|go|go ahead|continue|proceed|thanks|thank you|do it|lgtm|nope|stop)\b[.!]?\s*$)/i

function parse(text: string): Verdict | undefined {
  const json = /\{[\s\S]*\}/.exec(text)?.[0]
  if (json === undefined) return undefined
  try {
    const v = JSON.parse(json) as Partial<{ verdict: string; why: string; rewrite: string }>
    if (v.verdict === 'improve' && typeof v.rewrite === 'string' && v.rewrite.trim() !== '') {
      return { verdict: 'improve', why: v.why ?? '', rewrite: v.rewrite.trim() }
    }

    return { verdict: 'fine' }
  } catch {
    return undefined
  }
}

async function review($: EngineInterface, prompt: string, model: string): Promise<Verdict | undefined> {
  const messages = await $.session.messages().catch(() => [])
  const lastReply = Array.isArray(messages) ? messages.filter(m => m.role === 'assistant').at(-1)?.text ?? '' : ''
  const project = (await $.session.root()).split(/[\\/]/).at(-1) ?? ''
  const stop = new AbortController()
  const timer = $.clock.after(15000, () => stop.abort())
  const result = await $.model.complete(
    {
      model,
      system: SYSTEM,
      maxTokens: 700,
      prompt: `Project folder: ${project}\nAgent's previous message (may be empty):\n"""${lastReply.slice(-1500)}"""\n\nUser's new prompt:\n"""${prompt}"""`,
    },
    { signal: stop.signal },
  )
  timer.cancel()

  return result.isAnswered ? parse(result.text) : undefined
}

export const register: Register = (on, options) => {
  const model = typeof options.model === 'string' && options.model !== '' ? options.model : 'claude-haiku-4-5-20251001'
  const minChars = Number(options.minChars ?? 8)
  let enabled = options.enabled !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'coach', description: 'Prompt coach on/off: suggests a better prompt before sending', argumentHint: '[on|off]' })
    const stored = await $.store.get('enabled')
    if (typeof stored === 'boolean') enabled = stored

    return next(e)
  })

  on('command.run', { command: 'coach' }, async ($, e) => {
    const arg = e.args.trim()
    enabled = arg === 'on' ? true : arg === 'off' ? false : !enabled
    await $.store.set('enabled', enabled)

    return { text: `Prompt coach ${enabled ? 'on' : 'off'}.` }
  })

  on('prompt.submit', async ($, e, next) => {
    // typed at the terminal, from the desktop app / SDK host, or from your phone via Remote Control
    const isPerson = e.origin.kind === 'composer' || e.origin.kind === 'sdk' || e.origin.kind === 'bridge'
    if (!enabled || !isPerson || SKIP.test(e.text) || e.text.trim().length < minChars || e.text.length > 4000) return next(e)

    $.ui.status('coach: reviewing prompt…')
    let verdict: Verdict | undefined
    try {
      verdict = await review($, e.text, model)
    } finally {
      $.ui.status(undefined)
    }
    if (verdict === undefined || verdict.verdict === 'fine') return next(e)

    const SEND_NEW = 'Send improved'
    const SEND_MINE = 'Send mine'
    const EDIT = 'Edit improved'
    let choice: string
    try {
      choice = await $.ui.ask(`Prompt coach: ${verdict.why}\n\n${verdict.rewrite}\n\nWhich should I send?`, {
        header: 'Coach',
        options: [SEND_NEW, SEND_MINE, EDIT],
      })
    } catch {
      return next(e) // dialog dismissed: send theirs untouched
    }

    if (choice === SEND_NEW) {
      // The chat keeps showing what you typed, so say plainly what was sent instead (not sent to the model).
      $.ui.log(`prompt-coach sent the improved version:\n${verdict.rewrite}`)

      return next({ ...e, text: verdict.rewrite })
    }
    if (choice === SEND_MINE) return next(e)
    if (choice === EDIT) {
      const rewrite = verdict.rewrite
      $.clock.after(150, () => void $.prompt.fill({ text: rewrite }))

      return { drop: 'Suggestion loaded into the prompt box. Edit it and press Enter.' }
    }

    // Free text typed under "Other": that is what they want to send.
    $.ui.log(`prompt-coach sent your edited version:\n${choice}`)

    return next({ ...e, text: choice })
  })
}

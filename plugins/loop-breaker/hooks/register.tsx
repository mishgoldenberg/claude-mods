import type { EngineInterface, Register } from 'claude-code'

// ── claude-mods kit v1 (docs/design.md): identical in every mod ──
const TONE = { accent: 'claude', ok: 'success', warn: 'warning', bad: 'error', dim: 'inactive' } as const
const GLYPH = { on: '●', off: '○', warn: '▲', ok: '✓', fail: '✗' } as const
// ── end kit ──

/**
 * Spots Claude going in circles (the same command failing again and again, or one
 * file edited over and over in a single turn) and tells both of you.
 */
let nudged = new Set<string>()

/** The meaningful lines of a snippet: trimmed, at least 12 characters, so braces and blank lines don't count as overlap. */
const lines = (text: string) => text.split('\n').map(l => l.trim()).filter(l => l.length >= 12)

const norm = (command: string) => command.replace(/\s+/g, ' ').trim().slice(0, 300)

/** Tells you (toast) and Claude (a note it reads on its next step), once per loop. */
async function nudge($: EngineInterface, id: string, toast: string, note: string, agentId?: string) {
  if (nudged.has(id)) return
  nudged.add(id)
  $.ui.toast(`${GLYPH.warn} ${toast}`, { timeoutMs: 9000 })
  await $.session
    .append({ message: { type: 'user', content: [{ type: 'text', text: `<loop-breaker>${note}</loop-breaker>` }] }, agentId })
    .catch(error => $.ui.log(`loop-breaker: could not add note: ${String(error)}`, { to: 'debug' }))
}

export const register: Register = (on, options) => {
  const failLimit = Number(options.failLimit ?? 3)
  const editLimit = Number(options.editLimit ?? 3)
  let failures = new Map<string, number>()
  let edits = new Map<string, number>()
  let written = new Map<string, Set<string>>()

  on('turn.start', ($, e, next) => {
    failures = new Map()
    edits = new Map()
    written = new Map()
    nudged = new Set()

    return next(e)
  })

  on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($, e, next) => {
    const ran = await next(e)
    const key = norm(e.command)
    if (ran.deny !== undefined) return ran

    if (ran.isError === true) {
      const n = (failures.get(key) ?? 0) + 1
      failures.set(key, n)
      if (n >= failLimit) {
        await nudge(
          $,
          `fail:${key}`,
          `Same command failed ${n}× in a row: ${key.slice(0, 50)}`,
          `The command \`${key.slice(0, 200)}\` has now failed ${n} times. Stop retrying it. Re-read the full error output, state the root cause in one sentence, and either try a genuinely different approach or ask the user.`,
          e.agentId,
        )
      }
    } else {
      failures.delete(key)
    }

    return ran
  })

  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const input = e as unknown as { file_path: string; old_string?: string; new_string?: string; content?: string }
    const path = input.file_path
    const seen = written.get(path)
    // Several edits to different parts of a file are a plan; editing code this turn already changed is churn.
    const isRework = seen !== undefined && (input.old_string === undefined || lines(input.old_string).some(l => seen.has(l)))
    const after = new Set([...(seen ?? []), ...lines(input.new_string ?? input.content ?? '')])
    written.set(path, after)
    if (!isRework) return ran

    const n = (edits.get(path) ?? 0) + 1
    edits.set(path, n)
    if (n >= editLimit) {
      const name = path.split(/[\\/]/).at(-1) ?? path
      await nudge(
        $,
        `edit:${path}`,
        `${name}: same code reworked ${n}× this turn`,
        `You have now rewritten code you already changed in ${path} ${n} times this turn. Pause: re-read the whole file as it is now, work out why the earlier attempts didn't hold, and make one deliberate change instead of more patches.`,
        e.agentId,
      )
    }

    return ran
  })
}

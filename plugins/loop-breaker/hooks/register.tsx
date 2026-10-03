import type { EngineInterface, Register } from 'claude-code'

/**
 * Spots Claude going in circles (the same command failing again and again, or one
 * file edited over and over in a single turn) and tells both of you.
 */
let nudged = new Set<string>()

const norm = (command: string) => command.replace(/\s+/g, ' ').trim().slice(0, 300)

/** Tells you (toast) and Claude (a note it reads on its next step), once per loop. */
async function nudge($: EngineInterface, id: string, toast: string, note: string, agentId?: string) {
  if (nudged.has(id)) return
  nudged.add(id)
  $.ui.toast(`↻ ${toast}`, { timeoutMs: 9000 })
  await $.session
    .append({ message: { type: 'user', content: [{ type: 'text', text: `<loop-breaker>${note}</loop-breaker>` }] }, agentId })
    .catch(error => $.ui.log(`loop-breaker: could not add note: ${String(error)}`, { to: 'debug' }))
}

export const register: Register = (on, options) => {
  const failLimit = Number(options.failLimit ?? 3)
  const editLimit = Number(options.editLimit ?? 6)
  let failures = new Map<string, number>()
  let edits = new Map<string, number>()

  on('turn.start', ($, e, next) => {
    failures = new Map()
    edits = new Map()
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
    const path = e.file_path
    const n = (edits.get(path) ?? 0) + 1
    edits.set(path, n)
    if (n >= editLimit) {
      const name = path.split(/[\\/]/).at(-1) ?? path
      await nudge(
        $,
        `edit:${path}`,
        `${name} edited ${n}× this turn`,
        `You have edited ${path} ${n} times in this turn. Pause: re-read the whole file as it is now, check whether the edits are fighting each other, and make one deliberate change instead of more small patches.`,
        e.agentId,
      )
    }

    return ran
  })
}

export type GuardConfig = {
  /** ids of built-in rules that are on */
  enabled: string[]
  /** your own patterns: Bash commands matching `pattern` (a regex) are blocked */
  custom: { pattern: string; note: string }[]
}

export type GuardBlock = { at: number; rule: string; tool: string; what: string }

declare module 'claude-code' {
  interface PluginState {
    guardrails: {
      config: GuardConfig
      blocks: GuardBlock[]
    }
  }
}

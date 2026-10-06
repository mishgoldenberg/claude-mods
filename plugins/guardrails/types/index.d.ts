export type GuardConfig = {
  /** ids of built-in rules that are on */
  enabled: string[]
  /** your own patterns: Bash commands matching `pattern` (a regex) are blocked */
  custom: { pattern: string; note: string }[]
  /** rule ids this config has seen, so rules added later can be switched on for preset users */
  known?: string[]
}

export type GuardBlock = { at: number; rule: string; tool: string; what: string; project?: string }

declare module 'claude-code' {
  interface PluginState {
    guardrails: {
      config: GuardConfig
      blocks: GuardBlock[]
      /** files the agent wrote this session (normalized path -> content), checked before they run */
      scripts: Record<string, string>
      /** blocks from the last 30 days, mirrored to the plugin store */
      log: GuardBlock[]
    }
  }
}

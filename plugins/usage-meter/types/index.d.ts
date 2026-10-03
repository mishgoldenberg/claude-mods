export type UsageTurn = {
  at: number
  durationMs: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  model: string
}

export type UsageWindow = { kind: string; percentUsed: number; resetsAt?: string }

export type UsageSnapshot = {
  windows: UsageWindow[]
  costUsd: number | null
  startedAt: number
  updatedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'usage-meter': {
      snapshot: UsageSnapshot | null
      turns: UsageTurn[]
      /** first reading of each window this session, to estimate burn rate */
      baseline: { at: number; windows: UsageWindow[] } | null
    }
  }
}

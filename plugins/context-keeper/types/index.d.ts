export type ContextSnapshot = {
  percent: number
  tokens: number
  window: number
  categories: { name: string; tokens: number }[]
  memoryFiles: { path: string; tokens: number }[]
  updatedAt: number
}

export type Checkpoint = { path: string; at: number; percent: number; kind: 'handoff' | 'archive' }

declare module 'claude-code' {
  interface PluginState {
    'context-keeper': {
      snapshot: ContextSnapshot | null
      checkpoints: Checkpoint[]
      busy: string | null
    }
  }
}

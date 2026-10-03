export type NotifyKind = 'turn' | 'agent' | 'task' | 'approval' | 'question' | 'error'

export type NotifyEntry = { at: number; kind: NotifyKind; title: string; body: string; isRead: boolean }

declare module 'claude-code' {
  interface PluginState {
    notify: {
      entries: NotifyEntry[]
      isMuted: boolean
    }
  }
}

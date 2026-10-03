export type CallStatus = 'running' | 'approval' | 'done' | 'failed' | 'denied'

export type ActivityCall = {
  id: string
  tool: string
  summary: string
  agentId?: string
  isBackground: boolean
  startedAt: number
  endedAt?: number
  status: CallStatus
}

export type Phase = { kind: 'idle' | 'thinking' | 'tools'; since: number; prompt: string }

export type Todo = { content: string; status: string; activeForm?: string }

declare module 'claude-code' {
  interface PluginState {
    activity: {
      calls: ActivityCall[]
      phase: Phase
      todos: Todo[]
      showAll: boolean
    }
  }
}

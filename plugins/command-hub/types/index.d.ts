export type CommandRow = { name: string; description: string; source: string }

export type CommandDraft = { name: string; description: string; body: string; scope: 'project' | 'user' }

declare module 'claude-code' {
  interface PluginState {
    'command-hub': {
      commands: CommandRow[]
      query: string
      tab: 'essentials' | 'all' | 'create'
      draft: CommandDraft
    }
  }
}

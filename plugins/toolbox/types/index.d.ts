export type ToolRow = { name: string; group: string; short: string; isMcp: boolean }

export type Suggestion = { id: string; title: string; why: string; action?: { kind: 'command' | 'fill' | 'submit'; value: string; label: string } }

declare module 'claude-code' {
  interface PluginState {
    toolbox: {
      tools: ToolRow[]
      counts: Record<string, number>
      suggestions: Suggestion[]
      stack: string[]
      filter: string
    }
  }
}

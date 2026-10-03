export type QuickButton = { command: string; label: string }

declare module 'claude-code' {
  interface PluginState {
    quickbar: {
      buttons: QuickButton[]
      contextPercent: number | null
      isHidden: boolean
    }
  }
}

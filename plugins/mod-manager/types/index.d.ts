export type ModStatus = 'on' | 'off' | 'available'

export type ModRow = {
  name: string
  blurb: string
  usesTokens: boolean
  status: ModStatus
  version?: string
  scope?: string
}

declare module 'claude-code' {
  interface PluginState {
    'mod-manager': {
      rows: ModRow[]
      busy: string | null
      message: string
      needsRestart: boolean
    }
  }
}

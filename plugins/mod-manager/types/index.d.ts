export type ModStatus = 'on' | 'off' | 'available'

export type ModRow = {
  name: string
  blurb: string
  usesTokens: boolean
  status: ModStatus
  version?: string
  /** A newer version in the marketplace, when there is one. */
  latest?: string
  scope?: string
  /** The folder a local or project install belongs to; the CLI is run from there. */
  projectPath?: string
}

declare module 'claude-code' {
  interface PluginState {
    'mod-manager': {
      rows: ModRow[]
      busy: string | null
      message: string
      needsRestart: boolean
      /** mod-manager's own install, shown only when it has an update. */
      self: ModRow | null
    }
  }
}

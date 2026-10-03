export type FileChange = { path: string; edits: number; created: boolean; lastAt: number; lastTool: string }

export type DiffStat = { path: string; added: number; removed: number }

declare module 'claude-code' {
  interface PluginState {
    changes: {
      files: FileChange[]
      diff: DiffStat[]
      isGit: boolean
    }
  }
}

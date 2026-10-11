export type CiRun = {
  /** Actions run id; 0 for a check outside GitHub Actions (no log through gh). */
  id: number
  name: string
  status: string
  conclusion: string
  url: string
}

export type CiPhase = 'warte' | 'laeuft' | 'gruen' | 'rot' | 'keine' | 'fehler'

/** The pull request being watched, when it is one. */
export type CiPr = {
  number: number
  url: string
  title: string
  /** After green: ready to merge, waiting for a review, conflicts … (empty while running). */
  merge: string
}

export type CiWatch = {
  sha: string
  branch: string
  cwd: string
  startedAt: number
  endedAt: number
  phase: CiPhase
  runs: CiRun[]
  /** On red: the first failed run or check and the end of its log. */
  failed: { id: number; name: string; url: string; log: string } | null
  message: string
  isDismissed: boolean
  pr: CiPr | null
}

declare module 'claude-code' {
  interface PluginState {
    'ci-watch': { watch: CiWatch | null }
  }
}

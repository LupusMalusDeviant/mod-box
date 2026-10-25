export type SignFile = { path: string; ok: boolean | null; message: string }

export type SignJob = {
  /** What was built (the detected command, shortened). */
  build: string
  cwd: string
  at: number
  files: SignFile[]
  phase: 'gefunden' | 'signiert' | 'teilweise' | 'fehler'
  isDismissed: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'sign-guard': { job: SignJob | null; busy: boolean }
  }
}

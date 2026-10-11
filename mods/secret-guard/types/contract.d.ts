/** A find the guard stopped (or warned about); the value itself is never kept, only its hash. */
export type BlockedFind = {
  at: number
  what: string
  where: string
  /** Path relative to the project, when the find belongs to a file. */
  path: string | null
  /** sha256 of the found value, when there is one (key patterns; not for secret files). */
  hash: string | null
  stopped: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'secret-guard': {
      blocked: BlockedFind[]
      project: string[]
      global: string[]
    }
  }
}

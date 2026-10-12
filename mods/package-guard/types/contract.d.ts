export type PackageInfo = {
  exists?: boolean
  created?: string | null
  versions?: number
  latest?: string | null
  repo?: string | null
  downloads?: number | null
  error?: string
}

export type PackageHold = {
  command: string
  packages: Array<{ eco: 'npm' | 'pypi' | 'crates'; name: string; runs: boolean; reasons: string[]; repo: string | null }>
  at: number
  isDismissed: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'package-guard': {
      hold: PackageHold | null
      allowed: string[]
    }
  }
}

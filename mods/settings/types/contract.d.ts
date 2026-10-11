export type Tab = 'mods' | 'profiles' | 'sources' | 'diag'

/** Result of one live check: ok, a problem, or not done yet. */
export type SourcePlugin = {
  name: string
  description: string
  /** true: a mod with function hooks; false: another kind of plugin; null: remote, checked on import. */
  isMod: boolean | null
  extras: string[]
  /** The box id when already imported. */
  imported: string | null
  /** integrate | native | blocked | unsupported, or null while the plugin is remote. */
  verdict: string | null
  reasons: string[]
  /** Its parts as short lines. */
  parts: string[]
  /** name@marketplace for a native install from a Claude marketplace. */
  nativeId: string | null
  /** Its local folder, when the source has it. */
  dir: string | null
}

/** A plugin installed as itself, as `box.mjs native list` reports it. */
export type NativePlugin = {
  id: string
  version: string
  enabled: boolean
  managed: boolean
  trusted: boolean
  group: string
  tokens: string
  hasUserConfig: boolean
  errors: string[]
  changedAt: string | null
  missing: boolean
}

/** One option of a native plugin. The value of a sensitive one is never read. */
export type NativeField = {
  key: string
  type: string
  title: string
  description: string
  sensitive: boolean
  required: boolean
  options: string[] | null
  default: unknown
  set: boolean
  value: unknown
}

export type NativeInfo = {
  components: Record<string, { count: number; names: string[] }> | null
  alwaysOn: string | null
  fields: NativeField[] | null
  error?: string
}

export type Source = {
  kind: 'claude' | 'link'
  name: string
  link: string
  dir: string | null
  error?: string
  plugins: SourcePlugin[]
}

export type ImportReport = {
  ok: boolean
  title: string
  id?: string
  error?: string
  notes: string[]
}

/** Result of the update check for one mod that comes from an original repo. */
export type UpdateInfo = {
  id: string
  status: 'current' | 'update' | 'error'
  from?: string
  to?: string
  files: string[]
  error?: string
}

/** Token usage of one mod's own model calls (see hooks/usage.ts). */
export type ModUsage = {
  calls: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  usd: number
  unpriced: number
}

/** A hook of the box that failed, as the trace of the outermost hook saw it. */
export type HookError = {
  at: number
  event: string
  /** skipped: failed before next; kept: failed after next; expired: ran out of time; rejected. */
  outcome: string
  /** What was thrown, when the hook threw (the message is only there for hooks of the box itself). */
  message?: string
  component?: string
  requestId?: string
  /** The switched-on mods that hook this event. */
  candidates: string[]
  count: number
}

export type EnvCheck = { id: string; ok: boolean | null; text: string }

declare module 'claude-code' {
  interface PluginState {
    settings: {
      tab: Tab
      links: string[]
      sources: Source[] | null
      loadedAt: number
      busy: string | null
      filter: string
      open: string[]
      report: ImportReport | null
      expanded: string[]
      natives: NativePlugin[] | null
      nativeInfo: Record<string, NativeInfo>
      fresh: string[]
      updates: UpdateInfo[] | null
      usage: Record<string, ModUsage>
      errors: HookError[]
      envChecks: EnvCheck[] | null
      validation: { ok: boolean; text: string; at: number } | null
      debugLines: string[] | null
      updatedAt: number
      diff: { id: string; from: string; to: string; text: string } | null
    }
  }
}

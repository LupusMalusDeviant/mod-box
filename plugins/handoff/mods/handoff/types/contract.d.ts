/** Model calls the mod made itself: counted per session, priced at list price. */
export type ModUsage = {
  calls: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  usd: number
  unpriced: number
}

export type Handoff = {
  /** Path of the found or written note. */
  path: string
  /** When it was written (ms). */
  at: number
  /** The first line with content, as a preview. */
  preview: string
  /** gefunden: found at start; geschrieben: written in this session. */
  kind: 'gefunden' | 'geschrieben'
  isDismissed: boolean
}

declare module 'claude-code' {
  interface PluginState {
    handoff: { usage: Record<string, ModUsage>; note: Handoff | null; text: string; busy: boolean }
  }
}

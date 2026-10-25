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

export type MeterInfo = {
  /** Time of the main loop's last request (ms), 0 = unknown/cold. */
  lastAt: number
  /** Share of the last turn served from the cache, in percent. */
  hit: number | null
  percent: number | null
  tokens: number | null
  window: number | null
  /** The subscription's rate-limit windows (5 hours, week), as the status line has them. */
  limits: Array<{ kind: string; percentUsed: number; resetsAt?: string }>
  /** Context fill after each of the last turns (percent, oldest first), for the trend line. */
  trend: number[]
}

declare module 'claude-code' {
  interface PluginState {
    'cache-meter': { usage: Record<string, ModUsage>; info: MeterInfo; tick: number }
  }
}

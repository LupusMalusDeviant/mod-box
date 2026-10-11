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
}

declare module 'claude-code' {
  interface PluginState {
    'cache-meter': { info: MeterInfo; tick: number }
  }
}

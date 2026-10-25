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

declare module 'claude-code' {
  interface PluginState {
    'pet': { usage: Record<string, ModUsage> }
  }
}

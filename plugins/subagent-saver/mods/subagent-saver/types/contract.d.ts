/** How many subagents were started on the cheaper model, and the last one. */
export type SaverStats = { routed: number; last: string }

declare module 'claude-code' {
  interface PluginState {
    'subagent-saver': { stats: SaverStats }
  }
}

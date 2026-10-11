export type HeadsUp = { turnId: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    'heads-up': { note: HeadsUp | null }
  }
}

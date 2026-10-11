/** Which columns the pane shows. */
/** The palette the pane draws in; plugins aren't told the app's theme. */
export type Theme = 'light' | 'dark'

export type ViewMode = 'after' | 'both' | 'before'

export type Side = 'before' | 'after'

/** One piece of a message, at most CHUNK_CHARS long, cut at a paragraph break where possible. */
export type Chunk = {
  /** Index of the message in its side's transcript. */
  m: number
  role: 'user' | 'assistant'
  /** This chunk's position within the message, and how many the message has. */
  i: number
  n: number
  text: string
}

export type ModelUsageSummary = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

/** What the index keeps for each compaction; the chunks themselves live in files beside it. */
export type CompactMeta = {
  id: string
  at: number
  durationMs: number
  trigger: 'manual' | 'auto' | 'plugin'
  /** Absent for the main conversation. */
  agentId?: string
  agentLabel?: string
  instructions?: string
  tokensBefore?: number
  tokensAfter?: number
  usage?: ModelUsageSummary
  messages: Record<Side, number>
  chunks: Record<Side, number>
}

declare module 'claude-code' {
  interface PluginState {
    'visible-compact': {
      index: CompactMeta[]
      /** The compaction shown; null follows the newest. */
      selected: string | null
      view: ViewMode
      pages: Record<Side, number>
      theme: Theme
    }
  }
}

// The band manager's mailbox. A band mod computes its display in its own AbovePrompt hook (with its
// own $; the validator does not let $ cross an import) and drops it here with offer(). The settings
// hook, registered first and so the outermost, runs after all of them, takes the parts and draws
// them ordered, compact or one line each, or sends them to the status line.
export type BandPart = {
  /** The mod's switch key, e.g. "cacheMeter". */
  id: string
  /** Wants attention (CI red, sign offer, heads-up …): always its own line with its buttons. */
  urgent: boolean
  /** One short element for the compact line. */
  short: unknown
  /** The full element for its own line. */
  line: unknown
  /** Buttons that belong to the part. */
  actions: unknown[]
  /** Plain text for the status line. */
  status: string
}

const parts = new Map<string, BandPart[]>()

function keyOf(e: { requestId?: string }): string {
  return e.requestId ?? 'band'
}

/** Called by the manager before the inner hooks run. */
export function openBand(e: { requestId?: string }) {
  parts.set(keyOf(e), [])
}

/** Called by a band mod with its display for this render. */
export function offer(e: { requestId?: string }, part: BandPart) {
  const list = parts.get(keyOf(e))
  if (list) list.push(part)
  else parts.set(keyOf(e), [part])
}

/** Called by the manager after the inner hooks ran. */
export function takeBand(e: { requestId?: string }): BandPart[] {
  const list = parts.get(keyOf(e)) ?? []
  parts.delete(keyOf(e))
  return list
}

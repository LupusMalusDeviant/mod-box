// Token usage of the mods that call a model themselves (Next Steps, Heads-up, Catch Me Up,
// Handoff Note, keep-warm in the Cache Meter). Pure data and arithmetic: each of those mods records
// its calls with its own $ (session in $.state "mb_usage", total in $.store "usage-total"),
// the window only reads. Costs are an estimate from list prices.

export type ModUsage = {
  calls: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** Estimated US dollars of the calls whose model had a price. */
  usd: number
  /** Calls whose model had no price in the table. */
  unpriced: number
}

export type UsageBook = Record<string, ModUsage>

export const USAGE_STORE = 'usage-total'

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

// $ per million tokens: [cache read, cache write (1 h), output]; base input is half the 1 h write.
// List prices as Cache Tax keeps them (September 2026). Longer family names first.
const PRICES: Array<[string, number, number, number]> = [
  ['fable-5-1', 0.25, 20, 50],
  ['fable-5', 1, 20, 50],
  ['opus-5', 0.5, 10, 25],
  ['opus-4', 0.5, 10, 25],
  ['opus', 0.5, 10, 25],
  ['sonnet-5', 0.2, 4, 10],
  ['sonnet', 0.3, 6, 15],
  ['haiku', 0.1, 2, 5],
]

export function priceOf(model: string): [number, number, number] | null {
  const m = model.toLowerCase().replace(/[\s.]+/g, '-')
  for (const [family, read, write, output] of PRICES) if (m.includes(family)) return [read, write, output]
  return null
}

export function costOf(model: string, u: Usage): number | null {
  const p = priceOf(model)
  if (!p) return null
  const [read, write, output] = p
  return ((u.cache_read_input_tokens ?? 0) * read + (u.cache_creation_input_tokens ?? 0) * write + u.input_tokens * (write / 2) + u.output_tokens * output) / 1e6
}

export function addUsage(book: UsageBook | null | undefined, id: string, model: string, u: Usage): UsageBook {
  const prev = book?.[id] ?? { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, unpriced: 0 }
  const usd = costOf(model, u)
  return {
    ...(book ?? {}),
    [id]: {
      calls: prev.calls + 1,
      input: prev.input + u.input_tokens,
      output: prev.output + u.output_tokens,
      cacheRead: prev.cacheRead + (u.cache_read_input_tokens ?? 0),
      cacheWrite: prev.cacheWrite + (u.cache_creation_input_tokens ?? 0),
      usd: prev.usd + (usd ?? 0),
      unpriced: prev.unpriced + (usd == null ? 1 : 0),
    },
  }
}

export function tokensOf(m: ModUsage): number {
  return m.input + m.output + m.cacheRead + m.cacheWrite
}

export function sumBook(book: UsageBook | null | undefined): ModUsage {
  const out = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, unpriced: 0 }
  for (const m of Object.values(book ?? {})) {
    out.calls += m.calls
    out.input += m.input
    out.output += m.output
    out.cacheRead += m.cacheRead
    out.cacheWrite += m.cacheWrite
    out.usd += m.usd
    out.unpriced += m.unpriced
  }
  return out
}

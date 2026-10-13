// Screen Mask: what to hide while the screen is shared, and how. No $ here.
import { PATTERNS, isPlaceholder } from '../../secret-guard/hooks/register'

export type MaskRules = {
  /** Words or names to hide wherever they appear (case-insensitive). */
  terms: string[]
  /** The person's login name, hidden in paths like C:\Users\<name> or /home/<name>. */
  user: string
  emails: boolean
  ips: boolean
}

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
// IPv4 outside the loopback and documentation ranges.
const IPV4 = /\b(?!127\.|0\.0\.0\.0\b|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The text with every secret, address and listed term replaced by a short label. */
export function maskText(text: string, rules: MaskRules): string {
  if (!text) return text
  let out = text
  for (const [what, re] of PATTERNS) {
    out = out.replace(new RegExp(re.source, re.flags), m => (isPlaceholder(m) ? m : `[${what}]`))
  }
  if (rules.emails) out = out.replace(EMAIL, '[e-mail]')
  if (rules.ips) out = out.replace(IPV4, '[ip]')
  if (rules.user.length >= 2) {
    const u = escape(rules.user)
    out = out.replace(new RegExp(`([\\\\/](?:Users|home)[\\\\/])${u}(?=[\\\\/]|\\b)`, 'gi'), '$1•••')
  }
  for (const term of rules.terms) {
    if (term.length < 2) continue
    out = out.replace(new RegExp(`(?<![\\w])${escape(term)}(?![\\w])`, 'gi'), '•••')
  }
  return out
}

/** Every string inside a value (tool inputs and outputs are objects), masked. */
export function maskDeep<T>(value: T, mask: (s: string) => string, depth = 0): T {
  if (depth > 12) return value
  if (typeof value === 'string') return mask(value) as T
  if (Array.isArray(value)) return value.map(v => maskDeep(v, mask, depth + 1)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = maskDeep(v, mask, depth + 1)
    return out as T
  }
  return value
}

/** The terms option: comma or newline separated. */
export const parseTerms = (raw: string) =>
  raw
    .split(/[,\n]/)
    .map(s => s.trim())
    .filter(s => s.length >= 2)

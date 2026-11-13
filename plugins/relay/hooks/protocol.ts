// The relay protocol: what a worker must end its answer with, and how the
// main agent reads it. Pure functions only, so they can be tested.

export type Artifact = { path: string; change: 'created' | 'modified' | 'deleted' | 'read' | 'refused'; note?: string }
export type Fact = { id: string; text: string }

export type Packet = {
  status: 'done' | 'partial' | 'blocked' | 'failed'
  summary: string
  decisions: string[]
  facts: Fact[]
  artifacts: Artifact[]
  open_questions: string[]
  needs_from_main: string[]
  risks: string[]
  next_suggested: string[]
  sections: string[]
  compressed_by?: 'worker' | 'fallback' | 'none'
  write_check?: WriteCheck
}

// The working tree as git sees it before and after a run (contract 0001, 4.4).
// `dirty` maps each path git status lists to the hash of its content; a path
// that is gone reads `deleted`, one git does not track yet (or only staged as
// added, copied or renamed) `new:<hash>`, one git could not hash `unhashed`.
export type Snapshot = {
  head: string
  dirty: Record<string, string>
  // where the project lies inside its repository (git rev-parse --show-prefix)
  prefix?: string
}

// A path git names from the repository's top, relative to the project: inside
// it without the prefix, outside it with one ../ per level.
export function toProjectPath(repoPath: string, prefix: string): string {
  const pre = prefix.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!pre) return repoPath
  if (repoPath.startsWith(pre)) return repoPath.slice(pre.length)
  return `${'../'.repeat(pre.split('/').filter(Boolean).length)}${repoPath}`
}

export type Change = 'created' | 'modified' | 'deleted'

export type WriteCheck = {
  checked: boolean
  reason?: string
  changed: { path: string; change: Change }[]
  outside: string[]
  unattributed: string[]
  byOtherRole: { path: string; role: string }[]
  // What the check could not compare (unhashable paths, a failed diff); the
  // packet names each, so a gap is never silent (contract 0001, Nachtrag 1).
  incomplete?: string[]
}

export const UNHASHED = 'unhashed'

const LIST_FIELDS = ['decisions', 'open_questions', 'needs_from_main', 'risks', 'next_suggested', 'sections'] as const

export const PACKET_SCHEMA = `{
  "status": "done | partial | blocked | failed",
  "summary": "max 3 sentences: what was achieved",
  "decisions": ["every decision you took that others must respect"],
  "facts": [{ "id": "F1", "text": "a finding the main agent needs: numbers, names, IDs, URLs verbatim" }],
  "artifacts": [{ "path": "relative/path", "change": "created | modified | deleted | read | refused (a write that was blocked)", "note": "what is in it, or why it was refused" }],
  "open_questions": ["things you could not resolve"],
  "needs_from_main": ["requests for decisions or work outside your ownership"],
  "risks": ["conflicts, assumptions, things that may break"],
  "next_suggested": ["sensible next tasks"],
  "sections": ["the exact headings of your answer above, so details can be fetched on demand"]
}`

export function protocolPrompt(role: string, brief: string, owns: readonly string[]): string {
  const ownership = owns.length
    ? `You may only create or modify files under: ${owns.join(', ')}. Anything outside goes into "needs_from_main".`
    : 'Ownership is not restricted, but list every file you touch under "artifacts".'
  return [
    `You are the "${role}" worker in a relay of Claude Code sessions, steered by a main agent.`,
    brief ? `Your role: ${brief}` : '',
    ownership,
    'The main agent will NOT read your full answer by default; it reads only your relay packet and fetches sections on demand.',
    'Write your full answer first, structured with markdown headings. Then end with exactly one fenced block tagged relay holding JSON of this shape:',
    '```relay',
    PACKET_SCHEMA,
    '```',
    'Packet rules: never drop a decision, a file change, a blocker, an error, or an exact identifier (numbers, names, paths, URLs, versions).',
    'Compress wording, not content. Leave out reasoning, narration and anything the main agent can fetch from your sections.',
    'Use empty lists rather than omitting fields. Write the packet in the language of the task.',
  ].filter(Boolean).join('\n')
}

export function fallbackPrompt(role: string): string {
  return [
    `Compress the following answer of the "${role}" worker into a relay packet.`,
    'Never drop a decision, a file change, a blocker, an error, or an exact identifier. Compress wording, not content.',
    'Answer with JSON only, of this shape:',
    PACKET_SCHEMA,
  ].join('\n')
}

// Finds the last ```relay block (or a bare JSON object as a fallback) and
// normalises it; undefined when nothing parseable is there.
export function parsePacket(text: string): Packet | undefined {
  const fenced = [...text.matchAll(/```relay\s*\n([\s\S]*?)```/g)]
  const candidates = fenced.length
    ? [fenced.at(-1)?.[1] ?? '']
    : [text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]
  for (const raw of candidates) {
    try {
      return normalise(JSON.parse(raw))
    } catch {
      // not JSON: fall through
    }
  }
  return undefined
}

function normalise(value: unknown): Packet | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  const status = ['done', 'partial', 'blocked', 'failed'].includes(String(v.status))
    ? (v.status as Packet['status'])
    : 'partial'
  const strings = (x: unknown) => (Array.isArray(x) ? x.map(String) : [])
  const packet: Packet = {
    status,
    summary: typeof v.summary === 'string' ? v.summary : '',
    decisions: [],
    facts: Array.isArray(v.facts)
      ? v.facts.map((f, i) =>
          typeof f === 'string' ? { id: `F${i + 1}`, text: f } : { id: String(f?.id ?? `F${i + 1}`), text: String(f?.text ?? '') },
        )
      : [],
    artifacts: Array.isArray(v.artifacts)
      ? v.artifacts
          .filter(a => a && typeof a.path === 'string')
          .map(a => ({ path: a.path, change: a.change ?? 'modified', ...(a.note ? { note: String(a.note) } : {}) }))
      : [],
    open_questions: [],
    needs_from_main: [],
    risks: [],
    next_suggested: [],
    sections: [],
  }
  for (const field of LIST_FIELDS) packet[field] = strings(v[field])
  return packet
}

// Strips the relay block from the full answer, so the stored full text is
// what the worker wrote for humans.
export function stripPacket(text: string): string {
  return text.replace(/```relay\s*\n[\s\S]*?```\s*$/, '').trimEnd()
}

// The packet as the main agent reads it: dense, every essential kept.
// `lean` keeps what the main agent must act on and counts the rest, which
// worker_expand with section "packet" returns in full.
export function renderPacket(head: string, p: Packet, fullPath: string, detail: 'full' | 'lean' = 'full'): string {
  const lines = [head, `Status: ${p.status}${p.compressed_by === 'fallback' ? ' (packet built by fallback compressor)' : ''}`]
  if (p.summary) lines.push(`Summary: ${p.summary}`)
  const list = (title: string, items: string[]) => {
    if (items.length) lines.push(`${title}:`, ...items.map(i => `- ${i}`))
  }
  list('Decisions', p.decisions)
  if (detail === 'full') list('Facts', p.facts.map(f => `${f.id}: ${f.text}`))
  list('Artifacts', p.artifacts.map(a => `${a.path} (${a.change})${a.note ? ` – ${a.note}` : ''}`))
  list('Needs from main', p.needs_from_main)
  list('Open questions', p.open_questions)
  if (detail === 'full') {
    list('Risks', p.risks)
    list('Next suggested', p.next_suggested)
  } else {
    const held = [
      p.facts.length ? `${p.facts.length} facts` : '',
      p.risks.length ? `${p.risks.length} risks` : '',
      p.next_suggested.length ? `${p.next_suggested.length} next steps` : '',
    ].filter(Boolean)
    if (held.length) lines.push(`Held back: ${held.join(', ')} → worker_expand section "packet"`)
  }
  lines.push(`Full text: ${fullPath}${p.sections.length ? ` · sections: ${p.sections.join(' | ')}` : ''} → worker_expand`)
  return lines.join('\n')
}

// How `owns` compares paths: by the rule of the filesystem the project lies on
// (relay probes it, contract 0001, Nachtrag 1). Case-sensitive unless known
// otherwise, so `SRC/` is never taken for `src/` where they are two folders.
export type PathCase = { caseInsensitive?: boolean }

const fold = (s: string, opts: PathCase) => (opts.caseInsensitive ? s.toLowerCase() : s)

// Whether a worker may write `path`: it must lie inside the worker's cwd and
// under one of the owned paths. Returns the reason to refuse, or undefined.
export function ownershipDenial(path: string | undefined, cwd: string, owns: readonly string[], opts: PathCase = {}): string | undefined {
  if (!owns.length || !path) return undefined
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '')
  const p = norm(path)
  const base = norm(cwd)
  let rel: string
  if (fold(p, opts).startsWith(`${fold(base, opts)}/`)) rel = p.slice(base.length + 1)
  else if (/^([a-zA-Z]:)?\//.test(p)) return `${path} lies outside the project; this worker may only write under ${owns.join(', ')}.`
  else rel = p.replace(/^\.\//, '')
  if (rel.split('/').includes('..')) return `${path} leaves the owned paths (..); this worker may only write under ${owns.join(', ')}.`
  return isOwnedPath(rel, owns, opts)
    ? undefined
    : `${rel} is not owned by this worker (owns: ${owns.join(', ')}). Put the change into "needs_from_main" instead.`
}

// Whether a project-relative path lies under one of the owned paths.
export function isOwnedPath(rel: string, owns: readonly string[], opts: PathCase = {}): boolean {
  const norm = (s: string) => fold(s.replace(/\\/g, '/').replace(/\/+$/, '').replace(/^\.\//, ''), opts)
  const path = norm(rel)
  return owns.some(o => {
    const own = norm(o)
    return path === own || path.startsWith(`${own}/`)
  })
}

// `git status --porcelain=v1 -z --untracked-files=all` → path and its two
// status letters; a rename or copy also names its source (`orig`).
export function parsePorcelain(text: string): { path: string; code: string; orig?: string }[] {
  const out: { path: string; code: string; orig?: string }[] = []
  const parts = text.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] ?? ''
    if (entry.length < 4) continue
    const code = entry.slice(0, 2)
    if (code.includes('R') || code.includes('C')) {
      const orig = parts[++i] // the source follows
      out.push({ path: entry.slice(3), code, ...(orig ? { orig } : {}) })
    } else out.push({ path: entry.slice(3), code })
  }
  return out
}

// `git diff --name-status -z a b` → the paths the commits touched and how; a
// rename is its source deleted and its target created, a copy its target created.
export function parseNameStatus(text: string): { path: string; change: Change }[] {
  const parts = text.split('\0').filter(Boolean)
  const out: { path: string; change: Change }[] = []
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i] ?? ''
    if (/^[RC]/.test(status)) {
      const from = parts[++i]
      const to = parts[++i]
      if (from && status.startsWith('R')) out.push({ path: from, change: 'deleted' })
      if (to) out.push({ path: to, change: 'created' })
    } else {
      const p = parts[++i]
      if (p) out.push({ path: p, change: status.startsWith('A') ? 'created' : status.startsWith('D') ? 'deleted' : 'modified' })
    }
  }
  return out
}

// `git worktree list --porcelain -z` → each worktree's path and branch ref
// (absent for a detached HEAD).
export function parseWorktreeList(text: string): { path: string; branch?: string }[] {
  const out: { path: string; branch?: string }[] = []
  let cur: { path: string; branch?: string } | undefined
  for (const line of text.split('\0')) {
    if (line.startsWith('worktree ')) out.push((cur = { path: line.slice('worktree '.length) }))
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice('branch '.length)
  }
  return out
}

// Two absolute paths name the same place: slashes and a trailing slash do not
// count, case only where the filesystem ignores it.
export function isSamePath(a: string, b: string, opts: PathCase = {}): boolean {
  const norm = (s: string) => fold(s.replace(/\\/g, '/').replace(/\/+$/, ''), opts)
  return norm(a) === norm(b)
}

// What a run wrote, judged against what the role owns and what the roles
// running beside it own.
export function compareSnapshots(
  before: Snapshot,
  after: Snapshot,
  committed: readonly { path: string; change: Change }[],
  owns: readonly string[],
  others: { role: string; owns: readonly string[] }[],
  opts: PathCase = {},
): WriteCheck {
  const byCommit = new Map(committed.map(c => [c.path, c.change]))
  const kind = (path: string): Change => {
    const now = after.dirty[path]
    const was = before.dirty[path]
    if (now === 'deleted') return 'deleted'
    if (now?.startsWith('new:') && !was?.startsWith('new:')) return 'created'
    if (now === undefined) {
      const c = byCommit.get(path)
      if (c) return c
      if (was?.startsWith('new:')) return 'deleted'
    }
    return 'modified'
  }
  const incomplete: string[] = []
  const paths = new Set<string>()
  for (const p of new Set([...Object.keys(before.dirty), ...Object.keys(after.dirty)])) {
    if (before.dirty[p] === UNHASHED || after.dirty[p] === UNHASHED) incomplete.push(p)
    else if (before.dirty[p] !== after.dirty[p]) paths.add(p)
  }
  for (const c of committed) paths.add(c.path)
  const changed = [...paths].sort().map(path => ({ path, change: kind(path) }))
  const check: WriteCheck = { checked: true, changed, outside: [], unattributed: [], byOtherRole: [] }
  if (incomplete.length) check.incomplete = incomplete.sort().map(p => `${p}: git could not hash it (a submodule or unreadable path), changes there are unknown`)
  if (!owns.length) return check
  for (const { path } of changed) {
    if (isOwnedPath(path, owns, opts)) continue
    const other = others.find(o => o.owns.length && isOwnedPath(path, o.owns, opts))
    if (other) check.byOtherRole.push({ path, role: other.role })
    else if (others.length) check.unattributed.push(path)
    else check.outside.push(path)
  }
  return check
}

// Folds a write check into the packet: writes outside `owns` turn done into
// partial and land under risks; files the worker did not list are added; what
// could not be checked is named.
export function applyWriteCheck(p: Packet, check: WriteCheck): Packet {
  p.write_check = check
  for (const gap of check.incomplete ?? []) p.risks.push(`write check incomplete: ${gap}`)
  if (!check.checked) return p
  const listed = new Set(p.artifacts.map(a => a.path.replace(/\\/g, '/')))
  const notMine = new Set([...check.unattributed, ...check.byOtherRole.map(b => b.path)])
  for (const c of check.changed) {
    if (!listed.has(c.path) && !notMine.has(c.path)) p.artifacts.push({ path: c.path, change: c.change, note: 'found by the write check' })
  }
  for (const path of check.outside) {
    const c = check.changed.find(x => x.path === path)
    p.risks.push(`wrote outside owns: ${path} (${c?.change ?? 'modified'})`)
  }
  for (const path of check.unattributed) p.risks.push(`changed outside all owns, not attributable (roles ran in parallel): ${path}`)
  for (const { path, role } of check.byOtherRole) p.risks.push(`changed ${path}, probably by ${role}`)
  if (check.outside.length && p.status === 'done') p.status = 'partial'
  return p
}

// relayDir stays inside the project (contract 0001, Nachtrag 1): worktrees,
// run files and the queue live under it.
export function safeRelayDir(value: string): { dir: string; note?: string } {
  const v = value.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '')
  if (!v) return { dir: '.relay' }
  if (/^([a-zA-Z]:|\/)/.test(v) || v.split('/').includes('..')) {
    return { dir: '.relay', note: `relayDir "${value}" lies outside the project; relay uses .relay instead.` }
  }
  return { dir: v }
}

// ── redaction ───────────────────────────────────────────────────────────

const SECRET = '[redacted]'

// A field name that counts tokens rather than holding one (max_tokens,
// input tokens, maxTokensPerRun): its numeric value stays readable.
const isCounterName = (name: string) => /tokens|token[_-]?(?:count|limit|budget|usage|used)|max[_-]?tokens?/i.test(name)
const isCount = (value: string) => /^[\d.,]+[kKmMbB]?$/.test(value)

// key=value / key: value / "key": "value" for names that hold credentials.
// The value is taken whole: double, single or escaped quotes with spaces and
// escapes inside, else up to the next separator. Numbers are redacted too,
// except the count of a counter name (contract 0001, Nachtrag 1, N18).
const KEY_VALUE =
  /\b([A-Za-z0-9_.-]*(?:api[_-]?key|apikey|secret|token|passwd|password|access[_-]?key|private[_-]?key|credential|session[_-]?key)[A-Za-z0-9_.-]*)(\\?["']?\s*[:=]\s*)(\\"(?:[^"\\]|\\[^"])*\\"|"(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'|[^\s"'&,;\\]+)/gi

function redactKeyValue(match: string, name: string, sep: string, value: string): string {
  if (isCounterName(name) && isCount(value)) return match
  const quote = value.startsWith('\\"') ? '\\"' : value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : ''
  return `${name}${sep}${quote}${SECRET}${quote}`
}

// Credentials in text relay persists or delivers (live.log, run files,
// packets, notices): replaced before they leave relay (contract 0001,
// Nachtrag 1). Best effort by shape; it never makes text longer to read.
const SECRET_PATTERNS: [RegExp, string | ((...args: string[]) => string)][] = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, `${SECRET} private key`],
  // `Authorization: Bearer x`, `Proxy-Authorization: Basic x`
  [/\b((?:proxy-)?authorization)(\s*[:=]\s*)(?:(bearer|basic|token|digest)\s+)?[^\s"'\\,;]+/gi, `$1$2$3 ${SECRET}`],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${SECRET}`],
  // scheme://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):[^\s@/]+@/gi, `$1:${SECRET}@`],
  [KEY_VALUE, redactKeyValue as (...args: string[]) => string],
  // well-known token shapes
  [/\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, SECRET],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, SECRET],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, SECRET],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, SECRET],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, SECRET],
  [/\bnpm_[A-Za-z0-9]{30,}/g, SECRET],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, SECRET],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, SECRET],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, SECRET],
]

export function redact(text: string): string {
  let out = text
  for (const [re, by] of SECRET_PATTERNS) out = typeof by === 'string' ? out.replace(re, by) : out.replace(re, by)
  return out
}

// Every string in a value, redacted (packets, usage, write checks).
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T
  if (Array.isArray(value)) return value.map(v => redactDeep(v)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v)])) as T
  }
  return value
}

// "a, b  c" or a list → ["a", "b", "c"]; tool rules with spaces stay whole
// when given as a list.
export function toList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean)
  if (typeof value !== 'string') return []
  return value.split(/[,\n]/).map(s => s.trim()).filter(Boolean)
}

// One markdown section by heading (case-insensitive substring), up to the
// next heading of the same or a higher level.
export function extractSection(text: string, heading: string): string | undefined {
  const lines = text.split('\n')
  const needle = heading.toLowerCase().replace(/^#+\s*/, '')
  const start = lines.findIndex(l => /^#{1,6}\s/.test(l) && l.toLowerCase().includes(needle))
  if (start < 0) return undefined
  const level = (lines[start] ?? '').match(/^#+/)?.[0].length ?? 1
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const m = (lines[i] ?? '').match(/^(#{1,6})\s/)
    if (m && (m[1] ?? '').length <= level) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

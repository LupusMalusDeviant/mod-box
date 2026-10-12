// Read Guard: stops Claude from pulling a whole large or useless file into the context. A Read
// without offset/limit of a file above the limit, a lockfile, minified code or a source map is
// held with its size and a token estimate and a better way (Grep, offset/limit). The same with
// cat, type or Get-Content in the shell, which knows no limit at all. Claude Code's own Read stops
// only at about 25,000 tokens; this guard is the cheaper line before that. A second try at the
// same file goes through: Claude may really need it.
import type { EngineInterface, Register } from 'claude-code'

let lang: 'de' | 'en' = 'en'
const t = (de: string, en: string) => (lang === 'en' ? en : de)
let mode = 'block'
let limitKb = 50
let shell = true
// Files held once this session: the second try goes through.
const held = new Set<string>()

// Files Read turns into something else than text (images, PDFs, notebooks): not ours.
const MEDIA = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|ipynb)$/i
const LOCK = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|go\.sum|packages\.lock\.json|flake\.lock)$/i
const MINIFIED = /\.min\.(js|mjs|css)$|\.map$/i
// Below this even a lockfile or a minified file costs too little to bother.
const NOISE_MIN = 8 * 1024

export type Verdict = { kind: 'lock' | 'minified' | 'large'; size: number; tokens: number } | null

/** Why a whole-file read of this path and size is a waste; null when it is fine. Pure, for the tests. */
export function judge(path: string, size: number, limit: number): Verdict {
  const p = path.replace(/\\/g, '/')
  if (MEDIA.test(p)) return null
  const tokens = Math.round(size / 4)
  if (size >= NOISE_MIN && LOCK.test(p)) return { kind: 'lock', size, tokens }
  if (size >= NOISE_MIN && MINIFIED.test(p)) return { kind: 'minified', size, tokens }
  if (limit > 0 && size > limit) return { kind: 'large', size, tokens }
  return null
}

/** The file a plain shell dump reads (cat, type, Get-Content), or null. Not when piped, limited or several. */
export function shellDump(command: string): string | null {
  const c = command.trim()
  // piped into grep/head/…, chained, or redirected: the output is already shaped
  if (/[|;&<>\n]/.test(c)) return null
  const words = c.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  if (!/^(cat|type|gc|get-content)$/i.test(words[0] ?? '')) return null
  const files: string[] = []
  for (const w of words.slice(1)) {
    // -Raw, -Path, -LiteralPath change nothing; -n, -TotalCount, -Tail … shape the output
    if (w.startsWith('-')) {
      if (/^-(raw|path|literalpath)$/i.test(w)) continue
      return null
    }
    files.push(w.replace(/^["']|["']$/g, ''))
  }
  return files.length === 1 ? files[0]! : null
}

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`)
const ktok = (n: number) => (n >= 1000 ? `~${Math.round(n / 1000)}k` : `~${n}`)

function advice(v: NonNullable<Verdict>, path: string, viaShell: boolean): string {
  const what =
    v.kind === 'lock'
      ? 'a lockfile; look up one package with Grep (or npm ls / pip show / cargo tree) instead'
      : v.kind === 'minified'
        ? 'minified code or a source map; read the source file instead, or Grep for what you need'
        : `larger than the Read Guard limit of ${limitKb} KB; use Grep to find the part you need, then Read with offset and limit`
  return (
    `Read Guard held ${viaShell ? 'this shell command' : 'this Read'}: ${path} is ${kb(v.size)} (${ktok(v.tokens)} tokens), ${what}. ` +
    'If you really need the whole file, try the same call once more; it then goes through.'
  )
}

async function resolve($: EngineInterface, file: string): Promise<string> {
  if (/^([a-z]:)?[\\/]/i.test(file) || file.startsWith('~')) return file
  const cwd = (await $.session.cwd()).replace(/\\/g, '/').replace(/\/$/, '')
  return `${cwd}/${file.replace(/^\.\//, '')}`
}

async function check($: EngineInterface, path: string, viaShell: boolean): Promise<string | null> {
  const key = path.replace(/\\/g, '/').toLowerCase()
  if (held.has(key)) return null
  const st = await $.fs.stat(path).catch(() => null)
  if (!st || st.kind !== 'file') return null
  const v = judge(path, st.size, limitKb * 1024)
  if (!v) return null
  const name = path.replace(/\\/g, '/').split('/').pop()
  if (mode === 'warn') {
    $.ui.toast(`📖 ${t('Lese-Wächter', 'Read Guard')}: ${name} ${kb(v.size)} (${ktok(v.tokens)} Tokens)`, { timeoutMs: 5000 })
    return null
  }
  held.add(key)
  $.ui.toast(`📖 ${t('Lese-Wächter hat angehalten', 'Read Guard held')}: ${name} ${kb(v.size)} (${ktok(v.tokens)} Tokens)`, { timeoutMs: 5000 })
  return advice(v, path, viaShell)
}

export const register: Register = (on, options) => {
  lang = options.language === 'de' ? 'de' : 'en'
  mode = String(options.mode ?? 'block')
  limitKb = options.limitKb === 'off' ? 0 : Number(options.limitKb ?? 50) || 50
  shell = String(options.shell ?? 'on') !== 'off'

  on('session.start', {}, async ($, e, next) => {
    held.clear()
    return next(e)
  })

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const path = String(e.file_path ?? '')
    if (!path || e.offset != null || e.limit != null) return next(e)
    const deny = await check($, path, false)
    return deny ? { deny } : next(e)
  })

  for (const tool of ['Bash', 'PowerShell']) {
    on('tool.call', { tool }, async ($, e, next) => {
      if (!shell) return next(e)
      const file = shellDump(String(e.command ?? ''))
      if (!file) return next(e)
      const deny = await check($, await resolve($, file), true)
      return deny ? { deny } : next(e)
    })
  }
}

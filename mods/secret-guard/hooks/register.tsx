// Secret Guard: the counterpart of Blast Radius for secrets. Stops before Claude
//  - writes an API key, token or private key into a file (Write, Edit, MultiEdit, NotebookEdit),
//  - writes or `git add`s a .env, .pem, id_rsa & co. that git does not ignore,
//  - commits while a secret sits in the staged changes,
//  - redirects a secret from the command line into a file.
// Mode "block" refuses the action (Claude gets the reason), "warn" only reports.
//
// Exceptions, so test keys and example files pass:
//  - project: .secretguard-allow in the project root (can be committed, applies to the team),
//  - global: in the box's store (all projects).
// An entry is a path in gitignore style (tests/fixtures/**, *.example.ts) or a value as
// sha256:<hex>, so no secret ever stands in clear text in an exception list. Placeholders
// (EXAMPLE, DUMMY, FAKE, xxxx …) pass on their own (option); that covers the documentation keys
// of AWS too, which all contain "EXAMPLE".
// Only the person changes the exceptions (window /secret-allow); Claude writing the list is stopped.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BlockedFind } from '../types'

type Hit = { what: string; where: string; path: string | null; value: string | null; hard?: boolean }

const blocked = atom({ plugin: 'mod-box', key: 'sw_blocked' } as const, [] as BlockedFind[])
const projectLines = atom({ plugin: 'mod-box', key: 'sw_project' } as const, [] as string[])
const globalLines = atom({ plugin: 'mod-box', key: 'sw_global' } as const, [] as string[])

export const ALLOW_FILE = '.secretguard-allow'
const STORE_GLOBAL = 'secret-allow-global'
const PANE = 'mod-box-secret-allow'
const MAX_BLOCKED = 20

// Display language and options (module level: the pane and the checks read them).
let lang: 'de' | 'en' = 'de'
const t = (de: string, en: string) => (lang === 'en' ? en : de)
let placeholders = true
let isWindows = false

// Patterns of known secrets. Kept narrow, so examples and placeholders pass.
export const PATTERNS: Array<[string, RegExp]> = [
  ['Anthropic-API-Key', /sk-ant-[A-Za-z0-9_-]{20,}/g],
  ['OpenAI-API-Key', /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{32,}/g],
  ['GitHub-Token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})/g],
  ['GitLab-Token', /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ['AWS-Zugangsschlüssel', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['Google-API-Key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['Slack-Token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['Stripe-Live-Key', /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/g],
  ['Hugging-Face-Token', /\bhf_[A-Za-z0-9]{30,}/g],
  ['privater Schlüssel', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----/g],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  [
    'credentials in an assignment',
    /\b(?:api[_-]?key|secret|token|passw(?:or)?d|client[_-]?secret|access[_-]?key)\b["']?\s*[:=]\s*["'](?![^"']*(?:example|beispiel|changeme|placeholder|your[_-]|xxx|<|\$\{|\{\{))[A-Za-z0-9+/_\-.=]{20,}["']/gi,
  ],
]

/** Placeholders and documentation examples: they look like keys but are none. */
export function isPlaceholder(value: string): boolean {
  return /example|dummy|fake|placeholder|redacted|sample|x{6,}|0{10,}|\*{4,}|your[_-]?(?:api|key|token|secret)/i.test(value)
}

// Files that hold secrets; templates (.example, .sample, .template, .dist) are fine.
export const SECRET_FILE = /(^|[\\/])(\.env(\.[\w-]+)?|[^\\/]*\.(pem|key|p12|pfx|keystore|jks)|id_(rsa|dsa|ecdsa|ed25519)|credentials(\.json)?|\.npmrc|\.pypirc|\.netrc)$/i
const TEMPLATE = /\.(example|sample|template|dist)$/i

export function findSecrets(text: string, where: string, path: string | null = null): Hit[] {
  const hits: Hit[] = []
  for (const [what, re] of PATTERNS) {
    for (const m of text.matchAll(re)) hits.push({ what, where, path, value: m[0] })
  }
  return hits
}

export function isSecretFile(file: string): boolean {
  return SECRET_FILE.test(file) && !TEMPLATE.test(file)
}

// Paths of a `git add …`; "." and "-A" count as "everything".
export function gitAddPaths(command: string): string[] | 'all' | null {
  const m = /(?:^|[;&|]\s*)git\s+(?:-C\s+\S+\s+)?add\s+([^;&|]*)/.exec(command)
  if (!m) return null
  const words = (m[1] ?? '').trim().split(/\s+/).filter(Boolean)
  if (words.some(w => w === '.' || w === '-A' || w === '--all' || w === '*')) return 'all'
  return words.filter(w => !w.startsWith('-'))
}

// ---------------------------------------------------------------- exceptions

/** An exception line: a path pattern, or sha256:<hex>. Comments after # are dropped. */
export function parseAllow(lines: string[]): { globs: string[]; hashes: Set<string> } {
  const globs: string[] = []
  const hashes = new Set<string>()
  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, '').replace(/^#.*$/, '').trim()
    if (!line) continue
    const h = /^sha256:([0-9a-f]{64})$/i.exec(line)
    if (h) hashes.add(h[1]!.toLowerCase())
    else globs.push(line)
  }
  return { globs, hashes }
}

/** gitignore-like matching: no slash = any folder level; a slash = from the project root; ** spans folders. */
export function globMatch(glob: string, path: string, ignoreCase = false): boolean {
  let g = glob.trim().replace(/\\/g, '/')
  if (!g) return false
  const dirOnly = g.endsWith('/')
  if (dirOnly) g = g.slice(0, -1)
  const anchored = g.startsWith('/') || g.includes('/')
  g = g.replace(/^\//, '')
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!
    if (c === '*' && g[i + 1] === '*') {
      re += '.*'
      i++
      if (g[i + 1] === '/') i++
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  const body = anchored ? `^${re}` : `(^|.*/)${re}`
  return new RegExp(`${body}(/.*)?$`, ignoreCase ? 'i' : '').test(path.replace(/\\/g, '/').replace(/^\.\//, ''))
}

export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

async function projectRoot($: EngineInterface): Promise<string> {
  return (await $.session.cwd()).replace(/\\/g, '/').replace(/\/$/, '')
}

function relative(root: string, file: string): string {
  const f = file.replace(/\\/g, '/')
  const r = root + '/'
  if (isWindows ? f.toLowerCase().startsWith(r.toLowerCase()) : f.startsWith(r)) return f.slice(r.length)
  return f.replace(/^\.\//, '')
}

let projectCache: { path: string; mtime: number; lines: string[] } | null = null

async function loadProjectLines($: EngineInterface): Promise<string[]> {
  const file = `${await projectRoot($)}/${ALLOW_FILE}`
  const st = await $.fs.stat(file).catch(() => null)
  if (!st) {
    projectCache = { path: file, mtime: 0, lines: [] }
    return []
  }
  if (projectCache && projectCache.path === file && projectCache.mtime === st.mtimeMs) return projectCache.lines
  const lines = String(await $.fs.read(file).catch(() => '')).split(/\r?\n/)
  projectCache = { path: file, mtime: st.mtimeMs, lines }
  return lines
}

async function loadGlobalLines($: EngineInterface): Promise<string[]> {
  const saved = await $.store.get(STORE_GLOBAL).catch(() => null)
  return Array.isArray(saved) ? saved.filter((x): x is string => typeof x === 'string') : []
}

/** Drops the hits an exception covers. */
async function applyExceptions($: EngineInterface, hits: Hit[]): Promise<Hit[]> {
  if (hits.length === 0) return hits
  const all = parseAllow([...(await loadProjectLines($)), ...(await loadGlobalLines($))])
  const out: Hit[] = []
  for (const h of hits) {
    if (h.hard) {
      out.push(h)
      continue
    }
    if (h.path && all.globs.some(g => globMatch(g, h.path!, isWindows))) continue
    if (h.value) {
      if (placeholders && isPlaceholder(h.value)) continue
      if (all.hashes.has(await sha256(h.value))) continue
    }
    out.push(h)
  }
  return out
}

// ---------------------------------------------------------------- the guard

export const register: Register = (on, options) => {
  const mode = options.mode === 'warn' ? 'warn' : 'block'
  lang = options.language === 'en' ? 'en' : 'de'
  placeholders = options.placeholders !== 'off'

  on('session.start', {}, async ($, e, next) => {
    const r = await next(e)
    isWindows = (await $.env.get('OS')) === 'Windows_NT'
    await $.command.register({ name: 'secret-allow', description: t('Secret-Wächter: Ausnahmen verwalten', 'Secret Guard: manage exceptions') })
    return r
  })

  on('command.run', { command: 'secret-allow' }, async $ => {
    await refreshLists($)
    await $.ui.open({ id: PANE, title: t('Secret-Wächter · Ausnahmen', 'Secret Guard · exceptions'), focus: true, closeOnEscape: true })
    return { text: t('Ausnahmen des Secret-Wächters geöffnet.', 'Secret Guard exceptions opened.') }
  })

  on('tool.call', {}, async ($, e, next) => {
    const found = await check($, e as unknown as Record<string, unknown>)
    const hits = dedupe(await applyExceptions($, found))
    if (hits.length === 0) return next(e)
    const list = hits.map(h => `${h.what} (${h.where})`).join('; ')
    const isHard = hits.some(h => h.hard)
    await remember($, hits, mode === 'block' || isHard)
    if (mode === 'warn' && !isHard) {
      $.ui.toast(`${t('Secret-Wächter', 'Secret Guard')}: ${list}`)
      return next(e)
    }
    $.ui.toast(`${t('Secret-Wächter hat angehalten', 'Secret Guard stopped')}: ${list} · /secret-allow`)
    return {
      deny: isHard
        ? `Secret Guard stopped this: ${list}. The exception list ${ALLOW_FILE} is changed only by the user, through the Mod Box window (/secret-allow). Do not try to change it another way.`
        : `Secret Guard stopped this action: ${list}. Secrets do not belong in files in the repository or in commits. ` +
          'Use an environment variable or a file that is not versioned (in .gitignore), and write a placeholder instead. ' +
          `If this is a known test key or an example file, the user can allow it with /secret-allow; do not edit ${ALLOW_FILE} yourself. ` +
          'Do not retry it another way unless the user explicitly asks.',
    }
  })
  // No .catch: if the check itself fails (no git, say), the action goes on rather than blocking every edit.

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawPane($, e))
}

async function check($: EngineInterface, e: Record<string, unknown>): Promise<Hit[]> {
  const tool = String(e.tool)
  const root = await projectRoot($)
  const file = typeof e.file_path === 'string' ? e.file_path : typeof e.notebook_path === 'string' ? e.notebook_path : ''
  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
    const rel = relative(root, file)
    const where = file.split(/[\\/]/).pop() || file
    // The exception list belongs to the person.
    if (where === ALLOW_FILE) return [{ what: t('Änderung der Ausnahmeliste', 'change of the exception list'), where, path: rel, value: null, hard: true }]
    const texts: string[] = []
    if (typeof e.content === 'string') texts.push(e.content)
    if (typeof e.new_string === 'string') texts.push(e.new_string)
    if (typeof e.new_source === 'string') texts.push(e.new_source)
    if (Array.isArray(e.edits)) for (const x of e.edits) if (x && typeof x.new_string === 'string') texts.push(x.new_string)
    const hits = texts.flatMap(text => findSecrets(text, where, rel))
    // A .env may hold secrets when git ignores it.
    if (isSecretFile(file)) {
      if (await isIgnored($, file)) return []
      hits.push({ what: t('Geheimnis-Datei, die git nicht ignoriert', 'secret file that git does not ignore'), where, path: rel, value: null })
    }
    return hits
  }
  if (tool === 'Bash' && typeof e.command === 'string') {
    const cmd = e.command
    const hits: Hit[] = []
    if (cmd.includes(ALLOW_FILE) && /(>|\btee\b|\bsed\s+-i|\brm\b|\bmv\b|\bcp\b|Set-Content|Add-Content|Out-File|Remove-Item|\btruncate\b)/.test(cmd)) {
      hits.push({ what: t('Änderung der Ausnahmeliste', 'change of the exception list'), where: ALLOW_FILE, path: ALLOW_FILE, value: null, hard: true })
    }
    const add = gitAddPaths(cmd)
    if (add && add !== 'all') for (const p of add) if (isSecretFile(p)) hits.push({ what: t('git add einer Geheimnis-Datei', 'git add of a secret file'), where: p, path: relative(root, p), value: null })
    if (add === 'all') {
      // What "git add ." would take: changed and new files that are not ignored.
      const r = await $.process.run(['git', 'status', '--porcelain', '--untracked-files=all']).catch(() => null)
      for (const line of r?.exitCode === 0 ? r.stdout.split('\n') : []) {
        const p = line.slice(3).trim().replace(/^"|"$/g, '')
        if (p && isSecretFile(p)) hits.push({ what: t('git add . würde eine Geheimnis-Datei aufnehmen', 'git add . would stage a secret file'), where: p, path: p, value: null })
      }
    }
    if (/(?:^|[;&|]\s*)git\s+(?:-C\s+\S+\s+)?commit\b/.test(cmd)) {
      const staged = await $.process.run(['git', 'diff', '--cached', '--name-only']).catch(() => null)
      for (const p of staged?.exitCode === 0 ? staged.stdout.split('\n').filter(Boolean) : []) {
        if (isSecretFile(p)) hits.push({ what: t('Commit mit einer Geheimnis-Datei', 'commit with a secret file'), where: p, path: p, value: null })
      }
      const diff = await $.process.run(['git', 'diff', '--cached', '-U0', '--no-color']).catch(() => null)
      if (diff?.exitCode === 0) hits.push(...secretsInDiff(diff.stdout))
    }
    // A secret on the command line that is redirected into a file (echo KEY > file).
    const target = /(?:>>?|\btee\s+(?:-a\s+)?)\s*(["']?)([^\s"';&|]+)\1/.exec(cmd)
    if (target) hits.push(...findSecrets(cmd, t('Umleitung in eine Datei', 'redirect into a file'), relative(root, target[2]!)))
    return hits
  }
  return []
}

/** Added lines of a staged diff, per file, so path exceptions apply. */
export function secretsInDiff(diff: string): Hit[] {
  const hits: Hit[] = []
  let path: string | null = null
  let added: string[] = []
  const flush = () => {
    if (path && added.length) hits.push(...findSecrets(added.join('\n'), path, path))
    added = []
  }
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      flush()
      path = line.slice(4).replace(/^b\//, '').trim()
      if (path === '/dev/null') path = null
    } else if (line.startsWith('+') && !line.startsWith('+++')) added.push(line.slice(1))
  }
  flush()
  return hits
}

async function isIgnored($: EngineInterface, file: string): Promise<boolean> {
  const r = await $.process.run(['git', 'check-ignore', '-q', file]).catch(() => null)
  return r?.exitCode === 0
}

function dedupe(hits: Hit[]): Hit[] {
  const seen = new Set<string>()
  return hits.filter(h => {
    const k = `${h.what}|${h.where}|${h.value ?? ''}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

// Keeps the last finds for the window (hash only, never the value).
async function remember($: EngineInterface, hits: Hit[], stopped: boolean) {
  const now = await $.clock.now()
  const finds: BlockedFind[] = []
  for (const h of hits) {
    if (h.hard) continue
    finds.push({ at: now, what: h.what, where: h.where, path: h.path, hash: h.value ? await sha256(h.value) : null, stopped })
  }
  if (finds.length) await update($, blocked, list => [...finds, ...list].slice(0, MAX_BLOCKED)).catch(() => {})
}

// ---------------------------------------------------------------- the exceptions window

async function refreshLists($: EngineInterface) {
  projectCache = null
  const lines = await loadProjectLines($)
  await update($, projectLines, () => lines.filter(l => l.trim() !== ''))
  const g = await loadGlobalLines($)
  await update($, globalLines, () => g)
}

async function addEntry($: EngineInterface, scope: 'project' | 'global', entry: string) {
  const line = entry.trim()
  if (!line) return
  if (scope === 'global') {
    const list = await loadGlobalLines($)
    if (!list.includes(line)) await $.store.set(STORE_GLOBAL, [...list, line])
  } else {
    const file = `${await projectRoot($)}/${ALLOW_FILE}`
    const existing = await $.fs.read(file).then(String).catch(() => '')
    const header = existing ? '' : `# ${t('Ausnahmen für den Secret-Wächter der Mod Box: Pfade (gitignore-Stil) oder sha256:<hash> eines Werts.', 'Exceptions for the Mod Box Secret Guard: paths (gitignore style) or sha256:<hash> of a value.')}\n`
    const lines = existing.split(/\r?\n/)
    if (!lines.some(l => l.replace(/\s+#.*$/, '').trim() === line.replace(/\s+#.*$/, '').trim())) {
      await $.fs.write(file, (existing ? existing.replace(/\s*$/, '\n') : header) + line + '\n')
    }
  }
  $.ui.toast(t(`Ausnahme hinzugefügt (${scope === 'global' ? 'global' : ALLOW_FILE}).`, `Exception added (${scope === 'global' ? 'global' : ALLOW_FILE}).`))
  await refreshLists($)
}

async function removeEntry($: EngineInterface, scope: 'project' | 'global', entry: string) {
  if (scope === 'global') {
    await $.store.set(STORE_GLOBAL, (await loadGlobalLines($)).filter(l => l !== entry))
  } else {
    const file = `${await projectRoot($)}/${ALLOW_FILE}`
    const existing = await $.fs.read(file).then(String).catch(() => '')
    await $.fs.write(file, existing.split(/\r?\n/).filter(l => l !== entry).join('\n'))
  }
  await refreshLists($)
}

async function drawPane($: EngineInterface, e: any) {
  const { Box, Text, Button, Input } = $.ui.resolve(e) as any
  const finds = await read($, blocked)
  const proj = await read($, projectLines)
  const glob = await read($, globalLines)
  const when = (ms: number) => new Date(ms).toLocaleTimeString(lang === 'en' ? 'en-GB' : 'de-DE', { hour: '2-digit', minute: '2-digit' })
  const entryRow = (scope: 'project' | 'global', line: string, i: number) =>
    line.trim().startsWith('#') ? (
      <Text key={`${scope}-c-${i}`} dimColor>{`  ${line}`}</Text>
    ) : (
      <Box key={`${scope}-${i}`} flexDirection="row">
        <Text>{`  ${line.length > 90 ? line.slice(0, 89) + '…' : line}`}</Text>
        <Text>{'  '}</Text>
        <Button key={`sa-rm-${scope}-${i}`} label={t('Entfernen', 'Remove')} plain onPress={() => void removeEntry($, scope, line)} />
      </Box>
    )
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text dimColor wrap="wrap">
        {t(
          `Ausnahmen lassen bekannte Test-Schlüssel und Beispieldateien durch. Einträge: ein Pfad im gitignore-Stil (tests/fixtures/**, *.example.ts) oder sha256:<hash> eines Werts – Schlüssel stehen nie im Klartext in der Liste. Projekt-Ausnahmen liegen in ${ALLOW_FILE} (kann ins Repo), globale gelten überall. Claude kann die Liste nicht ändern.`,
          `Exceptions let known test keys and example files pass. Entries: a path in gitignore style (tests/fixtures/**, *.example.ts) or sha256:<hash> of a value – keys never stand in clear text in the list. Project exceptions live in ${ALLOW_FILE} (can be committed), global ones apply everywhere. Claude cannot change the list.`,
        )}
      </Text>

      <Box flexDirection="column" marginTop={1}>
        <Text bold>{t('Zuletzt gefunden', 'Last finds')}</Text>
        {finds.length === 0 ? <Text dimColor>{t('  Noch nichts.', '  Nothing yet.')}</Text> : null}
        {finds.map((f, i) => (
          <Box key={`sa-f-${i}`} flexDirection="column">
            <Text>
              <Text color={f.stopped ? 'red' : 'yellow'}>{`  ${f.stopped ? '✘' : '⚠'} ${f.what}`}</Text>
              <Text dimColor>{`  ${f.path ?? f.where} · ${when(f.at)}`}</Text>
            </Text>
            <Box flexDirection="row" paddingLeft={4}>
              {f.path ? <Button key={`sa-fp-${i}`} label={t('Datei erlauben (Projekt)', 'Allow file (project)')} plain onPress={() => void addEntry($, 'project', f.path!)} /> : null}
              {f.path && f.hash ? <Text>{'  '}</Text> : null}
              {f.hash ? <Button key={`sa-fv-${i}`} label={t('Wert erlauben (Projekt)', 'Allow value (project)')} plain onPress={() => void addEntry($, 'project', `sha256:${f.hash}  # ${f.what} ${f.path ?? f.where}`)} /> : null}
              {f.hash ? <Text>{'  '}</Text> : null}
              {f.hash ? <Button key={`sa-fg-${i}`} label={t('Wert erlauben (global)', 'Allow value (global)')} plain onPress={() => void addEntry($, 'global', `sha256:${f.hash}  # ${f.what}`)} /> : null}
            </Box>
          </Box>
        ))}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text bold>{t(`Projekt (${ALLOW_FILE})`, `Project (${ALLOW_FILE})`)}</Text>
        {proj.filter(l => !l.trim().startsWith('#')).length === 0 ? <Text dimColor>{t('  keine', '  none')}</Text> : null}
        {proj.map((l, i) => entryRow('project', l, i))}
        {Input ? <Input key="sa-add-project" label={t('  Neu: ', '  New: ')} placeholder="tests/fixtures/**" submitLabel={t('Hinzufügen', 'Add')} onSubmit={(v: string) => void addEntry($, 'project', v)} /> : null}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text bold>{t('Global (alle Projekte)', 'Global (all projects)')}</Text>
        {glob.length === 0 ? <Text dimColor>{t('  keine', '  none')}</Text> : null}
        {glob.map((l, i) => entryRow('global', l, i))}
        {Input ? <Input key="sa-add-global" label={t('  Neu: ', '  New: ')} placeholder="*.example.env" submitLabel={t('Hinzufügen', 'Add')} onSubmit={(v: string) => void addEntry($, 'global', v)} /> : null}
      </Box>

      <Text dimColor>{placeholders ? t('Platzhalter (EXAMPLE, DUMMY, FAKE, xxxx …) werden automatisch durchgelassen.', 'Placeholders (EXAMPLE, DUMMY, FAKE, xxxx …) pass automatically.') : t('Platzhalter-Erkennung ist aus.', 'Placeholder detection is off.')}</Text>
    </Box>
  )
}

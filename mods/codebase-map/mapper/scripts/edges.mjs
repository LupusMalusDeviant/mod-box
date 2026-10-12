#!/usr/bin/env node
// Ermittelt die Feature-Kanten eines Repos maschinell und prüft die Blueprint-Dateien gegen den Code.
// Aufruf:  node edges.mjs <repo> [--index docs/blueprints/INDEX.md] [--check] [--json]
// Ohne Abhängigkeiten; braucht nur Node und git.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const flag = name => args.includes(name)
const option = (name, fallback) => {
  const at = args.indexOf(name)
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback
}
if (flag('--help') || flag('-h')) {
  console.log(`node edges.mjs <repo> [--lang de|en] [--check] [--json] [--index <pfad>]

Liest docs/blueprints/INDEX.md (Feature-Tabelle und Abschnitt "## Zuordnung" mit Pfad-Globs),
ordnet jede Quelldatei einem Feature zu und gibt den Abschnitt "## Kanten (geprüft)" aus.
--check prüft zusätzlich Pfade und Bezeichner in den Feature-Dateien gegen den Code.`)
  process.exit(0)
}
const repo = args.find((a, i) => !a.startsWith('--') && !['--index', '--lang'].includes(args[i - 1] ?? '')) ?? '.'
const indexPath = resolve(repo, option('--index', 'docs/blueprints/INDEX.md'))
if (!existsSync(indexPath)) {
  console.error(`INDEX nicht gefunden: ${indexPath}\nErst die Feature-Tabelle und den Abschnitt "## Zuordnung" in INDEX.md schreiben, dann das Skript aufrufen.`)
  process.exit(2)
}
const warnings = []
const blueprintDir = indexPath.replace(/[\\/][^\\/]+$/, '')

const SOURCE = /\.(cs|razor|cshtml|ts|tsx|js|jsx|mjs|cjs|go|py|java|kt)$/i
const TEST = /(^|\/)(tests?|__tests__|spec|testing|mocks?|fakes?)\/|\.(test|spec)\.\w+$|_test\.go$|(^|\/)test_[^/]*\.py$|Tests?\.cs$|\.Tests?\//i
const SKIP = /(^|\/)(bin|obj|node_modules|dist|build|out|vendor|generated|\.git)\//i
const ROOT_FILE = /(^|\/)(Program|Startup)\.cs$|ServiceExtensions\.cs$|(^|\/)DependencyInjection\//
const CROSS = /^I?(Identity|IdentityContext|Settings|SettingsService|FileSystem|Audit|AuditLog|Telemetry|Logger|Log|Clock|TimeProvider|Options|Configuration)\w*$/

// ---------- INDEX lesen ----------
const readText = path => readFileSync(path, 'utf8').replace(/\r\n?/g, '\n')
const index = readText(indexPath)
const norm = s => s.toLowerCase().replace(/[^a-z0-9äöüß]+/g, '')
const sectionOf = (text, heading) => {
  const at = text.search(heading)
  if (at < 0) return ''
  const rest = text.slice(at).replace(/^[^\n]*\n/, '')
  const end = rest.search(/^#{1,2} /m)
  return end < 0 ? rest : rest.slice(0, end)
}
// Feature-Tabelle aus "## Features" (sonst aus dem ganzen INDEX), je Slug nur einmal.
const featureText = sectionOf(index, /^## Features\b/m) || index
const features = []
for (const [, name, , slug] of featureText.matchAll(/^\|\s*([^|\n]+?)\s*\|\s*([^|\n]*?)\s*\|[^|\n]*\]\(\.\/([^)\s]+?)\.md\)[^|\n]*\|/gm)) {
  if (!features.some(f => f.slug === slug)) features.push({ name: name.trim(), slug })
}
const bySlug = new Map(features.map(f => [f.slug, f]))

// Abschnitt "Zuordnung": | [Name](./slug.md) | `glob`, `glob` | fach / vertrag / querschnitt |
const globs = []
const role = new Map()
for (const line of sectionOf(index, /^## (Zuordnung|Mapping)\b/m).split('\n')) {
  const slug = /\]\(\.\/([^)\s]+?)\.md\)/.exec(line)?.[1]
  if (!slug) continue
  if (!bySlug.has(slug)) {
    warnings.push(`Zuordnung nennt ${slug}.md, das nicht in der Feature-Tabelle steht; Zeile ignoriert.`)
    continue
  }
  const cells = line.split('|').map(c => c.trim())
  const kind = norm(cells[3] ?? '')
  role.set(slug, kind.startsWith('vertrag') || kind.startsWith('contract') ? 'contract' : kind.startsWith('quer') || kind.startsWith('cross') ? 'cross' : 'domain')
  for (const [, glob] of (cells[2] ?? '').matchAll(/`([^`]+)`/g)) globs.push({ slug, glob, re: globRe(glob), weight: glob.split(/[*?]/)[0].length })
}
function globRe(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++ }
    else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`, 'i')
}
if (features.length === 0) fail('Keine Feature-Tabelle im INDEX gefunden.')
if (globs.length === 0) fail('Kein Abschnitt "## Zuordnung" mit Pfad-Globs im INDEX. Erst die Zuordnung schreiben.')

function fail(message) {
  console.error(message)
  process.exit(2)
}

// ---------- Dateien zuordnen ----------
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
const tracked = git('ls-files', '--cached', '--others', '--exclude-standard').split('\n').filter(Boolean)
const sources = tracked.filter(p => SOURCE.test(p) && !TEST.test(p) && !SKIP.test(p))
const owner = new Map()
const unassigned = []
const doubled = []
for (const path of sources) {
  const hits = globs.filter(g => g.re.test(path))
  if (hits.length === 0) { unassigned.push(path); continue }
  const best = Math.max(...hits.map(h => h.weight))
  const top = [...new Set(hits.filter(h => h.weight === best).map(h => h.slug))]
  if (top.length > 1) doubled.push(`${path} (${top.join(', ')})`)
  owner.set(path, top[0])
}

// ---------- Deklarationen und Nutzungen ----------
// Kommentare entfernen (Zeilen bleiben erhalten); in Razor zusätzlich reinen Text zwischen Tags, damit Fließtext keine Bezeichner liefert.
const blank = m => m.replace(/[^\n]/g, '')
const strip = (text, path) => {
  if (/\.py$/.test(path)) return text.replace(/#[^\n]*/g, '')
  const code = text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, '').replace(/@\*[\s\S]*?\*@/g, blank)
  return /\.(razor|cshtml)$/i.test(path) ? code.replace(/>([^<@{}]*)</g, (m, inner) => `>${blank(inner)}<`) : code
}

const declared = new Map() // Name -> [{slug, path, line, kind}]
const implementsOf = new Map() // Interface -> Set(slug)
const texts = new Map()
const lineAt = (text, offset) => text.slice(0, offset).split('\n').length

const DECL = {
  cs: /^([ \t]*)((?:(?:public|internal|private|protected|static|sealed|abstract|partial|readonly|file|ref|unsafe|new)\s+)*)(class|interface|record|struct|enum)\s+([A-Z]\w*)([^{;\n]*)/gm,
  ts: /^[ \t]*export\s+(?:default\s+)?(?:declare\s+)?(abstract\s+)?(class|interface|type|enum|function|const)\s+([A-Za-z_$][\w$]*)([^{=\n]*)/gm,
  go: /^type\s+([A-Z]\w*)\s+(struct|interface)?/gm,
  py: /^class\s+([A-Za-z_]\w*)\s*(\([^)]*\))?/gm,
  java: /^[ \t]*(?:public\s+|protected\s+)?(?:abstract\s+|final\s+|sealed\s+)*(class|interface|enum|record)\s+([A-Z]\w*)([^{\n]*)/gm,
}
const langOf = path => (/\.(cs|razor|cshtml)$/i.test(path) ? 'cs' : /\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(path) ? 'ts' : /\.go$/i.test(path) ? 'go' : /\.py$/i.test(path) ? 'py' : 'java')
const addDecl = (name, entry) => (declared.get(name) ?? declared.set(name, []).get(name)).push(entry)
const addImpl = (iface, slug) => (implementsOf.get(iface) ?? implementsOf.set(iface, new Set()).get(iface)).add(slug)
const baseNames = list => [...list.matchAll(/([A-Z]\w*)(?:<[^>]*>)?/g)].map(m => m[1])

for (const path of sources) {
  const slug = owner.get(path)
  const text = strip(readText(join(repo, path)), path)
  texts.set(path, text)
  if (!slug) continue
  const lang = langOf(path)
  if (lang === 'cs' && !/\.cs$/i.test(path)) continue
  const found = [...text.matchAll(DECL[lang])]
  if (lang === 'cs') {
    const indents = found.map(m => m[1].replace(/\t/g, '    ').length)
    const top = Math.min(...indents)
    found.forEach((m, i) => {
      const mods = m[2] ?? ''
      if (indents[i] > top || /\b(private|protected)\b/.test(mods)) return
      const kind = m[3] === 'interface' ? 'interface' : 'type'
      addDecl(m[4], { slug, path, line: lineAt(text, m.index), kind })
      const bases = /^\s*(?:<[^>]*>)?\s*(?:\([^)]*\))?\s*:\s*(.*?)(?:\bwhere\b|$)/.exec(m[5] ?? '')?.[1]
      if (bases && m[3] !== 'interface' && !/\babstract\b/.test(mods)) for (const b of baseNames(bases)) addImpl(b, slug)
    })
  } else if (lang === 'ts') {
    for (const m of found) {
      addDecl(m[3], { slug, path, line: lineAt(text, m.index), kind: m[2] === 'interface' ? 'interface' : 'type' })
      const impl = /\bimplements\s+([^{]+)/.exec(m[4] ?? '')?.[1]
      if (impl && !m[1]) for (const b of baseNames(impl)) addImpl(b, slug)
    }
  } else if (lang === 'go') {
    for (const m of found) addDecl(m[1], { slug, path, line: lineAt(text, m.index), kind: m[2] === 'interface' ? 'interface' : 'type' })
  } else if (lang === 'py') {
    for (const m of found) {
      addDecl(m[1], { slug, path, line: lineAt(text, m.index), kind: 'type' })
      for (const b of baseNames(m[2] ?? '')) addImpl(b, slug)
    }
  } else {
    for (const m of found) {
      addDecl(m[2], { slug, path, line: lineAt(text, m.index), kind: m[1] === 'interface' ? 'interface' : 'type' })
      const impl = /\bimplements\s+([^{]+)/.exec(m[3] ?? '')?.[1]
      if (impl) for (const b of baseNames(impl)) addImpl(b, slug)
    }
  }
}

// Eindeutig: nur ein Feature deklariert den Namen (partielle Klassen im selben Feature zählen als eins).
const unique = new Map()
for (const [name, list] of declared) {
  const slugs = new Set(list.map(d => d.slug))
  if (slugs.size === 1 && name.length >= 4) unique.set(name, list[0])
}

// ---------- Kanten ----------
const edges = new Map() // "a>b" -> {from, to, kinds:Set, via:Set, proof}
const addEdge = (from, to, kind, via, proof) => {
  if (!from || !to || from === to) return
  const key = `${from}>${to}`
  const edge = edges.get(key) ?? edges.set(key, { from, to, kinds: new Set(), via: new Set(), proof }).get(key)
  edge.kinds.add(kind)
  if (via) edge.via.add(via)
}
const isCross = (name, slug) => role.get(slug) === 'cross' || CROSS.test(name)

for (const [path, text] of texts) {
  const from = owner.get(path)
  if (!from || ROOT_FILE.test(path) || role.get(from) === 'contract') continue
  const seen = new Set()
  for (const m of text.matchAll(/\b[A-Za-z_]\w{2,}\b/g)) {
    const name = m[0]
    if (seen.has(name)) continue
    const decl = unique.get(name)
    if (!decl || decl.slug === from && decl.kind !== 'interface') continue
    seen.add(name)
    const proof = `${path}:${lineAt(text, m.index)}`
    if (decl.slug !== from && role.get(decl.slug) !== 'contract') addEdge(from, decl.slug, isCross(name, decl.slug) ? 'Querschnitt' : 'Typ', name, proof)
    if (decl.kind === 'interface') {
      for (const impl of implementsOf.get(name) ?? []) {
        if (impl === from || role.get(impl) === 'contract') continue
        addEdge(from, impl, isCross(name, impl) ? 'Querschnitt' : 'Laufzeit', name, proof)
      }
    }
  }
}

// Build-Kanten aus csproj (ProjectReference) und package.json (Workspace-Pakete).
const manifestOwner = path => globs.filter(g => g.re.test(path) || g.re.test(path.replace(/[^/]+$/, 'x.cs'))).sort((a, b) => b.weight - a.weight)[0]?.slug
const projects = tracked.filter(p => /\.(csproj|fsproj)$/i.test(p))
const projectSlug = new Map(projects.map(p => [p.replace(/^.*\//, '').toLowerCase(), manifestOwner(p)]))
for (const p of projects) {
  const from = manifestOwner(p)
  const text = readText(join(repo, p))
  for (const m of text.matchAll(/<ProjectReference\s+Include="([^"]+)"/g)) {
    const to = projectSlug.get(m[1].replace(/\\/g, '/').replace(/^.*\//, '').toLowerCase())
    if (to && role.get(to) !== 'contract') addEdge(from, to, 'Build', '', `${p}:${lineAt(text, m.index)}`)
  }
}
const packages = tracked.filter(p => /(^|\/)package\.json$/.test(p) && !SKIP.test(p))
const pkgSlug = new Map()
for (const p of packages) {
  try { const name = JSON.parse(readFileSync(join(repo, p), 'utf8')).name; if (name) pkgSlug.set(name, manifestOwner(p)) } catch {}
}
for (const p of packages) {
  try {
    const json = JSON.parse(readFileSync(join(repo, p), 'utf8'))
    for (const dep of Object.keys({ ...json.dependencies, ...json.devDependencies, ...json.peerDependencies })) {
      const to = pkgSlug.get(dep)
      if (to && role.get(to) !== 'contract') addEdge(manifestOwner(p), to, 'Build', '', p)
    }
  } catch {}
}

// HTTP-Kanten: Ein Feature enthält einen Pfad-String ("/api/chat", $"api/databases/{id}"), der zu einer
// Server-Route eines anderen Features passt. Sagt nur, dass A den Endpunkt von B anspricht, nicht ob die Stelle
// zur Laufzeit erreicht wird oder ob die genaue Unterroute existiert.
const segments = path => path.replace(/[?#].*$/, '').replace(/^~?\/+|\/+$/g, '').toLowerCase().split('/').filter(Boolean)
  .map(s => (/^\{.*\}$|^:\w+$|\{|\$/.test(s) ? '*' : s))
const routes = [] // {slug, segs, proof}
for (const [path, text] of texts) {
  const slug = owner.get(path)
  if (!slug) continue
  // ASP.NET: [Route("...")] an der Controller-Klasse, [controller] = Klassenname ohne "Controller".
  for (const m of text.matchAll(/\[Route\("([^"]*)"\)\][\s\S]{0,400}?\bclass\s+(\w+?)(?:Controller)?\b/g)) {
    routes.push({ slug, segs: segments(m[1].replace(/\[controller\]/gi, m[2])), proof: `${path}:${lineAt(text, m.index)}` })
  }
  // Minimal APIs und Express-artige Router.
  for (const m of text.matchAll(/\b(?:Map(?:Get|Post|Put|Patch|Delete|Group|Methods)|(?:app|router|server)\.(?:get|post|put|patch|delete|use|route))\(\s*["'`]([^"'`]+)["'`]/g)) {
    routes.push({ slug, segs: segments(m[1]), proof: `${path}:${lineAt(text, m.index)}` })
  }
}
const routeOf = segs => {
  let best = null
  for (const r of routes) {
    if (r.segs.length === 0 || r.segs.length > segs.length) continue
    if (r.segs.every((s, i) => s === '*' || segs[i] === '*' || s === segs[i]) && (!best || r.segs.length > best.segs.length)) best = r
  }
  return best
}
if (routes.length) {
  for (const [path, raw] of texts) {
    const from = owner.get(path)
    if (!from) continue
    for (const m of raw.matchAll(/["'`]((?:https?:\/\/[^"'`\/]+)?\/?(?:api|v\d)\/[^"'`\s]*)["'`]/g)) {
      const segs = segments(m[1].replace(/^https?:\/\/[^/]+/, ''))
      const route = routeOf(segs)
      if (route && route.slug !== from) addEdge(from, route.slug, 'HTTP', `/${segs.join('/')}`, `${path}:${lineAt(raw, m.index)}`)
    }
  }
}

// ---------- Ausgabe ----------
const ORDER = ['Build', 'Typ', 'Laufzeit', 'HTTP', 'Querschnitt']
const rows = [...edges.values()]
  .map(e => ({ ...e, kinds: ORDER.filter(k => e.kinds.has(k)), via: [...e.via].slice(0, 5) }))
  .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
const nodeId = slug => slug.replace(/[^A-Za-z0-9]/g, '_')

const check = flag('--check') ? checkBlueprints() : null
if (flag('--json')) {
  console.log(JSON.stringify({ sources: sources.length, assigned: owner.size, unassigned, doubled, edges: rows, check }, null, 1))
  process.exit(0)
}

const out = []
out.push(`<!-- edges.mjs: ${sources.length} Quelldateien, ${owner.size} zugeordnet, ${unassigned.length} ohne Feature, ${doubled.length} doppelt -->`)
const EN = option('--lang', 'de') === 'en'
const KIND_EN = { Build: 'Build', Typ: 'Type', Laufzeit: 'Runtime', HTTP: 'HTTP', Querschnitt: 'Cross-cutting' }
out.push('', EN ? '## Edges (verified)' : '## Kanten (geprüft)', '')
out.push(EN ? '| From | To | Kind | via | Evidence |' : '| Von | Nach | Art | via | Beleg |', '|-----|------|-----|-----|-------|')
for (const e of rows) {
  const kinds = e.kinds.map(k => (EN ? KIND_EN[k] : k)).join(', ')
  out.push(`| [${bySlug.get(e.from)?.name ?? e.from}](./${e.from}.md) | [${bySlug.get(e.to)?.name ?? e.to}](./${e.to}.md) | ${kinds} | ${e.via.map(v => `\`${v}\``).join(', ')} | \`${e.proof}\` |`)
}
out.push('', '```mermaid', 'graph LR')
for (const f of features) out.push(`    ${nodeId(f.slug)}["${f.name.replace(/["[\]]/g, '')}"]`)
for (const e of rows) {
  const drawn = e.kinds.filter(k => k !== 'Querschnitt')
  if (drawn.length === 0) continue
  out.push(`    ${nodeId(e.from)} ${drawn.every(k => k === 'Laufzeit' || k === 'HTTP') ? '-.->' : '-->'} ${nodeId(e.to)}`)
}
out.push('```')
out.push('', EN
  ? 'Arrow = "uses". Solid: build or type edge; dashed: runtime only, through an interface (DI) or an HTTP endpoint. An HTTP edge means the source names a route of the target; whether that code path is reached, and whether the exact sub-route exists, needs a look at the code. Cross-cutting edges (settings, audit, identity, logging) appear only in the table.'
  : 'Pfeil = „benutzt“. Durchgezogen: Build- oder Typ-Kante; gestrichelt: nur zur Laufzeit über ein Interface (DI) oder einen HTTP-Endpunkt. Eine HTTP-Kante heißt: Die Quelle nennt eine Route des Ziels; ob diese Stelle zur Laufzeit erreicht wird und ob die genaue Unterroute existiert, zeigt erst der Code. Querschnitt-Kanten (Settings, Audit, Identity, Logging) stehen nur in der Tabelle.')
if (warnings.length) {
  out.push('', '<!-- Warnungen:')
  for (const w of warnings) out.push(`  ${w}`)
  out.push('-->')
  for (const w of warnings) console.error(w)
}
if (unassigned.length || doubled.length) {
  out.push('', '<!-- Zuordnung unvollständig:')
  for (const p of unassigned.slice(0, 40)) out.push(`  ohne Feature: ${p}`)
  if (unassigned.length > 40) out.push(`  ... und ${unassigned.length - 40} weitere`)
  for (const p of doubled.slice(0, 20)) out.push(`  doppelt: ${p}`)
  out.push('-->')
}
if (check) {
  out.push('', '<!-- Prüfung der Blueprint-Dateien:')
  for (const c of check) out.push(`  ${c}`)
  if (check.length === 0) out.push('  keine Befunde')
  out.push('-->')
}
console.log(out.join('\n'))

// ---------- Prüfung der Feature-Dateien (Pfade und Bezeichner) ----------
function checkBlueprints() {
  const findings = []
  const ignored = path => { try { git('check-ignore', '-q', path); return true } catch { return false } }
  // Bezeichner aus allen versionierten Textdateien (auch Kommentare, csproj, Dockerfile, YAML) und alle Dateinamen ohne Endung.
  const tokens = new Set()
  const TEXT_FILE = /\.(cs|razor|cshtml|ts|tsx|js|jsx|mjs|cjs|go|py|java|kt|csproj|fsproj|props|targets|json|ya?ml|toml|xml|config|sh|ps1|conf|env|example|sql|html|css|md)$|(^|\/)(Dockerfile[^/]*|Makefile|\.env[^/]*)$/i
  for (const path of tracked) {
    for (const part of path.split('/')) tokens.add(part.replace(/\..*$/, ''))
    if (!TEXT_FILE.test(path) || SKIP.test(path) || path.startsWith(blueprintDir.slice(resolve(repo).length + 1).replace(/\\/g, '/'))) continue
    try { for (const m of readFileSync(join(repo, path), 'utf8').matchAll(/\b[A-Za-z_]\w{2,}\b/g)) tokens.add(m[0]) } catch {}
  }
  for (const f of features) {
    const file = join(blueprintDir, `${f.slug}.md`)
    if (!existsSync(file)) { findings.push(`${f.slug}.md fehlt`); continue }
    const md = readText(file)
    const files = sectionOf(md, /^## (Dateien|Files)\b/m)
    for (const line of files.split('\n')) {
      let dir = ''
      for (const [, token] of line.matchAll(/`([^`]+)`/g)) {
        const path = token.replace(/^\.\//, '')
        if (!/^[\w.@\-/]+$/.test(path) || path.endsWith('/')) continue
        if (!path.includes('/') && path.startsWith('.')) continue
        const full = path.includes('/') ? path : dir + path
        if (path.includes('/')) dir = path.slice(0, path.lastIndexOf('/') + 1)
        if (!path.includes('/') && /^[A-Z]\w*(\.[A-Z]\w*)+$/.test(path)) continue // Namespace wie System.Text.Json
        if (!SOURCE.test(full) && !/\.(csproj|json|ya?ml|toml|mod|sql)$/.test(full)) continue
        if (!existsSync(join(repo, full)) && !ignored(full)) findings.push(`${f.slug}.md: Pfad existiert nicht: ${full}`)
      }
    }
    for (const [, token] of md.matchAll(/`([A-Z][A-Za-z0-9_]{3,})(?:\.[A-Za-z_]\w*)?(?:\(\))?`/g)) {
      if (!tokens.has(token)) findings.push(`${f.slug}.md: Bezeichner nicht im Code: ${token}`)
    }
  }
  return [...new Set(findings)]
}

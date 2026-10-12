import type { MapData, MapFeature } from '../types'

export const BLUEPRINT_DIR = 'docs/blueprints'
export const INDEX_PATH = `${BLUEPRINT_DIR}/INDEX.md`

// Eigene Ausgaben und der CLAUDE.md-Verweis zählen nicht als Code-Änderung.
export const CODE_ONLY = [
  '--',
  '.',
  ':(exclude)docs/blueprints',
  ':(exclude)docs/SkillUsed',
  ':(exclude)CLAUDE.md',
  ':(exclude).claude/CLAUDE.md',
]

// codebase-mapper schreibt den Anker immer wörtlich als `**Stand (Commit):** <hash>`.
const STAMP = /\*\*Stand \(Commit\):\*\*\s*([0-9a-f]{7,40})\b/i

export const parseStamp = (index: string): string | null =>
  STAMP.exec(index)?.[1]?.toLowerCase() ?? null


const section = (text: string, heading: RegExp): string => {
  const found = heading.exec(text)
  if (!found) return ''
  const rest = text.slice(found.index + found[0].length)
  const end = rest.search(/^#{1,3} /m)
  return end < 0 ? rest : rest.slice(0, end)
}

const norm = (name: string) => name.toLowerCase().replace(/[^a-z0-9äöüß]+/g, '')

// Feature-Zeilen der INDEX-Tabelle: | Name | Kurzbeschreibung | [slug.md](./slug.md) |
export const parseIndexRows = (index: string) =>
  [...index.matchAll(/^\|\s*([^|\n]+?)\s*\|\s*([^|\n]*?)\s*\|[^|\n]*\]\(\.\/([^)\s]+?)\.md\)[^|\n]*\|/gm)]
    .map(([, name = '', summary = '', slug = '']) => ({ name, summary, slug }))
    .filter(row => row.slug !== '')

// Kanten des Mermaid-Graphen im INDEX: A --> B heißt "A benutzt B".
export const parseIndexEdges = (index: string, rows: { name: string; slug: string }[]) => {
  const block = /```mermaid\s+graph[\s\S]*?```/.exec(index)?.[0] ?? ''
  const label = new Map<string, string>()
  for (const [, id = '', text = ''] of block.matchAll(/(\w+)\[([^\]]+)\]/g)) label.set(id, text)
  const keys = rows.map(row => ({ slug: row.slug, name: norm(row.name), file: norm(row.slug) }))
  // Knoten über Label oder Id zuordnen: erst Name oder Slug exakt, dann ein eindeutiger Präfix ("Observability" zu "Observability & Monitoring").
  const match = (raw: string) => {
    const key = norm(raw)
    if (key === '') return undefined
    const exact = keys.find(k => k.name === key || k.file === key)
    if (exact) return exact.slug
    const prefixed = keys.filter(k => k.name.startsWith(key) || k.file.startsWith(key))
    return prefixed.length === 1 ? prefixed[0]?.slug : undefined
  }
  const slugOf = (id: string) => match(label.get(id) ?? '') ?? match(id)
  const edges: [string, string][] = []
  // Durchgezogen (-->) und gestrichelt (-.->, Laufzeitkante) zählen gleich.
  for (const [, from = '', to = ''] of block.matchAll(/(\w+)(?:\[[^\]]*\])?\s*(?:-->|-\.->)\s*(?:\|[^|]*\|\s*)?(\w+)/g)) {
    const a = slugOf(from)
    const b = slugOf(to)
    if (a && b && a !== b) edges.push([a, b])
  }
  return edges
}

const isPathLike = (token: string) => /^[\w.@\-/]+$/.test(token) && (/\.\w+$/.test(token) || token.endsWith('/'))

// Pfade aus dem Abschnitt "Dateien"; Kurznamen in derselben Zeile gelten relativ zum Ordner des letzten vollen Pfads.
export const parseFeatureFiles = (feature: string): string[] => {
  const files = new Set<string>()
  for (const line of section(feature, /^## (Dateien|Files)[^\n]*$/m).split('\n')) {
    let dir = ''
    for (const [, token = ''] of line.matchAll(/`([^`]+)`/g)) {
      const path = token.replace(/^\.\//, '')
      if (!isPathLike(path) || (!path.includes('/') && path.startsWith('.'))) continue
      if (path.includes('/')) {
        dir = path.endsWith('/') ? path : path.slice(0, path.lastIndexOf('/') + 1)
        files.add(path)
      } else {
        files.add(dir + path)
      }
    }
  }
  return [...files]
}

// Interne Abhängigkeiten aus dem Feature-Blueprint: Links auf ./<slug>.md
export const parseFeatureDeps = (feature: string): string[] =>
  [...section(feature, /^### (Intern|Internal)[^\n]*$/m).matchAll(/\]\(\.\/([^)\s]+?)\.md\)/g)].map(([, slug = '']) => slug)

// Abschnitt "Zuordnung" im INDEX: | [Name](./slug.md) | `glob`, `glob` | Rolle |
export const parseIndexGlobs = (index: string): Map<string, string[]> => {
  const globs = new Map<string, string[]>()
  for (const line of section(index, /^## (Zuordnung|Mapping)\b[^\n]*$/m).split('\n')) {
    const slug = /\]\(\.\/([^)\s]+?)\.md\)/.exec(line)?.[1]
    if (!slug) continue
    const cells = line.split('|')
    const list = [...(cells[2] ?? '').matchAll(/`([^`]+)`/g)].map(([, glob = '']) => glob)
    globs.set(slug, [...(globs.get(slug) ?? []), ...list])
  }
  return globs
}

const globRe = (glob: string) => {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? ''
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*'
      i++
      if (glob[i + 1] === '/') i++
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`, 'i')
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/
const PAGE_ID = /<!--\s*confluence-page-id:\s*(\S+?)\s*-->/

export const parseConfluence = (index: string) => ({
  isOptedIn: /^publish:\s*true\s*$/m.test(FRONTMATTER.exec(index)?.[1] ?? ''),
  pageId: PAGE_ID.exec(index)?.[1] ?? null,
})

export const buildMap = (index: string, features: Record<string, string>): MapData => {
  const rows = parseIndexRows(index)
  const edges = parseIndexEdges(index, rows)
  const known = new Set(rows.map(row => row.slug))
  const globs = parseIndexGlobs(index)
  const list: MapFeature[] = rows.map(row => {
    const text = features[row.slug] ?? ''
    const deps = new Set([
      ...edges.filter(([from]) => from === row.slug).map(([, to]) => to),
      ...parseFeatureDeps(text).filter(slug => known.has(slug) && slug !== row.slug),
    ])
    return { ...row, files: parseFeatureFiles(text), deps: [...deps], globs: globs.get(row.slug) ?? [] }
  })
  return { features: list, confluence: parseConfluence(index) }
}

const slash = (path: string) => path.replace(/\\/g, '/')

// Absoluter Tool-Pfad -> Pfad relativ zur Projektwurzel (ohne Groß/Klein-Unterschied, wie unter Windows).
export const relativeTo = (root: string, path: string): string | null => {
  const base = `${slash(root).replace(/\/+$/, '')}/`
  const full = slash(path)
  if (!/^([a-zA-Z]:)?\//.test(full)) return full.replace(/^\.\//, '')
  return full.toLowerCase().startsWith(base.toLowerCase()) ? full.slice(base.length) : null
}

const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/') + 1)

// Exakter Treffer; dann der spezifischste Glob aus der Zuordnung; sonst der Ordner, wenn genau ein Feature dort Dateien führt.
export const featureOf = (map: MapData, rel: string): string | null => {
  const path = rel.toLowerCase()
  const exact = map.features.find(f => f.files.some(file => file.toLowerCase() === path))
  if (exact) return exact.slug
  let best: { slug: string; weight: number } | null = null
  for (const f of map.features) {
    for (const glob of f.globs ?? []) {
      const weight = glob.split(/[*?]/)[0]?.length ?? 0
      if (globRe(glob).test(rel) && (best === null || weight > best.weight)) best = { slug: f.slug, weight }
    }
  }
  if (best) return best.slug
  const owners = map.features.filter(f =>
    f.files.some(file => {
      const own = file.toLowerCase()
      return own.endsWith('/') ? path.startsWith(own) : dirOf(own) !== '' && dirOf(own) === dirOf(path)
    }),
  )
  return owners.length === 1 ? (owners[0]?.slug ?? null) : null
}

export const blueprintSlugOf = (rel: string): string | null =>
  rel.startsWith(`${BLUEPRINT_DIR}/`) && rel.endsWith('.md') ? rel.slice(BLUEPRINT_DIR.length + 1, -3) : null

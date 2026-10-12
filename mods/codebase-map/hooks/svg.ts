import type { MapData } from '../types'

export type NodeState = 'active' | 'touched' | 'selected' | 'idle'

const W = 176
const H = 36
const GX = 18
const GY = 46
const PAD = 12

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

// Ebene = längster Weg von einem Feature, das niemand benutzt: Nutzer oben, Grundlagen unten.
export const layers = (map: MapData): string[][] => {
  const users = new Map<string, string[]>()
  for (const f of map.features) for (const dep of f.deps) users.set(dep, [...(users.get(dep) ?? []), f.slug])
  const depth = new Map<string, number>()
  const visit = (slug: string, seen: Set<string>): number => {
    const known = depth.get(slug)
    if (known !== undefined) return known
    if (seen.has(slug)) return 0
    seen.add(slug)
    const d = Math.max(-1, ...(users.get(slug) ?? []).map(user => visit(user, seen))) + 1
    seen.delete(slug)
    depth.set(slug, d)
    return d
  }
  const rows: string[][] = []
  for (const f of map.features) {
    const d = visit(f.slug, new Set())
    rows[d] = [...(rows[d] ?? []), f.slug]
  }
  return orderRows(map, rows.filter(row => row !== undefined))
}

// Je Ebene nach dem mittleren Platz der Nachbarn darüber sortieren: weniger Kreuzungen.
const orderRows = (map: MapData, rows: string[][]): string[][] => {
  const neighbours = new Map<string, Set<string>>()
  const link = (a: string, b: string) => neighbours.set(a, (neighbours.get(a) ?? new Set()).add(b))
  for (const f of map.features) for (const dep of f.deps) (link(f.slug, dep), link(dep, f.slug))
  const place = new Map<string, number>()
  return rows.map(row => {
    const centre = (slug: string) => {
      const seen = [...(neighbours.get(slug) ?? [])].flatMap(n => (place.has(n) ? [place.get(n) ?? 0] : []))
      return seen.length === 0 ? Number.POSITIVE_INFINITY : seen.reduce((a, b) => a + b, 0) / seen.length
    }
    const sorted = [...row].sort((a, b) => centre(a) - centre(b))
    sorted.forEach((slug, i) => place.set(slug, (i + 0.5) / sorted.length))
    return sorted
  })
}

// Drei klar getrennte Zustände: kräftiges Orange (läuft), blasses Gelb mit gestricheltem Rand (geändert), Blau (ausgewählt).
const FILL: Record<NodeState, string> = { active: '#fb923c', touched: '#fef9c3', selected: '#bfdbfe', idle: '#e5e7eb' }
const STROKE: Record<NodeState, string> = { active: '#c2410c', touched: '#a16207', selected: '#1d4ed8', idle: '#6b7280' }
const STROKE_WIDTH: Record<NodeState, number> = { active: 3, touched: 2, selected: 2, idle: 1 }
const DASH: Record<NodeState, string> = { active: '', touched: ' stroke-dasharray="5 3"', selected: '', idle: '' }
const LEGEND_H = 26

export type Legend = { active: string; touched: string; selected: string }

const legendOf = (legend: Legend) => {
  const items: [NodeState, string][] = [['active', legend.active], ['touched', legend.touched], ['selected', legend.selected]]
  let x = PAD
  return items
    .map(([state, label]) => {
      const swatch = `<rect x="${x}" y="${PAD - 2}" width="16" height="12" rx="3" fill="${FILL[state]}" stroke="${STROKE[state]}" stroke-width="${Math.min(STROKE_WIDTH[state], 2)}"${DASH[state]}/>`
      const text = `<text x="${x + 22}" y="${PAD + 8}" font-family="sans-serif" font-size="11" fill="#374151">${escape(label)}</text>`
      x += 22 + label.length * 6 + 18
      return swatch + text
    })
    .join('')
}

export const renderSvg = (map: MapData, stateOf: (slug: string) => NodeState, legend?: Legend) => {
  const rows = layers(map)
  const cols = Math.max(1, ...rows.map(row => row.length))
  const width = PAD * 2 + cols * W + (cols - 1) * GX
  const top = legend === undefined ? PAD : PAD + LEGEND_H
  const height = top + PAD + rows.length * H + Math.max(0, rows.length - 1) * GY
  const at = new Map<string, { x: number; y: number }>()
  rows.forEach((row, r) => {
    const x0 = (width - (row.length * W + (row.length - 1) * GX)) / 2
    row.forEach((slug, c) => at.set(slug, { x: x0 + c * (W + GX), y: top + r * (H + GY) }))
  })
  const bySlug = new Map(map.features.map(f => [f.slug, f]))
  const pairs = map.features.flatMap(f => f.deps.flatMap(dep => (at.has(f.slug) && at.has(dep) ? [[f.slug, dep] as const] : [])))
  // Anschlusspunkte je Knotenkante nach der Lage des Gegenübers über die Breite verteilen.
  const ports = new Map<string, number>()
  const spread = (slug: string, side: 'top' | 'bottom', others: string[]) => {
    const sorted = [...others].sort((a, b) => (at.get(a)?.x ?? 0) - (at.get(b)?.x ?? 0))
    sorted.forEach((other, i) => ports.set(`${slug}|${side}|${other}`, ((i + 1) / (sorted.length + 1)) * W))
  }
  for (const slug of at.keys()) {
    const y = at.get(slug)?.y ?? 0
    const ends = pairs.flatMap(([a, b]) => (a === slug ? [b] : b === slug ? [a] : []))
    spread(slug, 'top', ends.filter(other => (at.get(other)?.y ?? 0) < y))
    spread(slug, 'bottom', ends.filter(other => (at.get(other)?.y ?? 0) >= y))
  }
  const edges = pairs.map(([from, to]) => {
    const a = at.get(from) ?? { x: 0, y: 0 }
    const b = at.get(to) ?? { x: 0, y: 0 }
    const isUp = b.y < a.y
    const x1 = a.x + (ports.get(`${from}|${isUp ? 'top' : 'bottom'}|${to}`) ?? W / 2)
    const x2 = b.x + (ports.get(`${to}|${isUp ? 'bottom' : 'top'}|${from}`) ?? W / 2)
    const y1 = isUp ? a.y : a.y + H
    const y2 = isUp ? b.y + H : b.y
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#9ca3af" stroke-width="1.2" marker-end="url(#arrow)"/>`
  })
  const nodes = [...at.entries()].map(([slug, { x, y }]) => {
    const f = bySlug.get(slug)
    const state = stateOf(slug)
    return [
      `<g class="node"><title>${escape(`${f?.name ?? slug}: ${f?.summary ?? ''}`)}</title>`,
      `<rect x="${x}" y="${y}" width="${W}" height="${H}" rx="6" fill="${FILL[state]}" stroke="${STROKE[state]}" stroke-width="${STROKE_WIDTH[state]}"${DASH[state]}/>`,
      `<text x="${x + W / 2}" y="${y + H / 2 + 4}" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#111827">${escape(clip(f?.name ?? slug, 26))}</text></g>`,
    ].join('')
  })
  const source = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
    '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#9ca3af"/></marker></defs>',
    // Hover-Rahmen: zeigt zugleich, ob die Oberfläche die Grafik interaktiv (mit Tooltips) zeichnet.
    '<style>.node:hover rect{stroke:#111827;stroke-width:3}.node{cursor:help}</style>',
    ...(legend === undefined ? [] : [legendOf(legend)]),
    ...edges,
    ...nodes,
    '</svg>',
  ].join('')
  return { source, width, height }
}

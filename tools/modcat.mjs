// The community mod catalogue (github.com/karanb192/awesome-claude-code-mods, CC0): every public
// Claude Code mod a nightly scan found, with what Claude's validator says each can read, write, run
// or send. Fetched once a day into $MODBOX_HOME/mod-catalog.json; searched here.
//
//   node tools/box.mjs modcat [--query <words>] [--limit <n>] [--refresh]
import fs from 'node:fs'
import path from 'node:path'

import { HOME } from './native.mjs'

export const MODCAT_URL = 'https://raw.githubusercontent.com/karanb192/awesome-claude-code-mods/main/data/mods.json'
export const MODCAT_PAGE = 'https://mods.aidojo.si/'
const MAX_AGE_MS = 24 * 60 * 60 * 1000

const cacheFile = () => path.join(HOME(), 'mod-catalog.json')

/** Only what the window needs: the full file is about 11 MB. */
export function slim(data) {
  return {
    generated: data.generated ?? null,
    mods: (data.mods ?? [])
      .filter(m => m && !m.archived && m.kind !== 'builtin')
      .map(m => ({
        name: String(m.name ?? ''),
        repo: String(m.repo ?? ''),
        path: String(m.path ?? ''),
        url: String(m.url ?? (m.repo ? `https://github.com/${m.repo}` : '')),
        description: String(m.description ?? '').slice(0, 400),
        reach: { level: Number(m.reach?.level ?? 0), name: String(m.reach?.name ?? ''), labels: Array.isArray(m.reach?.labels) ? m.reach.labels.map(String) : [] },
        license: m.license ?? null,
        stars: Number(m.stars ?? 0),
        pushedAt: m.pushedAt ?? null,
        validated: m.validate?.status ?? null,
      })),
  }
}

async function load(refresh) {
  const file = cacheFile()
  if (!refresh && fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < MAX_AGE_MS) {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  }
  const res = await fetch(MODCAT_URL, { headers: { 'user-agent': 'mod-box (https://github.com/LupusMalusDeviant/mod-box)' }, signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`catalogue: HTTP ${res.status}`)
  const data = slim(await res.json())
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data))
  return data
}

/** Every word must appear in name, description or repo; most stars first. */
export function search(mods, query, limit, inBox = () => false) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const hits = mods.filter(m => {
    const hay = `${m.name} ${m.description} ${m.repo}`.toLowerCase()
    return words.every(w => hay.includes(w))
  })
  hits.sort((a, b) => b.stars - a.stars || String(b.pushedAt).localeCompare(String(a.pushedAt)))
  return { total: hits.length, mods: hits.slice(0, limit).map(m => ({ ...m, inBox: inBox(m) })) }
}

export async function modcat(a, box) {
  const data = await load(a.refresh === true)
  // In the box already: an import whose source repo and upstream name match.
  const repoOf = url => String(url ?? '').toLowerCase().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '')
  const taken = new Set(box.mods.map(m => `${repoOf(m.source?.url)}|${String(m.upstream ?? m.id).toLowerCase()}`))
  const inBox = m => taken.has(`${m.repo.toLowerCase()}|${m.name.toLowerCase()}`)
  const limit = Math.max(1, Math.min(100, Number(a.limit ?? 25) || 25))
  const query = typeof a.query === 'string' ? a.query : '' // a bare --query is true
  return { ok: true, generated: data.generated, count: data.mods.length, page: MODCAT_PAGE, ...search(data.mods, query, limit, inBox) }
}

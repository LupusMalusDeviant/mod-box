// Package Guard: what the public registry says about a package. Run by the mod as
//   node registry.mjs <npm|pypi|crates> <name>
// Prints one JSON line: { exists, created, versions, latest, repo } or { error }. Reads only
// public registry metadata; sends nothing but the package name.
const [eco, name] = process.argv.slice(2)
const UA = { 'user-agent': 'mod-box-package-guard (https://github.com/LupusMalusDeviant/mod-box)' }

async function get(url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(8000) })
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

async function main() {
  if (!['npm', 'pypi', 'crates'].includes(eco) || !name) throw new Error('usage: registry.mjs <npm|pypi|crates> <name>')
  if (eco === 'npm') {
    const j = await get(`https://registry.npmjs.org/${name.replace('/', '%2F')}`)
    if (!j) return { exists: false }
    return { exists: true, created: j.time?.created ?? null, versions: Object.keys(j.versions ?? {}).length, latest: j['dist-tags']?.latest ?? null, repo: typeof j.repository === 'string' ? j.repository : j.repository?.url ?? null }
  }
  if (eco === 'pypi') {
    const j = await get(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`)
    if (!j) return { exists: false }
    const uploads = Object.values(j.releases ?? {}).flat().map(f => f.upload_time_iso_8601 ?? f.upload_time).filter(Boolean).sort()
    const urls = j.info?.project_urls ?? {}
    return { exists: true, created: uploads[0] ?? null, versions: Object.keys(j.releases ?? {}).length, latest: j.info?.version ?? null, repo: urls.Source ?? urls.Repository ?? urls.Homepage ?? j.info?.home_page ?? null }
  }
  const j = await get(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`)
  if (!j) return { exists: false }
  return { exists: true, created: j.crate?.created_at ?? null, versions: (j.versions ?? []).length, latest: j.crate?.max_version ?? null, repo: j.crate?.repository ?? null, downloads: j.crate?.downloads ?? null }
}

main().then(
  r => console.log(JSON.stringify(r)),
  err => console.log(JSON.stringify({ error: String(err?.message ?? err) })),
)

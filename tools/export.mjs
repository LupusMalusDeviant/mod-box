// Standalone exports: each mod of the box as a plugin of its own, for people who want one mod
// without the Mod Box. The code is the box's code; this file only gives it its own shell:
// plugin.json with its own options, state under its own plugin name, a small band of its own
// instead of the box's band manager, a README that says where it comes from.
//
//   node tools/box.mjs export <id> [<id> ...] --out <folder>
//       Writes <folder>/plugins/<name>/ for each mod, plus <folder>/.claude-plugin/marketplace.json
//       and <folder>/README.md listing them, so <folder> can be pushed as one marketplace repo.
import fs from 'node:fs'
import path from 'node:path'

const CODE = /\.(ts|tsx|js|mjs)$/
const USERCONFIG_FIELDS = ['type', 'title', 'description', 'default', 'options', 'sensitive', 'required', 'min', 'max', 'multiple']
const strip = o => Object.fromEntries(Object.entries(o).filter(([k]) => USERCONFIG_FIELDS.includes(k)))

function copyDir(from, to, skip = () => false) {
  if (!fs.existsSync(from)) return
  fs.mkdirSync(to, { recursive: true })
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name)
    const b = path.join(to, e.name)
    if (skip(e.name)) continue
    if (e.isDirectory()) copyDir(a, b, skip)
    else fs.copyFileSync(a, b)
  }
}

const IMPORT = /(?:import|export)\s[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g
const EXTENSIONS = ['', '.ts', '.tsx', '.js', '.mjs', '/index.ts']

/** Copies box files that the exported code imports but that are not in the export yet, until none is missing. */
function copyImports(dir, ROOT) {
  for (let round = 0; round < 10; round++) {
    let copied = 0
    for (const file of walk(dir).filter(p => CODE.test(p))) {
      for (const m of fs.readFileSync(file, 'utf8').matchAll(IMPORT)) {
        const spec = m[1] ?? m[2]
        const target = path.resolve(path.dirname(file), spec)
        if (EXTENSIONS.some(ext => fs.existsSync(target + ext))) continue
        const rel = path.relative(dir, target)
        if (rel.startsWith('..')) continue
        const ext = EXTENSIONS.find(x => fs.existsSync(path.join(ROOT, rel) + x) && fs.statSync(path.join(ROOT, rel) + x).isFile())
        if (ext === undefined) continue
        write(path.join(dir, rel) + ext, fs.readFileSync(path.join(ROOT, rel) + ext, 'utf8'))
        copied++
      }
    }
    if (copied === 0) return
  }
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

/** State references of the box (`{ plugin: 'mod-box', key: 'ho_note' }`) moved to the mod's own plugin. */
export function standaloneState(code, { plugin, prefix, name }) {
  const re = new RegExp(`plugin:\\s*(['"])${plugin}\\1,\\s*key:\\s*(['"])${prefix}_(\\w+)\\2`, 'g')
  let out = code.replace(re, (_m, q1, q2, key) => `plugin: ${q1}${name}${q1}, key: ${q2}${key}${q2}`)
  // The box-wide token ledger becomes the mod's own.
  const usage = new RegExp(`plugin:\\s*(['"])${plugin}\\1,\\s*key:\\s*(['"])mb_usage\\2`, 'g')
  const usesLedger = usage.test(out)
  out = out.replace(usage, (_m, q1, q2) => `plugin: ${q1}${name}${q1}, key: ${q2}usage${q2}`)
  return { code: out, usesLedger }
}

const MOD_USAGE_TYPE = `/** Model calls the mod made itself: counted per session, priced at list price. */
export type ModUsage = {
  calls: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  usd: number
  unpriced: number
}
`

function entryFile(m, inner) {
  const importPath = `../mods/${m.id}/hooks/${path.basename(m.entry).replace(/\.(tsx|ts)$/, '')}`
  if (!m.band) {
    return `// Entry of the standalone ${m.title}: the Mod Box code, registered on its own.\nimport type { Register } from 'claude-code'\n\nimport { register as ${inner} } from '${importPath}'\n\nexport const register: Register = (on, options) => {\n  ;(${inner} as any)(on, options)\n}\n`
  }
  return `// Entry of the standalone ${m.title}. The mod hands its display to a band (in the Mod Box the
// band manager draws it); here this hook, registered first and so the outermost, draws it below
// whatever else is above the prompt.
import type { Register } from 'claude-code'

import { register as ${inner} } from '${importPath}'
import { openBand, takeBand } from '../mods/settings/hooks/band'

export const register: Register = (on, options) => {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    openBand(e)
    const rest = await next(e)
    const parts = takeBand(e)
    if (e.props.hasSurvey || parts.length === 0) return rest
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {rest}
        {parts.map(p => (
          <Box key={\`band-\${p.id}\`} flexDirection="row" paddingX={1}>
            <Box flexShrink={1}>{p.line as any}</Box>
            {(p.actions as any[]).flatMap((a, i) => [<Text key={\`gap-\${i}\`}>{'  '}</Text>, a])}
          </Box>
        ))}
      </Box>
    )
  })
  ;(${inner} as any)(on, options)
}
`
}

function readmeOf(m, name, info) {
  const lines = [`# ${m.title}`, '', m.description, '']
  if (info.origin) {
    lines.push(`> **Fork.** Based on [${info.origin.label}](${info.origin.url}) by ${info.origin.author} (${info.origin.license}); modified for the [Mod Box](https://github.com/LupusMalusDeviant/mod-box): ${info.origin.changes}. Each changed file says so at the top.`, '')
  } else {
    lines.push(`Part of the [Mod Box](https://github.com/LupusMalusDeviant/mod-box), which bundles it with other mods and one window to switch and configure them all. This is the same mod on its own.`, '')
  }
  if (info.note) lines.push(info.note, '')
  lines.push('## Install', '', 'In a terminal Claude Code session (2.1.287 or newer):', '', '```', `/plugin install ${name} --marketplace ${info.repo}`, '```', '')
  // Other mods it works with: none is needed, each adds something.
  if (info.companions?.length) {
    lines.push('## Works with', '', `${m.title} needs no other mod. These add to it when installed beside it:`, '', '| Mod | What it adds | Without it |', '|---|---|---|')
    for (const c of info.companions) lines.push(`| ${c.mod} | ${c.adds} | ${c.without} |`)
    lines.push('')
  }
  if (m.commands?.length) {
    lines.push('## Commands', '', '| Command | What it does |', '|---|---|')
    for (const c of m.commands) lines.push(`| \`${c.name.replace(/\|/g, '\\|')}\` | ${c.en} |`)
    lines.push('')
  }
  const opts = info.options
  if (opts.length) {
    lines.push('## Options', '', 'Set them in `/config` (or when installing).', '', '| Option | Default | What it does |', '|---|---|---|')
    for (const [key, o] of opts) lines.push(`| \`${key}\` | \`${String(o.default ?? '')}\` | ${(o.description ?? o.title ?? '').replace(/\|/g, '\\|')} |`)
    lines.push('')
  }
  if (m.costs) lines.push('## Token cost', '', m.costs, '')
  lines.push('## License', '', info.origin ? `${info.origin.license}, see [LICENSE](LICENSE).` : 'MIT, see [LICENSE](LICENSE).', '')
  return lines.join('\n')
}

/**
 * @param {object} ctx { ROOT, box, version, mitText, repo }
 * @param {string[]} ids mods to export
 * @param {string} out target folder (the marketplace repo)
 * @param {Record<string, object>} origins per mod id: { label, url, author, license, changes } for forks
 */
export function exportMods(ctx, ids, out, origins = {}) {
  const { ROOT, box } = ctx
  const allOptions = [...(box.settings ?? []), ...box.mods.flatMap(m => m.options ?? [])]
  const done = []
  for (const id of ids) {
    const m = box.mods.find(x => x.id === id || x.toggle === id)
    if (!m) throw new Error(`no mod ${id}`)
    const name = m.state?.from ?? m.id
    const dir = path.join(out, 'plugins', name)
    fs.rmSync(dir, { recursive: true, force: true })

    // Code: the mod, what it embeds, and the two box helpers it may import (band, usage).
    copyDir(path.join(ROOT, 'mods', m.id), path.join(dir, 'mods', m.id), n => n === 'upstream.json' || n === 'index.d.ts')
    for (const extra of m.extraDirs ?? []) {
      const modDir = extra.split('/').slice(0, 2).join('/')
      copyDir(path.join(ROOT, modDir), path.join(dir, modDir), n => n === 'upstream.json')
    }
    for (const f of ['band.ts', 'usage.ts']) {
      const src = path.join(ROOT, 'mods', 'settings', 'hooks', f)
      if (walk(dir).some(p => CODE.test(p) && fs.readFileSync(p, 'utf8').includes(`settings/hooks/${f.replace(/\.ts$/, '')}`))) write(path.join(dir, 'mods', 'settings', 'hooks', f), fs.readFileSync(src, 'utf8'))
    }

    // Other files of the box the code imports by a relative path (another mod's data module, for
    // example): copied to the same place, so the import still resolves.
    copyImports(dir, ROOT)

    let usesLedger = false
    for (const f of walk(dir).filter(p => CODE.test(p) && !p.endsWith('.d.ts'))) {
      const r = m.state ? standaloneState(fs.readFileSync(f, 'utf8'), { plugin: box.plugin, prefix: m.state.prefix, name }) : { code: fs.readFileSync(f, 'utf8'), usesLedger: false }
      const r2 = standaloneState(r.code, { plugin: box.plugin, prefix: '__none__', name })
      usesLedger ||= r.usesLedger || r2.usesLedger
      fs.writeFileSync(f, r2.code)
    }

    // Types: the mod's own contract, plus the token ledger where the mod keeps one.
    let types = null
    const contract = path.join(dir, 'mods', m.id, 'types', 'contract.d.ts')
    if (fs.existsSync(contract)) {
      let c = fs.readFileSync(contract, 'utf8')
      if (usesLedger) {
        c = MOD_USAGE_TYPE + '\n' + c.replace(new RegExp(`(['"]?${name}['"]?\\s*:\\s*\\{)`), '$1 usage: Record<string, ModUsage>;')
      }
      fs.writeFileSync(contract, c)
      write(path.join(dir, 'mods', m.id, 'types', 'index.d.ts'), "export * from './contract'\n")
      types = `./mods/${m.id}/types/contract.d.ts`
    } else if (usesLedger) {
      write(contract, `${MOD_USAGE_TYPE}\ndeclare module 'claude-code' {\n  interface PluginState {\n    '${name}': { usage: Record<string, ModUsage> }\n  }\n}\n`)
      types = `./mods/${m.id}/types/contract.d.ts`
    }

    // Options under the names the code reads (field names), plus what the box passed in.
    const options = []
    for (const o of m.options ?? []) if (o.field && o.field !== '__show') options.push([o.field, strip(o)])
    for (const [field, from] of Object.entries(m.pass ?? {})) {
      const src = allOptions.find(o => o.key === from)
      if (!src || options.some(([k]) => k === field)) continue
      const o = strip({ ...src, title: src.title?.replace(/^[^:]+:\s*/, '') })
      if (field === 'language') o.description = 'Language of the texts this mod shows and writes.'
      options.push([field, o])
    }
    const origin = origins[m.id] ?? null
    const manifest = {
      name,
      version: ctx.version,
      description: m.description,
      author: { name: 'Lupus Malus Deviant' },
      license: origin ? origin.license : 'MIT',
      homepage: `https://github.com/${ctx.repo}/tree/main/plugins/${name}`,
      ...(types ? { types } : {}),
      ...(options.length ? { userConfig: Object.fromEntries(options) } : {}),
    }
    write(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n')
    write(path.join(dir, 'hooks', 'hooks.json'), JSON.stringify({ modules: [m.band ? './entry.tsx' : './entry.ts'] }) + '\n')
    write(path.join(dir, 'hooks', m.band ? 'entry.tsx' : 'entry.ts'), entryFile(m, 'inner'))
    write(path.join(dir, 'README.md'), readmeOf(m, name, { origin, repo: ctx.repo, options, note: (ctx.notes ?? {})[m.id], companions: (ctx.companions ?? {})[m.id] }))
    if (origin) {
      fs.copyFileSync(path.join(ROOT, 'mods', m.id, 'LICENSE'), path.join(dir, 'LICENSE'))
    } else {
      write(path.join(dir, 'LICENSE'), ctx.mitText)
    }
    const smoke = fs.readFileSync(path.join(ROOT, 'tools', 'standalone-smoke.test.txt'), 'utf8').replace('PLUGIN', JSON.stringify(name).replace(/"/g, "'"))
    write(path.join(dir, 'tests', 'smoke.test.ts'), smoke)
    done.push({ name, title: m.title, description: m.description, origin, embedsFork: !!(ctx.notes ?? {})[m.id], commands: (m.commands ?? []).map(c => c.name) })
  }

  write(path.join(out, '.github', 'workflows', 'ci.yml'), fs.readFileSync(path.join(ROOT, 'tools', 'standalone-ci.yml.txt'), 'utf8'))
  write(path.join(out, '.gitattributes'), '* text=auto eol=lf\n*.wav binary\n')

  // The marketplace around them.
  write(
    path.join(out, '.claude-plugin', 'marketplace.json'),
    JSON.stringify(
      {
        name: ctx.marketplace,
        owner: { name: 'Lupus Malus Deviant' },
        description: ctx.description ?? 'Single Claude Code mods from the Mod Box, each installable on its own.',
        plugins: done.map(d => ({ name: d.name, source: `./plugins/${d.name}`, description: d.description })),
      },
      null,
      2,
    ) + '\n',
  )
  return done
}

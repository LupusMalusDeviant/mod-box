// Native management: plugins the box cannot (or should not) carry inside itself stay plugins of
// their own, installed by Claude Code. The box drives them through the official CLI
// (`claude plugin install | enable | disable | configure | details | update | uninstall`) and keeps
// a small registry of its own next to it: which plugins it manages, whether you trust them, and
// the attributes profiles judge them by. Nothing here edits Claude Code's settings files directly.
//
// Registry: $MODBOX_HOME/native.json (default ~/.claude/mod-box/native.json)
//   { "plugins": { "<name>@<marketplace>": { managed, trusted, group, tokens, compat, source,
//                                              addedAt, changedAt } } }
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const HOME = () => process.env.MODBOX_HOME || path.join(os.homedir(), '.claude', 'mod-box')
const REGISTRY = () => path.join(HOME(), 'native.json')
const DIFFS = () => path.join(HOME(), 'native-diffs')

export function readRegistry() {
  try {
    const j = JSON.parse(fs.readFileSync(REGISTRY(), 'utf8'))
    return { plugins: j.plugins ?? {} }
  } catch {
    return { plugins: {} }
  }
}

function writeRegistry(reg) {
  fs.mkdirSync(HOME(), { recursive: true })
  fs.writeFileSync(REGISTRY(), JSON.stringify(reg, null, 2) + '\n')
}

/** Runs the Claude Code CLI. Values for configure go through stdin only, never through argv. */
export function cli(exe, args, { input = undefined, timeout = 300_000 } = {}) {
  try {
    const stdout = execFileSync(exe, args, { encoding: 'utf8', input, timeout, stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
    return { code: 0, stdout, stderr: '' }
  } catch (err) {
    return { code: typeof err.status === 'number' ? err.status : 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? err.message ?? '') }
  }
}

/** The JSON of a `--json` run (the whole output, or its last line that parses), or null. */
function jsonLine(text) {
  try {
    return JSON.parse(String(text).trim())
  } catch {
    // several lines: take the last one that parses
  }
  for (const line of String(text).trim().split('\n').reverse()) {
    const l = line.trim()
    if (!l.startsWith('{') && !l.startsWith('[')) continue
    try {
      return JSON.parse(l)
    } catch {
      // not this line
    }
  }
  return null
}

const firstLine = s => String(s).trim().split('\n').filter(Boolean).pop() ?? ''

/** All installed plugins as Claude Code reports them, plus what the box knows about each. */
export function list(exe, { self = 'mod-box' } = {}) {
  const r = cli(exe, ['plugin', 'list', '--json'])
  let installed = []
  try {
    installed = JSON.parse(r.stdout)
  } catch {
    throw new Error(`claude plugin list --json: ${firstLine(r.stderr) || firstLine(r.stdout)}`)
  }
  const reg = readRegistry()
  const out = installed
    .filter(p => !p.id.startsWith(self + '@'))
    .map(p => {
      const meta = reg.plugins[p.id] ?? null
      return {
        id: p.id,
        version: p.version ?? '',
        scope: p.scope,
        enabled: p.enabled === true,
        installPath: p.installPath ?? null,
        hasUserConfig: p.hasUserConfig === true,
        errors: (p.errors ?? []).map(String),
        notes: (p.notes ?? []).map(String),
        managed: meta?.managed === true,
        trusted: meta?.trusted === true,
        group: meta?.group ?? 'native',
        tokens: meta?.tokens ?? 'none',
        compat: meta?.compat ?? null,
        changedAt: meta?.changedAt ?? null,
        source: meta?.source ?? null,
      }
    })
  // Registry entries whose plugin is gone (uninstalled outside the box) are reported, not hidden.
  for (const [id, meta] of Object.entries(reg.plugins)) {
    if (!out.some(p => p.id === id)) out.push({ id, version: '', scope: null, enabled: false, installPath: null, hasUserConfig: false, errors: ['not installed any more'], notes: [], managed: meta.managed === true, trusted: meta.trusted === true, group: meta.group ?? 'native', tokens: meta.tokens ?? 'none', compat: meta.compat ?? null, changedAt: meta.changedAt ?? null, source: meta.source ?? null, missing: true })
  }
  return out
}

/** `claude plugin details` as data: component inventory and projected token cost. */
export function details(exe, id) {
  const r = cli(exe, ['plugin', 'details', id])
  if (r.code !== 0) throw new Error(firstLine(r.stderr) || firstLine(r.stdout) || `details ${id} failed`)
  return parseDetails(r.stdout)
}

export function parseDetails(text) {
  const components = {}
  for (const m of text.matchAll(/^\s+(Skills|Agents|Hooks|MCP servers|LSP servers|Commands|Output styles|Monitors|Workflows) \((\d+)\)[ \t]*([^\n]*)$/gm)) {
    const names = m[3].replace(/\s{2,}\(.*\)$/, '').split(',').map(s => s.trim()).filter(Boolean)
    components[m[1]] = { count: Number(m[2]), names }
  }
  const always = /Always-on:\s*~?\s*([<\d.,]+\s*\w*)\s*tok/.exec(text)?.[1]?.trim() ?? null
  const perComponent = []
  const table = text.split(/Per-component[^\n]*\n/)[1] ?? ''
  for (const line of table.split('\n')) {
    const m = /^\s{2}(\S+)\s+([<~\d.,k ]+?)\s{2,}([<~\d.,k ]+)$/.exec(line)
    if (m && m[1] !== 'component') perComponent.push({ name: m[1], alwaysOn: m[2].trim(), onInvoke: m[3].trim() })
  }
  return { components, tokens: { alwaysOn: always, perComponent } }
}

/** Options of a plugin: schema, which are set. Values of sensitive options are never returned. */
export function options(exe, id) {
  const r = cli(exe, ['plugin', 'configure', id, '--json'])
  const j = jsonLine(r.stdout)
  if (!j) throw new Error(firstLine(r.stderr) || firstLine(r.stdout) || `configure ${id} failed`)
  const fields = Object.entries(j.schema ?? {}).map(([key, s]) => ({
    key,
    type: s.type ?? 'string',
    title: s.title ?? key,
    description: s.description ?? '',
    sensitive: s.sensitive === true,
    required: s.required === true,
    options: Array.isArray(s.options) ? s.options : null,
    default: s.default ?? null,
    set: (j.configured ?? []).includes(key),
    // Plain values only; a sensitive one is never read back.
    value: s.sensitive ? null : (j.inputs ?? {})[key] ?? null,
  }))
  return { id, fields }
}

/** Saves option values. The values travel through stdin only and are never echoed or logged. */
export function setOptions(exe, id, values) {
  const clean = {}
  for (const [k, v] of Object.entries(values ?? {})) clean[k] = Array.isArray(v) ? v.map(String) : String(v)
  const r = cli(exe, ['plugin', 'configure', id, '--values-stdin'], { input: JSON.stringify(clean) })
  if (r.code !== 0) throw new Error(firstLine(r.stderr) || firstLine(r.stdout) || 'configure failed')
  touch(id)
  return { id, saved: Object.keys(clean), message: firstLine(r.stdout) }
}

function touch(id, patch = {}) {
  const reg = readRegistry()
  if (!reg.plugins[id]) return
  reg.plugins[id] = { ...reg.plugins[id], ...patch, changedAt: new Date().toISOString() }
  writeRegistry(reg)
}

/**
 * Installs a plugin natively and keeps it switched off until you trust it. `source` is a
 * marketplace source (owner/repo, git URL or a folder path) or empty when `plugin` is already
 * "name@marketplace" of an added marketplace. A marketplace-declared install command is never
 * accepted here: the result asks for confirmation with its sha256.
 */
export function install(exe, plugin, { source = null, meta = {}, acceptCommand = null } = {}) {
  const args = ['plugin', 'install', plugin, '--json']
  if (source) args.push('--marketplace', source)
  if (acceptCommand) args.push('--accept-command', acceptCommand)
  const r = cli(exe, args)
  const j = jsonLine(r.stdout) ?? jsonLine(r.stderr)
  if (j?.shownCommand) return { ok: false, confirm: { sha256: j.shownCommand.sha256, command: j.shownCommand.command ?? j.shownCommand.text ?? '' }, message: j.message ?? '' }
  if (r.code !== 0 || (j && j.outcome && j.outcome !== 'ok')) throw new Error(j?.message ?? (firstLine(r.stderr) || firstLine(r.stdout) || 'install failed'))
  const id = j?.pluginId ?? plugin
  // Foreign code stays off until trusted.
  const off = cli(exe, ['plugin', 'disable', id, '--json'])
  const reg = readRegistry()
  reg.plugins[id] = { managed: true, trusted: false, group: meta.group ?? 'native', tokens: meta.tokens ?? 'none', compat: meta.compat ?? null, source: source ?? id.split('@')[1] ?? null, addedAt: new Date().toISOString(), changedAt: new Date().toISOString() }
  writeRegistry(reg)
  return { ok: true, id, message: j?.message ?? firstLine(r.stdout), disabled: off.code === 0 || /already disabled/i.test(off.stderr + off.stdout) }
}

/** Takes an installed plugin under the box's management. One you installed yourself counts as trusted. */
export function adopt(id, meta = {}) {
  const reg = readRegistry()
  const old = reg.plugins[id] ?? null
  // Fresh attributes win; trust stays as it was (an install through the box starts untrusted).
  reg.plugins[id] = {
    source: id.split('@')[1] ?? null,
    addedAt: new Date().toISOString(),
    ...(old ?? {}),
    managed: true,
    trusted: old ? old.trusted === true : true,
    group: meta.group ?? old?.group ?? 'native',
    tokens: meta.tokens ?? old?.tokens ?? 'none',
    compat: meta.compat ?? old?.compat ?? null,
    changedAt: new Date().toISOString(),
  }
  writeRegistry(reg)
  return { ok: true, id }
}

export function setTrust(id, trusted) {
  const reg = readRegistry()
  if (!reg.plugins[id]) throw new Error(`${id} is not managed by the box`)
  reg.plugins[id] = { ...reg.plugins[id], trusted, changedAt: new Date().toISOString() }
  writeRegistry(reg)
  return { ok: true, id, trusted }
}

/** Switches a plugin. A managed plugin nobody trusted yet is not switched on. */
export function setEnabled(exe, id, enabled) {
  const meta = readRegistry().plugins[id]
  if (enabled && meta?.managed && !meta.trusted) throw new Error(`${id} is not trusted yet: trust it first (it is foreign code)`)
  const r = cli(exe, ['plugin', enabled ? 'enable' : 'disable', id, '--json'])
  const j = jsonLine(r.stdout)
  const already = /already (enabled|disabled)/i.test(r.stderr + r.stdout) || j?.failureCode === 'already_in_goal_state'
  if (r.code !== 0 && !already) throw new Error(j?.message ?? (firstLine(r.stderr) || firstLine(r.stdout) || 'failed'))
  touch(id)
  return { ok: true, id, enabled, unchanged: already, restart: !already }
}

function hashTree(dir) {
  const out = {}
  const walk = d => {
    if (!d || !fs.existsSync(d)) return
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out[path.relative(dir, p).replace(/\\/g, '/')] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex')
    }
  }
  walk(dir)
  return out
}

/**
 * Updates a plugin and records what changed: files added, removed and changed between the old and
 * the new installed copy, and a text diff of the changed text files (kept for the window).
 */
export function update(exe, id) {
  const before = list(exe).find(p => p.id === id)
  if (!before) throw new Error(`${id} is not installed`)
  const oldDir = before.installPath
  const oldHashes = hashTree(oldDir)
  // The old copy may be removed by the update: keep a temporary copy for the diff.
  const keep = oldDir && fs.existsSync(oldDir) ? fs.mkdtempSync(path.join(os.tmpdir(), 'mbx-old-')) : null
  if (keep) fs.cpSync(oldDir, keep, { recursive: true, filter: p => !/[\\/](\.git|node_modules)([\\/]|$)/.test(p) })
  const r = cli(exe, ['plugin', 'update', id, '--json'])
  const j = jsonLine(r.stdout) ?? jsonLine(r.stderr)
  if (j?.shownCommand) return { ok: false, confirm: { sha256: j.shownCommand.sha256, command: j.shownCommand.command ?? '' }, message: j.message ?? '' }
  if (r.code !== 0) {
    if (keep) fs.rmSync(keep, { recursive: true, force: true })
    throw new Error(j?.message ?? (firstLine(r.stderr) || firstLine(r.stdout) || 'update failed'))
  }
  const after = list(exe).find(p => p.id === id)
  const newHashes = hashTree(after?.installPath)
  const added = Object.keys(newHashes).filter(f => !(f in oldHashes))
  const removed = Object.keys(oldHashes).filter(f => !(f in newHashes))
  const changed = Object.keys(newHashes).filter(f => f in oldHashes && oldHashes[f] !== newHashes[f])
  let diffText = ''
  if (keep && after?.installPath && changed.length) {
    const d = cli('git', ['diff', '--no-index', '--no-color', '--stat', '-p', keep, after.installPath], { timeout: 60_000 })
    diffText = (d.stdout || '').slice(0, 200_000)
  }
  if (keep) fs.rmSync(keep, { recursive: true, force: true })
  fs.mkdirSync(DIFFS(), { recursive: true })
  const diffFile = path.join(DIFFS(), id.replace(/[^\w.-]/g, '_') + '.diff')
  fs.writeFileSync(diffFile, diffText)
  touch(id)
  return { ok: true, id, from: before.version, to: after?.version ?? '', added, removed, changed, diffFile, message: j?.message ?? firstLine(r.stdout), restart: true }
}

/** Uninstalls; with prune also dependencies nobody needs any more. */
export function uninstall(exe, id, { prune = false, keepData = false } = {}) {
  const args = ['plugin', 'uninstall', id]
  if (prune) args.push('--prune', '-y')
  else args.push('--json')
  if (keepData) args.push('--keep-data')
  const r = cli(exe, args)
  if (r.code !== 0) throw new Error(firstLine(r.stderr) || firstLine(r.stdout) || 'uninstall failed')
  const reg = readRegistry()
  delete reg.plugins[id]
  writeRegistry(reg)
  return { ok: true, id, message: firstLine(r.stdout) }
}

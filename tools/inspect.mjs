// Static inventory of a plugin folder and the verdict how the Mod Box can handle it. Nothing in the
// plugin is run: files are read and pattern-matched only.
//
//   integrate    the plugin is only function hooks (+ files, a type contract, plain options): the
//                box can carry it as a sub-mod without losing anything.
//   native       it has parts one plugin cannot carry per mod (skills, commands, agents, MCP/LSP
//                servers, settings hooks, dependencies, secrets ...): the box manages it as an
//                installed Claude Code plugin through `claude plugin ...`.
//   blocked      something must be decided or fixed first (a clashing command, no license, a
//                hooks module that is missing).
//   unsupported  not a plugin the box can do anything with.
import fs from 'node:fs'
import path from 'node:path'

const CODE = /\.(tsx?|jsx?|mjs|cjs|mts|cts)$/
const SKIP = new Set(['.git', 'node_modules'])

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const asList = v => (v == null ? [] : Array.isArray(v) ? v : [v])
const listDir = (dir, filter) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(filter) : [])
const keysOf = v => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : [])

/**
 * The license of a plugin: its manifest, a LICENSE file in its folder, or one further up as far as
 * `root` (a collection repo usually has one license at its top for all its plugins).
 */
function licenseOf(dir, manifest, root) {
  if (manifest?.license) return { license: manifest.license, licenseFile: null }
  let d = path.resolve(dir)
  const stop = root ? path.resolve(root) : d
  for (let i = 0; i < 6; i++) {
    const lf = listDir(d, n => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(n))[0]
    if (lf) {
      const text = fs.readFileSync(path.join(d, lf), 'utf8')
      const id = (text.match(/\b(MIT|Apache-2\.0|Apache License|BSD|ISC|MPL|LGPL|AGPL|GPL|Unlicense)\b/i) ?? [null, 'see ' + lf])[1]
      return { license: /^Apache License$/i.test(id) ? 'Apache-2.0' : id, licenseFile: path.join(d, lf) }
    }
    if (d === stop || path.dirname(d) === d) break
    d = path.dirname(d)
  }
  return { license: null, licenseFile: null }
}

/** Everything a plugin folder declares or ships, read without running anything. */
export function inventory(dir, { root = null } = {}) {
  const pj = path.join(dir, '.claude-plugin', 'plugin.json')
  const manifest = fs.existsSync(pj) ? readJson(pj) : null
  const hjPath = path.join(dir, 'hooks', 'hooks.json')
  let hooksJson = null
  if (fs.existsSync(hjPath)) {
    try {
      hooksJson = readJson(hjPath)
    } catch (err) {
      hooksJson = { __error: String(err.message ?? err) }
    }
  }
  const modules = asList(hooksJson?.modules).map(String)
  const missingModules = modules.filter(m => !fs.existsSync(path.resolve(path.dirname(hjPath), m)))
  const classicHooks = [...keysOf(hooksJson?.hooks)]
  if (manifest?.hooks) {
    if (typeof manifest.hooks === 'string' || Array.isArray(manifest.hooks)) classicHooks.push('(manifest hooks)')
    else classicHooks.push(...keysOf(manifest.hooks.hooks ?? manifest.hooks))
  }

  const skills = [
    ...listDir(path.join(dir, 'skills'), n => fs.existsSync(path.join(dir, 'skills', n, 'SKILL.md'))),
    ...asList(manifest?.skills).map(s => `(manifest) ${typeof s === 'string' ? s : JSON.stringify(s)}`),
  ]
  const commandFiles = manifest?.commands ? ['(manifest commands)'] : listDir(path.join(dir, 'commands'), n => n.endsWith('.md'))
  const agents = manifest?.agents ? ['(manifest agents)'] : listDir(path.join(dir, 'agents'), n => n.endsWith('.md'))
  let mcp = []
  if (fs.existsSync(path.join(dir, '.mcp.json'))) {
    try {
      const j = readJson(path.join(dir, '.mcp.json'))
      mcp = keysOf(j.mcpServers ?? j)
    } catch {
      mcp = ['(.mcp.json)']
    }
  }
  if (manifest?.mcpServers) mcp.push(...(keysOf(manifest.mcpServers).length ? keysOf(manifest.mcpServers) : ['(manifest mcpServers)']))
  let lsp = []
  if (fs.existsSync(path.join(dir, '.lsp.json'))) {
    try {
      lsp = keysOf(readJson(path.join(dir, '.lsp.json')))
    } catch {
      lsp = ['(.lsp.json)']
    }
  }
  if (manifest?.lspServers) lsp.push(...(keysOf(manifest.lspServers).length ? keysOf(manifest.lspServers) : ['(manifest lspServers)']))
  const other = []
  for (const [d, label] of [
    ['output-styles', 'output styles'],
    ['workflows', 'workflows'],
    ['themes', 'themes'],
    ['monitors', 'monitors'],
    ['bin', 'executables (bin/)'],
  ]) {
    if (fs.existsSync(path.join(dir, d))) other.push(label)
  }
  for (const k of ['outputStyles', 'workflows', 'channels']) if (manifest?.[k]) other.push(k)
  if (manifest?.experimental) other.push('experimental components')
  if (fs.existsSync(path.join(dir, 'settings.json')) || manifest?.settings) other.push('plugin settings')

  const options = Object.entries(manifest?.userConfig ?? {}).map(([key, o]) => ({
    key,
    type: o?.type ?? 'string',
    sensitive: o?.sensitive === true,
    required: o?.required === true,
    multiple: o?.multiple === true,
    hasDefault: o?.default !== undefined,
  }))
  const dependencies = asList(manifest?.dependencies).map(d => (typeof d === 'string' ? d : `${d.name}${d.version ? '@' + d.version : ''}`))

  // What the hooks module(s) register, read from the source text.
  const codeFiles = walk(dir).filter(f => CODE.test(f) && !f.endsWith('.d.ts') && !/[\\/](tests?|__tests__)[\\/]/.test(f))
  const code = codeFiles.map(f => fs.readFileSync(f, 'utf8')).join('\n')
  const commands = [...new Set([...code.matchAll(/command\.register\(\s*\{[^}]*?name:\s*['"`]([\w:-]+)/g)].map(m => '/' + m[1]))]
  const tools = [...new Set([...code.matchAll(/tool\.register\(\s*\{[^}]*?name:\s*['"`]([\w:-]+)/g)].map(m => m[1]))]
  const usesPluginEnv = /CLAUDE_PLUGIN_(ROOT|DATA)/.test(code)

  const { license, licenseFile } = licenseOf(dir, manifest, root)

  return {
    name: manifest?.name ?? path.basename(dir),
    version: manifest?.version ?? '',
    description: manifest?.description ?? '',
    license,
    licenseFile,
    hasManifest: !!manifest,
    hooksJsonError: hooksJson?.__error ?? null,
    modules,
    missingModules,
    classicHooks,
    skills,
    commandFiles,
    agents,
    mcp,
    lsp,
    other,
    options,
    dependencies,
    commands,
    tools,
    usesPluginEnv,
    types: manifest?.types ?? null,
  }
}

/** The short component list the window shows. */
export function componentsOf(inv) {
  return {
    modules: inv.modules,
    commands: inv.commands,
    tools: inv.tools,
    skills: inv.skills,
    commandFiles: inv.commandFiles,
    agents: inv.agents,
    mcp: inv.mcp,
    lsp: inv.lsp,
    classicHooks: inv.classicHooks,
    other: inv.other,
    options: inv.options.map(o => ({ key: o.key, type: o.type, sensitive: o.sensitive, required: o.required })),
    dependencies: inv.dependencies,
  }
}

/**
 * How the box can take this plugin. `taken` lists what the box already uses:
 * { commands: Map name -> mod id, tools: Map name -> mod id }; a re-import of the same mod passes
 * its own id as `self`. `strategy` "auto" integrates what can be integrated and manages the rest
 * natively; "native" manages every plugin natively (the box only switches and configures it).
 */
export function verdictOf(inv, { taken = { commands: new Map(), tools: new Map() }, self = null, acceptUnlicensed = false, strategy = 'auto', t = (_de, en) => en } = {}) {
  const reasons = []
  if (!inv.hasManifest && !inv.modules.length) return { verdict: 'unsupported', reasons: [t('Kein Plugin: weder .claude-plugin/plugin.json noch Hooks-Modul.', 'Not a plugin: no .claude-plugin/plugin.json and no hooks module.')] }
  if (inv.hooksJsonError) return { verdict: 'unsupported', reasons: [t(`hooks/hooks.json ist kein gültiges JSON: ${inv.hooksJsonError}`, `hooks/hooks.json is not valid JSON: ${inv.hooksJsonError}`)] }

  // Parts one plugin cannot carry per mod: they need the plugin installed as itself.
  const nativeParts = []
  if (inv.skills.length) nativeParts.push(`skills (${inv.skills.join(', ')})`)
  if (inv.commandFiles.length) nativeParts.push(`commands (${inv.commandFiles.join(', ')})`)
  if (inv.agents.length) nativeParts.push(`agents (${inv.agents.join(', ')})`)
  if (inv.mcp.length) nativeParts.push(`MCP servers (${inv.mcp.join(', ')})`)
  if (inv.lsp.length) nativeParts.push(`LSP servers (${inv.lsp.join(', ')})`)
  if (inv.classicHooks.length) nativeParts.push(`classic settings hooks (${inv.classicHooks.join(', ')})`)
  for (const o of inv.other) nativeParts.push(o)
  if (nativeParts.length) reasons.push(t(`Hat Teile, die nur ein eigenständig installiertes Plugin tragen kann: ${nativeParts.join('; ')}.`, `Has parts only a plugin installed as itself can carry: ${nativeParts.join('; ')}.`))
  if (inv.dependencies.length) reasons.push(t(`Hängt von anderen Plugins ab (${inv.dependencies.join(', ')}); Claude Code installiert sie mit.`, `Depends on other plugins (${inv.dependencies.join(', ')}); Claude Code installs them along.`))
  const secrets = inv.options.filter(o => o.sensitive).map(o => o.key)
  if (secrets.length) reasons.push(t(`Hat geheime Optionen (${secrets.join(', ')}); die verwahrt Claude Code im Schlüsselbund, nicht die Box.`, `Has sensitive options (${secrets.join(', ')}); Claude Code keeps those in the keychain, not the box.`))
  if (inv.usesPluginEnv) reasons.push(t('Der Code liest CLAUDE_PLUGIN_ROOT/CLAUDE_PLUGIN_DATA, die in der Box auf die Box zeigen würden.', 'The code reads CLAUDE_PLUGIN_ROOT/CLAUDE_PLUGIN_DATA, which inside the box would point to the box.'))
  const wantsNative = reasons.length > 0

  if (!inv.modules.length && !wantsNative) return { verdict: 'unsupported', reasons: [t('Das Plugin hat keine Bestandteile, die die Box kennt.', 'The plugin has no parts the box knows.')] }

  const integrate = !wantsNative && strategy !== 'native'
  // Blockers: decide or fix first.
  const blockers = []
  if (inv.missingModules.length) blockers.push(t(`Hooks-Modul fehlt: ${inv.missingModules.join(', ')}.`, `Hooks module missing: ${inv.missingModules.join(', ')}.`))
  if (integrate && !inv.license && !acceptUnlicensed) blockers.push(t('Keine Lizenz gefunden: ohne Lizenz darf der Code nicht in die Box kopiert werden (--accept-unlicensed, wenn er dir gehört).', 'No license found: without one the code may not be copied into the box (--accept-unlicensed if it is yours).'))
  if (integrate) {
    for (const [list, map, de, en] of [
      [inv.commands, taken.commands, 'Befehl', 'Command'],
      [inv.tools, taken.tools, 'Werkzeug', 'Tool'],
    ]) {
      for (const n of list) {
        const owner = map.get(n)
        if (owner && owner !== self) blockers.push(t(`${de} ${n} gibt es in der Box schon (${owner}).`, `${en} ${n} already exists in the box (${owner}).`))
      }
    }
  }
  if (blockers.length) return { verdict: 'blocked', reasons: [...blockers, ...reasons] }
  if (!integrate) {
    if (!wantsNative) reasons.push(t('Strategie „nativ“: auch reine Hook-Mods werden als eigenes Plugin verwaltet.', 'Strategy "native": plain hook mods are managed as plugins of their own too.'))
    return { verdict: 'native', reasons }
  }
  const notes = []
  if (inv.modules.length > 1) notes.push(t(`${inv.modules.length} Hooks-Module: Claude Code selbst lädt nur eines pro Plugin, die Box hängt alle ein.`, `${inv.modules.length} hooks modules: Claude Code itself loads only one per plugin, the box registers all of them.`))
  const required = inv.options.filter(o => o.required && !o.hasDefault).map(o => o.key)
  if (required.length) notes.push(t(`Pflichtoptionen (${required.join(', ')}): der Mod lässt sich erst einschalten, wenn sie gesetzt sind.`, `Required options (${required.join(', ')}): the mod can be switched on once they are set.`))
  return { verdict: 'integrate', reasons: notes }
}

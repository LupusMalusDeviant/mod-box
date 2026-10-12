// node --test tools/native.test.mjs
// Native management end to end, in a throwaway Claude Code profile (CLAUDE_CONFIG_DIR) with a local
// marketplace made of the fixture plugins: install (off until trusted), trust, switch, details,
// options with a secret, profiles, update with a diff, adopt, uninstall. Needs Claude Code on this
// machine; nothing touches your real profile.
import assert from 'node:assert/strict'
import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let tmp, env, market, exe

function box(args, input) {
  try {
    const out = execFileSync(process.execPath, [path.join(REPO, 'tools', 'box.mjs'), ...args, '--lang', 'en'], { encoding: 'utf8', env, input, timeout: 300_000, stdio: ['pipe', 'pipe', 'pipe'] })
    return { raw: out, ...JSON.parse(out.trim().split('\n').pop()) }
  } catch (err) {
    const out = String(err.stdout ?? '')
    return { raw: out + String(err.stderr ?? ''), ...JSON.parse(out.trim().split('\n').pop() || '{"ok":false}') }
  }
}

function claude(args) {
  return execFileSync(exe, args, { encoding: 'utf8', env, timeout: 300_000, stdio: ['ignore', 'pipe', 'pipe'] })
}

function findExe() {
  const base = path.join(process.env.APPDATA ?? '', 'Claude', 'claude-code')
  const found = []
  if (fs.existsSync(base)) for (const v of fs.readdirSync(base)) for (const h of fs.existsSync(path.join(base, v)) && fs.statSync(path.join(base, v)).isDirectory() ? fs.readdirSync(path.join(base, v)) : []) {
    const e = path.join(base, v, h, process.platform === 'win32' ? 'claude.exe' : 'claude')
    if (fs.existsSync(e)) found.push([v, e])
  }
  found.sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
  if (found.length) return found.pop()[1]
  // npm install -g (as in CI): the binary inside the package, not the .cmd shim
  try {
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim()
    const e = path.join(root, '@anthropic-ai', 'claude-code', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')
    if (fs.existsSync(e)) return e
  } catch {
    // no npm
  }
  return 'claude'
}

before(() => {
  // A short path: Windows refuses long ones inside git clones.
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mbn-'))
  market = path.join(tmp, 'market')
  fs.cpSync(path.join(REPO, 'tools', 'fixtures', 'plugins'), market, { recursive: true })
  env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(tmp, 'cfg'), MODBOX_HOME: path.join(tmp, 'mb') }
  delete env.CLAUDE_CODE_PLUGIN_DIRS
  fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true })
  exe = findExe()
  claude(['plugin', 'marketplace', 'add', market])
})
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('native management', () => {
  test('install: installed, but off and untrusted until you decide', () => {
    const r = box(['native', 'install', 'fx-mixed@modbox-fixtures'])
    assert.equal(r.ok, true, r.error)
    const p = box(['native', 'list']).plugins.find(x => x.id === 'fx-mixed@modbox-fixtures')
    assert.equal(p.enabled, false)
    assert.equal(p.managed, true)
    assert.equal(p.trusted, false)
    assert.equal(p.tokens, 'optional') // skills/agents/MCP put text into the context
  })

  test('no switching on before trust; after trust it works', () => {
    assert.equal(box(['native', 'enable', 'fx-mixed@modbox-fixtures']).ok, false)
    assert.equal(box(['native', 'trust', 'fx-mixed@modbox-fixtures']).ok, true)
    const r = box(['native', 'enable', 'fx-mixed@modbox-fixtures'])
    assert.equal(r.ok, true, r.error)
    assert.equal(r.restart, true)
    assert.equal(box(['native', 'list']).plugins.find(x => x.id === 'fx-mixed@modbox-fixtures').enabled, true)
  })

  test('details: every component and the token cost', () => {
    const r = box(['native', 'details', 'fx-mixed@modbox-fixtures'])
    assert.equal(r.ok, true, r.error)
    assert.equal(r.components.Skills.count, 2)
    assert.equal(r.components.Agents.count, 1)
    assert.deepEqual(r.components['MCP servers'].names, ['fx-server'])
    assert.ok(r.tokens.alwaysOn)
  })

  test('a secret is saved through stdin and never shown again', () => {
    assert.equal(box(['native', 'install', 'fx-secret@modbox-fixtures']).ok, true)
    const secret = 'fixture-' + Math.random().toString(36).slice(2) + Date.now()
    const set = box(['native', 'set', 'fx-secret@modbox-fixtures'], JSON.stringify({ apiKey: secret }))
    assert.equal(set.ok, true, set.error)
    assert.ok(!set.raw.includes(secret))
    const o = box(['native', 'options', 'fx-secret@modbox-fixtures'])
    assert.ok(!o.raw.includes(secret))
    const f = o.fields.find(x => x.key === 'apiKey')
    assert.equal(f.sensitive, true)
    assert.equal(f.set, true)
    assert.equal(f.value, null)
    assert.ok(!box(['native', 'list']).raw.includes(secret))
    // the registry of the box holds no values either
    assert.ok(!fs.readFileSync(path.join(env.MODBOX_HOME, 'native.json'), 'utf8').includes(secret))
  })

  test('profiles switch managed, trusted plugins by the same rules as the box mods', () => {
    const off = box(['native', 'profile', 'guards'])
    assert.equal(off.ok, true, off.error)
    assert.deepEqual(off.changes, [{ id: 'fx-mixed@modbox-fixtures', enabled: false }])
    // fx-secret is untrusted: profiles leave it alone
    assert.ok(!off.changes.some(c => c.id === 'fx-secret@modbox-fixtures'))
    const on = box(['native', 'profile', 'all'])
    assert.deepEqual(on.changes, [{ id: 'fx-mixed@modbox-fixtures', enabled: true }])
  })

  test('update: new version, with the changed files and a diff', () => {
    const pj = path.join(market, 'fx-mixed', '.claude-plugin', 'plugin.json')
    fs.writeFileSync(pj, fs.readFileSync(pj, 'utf8').replace('"1.0.0"', '"1.1.0"'))
    fs.appendFileSync(path.join(market, 'fx-mixed', 'skills', 'fx-skill', 'SKILL.md'), '\nA new line in 1.1.0.\n')
    claude(['plugin', 'marketplace', 'update', 'modbox-fixtures'])
    const r = box(['native', 'update', 'fx-mixed@modbox-fixtures'])
    assert.equal(r.ok, true, r.error)
    assert.equal(r.to, '1.1.0')
    assert.ok(r.changed.some(f => f.endsWith('SKILL.md')) || r.added.some(f => f.endsWith('SKILL.md')))
    assert.match(fs.readFileSync(r.diffFile, 'utf8'), /A new line in 1\.1\.0/)
  })

  test('adopt: a plugin you installed yourself comes under the box, trusted', () => {
    claude(['plugin', 'install', 'fx-classic@modbox-fixtures'])
    const r = box(['native', 'adopt', 'fx-classic@modbox-fixtures'])
    assert.equal(r.ok, true, r.error)
    const p = box(['native', 'list']).plugins.find(x => x.id === 'fx-classic@modbox-fixtures')
    assert.equal(p.managed, true)
    assert.equal(p.trusted, true)
  })

  test('a plugin folder without a marketplace goes through the box\'s local marketplace', () => {
    const src = path.join(tmp, 'folder-plugin')
    fs.cpSync(path.join(REPO, 'tools', 'fixtures', 'plugins', 'fx-lsp'), src, { recursive: true })
    const pj = path.join(src, '.claude-plugin', 'plugin.json')
    fs.writeFileSync(pj, fs.readFileSync(pj, 'utf8').replace(/fx-lsp/g, 'fx-folder'))
    const r = box(['native', 'install', 'fx-folder', '--dir', src])
    assert.equal(r.ok, true, r.error)
    assert.equal(r.id, 'fx-folder@mod-box-local')
    const p = box(['native', 'list']).plugins.find(x => x.id === 'fx-folder@mod-box-local')
    assert.equal(p.enabled, false)
    assert.equal(p.trusted, false)
  })

  test('built-in mods: switched through Claude Code, in this profile\'s user settings only', () => {
    // Which built-ins a build offers is asked once and cached; a fresh profile without sign-in is
    // offered none, so the cache is told this one is there.
    const first = box(['native', 'builtins'])
    assert.equal(first.ok, true, first.error)
    const cacheFile = path.join(env.MODBOX_HOME, 'builtins.json')
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
    cache.items['cc-plugin-you-should-know'] = { available: true, description: 'You should know: a side agent.' }
    fs.writeFileSync(cacheFile, JSON.stringify(cache))
    const off = box(['native', 'builtins']).builtins.find(b => b.name === 'you-should-know')
    assert.deepEqual([off.enabled, off.isDefault, off.switchable], [false, true, true])
    const on = box(['native', 'builtin-on', 'you-should-know'])
    assert.equal(on.ok, true, on.error)
    const settings = JSON.parse(fs.readFileSync(path.join(env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8'))
    assert.equal(settings.enabledPlugins['cc-plugin-you-should-know@builtin'], true)
    const now = box(['native', 'builtins']).builtins.find(b => b.name === 'you-should-know')
    assert.deepEqual([now.enabled, now.isDefault], [true, false])
    assert.equal(box(['native', 'builtin-off', 'you-should-know']).ok, true)
    // the locked ones are not switched here
    const locked = box(['native', 'builtin-off', 'sec-default'])
    assert.equal(locked.ok, false)
  })

  test('uninstall: gone from Claude Code and from the registry', () => {
    for (const id of ['fx-mixed@modbox-fixtures', 'fx-secret@modbox-fixtures', 'fx-classic@modbox-fixtures', 'fx-folder@mod-box-local']) {
      const r = box(['native', 'uninstall', id])
      assert.equal(r.ok, true, r.error)
    }
    const left = box(['native', 'list']).plugins.filter(p => p.id.endsWith('@modbox-fixtures') || p.id.endsWith('@mod-box-local'))
    assert.deepEqual(left, [])
  })
})

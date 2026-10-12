// node --test tools/lifecycle.test.mjs
// The whole lifecycle of foreign mods, run against a throwaway copy of the box: inspect, import,
// conflicts, rollback, update, remove. Each case uses a fixture plugin from tools/fixtures/plugins.
// Slow (each import builds and runs `claude plugin validate`), so it is a file of its own.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FIX = path.join(REPO, 'tools', 'fixtures', 'plugins')
let box // the sandbox copy

function copyRepo(to) {
  fs.cpSync(REPO, to, { recursive: true, filter: src => !/[\\/](\.git|node_modules)([\\/]|$)/.test(src.slice(REPO.length)) })
}

function run(...args) {
  try {
    const out = execFileSync(process.execPath, [path.join(box, 'tools', 'box.mjs'), ...args, '--lang', 'en'], { encoding: 'utf8', timeout: 240_000, stdio: ['ignore', 'pipe', 'pipe'] })
    return JSON.parse(out.trim().split('\n').pop())
  } catch (err) {
    const out = String(err.stdout ?? '').trim().split('\n').pop()
    try {
      return JSON.parse(out)
    } catch {
      throw err
    }
  }
}

const readBox = () => JSON.parse(fs.readFileSync(path.join(box, 'box.json'), 'utf8'))
const modOf = id => readBox().mods.find(m => m.id === id)
const exists = rel => fs.existsSync(path.join(box, rel))
const read = rel => fs.readFileSync(path.join(box, rel), 'utf8')

// A fingerprint of everything the box generates or owns, to prove a failed step changed nothing.
function stateHash() {
  const h = crypto.createHash('sha256')
  const files = ['box.json', '.claude-plugin/plugin.json', 'hooks/register.ts', 'types/index.d.ts', 'mods/settings/hooks/catalog.ts']
  for (const f of files) h.update(f + '\0' + (exists(f) ? read(f) : '-'))
  h.update(fs.readdirSync(path.join(box, 'mods')).sort().join(','))
  return h.digest('hex')
}

before(() => {
  box = fs.mkdtempSync(path.join(os.tmpdir(), 'mbx-'))
  copyRepo(box)
})
after(() => fs.rmSync(box, { recursive: true, force: true }))

describe('inspect: what a plugin is, before anything runs', () => {
  test('a clean function-hook mod can be integrated', () => {
    const r = run('inspect', '--dir', path.join(FIX, 'fx-plain'))
    assert.equal(r.ok, true)
    assert.equal(r.plugins[0].verdict, 'integrate')
    assert.deepEqual(r.plugins[0].components.commands, ['/fx-plain'])
  })
  for (const [name, reason] of [
    ['fx-mixed', /skills|commands|agents|mcp/i],
    ['fx-classic', /classic hooks|settings hooks/i],
    ['fx-secret', /sensitive|secret/i],
    ['fx-dep', /depend/i],
    ['fx-lsp', /lsp/i],
  ]) {
    test(`${name} is managed natively, with the reason`, () => {
      const r = run('inspect', '--dir', path.join(FIX, name))
      assert.equal(r.plugins[0].verdict, 'native')
      assert.match(r.plugins[0].reasons.join(' '), reason)
    })
  }
  test('a plugin that Claude Code refuses (two hook modules) can still be integrated', () => {
    const r = run('inspect', '--dir', path.join(FIX, 'fx-multi'))
    assert.equal(r.plugins[0].verdict, 'integrate')
    assert.equal(r.plugins[0].components.modules.length, 2)
  })
  test('a command that clashes with the box is a blocker', () => {
    const r = run('inspect', '--dir', path.join(FIX, 'fx-dup'))
    assert.equal(r.plugins[0].verdict, 'blocked')
    assert.match(r.plugins[0].reasons.join(' '), /\/ci/)
  })
  test('no license is a blocker unless accepted', () => {
    const r = run('inspect', '--dir', path.join(FIX, 'fx-nolicense'))
    assert.equal(r.plugins[0].verdict, 'blocked')
    assert.match(r.plugins[0].reasons.join(' '), /licen/i)
  })
})

describe('import into the box', () => {
  test('a clean mod: imported, off, untrusted, command and options kept', () => {
    const r = run('import', '--dir', path.join(FIX, 'fx-plain'))
    assert.equal(r.ok, true, r.error)
    const m = modOf('fx-plain')
    assert.equal(m.default, false)
    assert.deepEqual(m.commands.map(c => c.name), ['/fx-plain'])
    assert.deepEqual(m.options.find(o => o.field === 'greeting').options, ['hi', 'moin'])
    assert.deepEqual(r.lost ?? [], [])
  })

  test('a mod added later is part of every profile, by the rule of each profile', () => {
    const cat = read('mods/settings/hooks/catalog.ts')
    const start = cat.indexOf('= [', cat.indexOf('export const PROFILES')) + 2
    const profiles = JSON.parse(cat.slice(start, cat.indexOf('\n]', start) + 2))
    const toggle = modOf('fx-plain').toggle
    const setOf = id => Object.fromEntries(profiles.find(p => p.id === id).set)
    assert.equal(setOf('default')[toggle], false) // imported mods default to off
    assert.equal(setOf('lean')[toggle], true) // tokens: none
    assert.equal(setOf('guards')[toggle], false) // not a guard
    assert.equal(setOf('all')[toggle], true)
  })

  test('a folder with spaces and umlauts in its path', () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mbx ')), 'Mein Ordner ü', 'fx-required')
    fs.cpSync(path.join(FIX, 'fx-required'), dir, { recursive: true })
    const r = run('inspect', '--dir', dir)
    assert.equal(r.ok, true, r.error)
    assert.equal(r.plugins[0].verdict, 'integrate')
  })

  test('Windows paths: a backslash folder path imports like a forward-slash one', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
    const back = path.join(FIX, 'fx-required').split('/').join('\\')
    const forward = back.split('\\').join('/')
    assert.equal(run('inspect', '--dir', forward).plugins[0].verdict, 'integrate')
    const r = run('inspect', '--dir', back)
    assert.equal(r.ok, true, r.error)
    assert.equal(r.plugins[0].verdict, 'integrate')
  })

  test('every hook module is registered, options keep their types', () => {
    const r = run('import', '--dir', path.join(FIX, 'fx-multi'))
    assert.equal(r.ok, true, r.error)
    const disp = read('hooks/register.ts')
    assert.match(disp, /fx-multi\/hooks\/alpha/)
    assert.match(disp, /fx-multi\/hooks\/beta/)
    assert.match(disp, /optNumber\(o, "fxMultiCount", 3\)/)
    assert.match(disp, /optBool\(o, "fxMultiLoud", false\)/)
  })

  test('files outside hooks/ (media, docs) come along and their paths still resolve', () => {
    const r = run('import', '--dir', path.join(FIX, 'fx-assets'))
    assert.equal(r.ok, true, r.error)
    assert.ok(exists('mods/fx-assets/media/hello.txt'))
    assert.ok(exists('mods/fx-assets/docs/help.txt'))
    assert.ok(exists('mods/fx-assets/media/ding.wav'))
    const code = read('mods/fx-assets/hooks/register.ts')
    assert.match(code, /asset: 'mods\/fx-assets\/media\/ding\.wav'/)
    assert.match(code, /\$\{\$\.plugin\.root\}\/mods\/fx-assets\/media\/hello\.txt/)
  })

  test('literal $.store keys get the mod prefix, so they cannot clash with other mods', () => {
    const r = run('import', '--dir', path.join(FIX, 'fx-store'))
    assert.equal(r.ok, true, r.error)
    const code = read('mods/fx-store/hooks/register.ts')
    const p = modOf('fx-store').state?.prefix ?? modOf('fx-store').storePrefix
    assert.match(code, new RegExp(`\\$\\.store\\.set\\('${p}:deadline'`))
    assert.match(code, new RegExp(`\\$\\.store\\.set\\(\`${p}:guard\``))
  })

  test('a required option does not make the whole box unloadable', () => {
    const r = run('import', '--dir', path.join(FIX, 'fx-required'))
    assert.equal(r.ok, true, r.error)
    const manifest = JSON.parse(read('.claude-plugin/plugin.json'))
    assert.equal(manifest.userConfig.fxRequiredEndpoint.required, undefined)
    assert.deepEqual(modOf('fx-required').needs ?? modOf('fx-required').requiredOptions, ['fxRequiredEndpoint'])
  })

  for (const name of ['fx-mixed', 'fx-classic', 'fx-secret', 'fx-dep', 'fx-lsp']) {
    test(`${name}: refused for the box, nothing changes, the native way is named`, () => {
      const before = stateHash()
      const r = run('import', '--dir', path.join(FIX, name))
      assert.equal(r.ok, false)
      assert.equal(r.verdict, 'native')
      assert.equal(stateHash(), before)
      assert.equal(modOf(name), undefined)
    })
  }

  test('a clashing command: refused, nothing changes', () => {
    const before = stateHash()
    const r = run('import', '--dir', path.join(FIX, 'fx-dup'))
    assert.equal(r.ok, false)
    assert.equal(stateHash(), before)
  })

  test('no license: refused unless accepted explicitly', () => {
    const before = stateHash()
    assert.equal(run('import', '--dir', path.join(FIX, 'fx-nolicense')).ok, false)
    assert.equal(stateHash(), before)
    const r = run('import', '--dir', path.join(FIX, 'fx-nolicense'), '--accept-unlicensed')
    assert.equal(r.ok, true, r.error)
  })
})

describe('update, rollback, remove', () => {
  test('a broken update rolls back to the working state', () => {
    // A copy of fx-plain whose next version does not parse.
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'mbx-src-'))
    fs.cpSync(path.join(FIX, 'fx-plain'), src, { recursive: true })
    // its own name and command, so it does not clash with fx-plain
    const pj = path.join(src, '.claude-plugin', 'plugin.json')
    fs.writeFileSync(pj, fs.readFileSync(pj, 'utf8').replace(/fx-plain/g, 'fx-broken'))
    const hp = path.join(src, 'hooks', 'register.ts')
    fs.writeFileSync(hp, fs.readFileSync(hp, 'utf8').replace(/fx-plain/g, 'fx-broken'))
    const r1 = run('import', '--dir', src, '--as', 'fx-broken')
    assert.equal(r1.ok, true, r1.error)
    const before = stateHash()
    fs.writeFileSync(path.join(src, 'hooks', 'register.ts'), 'export const register = (on => {\n')
    const r2 = run('reimport', 'fx-broken', '--dir', src)
    assert.equal(r2.ok, false)
    assert.equal(stateHash(), before)
    fs.rmSync(src, { recursive: true, force: true })
  })

  test('an update of a folder original: seen, diffed and merged', () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'mbx-up-'))
    fs.cpSync(path.join(FIX, 'fx-assets'), src, { recursive: true })
    for (const f of ['.claude-plugin/plugin.json', 'hooks/register.ts']) {
      const p = path.join(src, f)
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/fx-assets/g, 'fx-upd'))
    }
    const r1 = run('import', '--dir', src)
    assert.equal(r1.ok, true, r1.error)
    assert.equal(run('updates', 'fx-upd').mods[0].status, 'current')
    fs.writeFileSync(path.join(src, 'media', 'hello.txt'), 'hello from version 2\n')
    fs.writeFileSync(path.join(src, 'media', 'ding.wav'), Buffer.from([82, 73, 70, 70, 0, 1, 2, 3, 0, 9]))
    const u = run('updates', 'fx-upd').mods[0]
    assert.equal(u.status, 'update')
    assert.deepEqual(u.changed.sort(), ['media/ding.wav', 'media/hello.txt'])
    assert.match(run('diff', 'fx-upd').diff, /hello from version 2/)
    const m = run('update', 'fx-upd')
    assert.equal(m.ok, true, m.error)
    assert.equal(read('mods/fx-upd/media/hello.txt').trim(), 'hello from version 2')
    assert.deepEqual([...fs.readFileSync(path.join(box, 'mods/fx-upd/media/ding.wav'))], [82, 73, 70, 70, 0, 1, 2, 3, 0, 9])
    fs.rmSync(src, { recursive: true, force: true })
  })

  test('remove takes away code, options and baseline', () => {
    const r = run('remove', 'fx-plain')
    assert.equal(r.ok, true, r.error)
    assert.equal(modOf('fx-plain'), undefined)
    assert.equal(exists('mods/fx-plain'), false)
    assert.equal(JSON.parse(read('.claude-plugin/plugin.json')).userConfig.fxPlainGreeting, undefined)
  })

  test('the box still validates after all of this', () => {
    assert.equal(run('validate').ok, true)
  })
})

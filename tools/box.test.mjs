// node --test tools/
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { analyze, errorsOf, parseLink, prefixMembers, rewrite, ruleSays } from './box.mjs'

test('parseLink: short form, GitHub tree, other git URLs', () => {
  assert.deepEqual(parseLink('hamzafer/claude-code-mods'), { clone: 'https://github.com/hamzafer/claude-code-mods.git', ref: null, sub: '' })
  assert.deepEqual(parseLink('https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods/blast-radius'), {
    clone: 'https://github.com/anthropics/claude-code-playground.git',
    ref: 'main',
    sub: 'claude-code/mods/blast-radius',
  })
  assert.deepEqual(parseLink('https://github.com/a/b.git'), { clone: 'https://github.com/a/b.git', ref: null, sub: '' })
  assert.equal(parseLink('git@gitlab.com:x/y.git').clone, 'git@gitlab.com:x/y.git')
})

test('prefixMembers: one per line, several per line, nested, comments', () => {
  assert.equal(prefixMembers('\n  tree: FileTree\n  theme: Theme\n', 'ft'), '\n  ft_tree: FileTree\n  ft_theme: Theme\n')
  assert.equal(prefixMembers(' job: Job | null; busy: boolean ', 'sg'), ' sg_job: Job | null; sg_busy: boolean ')
  assert.equal(prefixMembers('a: { inner: number; deep: { x: 1 } }\nb: Array<{ k: string }>', 'p'), 'p_a: { inner: number; deep: { x: 1 } }\np_b: Array<{ k: string }>')
  assert.equal(prefixMembers('/** doc: nicht anfassen */\nsel: string | null', 'vc'), '/** doc: nicht anfassen */\nvc_sel: string | null')
  assert.equal(prefixMembers("'quoted-key': number", 'q'), 'q_quoted-key: number')
  assert.equal(prefixMembers('isOpen: StateFamily<boolean>\nf: (a: number) => void', 'x'), 'x_isOpen: StateFamily<boolean>\nx_f: (a: number) => void')
})

test('rewrite: own state, state of other box mods, matchers, paths, tools', () => {
  const src = [
    "const a = atom({ plugin: 'demo', key: 'items' } as const, [])",
    "const b = { key: 'flag', plugin: \"demo\" }",
    "const c = { plugin: 'next-steps', key: 'active' } as const",
    "const d = { plugin: 'fremd', key: 'x' }",
    "on('turn.complete', async ($, e, next) => next(e))",
    "on('ui.render', { component: 'Pane' }, async ($, e, next) => next(e))",
    "on(\"tool.call\", hook)",
    "const f = await $.fs.read($.plugin.root + '/INSTRUCTIONS.md')",
    'const g = `${$.plugin.root}/assets/x.png`',
    "const TOOL = 'mcp__demo__go'",
  ].join('\n')
  const r = rewrite(src, { upstream: 'demo', prefix: 'dm', id: 'demo', plugin: 'mod-box', prefixes: { 'next-steps': 'ns' } })
  const lines = r.code.split('\n')
  assert.equal(lines[0], "const a = atom({ plugin: 'mod-box', key: 'dm_items' } as const, [])")
  assert.equal(lines[1], "const b = { key: 'dm_flag', plugin: 'mod-box' }")
  assert.equal(lines[2], "const c = { plugin: 'mod-box', key: 'ns_active' } as const")
  assert.equal(lines[3], "const d = { plugin: 'fremd', key: 'x' }")
  assert.equal(lines[4], "on('turn.complete', {}, async ($, e, next) => next(e))")
  assert.equal(lines[5], "on('ui.render', { component: 'Pane' }, async ($, e, next) => next(e))")
  assert.equal(lines[6], 'on("tool.call", {}, hook)')
  assert.equal(lines[7], "const f = await $.fs.read($.plugin.root + '/mods/demo/INSTRUCTIONS.md')")
  assert.equal(lines[8], 'const g = `${$.plugin.root}/mods/demo/assets/x.png`')
  assert.equal(lines[9], "const TOOL = 'mcp__mod-box__go'")
  assert.equal(r.stateRefs, 2)
  assert.equal(r.notes.length, 1)
  assert.match(r.notes[0], /fremd/)
})

test('errorsOf: only the error lines', () => {
  const out = [
    'Validating marketplace manifest: x',
    '⚠ Found 1 warning:',
    '  ❯ description: nope',
    'Validating hooks: y',
    '✘ Found 1 error:',
    '  ❯ modules../register.ts: mod-box: a.ts does not parse: Unexpected ;',
    '✘ Validation failed',
  ].join('\n')
  assert.equal(errorsOf(out), 'mod-box: a.ts does not parse: Unexpected ;')
})

import { localPath, mergeText } from './box.mjs'

test('localPath: the contract is called contract.d.ts here', () => {
  assert.equal(localPath('types/index.d.ts', './types/index.d.ts'), 'types/contract.d.ts')
  assert.equal(localPath('hooks/register.tsx', './types/index.d.ts'), 'hooks/register.tsx')
  assert.equal(localPath('README.md', null), 'README.md')
})

test('mergeText: upstream change and own change in different places', () => {
  const base = 'a\nb\nc\nd\ne\nf\ng\n'
  const ours = 'a\nB-unsere\nc\nd\ne\nf\ng\n'
  const theirs = 'a\nb\nc\nd\ne\nf\nG-original\n'
  const r = mergeText(ours, base, theirs)
  assert.equal(r.conflicts, 0)
  assert.equal(r.text, 'a\nB-unsere\nc\nd\ne\nf\nG-original\n')
})

test('mergeText: the same place gives a conflict', () => {
  const r = mergeText('a\nunsere\nc\n', 'a\nb\nc\n', 'a\noriginal\nc\n')
  assert.equal(r.conflicts, 1)
  assert.match(r.text, /<<<<<<< mod-box/)
})

test('mergeText: Windows line endings do not count as a difference', () => {
  const r = mergeText('a\r\nb\r\nc\r\n', 'a\nb\nc\n', 'a\nb\nC\n')
  assert.equal(r.conflicts, 0)
  assert.equal(r.text, 'a\nb\nC\n')
})

test('ruleSays: profiles as rules reach new mods too', () => {
  const guard = { toggle: 'newGuard', group: 'guards', tokens: 'none', default: false }
  const chatty = { toggle: 'chatty', group: 'watchers', tokens: 'always', default: true }
  assert.equal(ruleSays('defaults', guard), false)
  assert.equal(ruleSays('defaults', chatty), true)
  assert.equal(ruleSays('all', guard), true)
  assert.equal(ruleSays({ group: ['guards'] }, guard), true)
  assert.equal(ruleSays({ group: ['guards'] }, chatty), false)
  assert.equal(ruleSays({ tokens: ['none', 'optional'] }, chatty), false)
  assert.equal(ruleSays({ all: false, on: ['chatty'] }, chatty), true)
})

test('analyze: a first guess at group, tokens, commands and where it runs', () => {
  const guard = analyze("on('tool.call', {}, async ($, e, next) => ({ deny: 'no' })); await $.process.run(['gh', 'pr']); $.command.register({ name: 'guardme' })")
  assert.equal(guard.group, 'guards')
  assert.equal(guard.tokens, 'none')
  assert.deepEqual(guard.commands, ['/guardme'])
  assert.deepEqual(guard.compat.needs, ['gh'])
  const pane = analyze("on('ui.render', { component: 'Pane' }, x); const { Box, Raster } = $.ui.resolve(e)")
  assert.equal(pane.group, 'display')
  assert.deepEqual(pane.compat.surfaces, ['terminal'])
  const win = analyze("await $.process.run(['powershell', '-c']); await $.model.complete({})")
  assert.deepEqual(win.compat.os, ['windows'])
  assert.equal(win.tokens, 'always')
})

test('reachOf: what a mod may do, read from its $ calls', async () => {
  const { reachOf } = await import('./box.mjs')
  const r = reachOf("await $.fs.read(p); await $.process.run(['gh', 'pr', 'view']); $.process.spawn({ argv: ['tail', '-f', x] }); await $.config.set({})")
  assert.equal(r.reads, true)
  assert.equal(r.writes, false)
  assert.equal(r.runs, true)
  assert.deepEqual(r.programs, ['gh', 'tail'])
  assert.equal(r.network, true) // gh talks to GitHub
  assert.equal(r.settings, true)
  assert.equal(r.model, false)
  const quiet = reachOf("on('ui.render', { component: 'AssistantMessage' }, (_$, e, next) => next(e))")
  assert.deepEqual([quiet.reads, quiet.writes, quiet.runs, quiet.network], [false, false, false, false])
  assert.equal(reachOf('await $.http.get(url)').network, true)
})

test('standaloneState: box state keys move to the mod plugin, the token ledger too', async () => {
  const { standaloneState } = await import('./export.mjs')
  const code = "const a = atom({ plugin: 'mod-box', key: 'hu_note' } as const, null)\nconst U = { plugin: 'mod-box', key: 'mb_usage' } as const\nconst other = { plugin: 'mod-box', key: 'ci_watch' }"
  const r = standaloneState(code, { plugin: 'mod-box', prefix: 'hu', name: 'heads-up' })
  assert.match(r.code, /plugin: 'heads-up', key: 'note'/)
  assert.match(r.code, /plugin: 'heads-up', key: 'usage'/)
  assert.match(r.code, /plugin: 'mod-box', key: 'ci_watch'/)
  assert.equal(r.usesLedger, true)
})

test('modcat: slims the catalogue and searches it by words, most stars first', async () => {
  const { slim, search } = await import('./modcat.mjs')
  const data = slim({
    generated: 'g',
    mods: [
      { name: 'a', repo: 'x/a', description: 'shows a diff', reach: { level: 1, name: 'draws', labels: ['draws'] }, stars: 5, validate: { status: 'passed' } },
      { name: 'b', repo: 'x/b', description: 'side by side diff view', stars: 50 },
      { name: 'old', repo: 'x/old', description: 'diff', stars: 99, archived: true },
      { name: 'agents-md', repo: 'anthropics/claude-code', description: 'diff', kind: 'builtin', stars: 1000 },
    ],
  })
  assert.equal(data.mods.length, 2)
  assert.equal(data.mods[0].validated, 'passed')
  const hits = search(data.mods, 'diff', 10, m => m.name === 'a')
  assert.deepEqual(hits.mods.map(m => [m.name, m.inBox]), [['b', false], ['a', true]])
  assert.equal(search(data.mods, 'side view', 10).total, 1)
  assert.equal(search(data.mods, '', 1).total, 2)
})

test('inspect: a dual license as LICENSE-MIT and LICENSE-APACHE counts, the MIT text named by its first sentence', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { inventory } = await import('./inspect.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-lic-'))
  try {
    fs.mkdirSync(path.join(dir, 'hooks'))
    fs.writeFileSync(path.join(dir, 'hooks', 'hooks.json'), '{ "modules": ["./register.ts"] }')
    fs.writeFileSync(path.join(dir, 'hooks', 'register.ts'), 'export const register = () => {}')
    fs.writeFileSync(path.join(dir, 'LICENSE-APACHE'), '                                 Apache License\n                           Version 2.0, January 2004\n')
    fs.writeFileSync(path.join(dir, 'LICENSE-MIT'), 'Copyright (c) 2026 Someone\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\n')
    const inv = inventory(dir)
    assert.equal(inv.license, 'Apache-2.0 OR MIT')
    assert.deepEqual(inv.licenseFiles.map(f => path.basename(f)), ['LICENSE-APACHE', 'LICENSE-MIT'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// Claude Code 2.1.287 refuses a whole hooks module when a function handed $ is declared a second
// time in the same file (a local const of the same name included): the box would not load (#19).
test('marketplace: every plugin in plugins/ is there with its own name and version', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const mp = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8'))
  const listed = mp.plugins.filter(p => p.source.startsWith('./plugins/'))
  assert.deepEqual(listed.map(p => p.source.slice('./plugins/'.length)).sort(), fs.readdirSync(path.join(root, 'plugins')).sort())
  for (const p of listed) {
    const pj = JSON.parse(fs.readFileSync(path.join(root, p.source, '.claude-plugin', 'plugin.json'), 'utf8'))
    assert.equal(pj.name, p.name)
    assert.equal(pj.version, p.version)
  }
  assert.ok(listed.some(p => p.name === 'relay'), 'relay ships in the marketplace')
})

test('no function handed $ is declared twice in a hooks file', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  const files = [path.join(root, 'hooks', 'register.ts')]
  for (const mod of fs.readdirSync(path.join(root, 'mods'))) {
    const dir = path.join(root, 'mods', mod, 'hooks')
    if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (/\.tsx?$/.test(f)) files.push(path.join(dir, f))
  }
  const twice = []
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8')
    const handed = new Set([...src.matchAll(/\bfunction\s+(\w+)\s*(?:<[^>]*>)?\s*\(\s*\$\s*[:,)]/g)].map(m => m[1]))
    for (const name of handed) {
      const lines = [...src.matchAll(new RegExp(String.raw`\b(?:const|let|var|function)\s+${name}\b`, 'g'))].map(m => src.slice(0, m.index).split('\n').length)
      if (lines.length > 1) twice.push(`${path.relative(root, file)}: ${name} (lines ${lines.join(', ')})`)
    }
  }
  assert.deepEqual(twice, [])
})

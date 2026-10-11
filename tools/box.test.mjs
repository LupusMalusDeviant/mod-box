// node --test tools/
import assert from 'node:assert/strict'
import { test } from 'node:test'

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

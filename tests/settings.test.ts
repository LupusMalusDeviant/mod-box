import { describe, expect, mock, test } from 'claude-code/testing'

import { failedLinks, findPrefix } from '../mods/settings/hooks/register'

// The tests read the German texts; the box itself defaults to English.
const DE = { options: { language: 'de' } }

const PANE = { component: 'Pane', requestId: 'mod-box-settings', props: { bodyColumns: 100 } }
const owner = { plugin: 'mod-box', tier: 'user' }

function rows() {
  return [
    { key: 'theme', label: 'Theme', kind: 'choice', value: 'dark', options: ['dark', 'light'], provider: { plugin: 'engine', tier: 'core' }, isLocked: false },
    { key: 'mod-box.blastRadius', label: 'Blast Radius', description: 'Hält riskante Befehle an.', kind: 'boolean', value: true, provider: owner, isLocked: false },
    { key: 'mod-box.headsUp', label: 'Heads-up (You Should Know)', description: 'Kostet je längerer Antwort einen kleinen Haiku-Aufruf.', kind: 'boolean', value: false, provider: owner, isLocked: false },
    { key: 'mod-box.savvyProgress', label: 'Savvy Progress', kind: 'boolean', value: true, provider: owner, isLocked: false },
    { key: 'mod-box.savvyLanguage', label: 'Savvy Progress: Sprache', kind: 'choice', value: 'auto', options: ['auto', 'en', 'ru'], provider: owner, isLocked: false },
    { key: 'mod-box.filetree', label: 'Filetree', kind: 'boolean', value: true, provider: owner, isLocked: false },
    { key: 'mod-box.filetreeOpen', label: 'Filetree: Öffnen mit', kind: 'text', value: '', provider: owner, isLocked: false },
  ]
}

let clock: any = null

function engine(on: any, extra: unknown[] = []) {
  clock = mock.clock(on)
  mock.store(on)
  const sets: Array<{ key: string; value: unknown }> = []
  on('command.register', () => ({ value: {} }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('config.list', () => ({ value: [...rows(), ...extra] }))
  on('config.set', (_$: any, e: any) => {
    sets.push({ key: e.key, value: e.value })
    return { value: e.value }
  })
  return sets
}

const pane = ($: any, surface: 'terminal' | 'desktop') => $.ui.mount({ plugin: 'mod-box', surface, ...PANE })

describe('Settings window', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`shows only the box rows (${surface})`, DE, async ($: any, on: any) => {
      engine(on)
      const ui = await pane($, surface)
      expect(await ui.find({ type: 'Text', text: /Blast Radius/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /💰/ })).toBeDefined()
      expect(await ui.find({ key: 'sel-savvyLanguage' })).toBeUndefined() // collapsed
      await ui.press({ key: 'exp-savvyProgress' })
      expect(await ui.find({ type: 'Text', text: /^Theme$/ })).toBeUndefined()
      expect(await ui.find({ key: 'sel-savvyLanguage' })).toBeDefined()
    })

    test(`saves switches and parameters via config.set (${surface})`, DE, async ($: any, on: any) => {
      const sets = engine(on)
      const ui = await pane($, surface)
      await ui.press({ key: 't-headsUp' })
      await ui.press({ key: 't-blastRadius' })
      await ui.press({ key: 'exp-savvyProgress' })
      await ui.press({ key: 'exp-filetree' })
      await ui.select({ key: 'sel-savvyLanguage', value: 'en' })
      await ui.input({ key: 'in-filetreeOpen', text: 'code {path}' })
      expect(sets).toEqual([
        { key: 'mod-box.headsUp', value: true },
        { key: 'mod-box.blastRadius', value: false },
        { key: 'mod-box.savvyLanguage', value: 'en' },
        { key: 'mod-box.filetreeOpen', value: 'code {path}' },
      ])
    })
  }
})

describe('Profiles and sources', () => {
  test('profile "lean" sets only the differing switches', DE, async ($: any, on: any) => {
    const sets = engine(on)
    const ui = await pane($, 'terminal')
    await ui.press({ key: 'tab-profiles' })
    await ui.press({ key: 'prof-b-lean' })
    expect(sets).toEqual([
      { key: 'mod-box.savvyProgress', value: false },
      { key: 'mod-box.filetree', value: false },
    ])
  })

  test('sources: show the catalog and import a mod', DE, async ($: any, on: any) => {
    engine(on)
    const calls: string[][] = []
    on('process.run', (_$: any, e: any) => {
      calls.push([...e.argv])
      const out = e.argv[2] === 'catalog'
        ? { ok: true, sources: [{ kind: 'link', name: 'sammlung', link: 'owner/repo', dir: '/c', plugins: [
            { name: 'token-weather', description: 'Wetter', isMod: true, extras: [], imported: null },
            { name: 'skills-only', description: 'nur Skills', isMod: false, extras: ['skills'], imported: null },
          ] }] }
        : { ok: true, id: 'token-weather', toggle: 'tokenWeather', notes: ['Hinweis A'] }
      return { value: { exitCode: 0, stdout: JSON.stringify(out) + '\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('command.run', () => ({ text: '' }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const ui = await pane($, 'terminal')
    await ui.press({ key: 'tab-sources' })
    await ui.input({ key: 'link-new', text: 'owner/repo' })
    expect(calls.filter(c => c[2] === 'catalog').at(-1)?.slice(3)).toEqual(['--url', 'owner/repo', '--lang', 'de'])
    expect(await ui.find({ type: 'Text', text: /token-weather/ })).toBeDefined()
    expect(await ui.find({ key: 'imp-owner/repo-skills-only' })).toBeUndefined()
    await ui.press({ key: 'imp-owner/repo-token-weather' })
    const imp = calls.find(c => c[2] === 'import')
    expect(imp?.[1]?.endsWith('/tools/box.mjs')).toBe(true)
    expect(imp?.slice(2)).toEqual(['import', '--url', 'owner/repo', '--plugin', 'token-weather', '--lang', 'de'])
    expect(await ui.find({ type: 'Text', text: /Hinweis A/ })).toBeDefined()
  })
})

describe('Language and design', () => {
  test('English UI', { options: { language: 'en' } }, async ($: any, on: any) => {
    engine(on)
    const ui = await pane($, 'terminal')
    expect(await ui.find({ key: 'tab-profiles' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /13 on/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /General/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /kostet Token/ })).toBeUndefined()
  })

})

describe('Upstream updates', () => {
  test('check, show the diff, apply', DE, async ($: any, on: any) => {
    engine(on)
    const calls: string[][] = []
    const opened: string[] = []
    on('command.run', () => ({ text: '' }))
    on('ui.open', (_$: any, e: any) => {
      opened.push(e.id)
      return { value: { isPlaced: true } }
    })
    on('process.run', (_$: any, e: any) => {
      const argv = [...e.argv]
      calls.push(argv)
      const cmd = argv[2]
      const out =
        cmd === 'updates'
          ? { ok: true, mods: [
              { id: 'blast-radius', status: 'update', from: 'aaa1111', to: 'bbb2222', changed: ['hooks/blast-radius.mjs'], added: [], removed: [] },
              { id: 'filetree', status: 'current', from: 'ccc3333', to: 'ccc3333', changed: [], added: [], removed: [] },
            ] }
          : cmd === 'diff'
            ? { ok: true, from: 'aaa1111', to: 'bbb2222', diff: '--- a/hooks/blast-radius.mjs\n+++ b/hooks/blast-radius.mjs\n@@ -1 +1 @@\n-alt\n+neu\n' }
            : { ok: true, from: 'aaa1111', to: 'bbb2222', files: 1, notes: [] }
      return { value: { exitCode: 0, stdout: JSON.stringify(out) + '\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    const ui = await pane($, 'terminal')
    await ui.press({ key: 'tab-sources' })
    await ui.press({ key: 'upd-check' })
    expect(await ui.find({ type: 'Text', text: /aaa1111 → bbb2222/ })).toBeDefined()
    expect(await ui.find({ key: 'upd-apply-filetree' })).toBeUndefined()
    await ui.press({ key: 'upd-diff-blast-radius' })
    expect(opened).toContain('mod-box-diff')
    await ui.press({ key: 'upd-apply-blast-radius' })
    expect(calls.find(c => c[2] === 'update')?.slice(2, 4)).toEqual(['update', 'blast-radius'])
    expect(await ui.find({ type: 'Text', text: /Update blast-radius/ })).toBeDefined()
  })
})

describe('Diagnosis', () => {
  test('detects failed box hooks in the trace', () => {
    const trace = [
      { plugin: 'mod-box', outcome: 'returned' },
      { plugin: 'mod-box', outcome: 'kept' },
      { plugin: 'mod-box', outcome: 'skipped', reason: 'bypassed by other' },
      { plugin: 'mod-box', outcome: 'skipped' },
      { plugin: 'fremd', outcome: 'expired' },
      { plugin: 'engine', outcome: 'returned' },
    ]
    expect(failedLinks(trace, 'mod-box')).toEqual(['kept', 'skipped'])
  })

  test('failing hooks show up in the tab', DE, async ($: any, on: any) => {
    // Deliberately without command.register: the session.start hooks that register commands fail.
    clock = mock.clock(on)
    mock.store(on)
    on('ui.toast', () => ({ value: undefined }))
    on('config.list', () => ({ value: rows() }))
    on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
    on('session.id', () => ({ value: 's' }))
    on('session.cwd', () => ({ value: '/work' }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
    on('env.get', () => ({ value: undefined }))
    on('fs.exists', () => ({ value: false }))
    on('fs.stat', () => ({ value: undefined }))
    on('session.version', () => ({ value: { version: '2.1.293' } }))
    on('process.run', () => ({ value: { exitCode: 0, stdout: 'v1\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await clock.advance(5000)
    const ui = await pane($, 'terminal')
    await ui.press({ key: 'tab-diag' })
    expect(await ui.find({ type: 'Text', text: /✘ session\.start/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /command\.register/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /in Frage/ })).toBeDefined()
  })
})

describe('Prefix of the /config rows', () => {
  test('mod-box. and mod-box@marketplace. are recognised', () => {
    expect(findPrefix(['theme', 'mod-box.blastRadius'], 'mod-box', ['blastRadius'])).toBe('mod-box.')
    expect(findPrefix(['theme', 'mod-box@mod-box.language', 'mod-box@mod-box.blastRadius'], 'mod-box', ['blastRadius'])).toBe('mod-box@mod-box.')
    expect(findPrefix(['other.blastRadius'], 'mod-box', ['blastRadius'])).toBe(null)
  })
})

describe('Without /config rows (desktop app)', () => {
  test('builds the rows itself and writes settings.json', DE, async ($: any, on: any) => {
    mock.clock(on)
    mock.store(on)
    let file = JSON.stringify({ model: 'opus', pluginConfigs: { 'mod-box@inline': { options: { filetreeGlyphs: 'nerd' } } } })
    on('config.list', () => ({ value: [{ key: 'theme', label: 'Theme', kind: 'choice', value: 'dark', options: ['dark'], provider: { plugin: 'engine', tier: 'core' }, isLocked: false }] }))
    on('config.set', () => ({ deny: 'no row' }))
    on('ui.toast', () => ({ value: undefined }))
    on('env.get', (_$: any, e: any) => ({ value: e.name === 'USERPROFILE' ? 'C:/Users/x' : undefined }))
    on('fs.read', () => ({ value: file }))
    on('fs.write', (_$: any, e: any) => {
      if (/settings\.json$/.test(e.path)) file = e.text
      return { value: undefined }
    })
    on('command.run', () => ({ text: '' }))
    const ui = await $.ui.mount({ plugin: 'mod-box', surface: 'desktop', ...PANE })
    expect(await ui.find({ type: 'Text', text: /Keine Einstellungen/ })).toBeUndefined()
    expect(await ui.find({ key: 't-headsUp' })).toBeDefined()
    await ui.press({ key: 't-headsUp' })
    const saved = JSON.parse(file)
    expect(saved.model).toBe('opus')
    expect(saved.pluginConfigs['mod-box@inline'].options).toEqual({ filetreeGlyphs: 'nerd', headsUp: true })
  })
})

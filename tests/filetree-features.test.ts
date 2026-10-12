import { describe, expect, mock, test } from 'claude-code/testing'

// The file tree's Features tab: the Codebase Map's features next to the files, its actions through
// the Codebase Map's own command.
const PANE = { component: 'Pane', requestId: 'filetree', props: { bodyColumns: 100, placement: 'right', scroll: { bodyRows: 40 } } }
// A small blueprint, read by the Codebase Map at session start as it would be from the repo.
const FILES: Record<string, string> = {
  '/w/docs/blueprints/INDEX.md': [
    '# Blueprint',
    '',
    '| Feature | Purpose | File |',
    '|---|---|---|',
    '| Core | The engine. | [core.md](./core.md) |',
    '| CLI | The command line. | [cli.md](./cli.md) |',
    '',
    '```mermaid',
    'graph LR',
    '  cli[CLI] --> core[Core]',
    '```',
  ].join('\n'),
  '/w/docs/blueprints/core.md': '# Core\n\n## Files\n\n- `src/core.ts`\n',
  '/w/docs/blueprints/cli.md': '# CLI\n\n## Files\n\n- `src/cli.ts`\n',
}

// The engine resolves paths for the system it runs on (X:\w\... on Windows): compare without drive and backslashes.
const norm = (p: unknown) => String(p).replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

// command.run from a pane is queued until the session is idle
const settle = () => new Promise(done => (globalThis as any).setTimeout(done, 50))

const TOASTS: string[] = []
const OPENED: string[] = []

const boot = async ($: any, on: any, filled: string[] = []) => {
  mock.clock(on); mock.store(on)
  on('session.id', () => ({ value: 's' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 1, window: 200000, percent: 0 }, rateLimits: [] } }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('command.register', (_$: any, e: any) => ({ value: { command: e.name } }))
  on('config.list', () => ({ value: [] }))
  on('env.get', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', (_$: any, e: any) => {
    OPENED.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', (_$: any, e: any) => {
    TOASTS.push(String(e.text ?? e.message ?? JSON.stringify(e)))
    return { value: undefined }
  })
  on('session.cwd', () => ({ value: '/w' }))
  on('session.root', () => ({ value: '/w' }))
  on('fs.exists', (_$: any, e: any) => ({ value: norm(e.path) in FILES }))
  on('fs.read', (_$: any, e: any) => {
    const p = norm(e.path)
    return p in FILES ? { value: FILES[p] } : { deny: 'none' }
  })
  on('fs.list', (_$: any, e: any) =>
    norm(e.path).replace(/\/$/, '') === '/w/docs/blueprints'
      ? { value: ['INDEX.md', 'core.md', 'cli.md'].map(name => ({ name, kind: 'file' })) }
      : { value: [] })
  on('fs.stat', () => ({ deny: 'none' }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('prompt.fill', (_$: any, e: any) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('command.list', () => ({ value: [] }))
  on('tool.register', () => ({ value: {} }))
  on('session.messages', () => ({ value: [] }))
  on('command.run', () => ({ text: 'NOBODY' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' })
}

describe('File tree: Features tab', () => {
  test('with the Codebase Map on: features, their links, and the actions of the map', { options: { codebaseMap: true, filetree: true, language: 'en' } }, async ($: any, on: any) => {
    const filled: string[] = []
    await boot($, on, filled)
    const ui = await $.ui.mount({ plugin: 'mod-box', surface: 'terminal', ...PANE })
    expect(await ui.find({ key: 'tab-features' })).toBeDefined()
    await ui.press({ key: 'tab-features' })
    expect(await ui.find({ type: 'Text', text: /2 Features/ })).toBeDefined()
    await ui.press({ key: 'fs-cli' })
    // CLI uses Core; Core's button opens Core
    expect(await ui.find({ key: 'fd-core' })).toBeDefined()
    expect(await ui.find({ key: 'ffb-src/cli.ts' })).toBeDefined()
    await ui.press({ key: 'fa-feature-update' })
    await settle()
    expect(filled.at(-1)).toMatch(/update the blueprint for the feature "CLI"/)
    await ui.press({ key: 'fa-check' })
    await settle()
    expect(filled.at(-1)).toMatch(/blueprint/i)
    await ui.press({ key: 'fa-map' })
    await settle()
    expect(OPENED).toContain('codebase-map')
    await ui.unmount()
  })

  test('with the Codebase Map off: no tabs, the tree as before', { options: { codebaseMap: false, filetree: true } }, async ($: any, on: any) => {
    await boot($, on)
    const ui = await $.ui.mount({ plugin: 'mod-box', surface: 'terminal', ...PANE })
    expect(await ui.find({ key: 'tab-features' })).toBeUndefined()
    await ui.unmount()
  })
})

describe('Codebase Map command', () => {
  test('/codebase-map update <feature> prepares the prompt for that one feature', { options: { codebaseMap: true, language: 'en' } }, async ($: any, on: any) => {
    const filled: string[] = []
    await boot($, on, filled)
    await $.command.run({ command: 'codebase-map', args: 'update core' })
    expect(filled.at(-1)).toMatch(/update the blueprint for the feature "Core"/)
    const r = await $.command.run({ command: 'codebase-map', args: 'update nothing-like-it' })
    expect(r.text).toMatch(/Usage/)
  })
})

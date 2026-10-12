import { describe, expect, mock, test } from 'claude-code/testing'

const PANE = { component: 'Pane', requestId: 'mod-box-settings', props: { bodyColumns: 100 } }
const DE = { options: { language: 'de' } }
const SECRET = 'never-' + 'shown-' + 'value'

const LIST = [
  { id: 'skills-pack@market', version: '1.2.0', enabled: true, managed: true, trusted: true, group: 'native', tokens: 'optional', hasUserConfig: true, errors: [], changedAt: null },
  { id: 'foreign@market', version: '0.1.0', enabled: false, managed: true, trusted: false, group: 'native', tokens: 'none', hasUserConfig: false, errors: [], changedAt: null },
  { id: 'csharp-lsp@claude-plugins-official', version: '1.0.0', enabled: true, managed: false, trusted: false, group: 'native', tokens: 'none', hasUserConfig: false, errors: [], changedAt: null },
]

function engine(on: any) {
  mock.clock(on)
  mock.store(on)
  const calls: string[][] = []
  on('command.register', () => ({ value: {} }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.copy', () => ({ value: undefined }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 1, window: 200000, percent: 0 }, rateLimits: [] } }))
  on('config.list', () => ({ value: [{ key: 'mod-box.blastRadius', label: 'Blast Radius', kind: 'boolean', value: true, provider: { plugin: 'mod-box', tier: 'user' }, isLocked: false }] }))
  on('env.get', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.id', () => ({ value: 's' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.messages', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => ({ deny: 'none' }))
  on('fs.list', () => ({ value: [] }))
  on('fs.stat', () => ({ deny: 'none' }))
  on('command.list', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('process.run', (_$: any, e: any) => {
    const argv = [...e.argv] as string[]
    calls.push(argv)
    const [, , cmd, action] = argv
    let out: any = { ok: true }
    if (cmd === 'native' && action === 'list') out = { ok: true, plugins: LIST }
    else if (cmd === 'native' && action === 'details') out = { ok: true, components: { Skills: { count: 2, names: ['a', 'b'] }, 'MCP servers': { count: 1, names: ['srv'] } }, tokens: { alwaysOn: '120' } }
    else if (cmd === 'native' && action === 'options')
      out = { ok: true, fields: [
        { key: 'apiKey', type: 'string', title: 'API key', description: '', sensitive: true, required: false, options: null, default: null, set: true, value: null },
        { key: 'mode', type: 'string', title: 'Mode', description: '', sensitive: false, required: false, options: ['fast', 'slow'], default: 'fast', set: true, value: 'fast' },
      ] }
    else if (cmd === 'native' && action === 'builtins')
      out = { ok: true, builtins: [
        { id: 'cc-plugin-you-should-know@builtin', name: 'you-should-know', description: 'You should know: a side agent watches your back.', enabled: false, isDefault: true, switchable: true, note: null },
        { id: 'cc-plugin-telemetry@builtin', name: 'telemetry', description: 'Telemetry: analytics events.', enabled: true, isDefault: true, switchable: false, note: 'analytics' },
      ] }
    else if (cmd === 'native') out = { ok: true, restart: true }
    return { value: { exitCode: 0, stdout: JSON.stringify(out) + '\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.run', () => ({ text: '' }))
  return calls
}

async function open($: any) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'mod-box', args: '' })
  await new Promise(done => (globalThis as any).setTimeout(done, 30))
  return $.ui.mount({ plugin: 'mod-box', surface: 'terminal', ...PANE })
}

describe('Natively managed plugins in the window', () => {
  test('managed and other installed plugins are listed', DE, async ($: any, on: any) => {
    engine(on)
    const ui = await open($)
    expect(await ui.find({ type: 'Text', text: /Nativ verwaltet/ })).toBeDefined()
    expect(await ui.find({ key: 'nt-skills-pack@market' })).toBeDefined()
    expect(await ui.find({ key: 'nt-foreign@market' })).toBeDefined()
    expect(await ui.find({ key: 'nad-csharp-lsp@claude-plugins-official' })).toBeDefined()
  })

  test('an untrusted plugin is not switched on', DE, async ($: any, on: any) => {
    const calls = engine(on)
    const ui = await open($)
    await ui.press({ key: 'nt-foreign@market' })
    expect(calls.some(c => c[2] === 'native' && c[3] === 'enable')).toBe(false)
    await ui.press({ key: 'nt-skills-pack@market' })
    expect(calls.some(c => c[2] === 'native' && c[3] === 'disable' && c[4] === 'skills-pack@market')).toBe(true)
  })

  test('details: parts and token cost; a secret has no field and no value', DE, async ($: any, on: any) => {
    engine(on)
    const ui = await open($)
    await ui.press({ key: 'nx-skills-pack@market' })
    await new Promise(done => (globalThis as any).setTimeout(done, 30))
    expect(await ui.find({ type: 'Text', text: /Skills \(2\): a, b/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /~120 Token/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /🔑 gesetzt/ })).toBeDefined()
    expect(await ui.find({ key: 'nin-skills-pack@market-apiKey' })).toBeUndefined()
    expect(await ui.find({ key: 'ns-skills-pack@market-apiKey' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: new RegExp(SECRET) })).toBeUndefined()
    expect(await ui.find({ key: 'nsel-skills-pack@market-mode' })).toBeDefined()
  })

  test('a plain option goes through stdin, never as an argument', DE, async ($: any, on: any) => {
    const calls = engine(on)
    const ui = await open($)
    await ui.press({ key: 'nx-skills-pack@market' })
    await new Promise(done => (globalThis as any).setTimeout(done, 30))
    await ui.select({ key: 'nsel-skills-pack@market-mode', value: 'slow' })
    const set = calls.find(c => c[2] === 'native' && c[3] === 'set')
    expect(set).toBeDefined()
    expect(set!.join(' ')).not.toContain('slow')
  })

  test('trust, then the active profile decides; adopt takes over an installed plugin', DE, async ($: any, on: any) => {
    const calls = engine(on)
    const ui = await open($)
    await ui.press({ key: 'nx-foreign@market' })
    await new Promise(done => (globalThis as any).setTimeout(done, 30))
    await ui.press({ key: 'ntr-foreign@market' })
    expect(calls.some(c => c[2] === 'native' && c[3] === 'trust' && c[4] === 'foreign@market')).toBe(true)
    expect(calls.some(c => c[2] === 'native' && c[3] === 'profile')).toBe(true)
    await ui.press({ key: 'nad-csharp-lsp@claude-plugins-official' })
    expect(calls.some(c => c[2] === 'native' && c[3] === 'adopt' && c[4] === 'csharp-lsp@claude-plugins-official')).toBe(true)
  })

  test('Claude Code\'s built-in mods: listed, switchable ones switched through the CLI', DE, async ($: any, on: any) => {
    const calls = engine(on)
    const ui = await open($)
    await new Promise(done => (globalThis as any).setTimeout(done, 50))
    expect(await ui.find({ type: 'Text', text: /Eingebaut in Claude Code/ })).toBeDefined()
    expect(await ui.find({ key: 'bt-you-should-know' })).toBeDefined()
    // telemetry follows the analytics setting: shown, but no switch
    expect(await ui.find({ key: 'bt-telemetry' })).toBeUndefined()
    await ui.press({ key: 'bt-you-should-know' })
    await new Promise(done => (globalThis as any).setTimeout(done, 50))
    expect(calls.some(c => c.includes('builtin-on') && c.includes('you-should-know'))).toBe(true)
  })
})

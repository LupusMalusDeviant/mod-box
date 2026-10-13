import { describe, expect, mock, test } from 'claude-code/testing'

import { maskDeep, maskText, parseTerms } from '../mods/screen-mask/hooks/mask'

const QUIET = { language: 'en', filetree: false, savvyProgress: false, replayTheater: false, cacheMeter: false, readGuard: false, packageGuard: false }
const RULES = { terms: ['Acme Corp', 'bluebird'], user: 'lupus', emails: true, ips: true }
const BS = String.fromCharCode(92)
const WIN_PATH = ['C:', 'Users', 'lupus', 'x'].join(BS)
// Built at run time so this file holds no key-shaped string.
const KEY = ['sk', 'ant', 'api03', 'A'.repeat(24)].join('-')

function engine(on: any) {
  mock.clock(on)
  mock.store(on)
  on('command.register', () => ({ value: {} }))
  on('tool.register', () => ({ value: {} }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('session.id', () => ({ value: 's' }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('env.get', (_$: any, e: any) => ({ value: e.name === 'USERNAME' ? 'lupus' : undefined }))
  // What Claude Code would draw: the text it was handed.
  on('ui.render', ($: any, e: any) => $.ui.resolve(e).Text({ children: String(e.props?.text ?? 'below') }))
}

describe('Screen Mask', () => {
  test('hides keys, e-mails, IPs, the login name in paths and listed terms', () => {
    const out = maskText('key ' + KEY + ' mail a.b@example.org ip 10.1.2.3 path ' + WIN_PATH + ' and /home/lupus/y; ACME corp ships Bluebird', RULES)
    expect(out).not.toContain(KEY)
    expect(out).toContain('[e-mail]')
    expect(out).toContain('[ip]')
    expect(out).toContain(['C:', 'Users', '•••', 'x'].join(BS))
    expect(out).toContain('/home/•••/y')
    expect(out).not.toMatch(/acme corp|bluebird/i)
  })

  test('leaves loopback, documentation IPs, placeholders and other words alone', () => {
    const out = maskText('127.0.0.1 192.0.2.4 lupusmalus bluebirds', RULES)
    expect(out).toBe('127.0.0.1 192.0.2.4 lupusmalus bluebirds')
  })

  test('masks every string inside tool input objects', () => {
    const out = maskDeep({ command: 'ssh 10.0.0.9', nested: [{ to: 'x@y.de' }], n: 3 }, s => maskText(s, RULES))
    expect(out).toEqual({ command: 'ssh [ip]', nested: [{ to: '[e-mail]' }], n: 3 })
  })

  test('terms: comma or newline, short ones dropped', () => {
    expect(parseTerms('Acme, b,\nBluebird ')).toEqual(['Acme', 'Bluebird'])
  })

  test('/mask switches the drawing only', { options: { ...QUIET, screenMask: true } }, async ($: any, on: any) => {
    engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' })
    const props = { text: 'write to a.b@example.org' }
    let ui = await $.ui.mount({ plugin: 'mod-box', surface: 'terminal', component: 'AssistantMessage', props })
    expect(await ui.find({ type: 'Text', text: /a\.b@example\.org/ })).toBeDefined()
    await $.command.run({ command: 'mask', args: 'on' })
    ui = await $.ui.mount({ plugin: 'mod-box', surface: 'terminal', component: 'AssistantMessage', props })
    expect(await ui.find({ type: 'Text', text: /\[e-mail\]/ })).toBeDefined()
    expect(props.text).toBe('write to a.b@example.org')
    await $.command.run({ command: 'mask', args: 'off' })
    ui = await $.ui.mount({ plugin: 'mod-box', surface: 'terminal', component: 'AssistantMessage', props })
    expect(await ui.find({ type: 'Text', text: /a\.b@example\.org/ })).toBeDefined()
  })
})

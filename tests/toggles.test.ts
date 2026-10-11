import { describe, expect, mock, test } from 'claude-code/testing'

import { addUsage, priceOf, sumBook } from '../mods/settings/hooks/usage'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 200 } }
const LONG = 'Ich habe die Zahlungslogik umgebaut. '.repeat(15) + 'Nebenbei: der Retry kann Kunden doppelt belasten.'
const wait = () => new Promise(done => (globalThis as any).setTimeout(done, 10))

let clock: any = null
let statusLine: Array<string | undefined> = []

// Stands for the engine beneath the Mod Box.
function engine(on: any, rows: unknown[] = []) {
  clock = mock.clock(on)
  mock.store(on)
  statusLine = []
  on('command.register', () => ({ value: {} }))
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('command.list', () => ({ value: [] }))
  on('session.id', () => ({ value: 's1' }))
  on('config.list', () => ({ value: rows }))
  on('session.cwd', () => ({ value: '/work' }))
  on('ui.status', (_$: any, e: any) => {
    statusLine.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 90_000, window: 200_000, percent: 45 }, rateLimits: [{ kind: 'five_hour', percentUsed: 42 }] } }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', () => ({ text: '' }))
  on('model.complete', () => ({
    value: { isAnswered: true, text: 'Der Retry kann Kunden doppelt belasten.', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  }))
  on('ui.render', ($: any, e: any) => $.ui.resolve(e).Text({ children: 'unten' }))
}

async function turn($: any) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(1_000) // the mocked clock starts at 0, which the meter reads as no request yet
  await $.turn.start({ text: 'bau um', turnId: 't1' })
  await $.turn.complete({
    reason: 'answer', answer: LONG, durationMs: 1, isAborted: false, turnId: 't1',
    usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, output_tokens: 10, model: 'claude-opus-5-5' },
  })
  await wait()
}

const band = ($: any) => $.ui.mount({ plugin: 'mod-box', surface: 'terminal', ...BAND })

// Off for these tests: they react to every tool call with timers that would fire after the test.
const QUIET = { language: 'de', filetree: false, savvyProgress: false, replayTheater: false }

describe('Switches and band', () => {
  test('default: compact row with the Cache Meter, Heads-up off', { options: QUIET }, async ($: any, on: any) => {
    engine(on)
    await turn($)
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /⏱/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /45%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Kontext/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Heads up/ })).toBeUndefined()
    expect(await ui.find({ key: 'cm-warm' })).toBeDefined()
  })

  test('layout "lines": full row with context and subscription limit', { options: { ...QUIET, bandLayout: 'lines' } }, async ($: any, on: any) => {
    engine(on)
    await turn($)
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /Kontext/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /42%/ })).toBeDefined()
  })

  test('Cache Meter in the status line instead of the band', { options: { ...QUIET, cacheMeterShow: 'status' } }, async ($: any, on: any) => {
    engine(on)
    await turn($)
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /⏱/ })).toBeUndefined()
    expect(statusLine.filter(Boolean).at(-1)).toMatch(/^Cache /)
  })

  test('Cache Meter off', { options: { ...QUIET, cacheMeter: false } }, async ($: any, on: any) => {
    engine(on)
    await turn($)
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /⏱/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /unten/ })).toBeDefined()
  })

  test('Heads-up is urgent: own row with buttons, even when compact', { options: { ...QUIET, headsUp: true } }, async ($: any, on: any) => {
    engine(on)
    await turn($)
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /Heads up/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /doppelt belasten/ })).toBeDefined()
    expect(await ui.find({ key: 'hu-ok' })).toBeDefined()
  })

  test('cold cache: cost from the embedded Cache Tax', { options: { ...QUIET, bandLayout: 'lines' } }, async ($: any, on: any) => {
    engine(on)
    await turn($)
    await clock.advance(61 * 60_000)
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /kalt/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /≈ \$0\.90/ })).toBeDefined()
  })
})

describe('Mod tokens', () => {
  test('calculation: Haiku call, totals', () => {
    const b1 = addUsage(null, 'headsUp', 'claude-haiku-5-5', { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
    expect(b1.headsUp?.calls).toBe(1)
    expect(Math.round((b1.headsUp?.usd ?? 0) * 1e6)).toBe(1500) // 1000 × $1/MTok + 100 × $5/MTok
    const b2 = addUsage(b1, 'handoff', 'unbekanntes-modell', { input_tokens: 10, output_tokens: 10 })
    expect(b2.handoff?.unpriced).toBe(1)
    expect(sumBook(b2).calls).toBe(2)
    expect(priceOf('Claude Opus 5.5')).toEqual([0.5, 10, 25])
  })

  test('Heads-up counts its call, the window shows it', { options: { ...QUIET, headsUp: true } }, async ($: any, on: any) => {
    engine(on, [{ key: 'mod-box.headsUp', label: 'Heads-up (You Should Know)', kind: 'boolean', value: true, provider: { plugin: 'mod-box', tier: 'user' }, isLocked: false }])
    on('fs.list', () => ({ value: [] }))
    await turn($)
    const ui = await $.ui.mount({ plugin: 'mod-box', surface: 'terminal', component: 'Pane', requestId: 'mod-box-settings', props: { bodyColumns: 120 } })
    await ui.press({ key: 'tab-diag' })
    expect(await ui.find({ type: 'Text', text: /Diese Sitzung: 1 Aufruf/ })).toBeDefined()
  })
})

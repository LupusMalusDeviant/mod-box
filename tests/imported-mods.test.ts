import { describe, expect, mock, test } from 'claude-code/testing'

import { splitRows } from '../mods/cc-split-diff-view/hooks/split-rows'

const QUIET = { language: 'en', filetree: false, savvyProgress: false, replayTheater: false, cacheMeter: false, readGuard: false, packageGuard: false }
const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

function engine(on: any) {
  mock.clock(on)
  mock.store(on)
  const toasts: string[] = []
  on('command.register', () => ({ value: {} }))
  on('tool.register', () => ({ value: {} }))
  on('ui.toast', (_$: any, e: any) => {
    toasts.push(String(e.text ?? e.message ?? ''))
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('session.id', () => ({ value: 's' }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.root', () => ({ value: '/repo' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('env.get', () => ({ value: undefined }))
  on('process.run', () => ok())
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  return toasts
}

describe('Split Diff', () => {
  test('one hunk becomes rows: removed left, added right, numbered', () => {
    const diff = splitRows([{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 2, lines: [' keep', '-old', '+new'] }])
    expect(diff?.removed).toBe(1)
    expect(diff?.added).toBe(1)
    const changed = diff?.rows.find(r => r.kind === 'row' && r.changed) as any
    expect(changed.left).toEqual({ no: 4, text: 'old' })
    expect(changed.right).toEqual({ no: 4, text: 'new' })
  })

  test('no hunks: Claude Code draws it as before', () => {
    expect(splitRows([])).toBe(null)
  })
})

describe('Human in the Loop', () => {
  test('Claude assigns a task; one without a reason is refused', { options: { ...QUIET, humanInTheLoop: true } }, async ($: any, on: any) => {
    engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' })
    const bad = await $.tool.call({ tool: 'mcp__mod-box__assign_task', title: 'Add the API key to .env' })
    expect(bad.deny).toContain('why is required')
    const good = await $.tool.call({ tool: 'mcp__mod-box__assign_task', title: 'Add the API key to .env', why: 'The tests need it.' })
    expect(good.deny).toBeUndefined()
    expect(String(good.result)).toContain('#1')
  })
})

describe('Prompt Rail', () => {
  test('/prompt-rail off switches it off through the box setting', { options: { ...QUIET, promptRail: true } }, async ($: any, on: any) => {
    engine(on)
    const sets: Array<{ key: string; value: unknown }> = []
    on('config.set', (_$: any, e: any) => {
      sets.push({ key: e.key, value: e.value })
      return { value: e.value }
    })
    on('ui.close', () => ({ value: undefined }))
    on('command.run', () => ({ text: 'NOBODY' }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' })
    await $.command.run({ command: 'prompt-rail', args: 'off' })
    expect(sets.at(-1)).toEqual({ key: 'mod-box.promptRailMode', value: 'off' })
  })
})

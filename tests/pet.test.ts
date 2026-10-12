import { describe as group, expect, mock, test } from 'claude-code/testing'

import { describe, gist, statusText } from '../mods/pet/hooks/register'

const QUIET = { language: 'en', filetree: false, savvyProgress: false, replayTheater: false, cacheMeter: false, readGuard: false, packageGuard: false }
const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const wait = (ms = 30) => new Promise(done => (globalThis as any).setTimeout(done, ms))

function engine(on: any, os = 'Windows_NT') {
  mock.clock(on)
  mock.store(on)
  const writes: Array<{ path: string; text: string }> = []
  const runs: string[][] = []
  on('command.register', () => ({ value: {} }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('fs.stat', (_$: any, e: any) => (/Pet\.cs$/.test(e.path) ? { value: { kind: 'file', size: 1, mtimeMs: 5, isLink: false } } : { deny: 'ENOENT' }))
  on('fs.write', (_$: any, e: any) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('session.id', () => ({ value: 's' }))
  on('ui.render', ($: any, e: any) => $.ui.resolve(e).Text({ children: 'below' }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('session.cwd', () => ({ value: 'C:\\work\\shop' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('env.get', (_$: any, e: any) => ({ value: ({ OS: os, TEMP: 'C:\\Temp', LOCALAPPDATA: 'C:\\Local' } as Record<string, string>)[e.name] }))
  on('process.run', (_$: any, e: any) => {
    runs.push([...e.argv])
    return ok()
  })
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  return { writes, runs }
}

group('Desktop pet: words', () => {
  test('describes tool calls', () => {
    expect(describe('Read', { file_path: 'C:\\w\\src\\app.ts' }, false)).toBe('Reading app.ts')
    expect(describe('Edit', { file_path: '/w/src/app.ts' }, true)).toBe('Ändere app.ts')
    expect(describe('Bash', { command: 'npm test', description: 'Run the tests' }, false)).toBe('Run the tests')
    expect(describe('Bash', { command: 'npm test' }, false)).toBe('Running: npm test')
    expect(describe('WebFetch', { url: 'https://docs.example.com/a/b' }, false)).toBe('Reading docs.example.com')
    expect(describe('mcp__github__create_issue', {}, false)).toBe('Using github: create issue')
    expect(describe('Grep', { pattern: 'x'.repeat(80) }, false).length).toBeLessThan(60)
  })

  test('takes the gist of an answer without markdown', () => {
    expect(gist('**Done.** I fixed `login.ts` and added a test.\n\n```ts\ncode\n```\nMore details follow here.')).toBe('Done. I fixed login.ts and added a test. More details follow here.')
    expect(gist('A'.repeat(400)).length).toBeLessThanOrEqual(170)
  })

  test('writes key=value lines with escaped newlines', () => {
    expect(statusText({ kind: 'done', title: 't', text: 'a\nb' }, 7)).toBe('at=7\nkind=done\ntitle=t\ntext=a\\nb\n')
  })
})

group('Desktop pet: in the session', () => {
  test('builds, starts and narrates a turn', { options: { ...QUIET, pet: true } }, async ($: any, on: any) => {
    const { writes, runs } = engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\\work\\shop' })
    await wait()
    // built (no exe yet), then started
    const ps = runs.filter(r => r[0] === 'powershell')
    expect(ps).toHaveLength(2)
    expect(ps[0]!.at(-1)).toContain('csc')
    expect(ps[1]!.at(-1)).toContain('Start-Process')
    expect(writes[0]!.path).toBe('C:\\Temp\\mod-box-pet.txt')
    expect(writes[0]!.text).toContain('kind=hello')

    await $.turn.start({ text: 'fix the login', turnId: 't1' })
    await $.tool.call({ tool: 'Edit', file_path: 'C:\\work\\shop\\login.ts', old_string: 'a', new_string: 'b' })
    await wait()
    expect(writes.at(-1)!.text).toContain('text=Changing login.ts')
    await $.turn.complete({ turnId: 't1', answer: 'Fixed the login check. The test passes now.', durationMs: 5, isAborted: false, reason: 'answer' })
    await wait()
    const last = writes.at(-1)!.text
    expect(last).toContain('kind=done')
    expect(last).toContain('title=shop · Done · 1 step · 1 file changed')
    expect(last).toContain('text=Fixed the login check. The test passes now.')
  })

  test('a question at the end is an "ask"', { options: { ...QUIET, pet: true } }, async ($: any, on: any) => {
    const { writes } = engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\\work\\shop' })
    await $.turn.complete({ turnId: 't1', answer: 'Should I also update the docs?', durationMs: 5, isAborted: false, reason: 'answer' })
    await wait()
    expect(writes.at(-1)!.text).toContain('kind=ask')
  })

  test('does nothing outside Windows', { options: { ...QUIET, pet: true } }, async ($: any, on: any) => {
    const { writes, runs } = engine(on, 'Linux')
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' })
    await $.tool.call({ tool: 'Read', file_path: '/w/a.ts' })
    await wait()
    expect(writes).toEqual([])
    expect(runs.filter(r => r[0] === 'powershell')).toEqual([])
  })

  test('off by default', { options: QUIET }, async ($: any, on: any) => {
    const { writes } = engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\\work\\shop' })
    await wait()
    expect(writes).toEqual([])
  })
})

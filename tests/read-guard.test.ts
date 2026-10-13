import { describe, expect, mock, test } from 'claude-code/testing'

import { judge, shellDump } from '../mods/read-guard/hooks/register'

const QUIET = { language: 'en', filetree: false, savvyProgress: false, replayTheater: false, cacheMeter: false }
const KB = 1024
// path -> size
const FILES: Record<string, number> = {
  '/repo/src/app.ts': 6 * KB,
  '/repo/src/huge.ts': 300 * KB,
  '/repo/package-lock.json': 400 * KB,
  '/repo/dist/app.min.js': 90 * KB,
  '/repo/shot.png': 2000 * KB,
}

function engine(on: any) {
  mock.clock(on)
  mock.store(on)
  const ran: string[] = []
  on('command.register', () => ({ value: {} }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('fs.stat', (_$: any, e: any) => {
    const p = String(e.path).replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
    return p in FILES ? { value: { kind: 'file', size: FILES[p], mtimeMs: 1, isLink: false } } : { deny: 'ENOENT' }
  })
  on('session.id', () => ({ value: 's' }))
  on('ui.render', ($: any, e: any) => $.ui.resolve(e).Text({ children: 'below' }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('env.get', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('tool.call', (_$: any, e: any) => {
    ran.push(`${e.tool}:${e.file_path ?? e.command ?? ''}`)
    return { result: 'ok', text: 'ok' }
  })
  return ran
}

describe('Read guard: rules', () => {
  test('judges size and kind', () => {
    expect(judge('/r/src/a.ts', 6 * KB, 50 * KB)).toBe(null)
    expect(judge('/r/src/a.ts', 60 * KB, 50 * KB)?.kind).toBe('large')
    expect(judge('/r/src/a.ts', 60 * KB, 0)).toBe(null)
    expect(judge('C:\\r\\yarn.lock', 20 * KB, 0)?.kind).toBe('lock')
    expect(judge('/r/Cargo.lock', 2 * KB, 50 * KB)).toBe(null)
    expect(judge('/r/dist/x.min.js', 20 * KB, 0)?.kind).toBe('minified')
    expect(judge('/r/dist/x.js.map', 20 * KB, 0)?.kind).toBe('minified')
    expect(judge('/r/doc.pdf', 5000 * KB, 50 * KB)).toBe(null)
    expect(judge('/r/a.ts', 40_000, 0)).toBe(null)
    expect(judge('/r/a.ts', 400_000, 50 * KB)?.tokens).toBe(100_000)
  })

  test('recognises a plain shell dump only', () => {
    expect(shellDump('cat src/huge.ts')).toBe('src/huge.ts')
    expect(shellDump('Get-Content -Raw "C:\\r\\a b.ts"')).toBe('C:\\r\\a b.ts')
    expect(shellDump('type package-lock.json')).toBe('package-lock.json')
    expect(shellDump('cat a.ts | grep foo')).toBe(null)
    expect(shellDump('cat a.ts b.ts')).toBe(null)
    expect(shellDump('cat -n a.ts')).toBe(null)
    expect(shellDump('Get-Content a.ts -TotalCount 50')).toBe(null)
    expect(shellDump('cat a.ts > b.ts')).toBe(null)
    expect(shellDump('catalog a.ts')).toBe(null)
  })
})

describe('Read guard: in the session', () => {
  test('holds a whole big Read once, lets offset/limit and small files through', { options: QUIET }, async ($: any, on: any) => {
    const ran = engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' })
    const first = await $.tool.call({ tool: 'Read', file_path: '/repo/src/huge.ts' })
    expect(first.deny).toContain('300 KB')
    expect(first.deny).toContain('~77k tokens')
    expect((await $.tool.call({ tool: 'Read', file_path: '/repo/src/huge.ts', offset: 1, limit: 100 })).deny).toBeUndefined()
    expect((await $.tool.call({ tool: 'Read', file_path: '/repo/src/app.ts' })).deny).toBeUndefined()
    expect((await $.tool.call({ tool: 'Read', file_path: '/repo/shot.png' })).deny).toBeUndefined()
    // allow_large (Claude Code 2.1.296) says Claude means the whole file
    expect((await $.tool.call({ tool: 'Read', file_path: '/repo/package-lock.json', allow_large: true })).deny).toBeUndefined()
    // the second try goes through
    expect((await $.tool.call({ tool: 'Read', file_path: '/repo/src/huge.ts' })).deny).toBeUndefined()
    expect(ran).toEqual(['Read:/repo/src/huge.ts', 'Read:/repo/src/app.ts', 'Read:/repo/shot.png', 'Read:/repo/package-lock.json', 'Read:/repo/src/huge.ts'])
  })

  test('lockfile via cat, relative to the project', { options: QUIET }, async ($: any, on: any) => {
    engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' })
    const r = await $.tool.call({ tool: 'Bash', command: 'cat package-lock.json' })
    expect(r.deny).toContain('lockfile')
    expect((await $.tool.call({ tool: 'Bash', command: 'cat package-lock.json | grep zod' })).deny).toBeUndefined()
  })

  test('limit off still holds minified files', { options: { ...QUIET, readLimit: 'off' } }, async ($: any, on: any) => {
    engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' })
    expect((await $.tool.call({ tool: 'Read', file_path: '/repo/src/huge.ts' })).deny).toBeUndefined()
    expect((await $.tool.call({ tool: 'Read', file_path: '/repo/dist/app.min.js' })).deny).toContain('minified')
  })

  test('warn mode and off let everything through', { options: { ...QUIET, readMode: 'warn' } }, async ($: any, on: any) => {
    engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' })
    expect((await $.tool.call({ tool: 'Read', file_path: '/repo/src/huge.ts' })).deny).toBeUndefined()
  })

  test('when off it checks nothing', { options: { ...QUIET, readGuard: false } }, async ($: any, on: any) => {
    engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' })
    expect((await $.tool.call({ tool: 'Read', file_path: '/repo/src/huge.ts' })).deny).toBeUndefined()
  })
})

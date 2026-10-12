import { describe, expect, mock, test } from 'claude-code/testing'

const boot = async ($: any, on: any, seen: any[] = []) => {
  mock.clock(on); mock.store(on)
  on('session.id', () => ({ value: 's' }))
  on('session.usage', () => ({ value: undefined }))
  on('prompt.submit', (_$: any, e: any) => {
    seen.push(e)
    return { text: e.text }
  })
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('command.register', (_$: any, e: any) => ({ value: { command: e.name } }))
  on('config.list', () => ({ value: [] }))
  on('env.get', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: false } }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/w' }))
  on('session.root', () => ({ value: '/w' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => ({ deny: 'none' }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }))
  on('command.run', () => ({ text: 'NOBODY' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' })
}

describe('Codebase Map', () => {
  test('/codebase-map answers with its usage for an unknown argument', { options: { codebaseMap: true } }, async ($: any, on: any) => {
    await boot($, on)
    const r = await $.command.run({ command: 'codebase-map', args: 'nonsense' })
    expect(r.text).toMatch(/codebase-map \[create\|update\|check\|publish\]/)
  })

  // The other mods with a prompt.submit hook read e.origin, which the test kit does not set; switch them off here.
  test('a blueprint prompt gets the pointer to the mapper instructions inside the box', { options: { codebaseMap: true, cacheMeter: false, filetree: false } }, async ($: any, on: any) => {
    const seen: any[] = []
    await boot($, on, seen)
    await $.prompt.submit({ text: 'update the blueprint' })
    expect(seen.at(-1)?.context?.at(-1)).toMatch(/mods\/codebase-map\/mapper\/INSTRUCTIONS\.md/)
  })

  test('switched off, the mod leaves prompts alone', async ($: any, on: any) => {
    const seen: any[] = []
    await boot($, on, seen)
    await $.prompt.submit({ text: 'update the blueprint' })
    expect(seen.at(-1)?.context ?? []).toEqual([])
  })
})

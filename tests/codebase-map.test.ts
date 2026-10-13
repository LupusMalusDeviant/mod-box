import { describe, expect, mock, test } from 'claude-code/testing'

const boot = async ($: any, on: any, seen: any[] = [], files: Record<string, string> = {}) => {
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
  // Windows makes /w X:\w: compare paths without drive and backslashes
  const norm = (p: unknown) => String(p).split(String.fromCharCode(92)).join('/').replace(/^[A-Za-z]:/, '')
  on('fs.exists', (_$: any, e: any) => ({ value: norm(e.path) in files }))
  on('fs.read', (_$: any, e: any) => (norm(e.path) in files ? { value: files[norm(e.path)] } : { deny: 'none' }))
  on('fs.list', (_$: any, e: any) => {
    const dir = norm(e.path).replace(/\/$/, '') + '/'
    return { value: Object.keys(files).filter(p => p.startsWith(dir)).map(p => ({ name: p.slice(dir.length), kind: 'file' })) }
  })
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }))
  on('command.run', () => ({ text: 'NOBODY' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' })
}

describe('Codebase Map', () => {
  test('/codebase-map answers with its usage for an unknown argument', { options: { codebaseMap: true } }, async ($: any, on: any) => {
    await boot($, on)
    const r = await $.command.run({ command: 'codebase-map', args: 'nonsense' })
    expect(r.text).toMatch(/codebase-map \[create\|update \[feature\]\|check\|publish \[feature\]\]/)
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

  // Every state write redraws the pane, and the desktop then reloads the graph's frame: a flash.
  test('an unchanged map is not written again (no redraw, no flicker)', { options: { codebaseMap: true, cacheMeter: false, filetree: false } }, async ($: any, on: any) => {
    const files: Record<string, string> = {
      '/w/docs/blueprints/INDEX.md': '# Codebase blueprint\n\n| Feature | What | File |\n|---|---|---|\n| Alpha | first | [alpha.md](./alpha.md) |\n',
      '/w/docs/blueprints/alpha.md': '# Alpha\n\nThe first feature.\n',
    }
    on('tool.call', () => ({ result: 'ok', text: 'ok' }))
    on('turn.complete', () => ({ text: '' }))
    on('tool.register', () => ({ value: {} }))
    // the host's state, counting the writes per key
    const held = new Map<string, unknown>()
    const writes: Record<string, number> = {}
    on('state.get', (_$: any, e: any) => ({ value: { value: held.get(e.key), version: writes[e.key] ?? 0 } }))
    on('state.set', (_$: any, e: any) => {
      held.set(e.key, e.value)
      writes[e.key] = (writes[e.key] ?? 0) + 1
      return { value: { isSet: true, version: writes[e.key] } }
    })
    await boot($, on, [], files)
    expect((held.get('cm2_map') as any)?.features?.map((f: any) => f.slug)).toEqual(['alpha'])
    const first = { version: writes.cm2_map ?? 0 }
    // a shell command marks the map dirty, the end of the turn reads it again: same content
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' })
    expect(writes.cm2_map).toBe(first.version)
    expect(writes.cm2_status ?? 0).toBeLessThanOrEqual(1)
    // a real change is written
    files['/w/docs/blueprints/INDEX.md'] = files['/w/docs/blueprints/INDEX.md']!.replace('| first |', '| the first, renamed |')
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    await $.turn.complete({ turnId: 't2', answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' })
    expect(writes.cm2_map).toBeGreaterThan(first.version)
  })
})

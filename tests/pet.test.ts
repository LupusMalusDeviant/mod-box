import { describe as group, expect, mock, test } from 'claude-code/testing'

import { describe, gist, parseAnswer, pickLook, statusText } from '../mods/pet/hooks/register'

const QUIET = { language: 'en', filetree: false, savvyProgress: false, replayTheater: false, cacheMeter: false, readGuard: false, packageGuard: false }
const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const wait = (ms = 30) => new Promise(done => (globalThis as any).setTimeout(done, ms))

// What the pet wrote after a click, as the test sets it: the answer file's text and its time.
const answer = { text: '', at: 0 }
const clicked = { permission: '' }

function engine(on: any, os = 'Windows_NT', tool: (e: any) => unknown = () => ({ result: 'ok', text: 'ok' })) {
  answer.text = ''
  clicked.permission = ''
  answer.at = 0
  const clock = mock.clock(on)
  mock.store(on)
  const writes: Array<{ path: string; text: string }> = []
  const runs: string[][] = []
  on('command.register', () => ({ value: {} }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('fs.stat', (_$: any, e: any) =>
    /Pet\.cs$/.test(e.path) ? { value: { kind: 'file', size: 1, mtimeMs: 5, isLink: false } }
    : /\.answer$/.test(e.path) && answer.at ? { value: { kind: 'file', size: 1, mtimeMs: answer.at, isLink: false } }
    : { deny: 'ENOENT' })
  on('fs.read', (_$: any, e: any) => (/\.answer$/.test(e.path) && answer.at ? { value: answer.text } : { deny: 'ENOENT' }))
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
    // the permission waiter, as if the pet's button had been clicked
    if (e.init?.env?.PET_ID && clicked.permission) return ok(`id=${e.init.env.PET_ID}`+String.fromCharCode(10)+`choice=${clicked.permission}`+String.fromCharCode(10))
    return ok()
  })
  on('tool.call', (_$: any, e: any) => tool(e))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  return { writes, runs, clock }
}

// The pet's click: the answer file for the question last shown.
function click(writes: Array<{ text: string }>, choice: string) {
  const id = /^ask=(.*)$/m.exec(writes.at(-1)!.text)?.[1]
  answer.text = `id=${id}\nchoice=${choice}\n`
  answer.at += 1
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
    // Linux resolves C:\Temp against the working folder (<cwd>/C:\Temp\...): compare the end only
    expect(writes[0]!.path.split(String.fromCharCode(92)).join('/')).toMatch(/(^|\/)C:\/Temp\/mod-box-pet\.txt$/)
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

group('Desktop pet: figures and clicks', () => {
  test('the status file carries the figure and the choices; the answer file is read back', () => {
    const text = statusText({ kind: 'ask', title: 'q', text: 'Which one?', ask: 'q-1-0', choices: ['A', 'B'] }, 7, { pet: 'cat', fur: 'calico' })
    expect(text).toBe('at=7\nkind=ask\ntitle=q\ntext=Which one?\npet=cat\nfur=calico\nask=q-1-0\nchoice=A\nchoice=B\n')
    expect(parseAnswer('id=q-1-0\nchoice=B\n')).toEqual({ id: 'q-1-0', choice: 'B' })
    expect(parseAnswer('id=\nchoice=B')).toBe(null)
    expect(pickLook('cat', 'tuxedo')).toEqual({ pet: 'cat', fur: 'tuxedo' })
    expect(pickLook('unicorn', 'plaid')).toEqual({ pet: 'box', fur: 'auto' })
    expect(pickLook('random', 'auto', () => 0).pet).toBe('cat') // never the box by chance
  })

  test("Claude's question: a click in the pet answers it", { options: { ...QUIET, pet: true, petKind: 'cat' } }, async ($: any, on: any) => {
    // the dialog waits
    const { writes, clock } = engine(on, 'Windows_NT', e => (e.tool === 'AskUserQuestion' ? new Promise(() => {}) : { result: 'ok', text: 'ok' }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\\work\\shop' })
    await wait()
    const questions = [{ question: 'Which database?', header: 'DB', multiSelect: false, options: [{ label: 'PostgreSQL', description: '' }, { label: 'SQLite', description: '' }] }]
    const call = $.tool.call({ tool: 'AskUserQuestion', questions })
    await wait()
    const shown = writes.at(-1)!.text
    expect(shown).toContain('pet=cat')
    expect(shown).toContain('choice=PostgreSQL\nchoice=SQLite')
    click(writes, 'SQLite')
    await clock.advance(700)
    const r = await call
    expect(r.result.answers).toEqual({ 'Which database?': 'SQLite' })
  })

  test("Claude's question answered in the dialog first: that answer counts", { options: { ...QUIET, pet: true } }, async ($: any, on: any) => {
    const { writes } = engine(on, 'Windows_NT', e => (e.tool === 'AskUserQuestion' ? { result: { questions: e.questions, answers: { 'Go?': 'Yes' } }, text: 'Yes' } : { result: 'ok', text: 'ok' }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\\work\\shop' })
    const r = await $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: 'Go?', header: 'Go', multiSelect: false, options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }] })
    expect(r.result.answers).toEqual({ 'Go?': 'Yes' })
    await wait()
    expect(writes.at(-1)!.text).not.toContain('choice=')
  })

  test('a permission request is shown, not answered', { options: { ...QUIET, pet: true } }, async ($: any, on: any) => {
    const { writes } = engine(on)
    on('classic.PermissionRequest', () => ({}))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\\work\\shop' })
    const r = await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'git push', description: 'Push the branch' } })
    await wait()
    expect(r.decision).toBeUndefined()
    expect(writes.at(-1)!.text).toContain('title=shop · Permission needed')
    expect(writes.at(-1)!.text).toContain('text=Push the branch · please confirm in Claude Code')
  })

  test('permissions "answer": allow once from the pet, never a rule', { options: { ...QUIET, pet: true, petPermissions: 'answer' } }, async ($: any, on: any) => {
    const { writes } = engine(on)
    on('classic.PermissionRequest', () => ({}))
    clicked.permission = 'Allow once' // what the waiter reads from the pet's answer file
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\\work\\shop' })
    const r = await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'git push', description: 'Push the branch' } })
    expect(r.decision).toEqual({ behavior: 'allow' })
    const offered = writes.find(w => w.text.includes('choice=Allow once'))!.text
    expect(offered).toContain('choice=Allow once'+String.fromCharCode(10)+'choice=Deny')
    await wait()
    expect(writes.at(-1)!.text).toContain('title=shop · Allowed')
  })

  test('permissions "answer": no click, the dialog decides', { options: { ...QUIET, pet: true, petPermissions: 'answer' } }, async ($: any, on: any) => {
    engine(on)
    on('classic.PermissionRequest', () => ({}))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\\work\\shop' })
    const r = await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'git push' } })
    expect(r.decision).toBeUndefined()
  })

  test('Next Steps suggestions become buttons; a click sends one', { options: { ...QUIET, pet: true, nextSteps: true } }, async ($: any, on: any) => {
    const { writes, clock } = engine(on)
    const sent: string[] = []
    on('prompt.submit', (_$: any, e: any) => {
      sent.push(e.text)
      return { text: e.text }
    })
    on('agent.list', () => ({ value: [] }))
    on('session.messages', () => ({ value: [{ role: 'user', text: 'fix the login' }] }))
    on('model.complete', () => ({ value: { isAnswered: true, text: 'Run the login tests\nOpen a draft PR', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\\work\\shop' })
    await $.turn.complete({ turnId: 't1', answer: 'Fixed the login check. The test passes now, all green.', durationMs: 5, isAborted: false, reason: 'answer' })
    await wait()
    await clock.advance(700)
    await wait()
    expect(writes.at(-1)!.text).toContain('choice=Run the login tests\nchoice=Open a draft PR')
    click(writes, 'Open a draft PR')
    await clock.advance(700)
    await wait()
    expect(sent).toContain('Open a draft PR')
  })

  test('/pet fox picks the figure and keeps it in the settings', { options: { ...QUIET, pet: true } }, async ($: any, on: any) => {
    const { writes } = engine(on)
    const sets: Array<{ key: string; value: unknown }> = []
    on('config.set', (_$: any, e: any) => {
      sets.push({ key: e.key, value: e.value })
      return { value: e.value }
    })
    on('command.run', () => ({ text: 'NOBODY' }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\\work\\shop' })
    const r = await $.command.run({ command: 'pet', args: 'fox' })
    expect(r.text).toContain('fox')
    expect(sets).toContainEqual({ key: 'mod-box.petKind', value: 'fox' })
    expect(writes.at(-1)!.text).toContain('pet=fox')
  })
})

import { describe as group, expect, mock, test } from 'claude-code/testing'

import { cacheState, describe, gist, lastQuestion, parseAnswer, parseLook, pickLook, statusText } from '../mods/pet/hooks/register'

const QUIET = { language: 'en', filetree: false, savvyProgress: false, replayTheater: false, cacheMeter: false, readGuard: false, packageGuard: false }
const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const wait = (ms = 30) => new Promise(done => (globalThis as any).setTimeout(done, ms))

// What the pet wrote after a click, as the test sets it: the answer file's text and its time.
const answer = { text: '', at: 0 }
const clicked = { permission: '' }
// Whether the sign-binary skill's script is there.
const skill = { there: false }

function engine(on: any, os = 'Windows_NT', tool: (e: any) => unknown = () => ({ result: 'ok', text: 'ok' }), stored: Record<string, unknown> = {}) {
  answer.text = ''
  clicked.permission = ''
  skill.there = false
  answer.at = 0
  const clock = mock.clock(on)
  mock.store(on, stored)
  const writes: Array<{ path: string; text: string }> = []
  const runs: string[][] = []
  on('command.register', () => ({ value: {} }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.exists', (_$: any, e: any) => ({ value: skill.there && /sign\.ps1$/.test(e.path) }))
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
  on('env.get', (_$: any, e: any) => ({ value: ({ OS: os, TEMP: 'C:\\Temp', LOCALAPPDATA: 'C:\\Local', USERPROFILE: 'C:\\Users\\me' } as Record<string, string>)[e.name] }))
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

  test('finds the question an answer ends with', () => {
    const nl = String.fromCharCode(10)
    expect(lastQuestion(['The name tag is built.', '', 'Shall I **push**, open the PR and merge? Then I rebuild the pet.'].join(nl))).toBe('Shall I push, open the PR and merge?')
    expect(lastQuestion(['Is this a question? Not at the end.', '', 'Done, all green.'].join(nl))).toBe(null)
    expect(lastQuestion('See [the run](https://x.test/run?id=4) for details.')).toBe(null)
    expect(lastQuestion('Ready. Which one?')).toBe('Which one?')
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

  test('signs a fresh build with the sign-binary skill when no script is set', { options: { ...QUIET, pet: true } }, async ($: any, on: any) => {
    const { runs } = engine(on)
    skill.there = true
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\\work\\shop' })
    await wait()
    const ps = runs.filter(r => r[0] === 'powershell')
    expect(ps).toHaveLength(3) // build, sign, start
    expect(ps[1]!.join(' ')).toMatch(/sign-binary.sign\.ps1 -Exe .*ModBoxPet\.exe$/)
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
    // the question's bubble comes back when hidden; nothing covers it with "Using AskUserQuestion"
    expect(shown).toMatch(/^remind=60$/m)
    expect(writes.some(w => w.text.includes('AskUserQuestion'))).toBe(false)
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

  test('permissions "answer": the question keeps its own choices, no allow/deny', { options: { ...QUIET, pet: true, petPermissions: 'answer' } }, async ($: any, on: any) => {
    const { writes, runs } = engine(on)
    on('classic.PermissionRequest', () => ({}))
    clicked.permission = 'Allow once'
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ['C:', 'work', 'shop'].join(String.fromCharCode(92)) })
    await wait()
    const before = writes.length
    const r = await $.classic.PermissionRequest({ tool_name: 'AskUserQuestion', tool_input: { questions: [] } })
    await wait()
    expect(r.decision).toBeUndefined()
    expect(writes.length).toBe(before) // the question's bubble stays as it is
    expect(runs.some(x => x.join(' ').includes('PET_WAIT'))).toBe(false)
    const plan = await $.classic.PermissionRequest({ tool_name: 'ExitPlanMode', tool_input: { plan: 'x' } })
    await wait()
    expect(plan.decision).toBeUndefined()
    expect(writes.at(-1)!.text).not.toContain('choice=')
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

group('Desktop pet: skins per session', () => {
  const CWD = ['C:', 'work', 'shop'].join(String.fromCharCode(92))
  // the right-click menu's pick, as the pet writes it
  const menu = (choice: string) => {
    answer.text = 'id=look' + String.fromCharCode(10) + 'choice=' + choice + String.fromCharCode(10)
    answer.at += 1
  }
  const settings = (on: any) => {
    const sets: Array<{ key: string; value: unknown }> = []
    on('config.set', (_$: any, e: any) => {
      sets.push({ key: e.key, value: e.value })
      return { value: e.value }
    })
    return sets
  }

  test('figure and coat from a menu pick or /pet', () => {
    expect(parseLook('cat calico', { pet: 'box', fur: 'auto' })).toEqual({ pet: 'cat', fur: 'calico' })
    expect(parseLook('dog', { pet: 'cat', fur: 'black' })).toEqual({ pet: 'dog', fur: 'black' })
    expect(parseLook('unicorn', { pet: 'cat', fur: 'black' })).toBe(null)
  })

  test('one pet per session: /pet sets this session only, kept for a restart', { options: { ...QUIET, pet: true, petPerSession: 'on' } }, async ($: any, on: any) => {
    // chosen before a restart
    const { writes } = engine(on, 'Windows_NT', undefined, { 'pet:looks': { s: { pet: 'owl', fur: 'auto' } } })
    const sets = settings(on)
    on('command.run', () => ({ text: 'NOBODY' }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
    await wait()
    expect(writes.at(-1)!.text).toContain('pet=owl')
    const r = await $.command.run({ command: 'pet', args: 'fox' })
    expect(r.text).toContain("This session's pet is now: fox")
    expect(sets).toEqual([]) // the setting for all sessions stays
    expect(writes.at(-1)!.text).toContain('pet=fox')
  })

  test('right-click › Figur: one pet for all keeps it as the setting', { options: { ...QUIET, pet: true } }, async ($: any, on: any) => {
    const { writes, clock } = engine(on)
    const sets = settings(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
    await wait()
    menu('cat calico')
    await clock.advance(700)
    await wait()
    expect(writes.at(-1)!.text).toContain('pet=cat' + String.fromCharCode(10) + 'fur=calico')
    expect(sets).toEqual([{ key: 'mod-box.petKind', value: 'cat' }, { key: 'mod-box.petFur', value: 'calico' }])
    // a second pick works too
    menu('dragon')
    await clock.advance(700)
    await wait()
    expect(writes.at(-1)!.text).toContain('pet=dragon')
  })
})

group('Desktop pet: the prompt cache', () => {
  const CWD = ['C:', 'work', 'shop'].join(String.fromCharCode(92))
  const MIN = 60_000
  // A 5-minute cache (the API's), so the clock has little to run through.
  const FIVE = { ...QUIET, pet: true, cacheMeterTtl: '5', petCacheWarn: '2' }
  const turn = async ($: any, id: string) => {
    await $.turn.start({ text: 'go on', turnId: id })
    await $.turn.complete({ turnId: id, answer: 'Done with that part of the work now.', durationMs: 5, isAborted: false, reason: 'answer' })
  }

  test('warm, cooling, cold', () => {
    expect(cacheState(0, 10, 5 * MIN, 2 * MIN)).toBe(null)
    expect(cacheState(1_000, 1_000 + 2 * MIN, 5 * MIN, 2 * MIN)).toBe('warm')
    expect(cacheState(1_000, 1_000 + 4 * MIN, 5 * MIN, 2 * MIN)).toBe('cooling')
    expect(cacheState(1_000, 1_000 + 4 * MIN, 5 * MIN, 0)).toBe('warm')
    expect(cacheState(1_000, 1_000 + 6 * MIN, 5 * MIN, 2 * MIN)).toBe('cold')
  })

  test('warns before the cache goes cold; the button keeps it warm', { options: FIVE }, async ($: any, on: any) => {
    const { writes, clock } = engine(on)
    const ran: string[] = []
    on('command.list', () => ({ value: [{ name: 'keepwarm' }] }))
    on('command.run', (_$: any, e: any) => {
      ran.push(`${e.command} ${e.args ?? ''}`)
      return { text: 'ok' }
    })
    await clock.advance(1_000)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
    await turn($, 't1')
    await clock.advance(3.5 * MIN)
    await wait()
    const warned = writes.find(w => w.text.includes('Cache is cooling'))
    expect(warned?.text).toContain('choice=Keep warm (1 h)')
    click(writes.filter(w => w.text.includes('Cache is cooling')) as any, 'Keep warm (1 h)')
    await clock.advance(1_000)
    await wait()
    expect(ran).toContain('keepwarm 1h')
  })

  test('one pet per active session: asleep when the cache is cold, back with the next message', { options: { ...FIVE, petPerSession: 'on' } }, async ($: any, on: any) => {
    const { writes, runs, clock } = engine(on)
    on('command.list', () => ({ value: [] }))
    await clock.advance(1_000)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
    await turn($, 't1')
    await clock.advance(6 * MIN)
    await wait()
    expect(writes.at(-1)!.text).toContain('kind=bye')
    expect(writes.at(-1)!.text).toContain('Cache is cold')
    const starts = runs.filter(r => r.join(' ').includes('Start-Process')).length
    await $.turn.start({ text: 'and now the tests', turnId: 't2' })
    await wait()
    expect(runs.filter(r => r.join(' ').includes('Start-Process')).length).toBe(starts + 1)
    expect(writes.at(-1)!.text).toContain('kind=work')
  })

  const PER = { ...FIVE, petPerSession: 'on' }
  const starts = (runs: string[][]) => runs.filter(r => r.join(' ').includes('Start-Process')).length

  test('started again (plugin reloaded) with a cold cache: no pet until the next message', { options: PER }, async ($: any, on: any) => {
    const { writes, runs, clock } = engine(on, 'Windows_NT', undefined, { 'pet:active': { s: 1_000 } })
    on('command.list', () => ({ value: [] }))
    await clock.advance(7 * MIN)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
    await wait()
    expect(writes.at(-1)!.text).toContain('kind=bye')
    expect(starts(runs)).toBe(0)
    await clock.advance(2 * MIN)
    await wait()
    expect(starts(runs)).toBe(0)
    await $.turn.start({ text: 'go on', turnId: 't1' })
    await wait()
    expect(starts(runs)).toBeGreaterThan(0)
  })

  test('started again with a warm cache: the pet stays', { options: PER }, async ($: any, on: any) => {
    const { writes, runs, clock } = engine(on, 'Windows_NT', undefined, { 'pet:active': { s: 1_000 } })
    on('command.list', () => ({ value: [] }))
    await clock.advance(2 * MIN)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
    await wait()
    expect(writes.at(-1)!.text).toContain('kind=hello')
    expect(starts(runs)).toBeGreaterThan(0)
  })

  test('an old session taken up again, its time unknown: asleep', { options: PER }, async ($: any, on: any) => {
    const { writes, runs, clock } = engine(on)
    on('command.list', () => ({ value: [] }))
    on('session.messages', () => ({ value: [{ role: 'user', text: 'fix the login' }] }))
    await clock.advance(1_000)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
    await wait()
    expect(writes.at(-1)!.text).toContain('kind=bye')
    expect(starts(runs)).toBe(0)
  })

  test('no warning while keep-warm holds the cache', { options: FIVE }, async ($: any, on: any) => {
    const { writes, clock } = engine(on, 'Windows_NT', undefined, { 'deadline:s': 10 * 60 * 60_000 })
    on('command.list', () => ({ value: [{ name: 'keepwarm' }] }))
    await clock.advance(1_000)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
    await turn($, 't1')
    await clock.advance(6 * MIN)
    await wait()
    expect(writes.some(w => /Cache is (cooling|cold)/.test(w.text))).toBe(false)
  })
})

group('Desktop pet: typing', () => {
  const CWD = ['C:', 'work', 'shop'].join(String.fromCharCode(92))
  const NL = String.fromCharCode(10)
  const TYPING = { ...QUIET, pet: true, petTyping: 'on' }
  // what the pet writes after Enter in its input box: the id the status named under free=
  const type = (writes: Array<{ text: string }>, text: string) => {
    const id = /^free=(.*)$/m.exec(writes.at(-1)!.text)?.[1]
    answer.text = `id=${id}${NL}choice=${text}${NL}`
    answer.at += 1
  }

  test('the status names where typed text goes, the hotkey and the write button', () => {
    const text = statusText({ kind: 'ask', title: 'q', text: 'Which?', ask: 'q-1-0', choices: ['A'], free: 'q-1-0' }, 7, undefined, { type: 'on', hotkey: 'ctrl+alt+space', typelabel: 'Write …' })
    expect(text).toBe(['at=7', 'kind=ask', 'title=q', 'text=Which?', 'ask=q-1-0', 'choice=A', 'free=q-1-0', 'type=on', 'hotkey=ctrl+alt+space', 'typelabel=Write …', ''].join(NL))
  })

  test('typed with nothing open: the next prompt of this session', { options: TYPING }, async ($: any, on: any) => {
    const { writes, clock } = engine(on)
    const sent: string[] = []
    on('prompt.submit', (_$: any, e: any) => {
      sent.push(e.text)
      return { text: e.text }
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
    await wait()
    const status = writes.at(-1)!.text
    expect(status).toMatch(/^name=shop$/m)
    expect(status).toContain('free=prompt-s')
    expect(status).toContain('type=on' + NL + 'hotkey=ctrl+alt+space')
    type(writes, 'run the boss fight tests')
    await clock.advance(700)
    await wait()
    expect(sent).toEqual(['run the boss fight tests'])
  })

  test("typed during Claude's question: its free-text answer", { options: TYPING }, async ($: any, on: any) => {
    const { writes, clock } = engine(on, 'Windows_NT', e => (e.tool === 'AskUserQuestion' ? new Promise(() => {}) : { result: 'ok', text: 'ok' }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
    await wait()
    const questions = [
      { question: 'Which database?', header: 'DB', multiSelect: false, options: [{ label: 'PostgreSQL', description: '' }, { label: 'SQLite', description: '' }] },
      { question: 'Name of the table?', header: 'Name', type: 'text' },
    ]
    const call = $.tool.call({ tool: 'AskUserQuestion', questions })
    await wait()
    expect(writes.at(-1)!.text).toContain('typelabel=Write your own answer …')
    type(writes, 'SQLite with WAL')
    await clock.advance(700)
    await wait()
    expect(writes.at(-1)!.text).toContain('text=Name of the table?')
    type(writes, 'enemies')
    await clock.advance(700)
    const r = await call
    expect(r.result.answers).toEqual({ 'Which database?': 'SQLite with WAL', 'Name of the table?': 'enemies' })
  })

  test('typing off: no input, a typed text is not taken', { options: { ...QUIET, pet: true } }, async ($: any, on: any) => {
    const { writes, clock } = engine(on)
    const sent: string[] = []
    on('prompt.submit', (_$: any, e: any) => {
      sent.push(e.text)
      return { text: e.text }
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
    await wait()
    expect(writes.at(-1)!.text).not.toMatch(/^(free|type|hotkey)=/m)
    answer.text = `id=prompt-s${NL}choice=rm -rf${NL}`
    answer.at += 1
    await clock.advance(700)
    await wait()
    expect(sent).toEqual([])
  })
})

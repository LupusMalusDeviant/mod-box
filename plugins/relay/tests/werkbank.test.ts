// The werkbank backend with a fake werkbank-relay (contract 0001, Nachtrag 2).
import { describe, expect, test } from 'claude-code/testing'
import { protocolPrompt } from '../hooks/protocol.ts'
import { fakeWorld, WERKBANK_JOB, type Scenario } from './fakes.ts'

const WB = { defaultBackend: 'werkbank' }
const HOME = { USERPROFILE: 'C:/Users/u' }

describe('werkbank backend', () => {
  test('argv, task on stdin, protocol in a file, token file under home; the next task resumes the session', { options: WB }, async ($: any, on: any) => {
    const w = fakeWorld(on, { env: HOME })
    if (!(await w.start($))) return
    const r = await w.send($, { role: 'coder', task: 'Fix the parser', owns: ['src/'], model: 'claude-opus-5-5' })
    expect(String(r.result)).toContain('coder run 1 started on werkbank')
    expect(await w.until(() => w.submitted.length === 1)).toBe(true)
    const a = w.spawns[0]!
    expect(a.argv).toEqual([
      'werkbank-relay', 'run', '--leitstand', 'http://100.73.150.87:5080', '--token-file', 'C:/Users/u/.werkbank/relay.token',
      '--role', 'coder', '--run', '1', '--cwd', '/w', '--model', 'claude-opus-5-5', '--timeout-min', '30',
      '--disallowed-tools', 'Bash(git push:*)', '--owns', 'src/', '--protocol-file', '/w/.relay/tmp/coder-1.protocol.md',
    ])
    expect(a.input).toBe('Fix the parser')
    expect(a.protocolFile).toBe(protocolPrompt('coder', '', ['src/']))
    // the protocol file never outlives its run
    expect(w.files.get('.relay/tmp/coder-1.protocol.md')).toBe('')

    const p = w.submitted[0]!
    expect(p).toContain('[relay] coder · run 1 finished (werkbank · claude-opus-5-5 · 12.0k in / 3.1k out tokens, $0.42)')
    expect(p).toContain('Status: done')
    expect(p).toContain('verify: npm test → exit 0, tests 147/147 passed, 0 failed')
    expect(p).toContain(`The changes are on branch agent/relay/coder (werkbank job ${WERKBANK_JOB}, commits abc1234); relay does not merge them.`)
    expect(p).toContain('commit abc1234 (created)')
    // the progress lines on stderr make up the live log
    const live = w.files.get('.relay/runs/coder/live.log')!
    expect(live).toContain('running auf fsn1-5')
    expect(live).toContain('verifying')
    expect(live).not.toContain('jobId')

    await w.send($, { role: 'coder', task: 'More' })
    await w.until(() => w.submitted.length === 2)
    const b = w.spawns[1]!.argv
    expect(b[b.indexOf('--session') + 1]).toBe('fsn1-5:9b1f')
    expect(b[b.indexOf('--run') + 1]).toBe('2')
  })

  test('no local snapshot: the write check compares the files the job changed with owns', { options: WB }, async ($: any, on: any) => {
    const w = fakeWorld(on)
    w.play('write-outside')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't', owns: ['src/'] })
    await w.until(() => w.submitted.length === 1)
    const p = w.submitted[0]!
    expect(p).toContain('Status: partial')
    expect(p).toContain('⚠ wrote outside owns (1)')
    expect(p).toContain('wrote outside owns: other/x.md (modified)')
    expect(p).not.toContain('wrote outside owns: src/a.ts')
    // nothing local was looked at: no git status, no hashes
    expect(w.runs.some(c => c.argv[0] === 'git' && (c.argv[1] === 'status' || c.argv[1] === 'hash-object'))).toBe(false)
    expect(JSON.parse(w.files.get('.relay/runs/coder/001.packet.json')!).write_check.checked).toBe(true)
  })

  test('a project inside the repo: repo paths are mapped onto the project', { options: WB }, async ($: any, on: any) => {
    const w = fakeWorld(on)
    w.git.prefix = 'app/'
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't', owns: ['src/'] })
    await w.until(() => w.submitted.length === 1)
    // the job changed src/a.ts at the repo's top, which is ../src/a.ts from app/
    expect(w.submitted[0]).toContain('wrote outside owns: ../src/a.ts (modified)')
  })

  test('the job state decides the packet status', { options: WB }, async ($: any, on: any) => {
    const w = fakeWorld(on)
    const cases: [Scenario, string, string][] = [
      ['red', 'Status: partial', `werkbank job ${WERKBANK_JOB} ended red: verify: npm test → exit 1, tests 145/147 passed, 2 failed`],
      ['needs-approval', 'Status: partial', "ended needs-approval: the push needs the user's approval"],
      ['limit', 'Status: partial', 'ended limit: Claude usage limit reached'],
      ['timed-out', 'Status: partial', `Summary: werkbank job ${WERKBANK_JOB} ended timed-out without a relay packet.`],
      ['failed', 'Status: failed', `Summary: werkbank job ${WERKBANK_JOB} ended failed without a relay packet: claude exited 1.`],
      ['cancelled', 'Status: failed', `werkbank job ${WERKBANK_JOB} ended cancelled`],
    ]
    w.play(...cases.map(c => c[0]))
    if (!(await w.start($))) return
    for (const [i, [scenario, status, line]] of cases.entries()) {
      await w.send($, { role: `r${i}`, task: scenario })
      await w.until(() => w.submitted.length === i + 1)
      expect(w.submitted[i]).toContain(status)
      expect(w.submitted[i]).toContain(line)
    }
    // a job without a packet still names its branch
    expect(w.submitted[3]).toContain('The changes are on branch agent/relay/r3')
    // a failed job is no 'error after the answer'
    expect(w.submitted.join('\n')).not.toContain('reported an error after the answer')
  })

  test('the program could not work: its error kind is named, the run failed', { options: WB }, async ($: any, on: any) => {
    const w = fakeWorld(on)
    const cases: [Scenario, string][] = [
      ['error-auth', 'error (auth)'],
      ['error-network', 'error (network)'],
      ['error-repo', 'error (repo)'],
      ['error-budget', 'error (budget)'],
      ['not-json', 'error (cli)'],
    ]
    w.play(...cases.map(c => c[0]))
    if (!(await w.start($))) return
    for (const [i, [, head]] of cases.entries()) {
      await w.send($, { role: `e${i}`, task: 't' })
      await w.until(() => w.submitted.length === i + 1)
      expect(w.submitted[i]).toContain(head)
      expect(w.submitted[i]).toContain('Status: failed')
    }
    expect(w.submitted[1]).toContain('Leitstand http://100.73.150.87:5080 not reachable')
    expect(w.submitted[4]).toContain('boom')
  })

  test('a moved session is said and taken for the next run', { options: WB }, async ($: any, on: any) => {
    const w = fakeWorld(on)
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 'one' })
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).not.toContain('session moved')
    w.play('session-moved')
    await w.send($, { role: 'coder', task: 'two' })
    await w.until(() => w.submitted.length === 2)
    expect(w.submitted[1]).toContain('the werkbank session moved (fsn1-5:9b1f → fsn1-4:fresh2)')
    expect(w.submitted[1]).toContain('Status: done')
    await w.send($, { role: 'coder', task: 'three' })
    await w.until(() => w.submitted.length === 3)
    const c = w.spawns[2]!.argv
    expect(c[c.indexOf('--session') + 1]).toBe('fsn1-4:fresh2')
  })

  test('a werkbank run stops after 60 minutes, not after runTimeoutMin', { options: { ...WB, runTimeoutMin: 1 } }, async ($: any, on: any) => {
    const w = fakeWorld(on)
    w.play('hang')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 'slow' })
    await w.clock.advance(2 * 60_000)
    await w.clock.settle()
    expect(w.submitted).toHaveLength(0)
    await w.clock.advance(58 * 60_000)
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).toContain('stopped after 60 min')
    expect(w.submitted[0]).toContain('Worker was stopped after 60 minutes without a packet.')
    // the worker on the server gets the run limit
    const a = w.spawns[0]!.argv
    expect(a[a.indexOf('--timeout-min') + 1]).toBe('1')
  })

  test('a task over 16 KiB is refused before the start and keeps the session', { options: WB }, async ($: any, on: any) => {
    const w = fakeWorld(on)
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 'one' })
    await w.until(() => w.submitted.length === 1)
    await w.send($, { role: 'coder', task: 'ä'.repeat(9000) })
    await w.until(() => w.submitted.length === 2)
    expect(w.spawns).toHaveLength(1)
    expect(w.submitted[1]).toContain('Worker was not started: werkbank: the task has 18000 bytes')
    expect(w.submitted[1]).toContain('not started')
    await w.send($, { role: 'coder', task: 'three' })
    await w.until(() => w.submitted.length === 3)
    const c = w.spawns[1]!.argv
    expect(c[c.indexOf('--session') + 1]).toBe('fsn1-5:9b1f')
  })

  test('worker_status names what werkbank ignores and a timeout below the run limit', { options: { ...WB, werkbankTimeoutMin: 20 } }, async ($: any, on: any) => {
    const w = fakeWorld(on)
    if (!(await w.start($))) return
    const r = await w.send($, { role: 'coder', task: 't', effort: 'high', isolation: 'worktree' })
    expect(String(r.result)).toContain('werkbank ignores: effort, isolation')
    await w.until(() => w.submitted.length === 1)
    // the worktree is not set up for werkbank: the job runs from the project
    expect(w.spawns[0]!.argv[w.spawns[0]!.argv.indexOf('--cwd') + 1]).toBe('/w')
    expect(w.runs.some(c => c.argv[1] === 'worktree' && c.argv[2] === 'add')).toBe(false)
    const status = await w.status($)
    expect(status).toContain('ignored: effort, isolation')
    expect(status).toContain('werkbankTimeoutMin (20) is not above runTimeoutMin (30)')
  })
})

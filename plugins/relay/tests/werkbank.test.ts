// The werkbank backend with a fake werkbank-relay (contract 0001, Nachtrag 2).
import { describe, expect, test } from 'claude-code/testing'
import { protocolPrompt } from '../hooks/protocol.ts'
import { fakeWorld, KEY_BODY, MISMATCHED_BODY, SECRETS, WERKBANK_JOB, type Scenario } from './fakes.ts'

const WB = { defaultBackend: 'werkbank' }
const HOME = { USERPROFILE: 'C:/Users/u', OS: 'Windows_NT' }
// The token file needs a home to resolve `~` (N50).
const world = (on: any, init: Parameters<typeof fakeWorld>[1] = {}) => fakeWorld(on, { env: HOME, ...init })

describe('werkbank backend', () => {
  test('argv, task on stdin, protocol in a file, token file under home; the next task resumes the session', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
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
    const w = world(on)
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
    const w = world(on)
    w.git.prefix = 'app/'
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't', owns: ['src/'] })
    await w.until(() => w.submitted.length === 1)
    // the job changed src/a.ts at the repo's top, which is ../src/a.ts from app/
    expect(w.submitted[0]).toContain('wrote outside owns: ../src/a.ts (modified)')
  })

  test('the job state decides the packet status', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    const cases: [Scenario, string, string][] = [
      ['red', 'Status: partial', `werkbank job ${WERKBANK_JOB} ended red: verify: npm test → exit 1, tests 145/147 passed, 2 failed`],
      ['needs-approval', 'Status: partial', "ended needs-approval (cli): the push needs the user's approval"],
      ['limit', 'Status: partial', 'ended limit (budget): Claude usage limit reached'],
      ['timed-out', 'Status: partial', `Summary: werkbank job ${WERKBANK_JOB} ended timed-out without a relay packet`],
      ['failed', 'Status: failed', `werkbank job ${WERKBANK_JOB} ended failed (cli): claude exited 1`],
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
    const w = world(on)
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
    const w = world(on)
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
    const w = world(on)
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
    const w = world(on)
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
    const w = world(on)
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

describe('werkbank, Nachtrag 2a (Codex review of 8121e9e)', () => {
  test('N48: a done job with a failing exit is partial and names the error', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.play('answer-exit1')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).toContain('Status: partial')
    expect(w.submitted[0]).toContain('werkbank-relay reported an error (cli)')
    expect(w.submitted[0]).toContain('error (cli)')
  })

  test('N49: a failing git prefix leaves the write check incomplete, not passed', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    if (!(await w.start($))) return
    w.during(() => {
      w.git.isBroken = true
    })
    await w.send($, { role: 'coder', task: 't', owns: ['src/'] })
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).toContain('⚠ write check incomplete')
    expect(w.submitted[0]).toContain('project prefix unknown')
    expect(JSON.parse(w.files.get('.relay/runs/coder/001.packet.json')!).write_check.checked).toBe(false)
  })

  test('N50: the token file needs a home to resolve ~', { options: WB }, async ($: any, on: any) => {
    const w = fakeWorld(on)
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.spawns).toHaveLength(0)
    expect(w.submitted[0]).toContain('Worker was not started: werkbank: werkbankTokenFile must be an absolute path')
  })

  test('N52: a protocol file that is a link out of the project stops the run', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.links.set('.relay/tmp/coder-1.protocol.md', '/etc/cron.d/x')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.spawns).toHaveLength(0)
    expect(w.submitted[0]).toContain('Worker was not started: .relay/tmp/coder-1.protocol.md resolves to /etc/cron.d/x')
    expect(w.files.has('.relay/tmp/coder-1.protocol.md')).toBe(false)
  })

  test('N52: the same for an opencode task file', { options: { defaultBackend: 'opencode' } }, async ($: any, on: any) => {
    const w = fakeWorld(on)
    w.links.set('.relay/tmp/scout-1.md', '/home/u/.bashrc')
    if (!(await w.start($))) return
    await w.send($, { role: 'scout', task: 'Look', model: 'ollama/m' })
    await w.until(() => w.submitted.length === 1)
    expect(w.spawns).toHaveLength(0)
    expect(w.submitted[0]).toContain('Worker was not started: .relay/tmp/scout-1.md resolves to /home/u/.bashrc')
    expect(w.files.has('.relay/tmp/scout-1.md')).toBe(false)
  })

  test('N53: after a restart the protocol file is cleared and the write check names the server', { options: WB }, async ($: any, on: any) => {
    const queue = {
      version: 1,
      owner: { session: 'old', heartbeatAt: '1970-01-01T00:00:00.000Z' },
      jobs: [{ id: 'j_1', role: 'coder', task: 'was running', enqueuedAt: '1970-01-01T00:00:00.000Z', state: 'running', run: 3, backend: 'werkbank' }],
    }
    const w = world(on, {
      files: { '.relay/queue.json': JSON.stringify(queue), '.relay/tmp/coder-3.protocol.md': 'PROTO with the brief' },
      store: { 'roles:/w': { coder: { name: 'coder', runs: 3, isBusy: true } } },
    })
    await w.clock.set(10 * 60_000)
    if (!(await w.start($))) return
    await w.until(() => w.submitted.length === 1)
    expect(w.files.get('.relay/tmp/coder-3.protocol.md')).toBe('')
    expect(w.submitted[0]).toContain('[relay] coder · run 3 interrupted')
    expect(w.submitted[0]).toContain('the werkbank job may still be running on the server; its changes would be on agent/relay/coder')
  })

  test('N54: a red job with prose gets no fallback compression and keeps its end line', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.play('red-prose', 'timed-out')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).toContain('Status: partial')
    expect(w.submitted[0]).not.toContain('fallback compressor')
    expect(w.submitted[0]).toContain(`werkbank job ${WERKBANK_JOB} ended red: verify: npm test → exit 1, tests 145/147 passed, 2 failed`)
    expect(w.files.get('.relay/runs/coder/001.full.md')).toContain('Plain prose, no packet.')
    await w.send($, { role: 'coder', task: 't2' })
    await w.until(() => w.submitted.length === 2)
    // the substitute packet carries the end line too
    expect(w.submitted[1]).toContain(`- werkbank job ${WERKBANK_JOB} ended timed-out`)
  })

  test('N55: changing isolation keeps a werkbank session; no "moved" without a session sent', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 'one' })
    await w.until(() => w.submitted.length === 1)
    const r = await w.send($, { role: 'coder', task: 'two', isolation: 'worktree' })
    expect(String(r.result)).not.toContain('old session was dropped')
    await w.until(() => w.submitted.length === 2)
    const b = w.spawns[1]!.argv
    expect(b[b.indexOf('--session') + 1]).toBe('fsn1-5:9b1f')
  })

  test('N55: an unsafe stored session is not sent and not reported as moved', { options: WB }, async ($: any, on: any) => {
    const w = world(on, { store: { 'roles:/w': { odd: { name: 'odd', runs: 1, isBusy: false, sessionId: '-bad', sessionBackend: 'werkbank', sessionDir: '/w' } } } })
    if (!(await w.start($))) return
    await w.send($, { role: 'odd', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.spawns[0]!.argv).not.toContain('--session')
    expect(w.submitted[0]).not.toContain('session moved')
  })

  test('N51: a private key over several lines never reaches live.log (werkbank stderr, codex stdout)', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.play('key-lines', 'key-lines')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    await w.send($, { role: 'cx', task: 't', backend: 'codex' })
    await w.until(() => w.submitted.length === 2)
    for (const role of ['coder', 'cx']) {
      const live = w.files.get(`.relay/runs/${role}/live.log`)!
      expect(live).toContain('[redacted private key]')
      expect(live).not.toContain(KEY_BODY)
    }
    // since N134 nothing after the first key marker is shown
    expect(w.files.get('.relay/runs/coder/live.log')).not.toContain('verify done')
  })

  test('N57: live.log shows progress while the run still holds its slot', { options: { ...WB, maxParallel: 1 } }, async ($: any, on: any) => {
    const w = world(on)
    w.play('progress-held')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 'long' })
    const r = await w.send($, { role: 'other', task: 'waits' })
    expect(String(r.result)).toContain('task queued')
    await w.clock.advance(5000)
    await w.until(() => (w.files.get('.relay/runs/coder/live.log') ?? '').includes('running auf fsn1-5'))
    const live = w.files.get('.relay/runs/coder/live.log')!
    expect(live).toContain('queued')
    expect(live).toContain('running auf fsn1-5')
    expect(w.submitted).toHaveLength(0)
    expect(w.spawns).toHaveLength(1)
    w.releaseHeld()
    await w.until(() => w.submitted.length === 2)
    expect(w.files.get('.relay/runs/coder/live.log')).toContain('verifying')
  })
})

describe('werkbank, Nachtrag 2b (second Codex review)', () => {
  test('N59: git failing already before the start leaves the write check incomplete', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    if (!(await w.start($))) return
    w.git.isBroken = true
    await w.send($, { role: 'coder', task: 't', owns: ['src/'] })
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).toContain('⚠ write check incomplete')
    expect(w.submitted[0]).toContain('project prefix unknown')
  })

  test('N61: a done object followed by a kill is not done', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.play('signal-after-done')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).toContain('Status: partial')
    expect(w.submitted[0]).toContain('werkbank-relay reported an error (cli): ended by signal SIGKILL')
  })

  test('N63: progress that all came in the first 2 seconds still reaches live.log', { options: { ...WB, maxParallel: 1 } }, async ($: any, on: any) => {
    const w = world(on)
    w.play('progress-quiet')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 'long' })
    await w.until(() => w.heldCount() === 1)
    await w.clock.advance(2000)
    await w.until(() => (w.files.get('.relay/runs/coder/live.log') ?? '').includes('running auf fsn1-5'))
    expect(w.files.get('.relay/runs/coder/live.log')).toContain('running auf fsn1-5')
    expect(w.submitted).toHaveLength(0)
    w.releaseHeld()
    await w.until(() => w.submitted.length === 1)
  })

  test('N66: malformed commit ids are counted, never shown', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.play('bad-commits')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).toContain('werkbank reported 2 malformed commit id(s) (not shown)')
    expect(w.submitted[0]).toContain('commits abc1234)')
    expect(w.submitted[0]).not.toContain('token=')
    expect(w.submitted[0]).not.toContain('nope')
  })

  test('N64: on Windows a token file without a drive is refused', { options: { ...WB, werkbankTokenFile: '\\Users\\u\\relay.token' } }, async ($: any, on: any) => {
    const w = world(on)
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.spawns).toHaveLength(0)
    expect(w.submitted[0]).toContain('with a drive or a UNC share')
  })
})

describe('werkbank, Nachtrag 2c (third Codex review)', () => {
  test('N68: a finished run never writes over the live.log of the next run of its role', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.play('ok', 'held')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 'one' })
    await w.send($, { role: 'coder', task: 'two' })
    await w.until(() => w.heldCount() === 1 && (w.files.get('.relay/runs/coder/live.log') ?? '').includes('run 2'))
    // the first run's 2-second write would be due now
    await w.clock.advance(5000)
    await w.until(() => false, 30)
    const live = w.files.get('.relay/runs/coder/live.log')!
    expect(live).toContain('coder · run 2')
    expect(live).not.toContain('coder · run 1')
    w.releaseHeld()
    await w.until(() => w.submitted.length === 2)
    expect(w.files.get('.relay/runs/coder/live.log')).toContain('# finished')
  })

  test('N69: an error field that is no object turns done into partial', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.play('error-malformed')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).toContain('Status: partial')
    expect(w.submitted[0]).toContain('werkbank-relay reported an error (cli): werkbank-relay sent a malformed error field')
  })

  test('N71: killed before the JSON names the signal, not "could not start"', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.play('killed-early')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).toContain('ended by signal SIGTERM')
    expect(w.submitted[0]).not.toContain('could not start')
  })

  test('N72: a session id that looks like a credential is neither kept nor sent', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.play('session-token', 'ok')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 'one' })
    await w.until(() => w.submitted.length === 1)
    await w.send($, { role: 'coder', task: 'two' })
    await w.until(() => w.submitted.length === 2)
    expect(w.spawns[1]!.argv).not.toContain('--session')
    expect(w.submitted.join('\n')).not.toContain('abcdef0123456789abcd')
  })
})

describe('werkbank, Nachtrag 2d (fourth Codex review)', () => {
  test('N73: a packet with status ["done"] and a write outside owns is partial', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.play('status-array')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't', owns: ['src/'] })
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).toContain('Status: partial')
    expect(w.submitted[0]).not.toContain('Status: done')
    expect(w.submitted[0]).toContain('wrote outside owns: other/x.md')
  })

  test('N74: a key with a foreign END never reaches full.md or the packet', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.play('key-mismatch')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).not.toContain(MISMATCHED_BODY)
    for (const [path, text] of w.files) if (path.startsWith('.relay/runs/coder/')) expect(text).not.toContain(MISMATCHED_BODY)
  })

  test('N78: a rejected new session drops the old one too', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.play('ok', 'session-token', 'ok')
    if (!(await w.start($))) return
    for (const task of ['one', 'two', 'three']) {
      const n = w.submitted.length + 1
      await w.send($, { role: 'coder', task })
      await w.until(() => w.submitted.length === n)
    }
    // run 2 resumed the valid session; run 3 starts fresh
    expect(w.spawns[1]!.argv).toContain('--session')
    expect(w.spawns[2]!.argv).not.toContain('--session')
    expect(w.submitted[1]).toContain('werkbank reported a session id relay does not keep; the next task for coder starts a fresh session.')
  })
})

describe('werkbank, Nachtrag 2e (fifth Codex review)', () => {
  const running = (role: string, run: number) => ({
    version: 1,
    owner: { session: 'old', heartbeatAt: '1970-01-01T00:00:00.000Z' },
    jobs: [{ id: 'j_1', role, task: 'was running', enqueuedAt: '1970-01-01T00:00:00.000Z', state: 'running', run, backend: 'werkbank' }],
  })

  test('N81: a queued role that leaves the temp folder is dropped; no file outside is cleared', { options: WB }, async ($: any, on: any) => {
    // the fake file system does not resolve "..": the file sits where the bad path would land
    const outside = '.relay/tmp/../../docs/release-3.protocol.md'
    const w = world(on, { files: { '.relay/queue.json': JSON.stringify(running('../../docs/release', 3)), [outside]: 'KEEP' } })
    await w.clock.set(10 * 60_000)
    if (!(await w.start($))) return
    await w.until(() => false, 30)
    expect(w.files.get(outside)).toBe('KEEP')
    expect(await w.status($)).toContain('relay left out 1 job(s) from the queue with an invalid role name or run number.')
  })

  test('N82: a werkbankBin that looks like a credential runs neither the job nor the version probe', { options: { ...WB, werkbankBin: '/opt/apikey=sample-secret/werkbank-relay' } }, async ($: any, on: any) => {
    const w = world(on)
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.spawns).toHaveLength(0)
    expect(w.runs.some((r: { argv: string[] }) => r.argv.join(' ').includes('sample-secret'))).toBe(false)
    expect(w.submitted[0]).toContain('werkbankBin looks like it contains a credential')
    expect(w.submitted[0]).not.toContain('sample-secret')
  })

  test('N83: JSON-escaped key markers in separate codex events keep the key out of live.log', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.play('key-escaped')
    if (!(await w.start($))) return
    await w.send($, { role: 'cx', task: 't', backend: 'codex' })
    await w.until(() => w.submitted.length === 1)
    const live = w.files.get('.relay/runs/cx/live.log')!
    expect(live).not.toContain(KEY_BODY)
    expect(live).toContain('[redacted private key]')
  })

  test('N86: an interrupted werkbank run says the write check is incomplete in its headline', { options: WB }, async ($: any, on: any) => {
    const w = world(on, {
      files: { '.relay/queue.json': JSON.stringify(running('coder', 3)) },
      store: { 'roles:/w': { coder: { name: 'coder', runs: 3, isBusy: true } } },
    })
    await w.clock.set(10 * 60_000)
    if (!(await w.start($))) return
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).toContain('[relay] coder · run 3 interrupted (werkbank) ⚠ write check incomplete')
  })
})

describe('werkbank, Nachtrag 2f (sixth Codex review)', () => {
  test('N87: a whole JSON-escaped key on stderr reaches neither live.log nor packet nor message', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.play('key-escaped-stderr')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).not.toContain(KEY_BODY)
    expect(w.files.get('.relay/runs/coder/live.log')).not.toContain(KEY_BODY)
    expect(w.files.get('.relay/runs/coder/001.packet.json')).not.toContain(KEY_BODY)
  })

  test('N88: a live.log that is a link out of the project is not written, and that is said', { options: WB }, async ($: any, on: any) => {
    // the run folder exists from an earlier run; only the log in it is a link
    const w = world(on, { files: { '.relay/runs/coder/000.full.md': 'earlier' } })
    w.links.set('.relay/runs/coder/live.log', '/etc/cron.d/x')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.files.has('.relay/runs/coder/live.log')).toBe(false)
    expect(w.submitted[0]).toContain('live.log was not written: .relay/runs/coder/live.log resolves to /etc/cron.d/x')
  })

  test('N89: a failed job killed by a signal names the signal beside its reason', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.play('failed-signal')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).toContain('Status: failed')
    expect(w.submitted[0]).toContain('the repo is gone')
    expect(w.submitted[0]).toContain('ended by signal SIGTERM')
  })

  test('N92: a stored report delivered after a restart keeps its headline', { options: WB }, async ($: any, on: any) => {
    const head = '[relay] coder · run 3 interrupted (werkbank) ⚠ write check incomplete'
    const packet = { run: 3, backend: 'werkbank', usage: {}, head, status: 'failed', summary: 'Interrupted.', decisions: [], facts: [], artifacts: [], open_questions: [], needs_from_main: [], risks: [], next_suggested: [], sections: [] }
    const queue = {
      version: 1,
      owner: { session: 'old', heartbeatAt: '1970-01-01T00:00:00.000Z' },
      jobs: [{ id: 'j_1', role: 'coder', task: 't', enqueuedAt: '1970-01-01T00:00:00.000Z', state: 'running', run: 3, backend: 'werkbank', delivery: 'stored' }],
    }
    const w = world(on, {
      files: { '.relay/queue.json': JSON.stringify(queue), '.relay/runs/coder/003.packet.json': JSON.stringify(packet), '.relay/runs/coder/003.full.md': '# coder · run 3' },
      store: { 'roles:/w': { coder: { name: 'coder', runs: 3, isBusy: true } } },
    })
    await w.clock.set(10 * 60_000)
    if (!(await w.start($))) return
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).toContain(`${head} · delivered after a restart`)
  })
})

describe('werkbank, Nachtrag 2g (seventh Codex review)', () => {
  test('N94: a key with an escaped letter in its markers reaches neither live.log nor the error', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.play('key-letter-stderr')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).not.toContain(KEY_BODY)
    expect(w.files.get('.relay/runs/coder/live.log')).not.toContain(KEY_BODY)
    expect(w.files.get('.relay/runs/coder/001.packet.json')).not.toContain(KEY_BODY)
  })

  test('N95: a key split over three risks entries reaches neither packet.json nor the message', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.play('key-split-risks')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).not.toContain(KEY_BODY)
    expect(w.files.get('.relay/runs/coder/001.packet.json')).not.toContain(KEY_BODY)
    // since N120 any key marker hides the whole answer
    expect(w.submitted[0]).toContain('answer hidden: the output contains a private key marker')
  })

  test('N96: a live.log turned into a link after its last flush is still named in the report', { options: { ...WB, maxParallel: 1 } }, async ($: any, on: any) => {
    const w = world(on)
    w.play('progress-held')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 'long' })
    await w.clock.advance(5000)
    await w.until(() => (w.files.get('.relay/runs/coder/live.log') ?? '').includes('running auf fsn1-5'))
    w.links.set('.relay/runs/coder/live.log', '/etc/cron.d/x')
    w.releaseHeld()
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).toContain('live.log was not written: .relay/runs/coder/live.log resolves to /etc/cron.d/x')
  })

  const storedJob = (run: number) => ({
    version: 1,
    owner: { session: 'old', heartbeatAt: '1970-01-01T00:00:00.000Z' },
    jobs: [{ id: 'j_1', role: 'coder', task: 't', enqueuedAt: '1970-01-01T00:00:00.000Z', state: 'running', run, backend: 'werkbank', delivery: 'stored' }],
  })
  const laterPacket = { run: 2, backend: 'werkbank', usage: {}, head: '[relay] coder · run 2 finished (werkbank)', status: 'done', summary: 'run two did it', decisions: [], facts: [], artifacts: [], open_questions: [], needs_from_main: [], risks: [], next_suggested: [], sections: [] }

  test('N97: a slot taken by a later run is not delivered as the earlier one', { options: { ...WB, keepRuns: 1 } }, async ($: any, on: any) => {
    const w = world(on, {
      files: { '.relay/queue.json': JSON.stringify(storedJob(1)), '.relay/runs/coder/001.packet.json': JSON.stringify(laterPacket), '.relay/runs/coder/001.full.md': '# coder · run 2' },
      store: { 'roles:/w': { coder: { name: 'coder', runs: 2, isBusy: false } } },
    })
    await w.clock.set(10 * 60_000)
    if (!(await w.start($))) return
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).not.toContain('run two did it')
    expect(w.submitted[0]).toContain('run 1 interrupted')
    expect(w.submitted[0]).toContain('the stored report was overwritten by a later run (keepRuns)')
  })

  test('N97: the kept message of the run is delivered, then cleared', { options: { ...WB, keepRuns: 1 } }, async ($: any, on: any) => {
    const message = '[relay] coder · run 1 finished (werkbank)\nStatus: done\nrun one did it'
    const w = world(on, {
      files: {
        '.relay/queue.json': JSON.stringify(storedJob(1)),
        '.relay/runs/coder/001.packet.json': JSON.stringify(laterPacket),
        // since N103 the kept message starts with its job's id, since N111 with its length
        '.relay/runs/coder/undelivered-1.md': `<!-- relay job j_1 length ${message.length} -->\n${message}`,
      },
      store: { 'roles:/w': { coder: { name: 'coder', runs: 2, isBusy: false } } },
    })
    await w.clock.set(10 * 60_000)
    if (!(await w.start($))) return
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).toContain('run one did it')
    expect(w.files.get('.relay/runs/coder/undelivered-1.md')).toBe('')
  })
})

describe('werkbank, Nachtrag 2h (eighth Codex review)', () => {
  const runningJob = (run: number, delivery?: 'stored') => ({
    version: 1,
    owner: { session: 'old', heartbeatAt: '1970-01-01T00:00:00.000Z' },
    jobs: [{ id: 'j_1', role: 'coder', task: 't', enqueuedAt: '1970-01-01T00:00:00.000Z', state: 'running', run, backend: 'werkbank', ...(delivery ? { delivery } : {}) }],
  })
  const laterPacket = { run: 2, backend: 'werkbank', usage: {}, head: '[relay] coder · run 2 finished (werkbank)', status: 'done', summary: 'run two did it', decisions: [], facts: [], artifacts: [], open_questions: [], needs_from_main: [], risks: [], next_suggested: [], sections: [] }
  const kept = '[relay] coder · run 1 finished (werkbank)\nStatus: done\nrun one did it'

  test('N99: an undelivered file that is a link out is not written, and that is said', { options: WB }, async ($: any, on: any) => {
    // the run folder exists from an earlier run; only the kept file is a link
    const w = world(on, { files: { '.relay/runs/coder/000.full.md': 'earlier' } })
    w.links.set('.relay/runs/coder/undelivered-1.md', '/etc/cron.d/x')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    // nothing was written through the link
    expect(w.files.has('.relay/runs/coder/undelivered-1.md')).toBe(false)
    expect(w.submitted[0]).toContain('Not stored: .relay/runs/coder/undelivered-1.md resolves to /etc/cron.d/x')
    expect(w.files.get('.relay/runs/coder/001.full.md')).toContain('# coder · run 1')
  })

  test('N100: a key spread over decisions, summary and risks reaches neither packet.json nor the message', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.play('key-across-fields')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).not.toContain(KEY_BODY)
    expect(w.files.get('.relay/runs/coder/001.packet.json')).not.toContain(KEY_BODY)
    // since N120 any key marker hides the whole answer
    expect(w.submitted[0]).toContain('answer hidden: the output contains a private key marker')
  })

  test('N101: a codex event with a whole key over three fields never reaches live.log', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.play('key-fields-event')
    if (!(await w.start($))) return
    await w.send($, { role: 'cx', task: 't', backend: 'codex' })
    await w.until(() => w.submitted.length === 1)
    const live = w.files.get('.relay/runs/cx/live.log')!
    expect(live).not.toContain(KEY_BODY)
    expect(live).toContain('[redacted private key]')
  })

  test('N101: with a key still open, the end line of live.log hides the error text', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.play('key-open-error')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    const live = w.files.get('.relay/runs/coder/live.log')!
    expect(live).not.toContain(KEY_BODY)
    expect(live).toContain('error (text hidden: a private key marker was in the output)')
  })

  test('N102: an interrupted run whose slot a later run holds leaves those files alone', { options: { ...WB, keepRuns: 1 } }, async ($: any, on: any) => {
    const later = JSON.stringify(laterPacket)
    const w = world(on, {
      files: { '.relay/queue.json': JSON.stringify(runningJob(1, 'stored')), '.relay/runs/coder/001.packet.json': later, '.relay/runs/coder/001.full.md': '# coder · run 2' },
      store: { 'roles:/w': { coder: { name: 'coder', runs: 2, isBusy: false } } },
    })
    await w.clock.set(10 * 60_000)
    if (!(await w.start($))) return
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).toContain('run 1 interrupted')
    expect(w.files.get('.relay/runs/coder/001.packet.json')).toBe(later)
    expect(w.files.get('.relay/runs/coder/001.full.md')).toBe('# coder · run 2')
  })

  test('N103: a running job without delivery stored gets its kept message, not "interrupted"', { options: WB }, async ($: any, on: any) => {
    const w = world(on, {
      files: { '.relay/queue.json': JSON.stringify(runningJob(1)), '.relay/runs/coder/undelivered-1.md': `<!-- relay job j_1 length ${kept.length} -->\n${kept}` },
      store: { 'roles:/w': { coder: { name: 'coder', runs: 1, isBusy: true } } },
    })
    await w.clock.set(10 * 60_000)
    if (!(await w.start($))) return
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).toContain('run one did it')
    expect(w.submitted[0]).not.toContain('interrupted')
    expect(w.submitted[0]).not.toContain('relay job j_1')
  })

  test('N103: a kept message of another job is not delivered', { options: WB }, async ($: any, on: any) => {
    const w = world(on, {
      files: { '.relay/queue.json': JSON.stringify(runningJob(1, 'stored')), '.relay/runs/coder/undelivered-1.md': `<!-- relay job j_9 length ${kept.length} -->\n${kept}` },
      store: { 'roles:/w': { coder: { name: 'coder', runs: 1, isBusy: true } } },
    })
    await w.clock.set(10 * 60_000)
    if (!(await w.start($))) return
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).not.toContain('run one did it')
    expect(w.submitted[0]).toContain('run 1 interrupted')
  })

  test('N104: a live.log write that fails is named under risks', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.io.failWrite = (p: string) => p === '.relay/runs/coder/live.log'
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).toContain('live.log was not written: the write failed (')
    expect(w.submitted[0]).toContain('ENOSPC')
  })

  test('N105: a kept message delivered after a restart says so in its first line', { options: WB }, async ($: any, on: any) => {
    const w = world(on, {
      files: { '.relay/queue.json': JSON.stringify(runningJob(1, 'stored')), '.relay/runs/coder/undelivered-1.md': `<!-- relay job j_1 length ${kept.length} -->\n${kept}` },
      store: { 'roles:/w': { coder: { name: 'coder', runs: 1, isBusy: true } } },
    })
    await w.clock.set(10 * 60_000)
    if (!(await w.start($))) return
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]!.split('\n')[0]).toBe('[relay] coder · run 1 finished (werkbank) · delivered after a restart')
  })

  test('N106: a codex error event and a signal are both named, the kind kept', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.play('error-signal')
    if (!(await w.start($))) return
    await w.send($, { role: 'cx', task: 't', backend: 'codex' })
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).toContain('stream disconnected before completion · ended by signal SIGTERM')
  })
})

describe('werkbank, Nachtrag 2i (ninth Codex review)', () => {
  const runningJob = (run: number, delivery?: 'stored') => ({
    version: 1,
    owner: { session: 'old', heartbeatAt: '1970-01-01T00:00:00.000Z' },
    jobs: [{ id: 'j_1', role: 'coder', task: 't', enqueuedAt: '1970-01-01T00:00:00.000Z', state: 'running', run, backend: 'werkbank', ...(delivery ? { delivery } : {}) }],
  })
  const kept = '[relay] coder · run 1 finished (werkbank)\nStatus: done\nrun one did it'
  // since N120 the marker alone hides the answer
  const KEY_STILL_OPEN = 'answer hidden: the output contains a private key marker'
  // a job queued earlier and waiting for its start
  const waitingJob = {
    version: 1,
    owner: { session: 'old', heartbeatAt: '1970-01-01T00:00:00.000Z' },
    jobs: [{ id: 'j_1', role: 'coder', task: 't', enqueuedAt: '1970-01-01T00:00:00.000Z', state: 'queued', backend: 'werkbank' }],
  }

  test('N107: a key opened on stderr whose body is the error reaches neither packet.json nor the message', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.play('key-open-error')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).not.toContain(KEY_BODY)
    expect(w.files.get('.relay/runs/coder/001.packet.json')).not.toContain(KEY_BODY)
    // since N114 the key still open at the end hides the whole answer
    expect(w.submitted[0]).toContain(KEY_STILL_OPEN)
    // the kind of the error stays
    expect(w.submitted[0]).toContain('error (cli)')
  })

  test('N107: a key opened in the prose and going on in the packet reaches no report', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.play('key-into-packet')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).not.toContain(KEY_BODY)
    expect(w.files.get('.relay/runs/coder/001.packet.json')).not.toContain(KEY_BODY)
    expect(w.files.get('.relay/runs/coder/001.full.md')).not.toContain(KEY_BODY)
  })

  test('N108: worker_expand does not read a full.md that is a link out', { options: WB }, async ($: any, on: any) => {
    const w = world(on, {
      files: { '.relay/runs/coder/001.full.md': 'what the link target holds' },
      store: { 'roles:/w': { coder: { name: 'coder', runs: 1, isBusy: false } } },
    })
    w.links.set('.relay/runs/coder/001.full.md', '/home/u/.netrc')
    if (!(await w.start($))) return
    const r = String((await $.tool.call({ tool: 'mcp__relay__worker_expand', role: 'coder', run: 1 })).result)
    expect(r).not.toContain('what the link target holds')
    expect(r).toContain('relay does not read .relay/runs/coder/001.full.md')
  })

  test('N108: a restart does not read a packet.json that is a link out', { options: WB }, async ($: any, on: any) => {
    const envelope = { run: 1, backend: 'werkbank', usage: {}, status: 'done', summary: 'what the link target holds', decisions: [], facts: [], artifacts: [], open_questions: [], needs_from_main: [], risks: [], next_suggested: [], sections: [] }
    const w = world(on, {
      files: { '.relay/queue.json': JSON.stringify(runningJob(1, 'stored')), '.relay/runs/coder/001.packet.json': JSON.stringify(envelope) },
      store: { 'roles:/w': { coder: { name: 'coder', runs: 1, isBusy: true } } },
    })
    w.links.set('.relay/runs/coder/001.packet.json', '/home/u/x.json')
    await w.clock.set(10 * 60_000)
    if (!(await w.start($))) return
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).not.toContain('what the link target holds')
    expect(w.submitted[0]).toContain('run 1 interrupted')
    expect(w.submitted[0]).toContain('the stored report was not read')
  })

  test('N109: a storage warning naming a credential in its path is redacted', { options: WB }, async ($: any, on: any) => {
    const w = world(on, { files: { '.relay/runs/coder/000.full.md': 'earlier' } })
    w.links.set('.relay/runs/coder/undelivered-1.md', `/home/u/password=${SECRETS.password}/x`)
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).toContain('Not stored: .relay/runs/coder/undelivered-1.md resolves to')
    expect(w.submitted[0]).not.toContain(SECRETS.password)
  })

  test('N110: a retried delivery does not overwrite the files of a later run in its slot', { options: { ...WB, keepRuns: 1 } }, async ($: any, on: any) => {
    const w = world(on)
    let isFull = true
    w.io.failWrite = (p: string) => isFull && p === '.relay/runs/coder/undelivered-1.md'
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 'task one' })
    await w.until(() => w.files.get('.relay/runs/coder/001.full.md')?.includes('task one') ?? false)
    await w.send($, { role: 'coder', task: 'task two' })
    await w.until(() => w.submitted.some(s => s.includes('run 2 finished')))
    expect(w.files.get('.relay/runs/coder/001.full.md')).toContain('task two')
    isFull = false
    for (let i = 0; i < 10 && !w.submitted.some(s => s.includes('run 1 ')); i++) await w.clock.advance(60_000)
    await w.until(() => w.submitted.some(s => s.includes('run 1 ')))
    const one = w.submitted.find(s => s.includes('run 1 '))!
    expect(one).toContain('Not stored: a later run holds this slot.')
    // run 2's files stay as they are
    expect(w.files.get('.relay/runs/coder/001.full.md')).toContain('task two')
    expect(w.files.get('.relay/runs/coder/001.packet.json')).toContain('"run": 2')
  })

  test('N111: a kept message shorter than its id line says is not delivered', { options: WB }, async ($: any, on: any) => {
    const w = world(on, {
      files: { '.relay/queue.json': JSON.stringify(runningJob(1)), '.relay/runs/coder/undelivered-1.md': `<!-- relay job j_1 length ${kept.length + 40} -->\n${kept}` },
      store: { 'roles:/w': { coder: { name: 'coder', runs: 1, isBusy: true } } },
    })
    await w.clock.set(10 * 60_000)
    if (!(await w.start($))) return
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).not.toContain('run one did it')
    expect(w.submitted[0]).toContain('run 1 interrupted')
  })

  test('N114: a key opened on stderr keeps its body in a codex error event out of live.log', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.play('key-stderr-event')
    if (!(await w.start($))) return
    await w.send($, { role: 'cx', task: 't', backend: 'codex' })
    await w.until(() => w.submitted.length === 1)
    expect(w.files.get('.relay/runs/cx/live.log')).not.toContain(KEY_BODY)
    expect(w.submitted[0]).not.toContain(KEY_BODY)
  })

  test('N114: a key opened on stderr hides the werkbank answer that holds its body', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.play('key-stderr-answer')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).not.toContain(KEY_BODY)
    expect(w.files.get('.relay/runs/coder/001.packet.json')).not.toContain(KEY_BODY)
    expect(w.files.get('.relay/runs/coder/001.full.md')).not.toContain(KEY_BODY)
    expect(w.submitted[0]).toContain(KEY_STILL_OPEN)
    expect(w.submitted[0]).toContain('Status: failed')
  })

  test('N115: a failed existence query keeps worker_expand from reading a linked full.md', { options: WB }, async ($: any, on: any) => {
    const w = world(on, {
      files: { '.relay/runs/coder/001.full.md': 'what the link target holds' },
      store: { 'roles:/w': { coder: { name: 'coder', runs: 1, isBusy: false } } },
    })
    w.links.set('.relay/runs/coder/001.full.md', '/home/u/.netrc')
    w.io.failExists = (p: string) => p === '.relay/runs/coder/001.full.md'
    if (!(await w.start($))) return
    const r = String((await $.tool.call({ tool: 'mcp__relay__worker_expand', role: 'coder', run: 1 })).result)
    expect(r).not.toContain('what the link target holds')
    expect(r).toContain('could not be checked')
  })

  test('N116: a delivery whose path check waits does not overwrite the later run in its slot', { options: { ...WB, keepRuns: 1 } }, async ($: any, on: any) => {
    const w = world(on)
    let isDelayed = false
    // run 1's existence query for its full.md (the check before its first
    // write) waits a minute; run 2 may run meanwhile (N126)
    w.io.existsDelay = (p: string) => (p === '.relay/runs/coder/001.full.md' && !isDelayed ? ((isDelayed = true), 60_000) : 0)
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 'task one' })
    await w.send($, { role: 'coder', task: 'task two' })
    for (let i = 0; i < 10 && w.submitted.length < 2; i++) await w.clock.advance(30_000)
    await w.until(() => w.submitted.length === 2)
    // the delay really happened
    expect(isDelayed).toBe(true)
    expect(w.files.get('.relay/runs/coder/001.full.md')).toContain('task two')
  })

  test('N117: a relay block removed by the redaction leaves no packet from a JSON example', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.play('key-fence-example')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).not.toContain('example only')
  })

  test('N118: a kept message that is a link out means interrupted, with or without delivery stored', { options: WB }, async ($: any, on: any) => {
    const w = world(on, {
      files: { '.relay/queue.json': JSON.stringify(runningJob(1)), '.relay/runs/coder/undelivered-1.md': `<!-- relay job j_1 length ${kept.length} -->\n${kept}` },
      store: { 'roles:/w': { coder: { name: 'coder', runs: 1, isBusy: true } } },
    })
    w.links.set('.relay/runs/coder/undelivered-1.md', '/home/u/x.md')
    await w.clock.set(10 * 60_000)
    if (!(await w.start($))) return
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).not.toContain('run one did it')
    expect(w.submitted[0]).toContain('run 1 interrupted')
    expect(w.submitted[0]).toContain('the kept message was not read')
  })

  test('N118: with delivery stored and a safe packet.json, a linked kept message still means interrupted', { options: WB }, async ($: any, on: any) => {
    const envelope = { run: 1, backend: 'werkbank', usage: {}, status: 'done', summary: 'stored packet', decisions: [], facts: [], artifacts: [], open_questions: [], needs_from_main: [], risks: [], next_suggested: [], sections: [] }
    const w = world(on, {
      files: { '.relay/queue.json': JSON.stringify(runningJob(1, 'stored')), '.relay/runs/coder/001.packet.json': JSON.stringify(envelope) },
      store: { 'roles:/w': { coder: { name: 'coder', runs: 1, isBusy: true } } },
    })
    w.links.set('.relay/runs/coder/undelivered-1.md', '/home/u/x.md')
    await w.clock.set(10 * 60_000)
    if (!(await w.start($))) return
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).toContain('run 1 interrupted')
    expect(w.submitted[0]).toContain('the kept message was not read')
  })

  test('N119: worker_expand redacts a section name it did not find', { options: WB }, async ($: any, on: any) => {
    const w = world(on, {
      // since N138 both files of the slot must name the run
      files: { '.relay/runs/coder/001.full.md': '# coder · run 1\n\n## Work\n\nDone.\n', '.relay/runs/coder/001.packet.json': JSON.stringify({ run: 1, status: 'done', summary: 'x' }) },
      store: { 'roles:/w': { coder: { name: 'coder', runs: 1, isBusy: false } } },
    })
    if (!(await w.start($))) return
    const r = String((await $.tool.call({ tool: 'mcp__relay__worker_expand', role: 'coder', run: 1, section: `token=${SECRETS.token}` })).result)
    expect(r).toContain('No section')
    expect(r).not.toContain(SECRETS.token)
  })

  test('N120: a key opened and closed on stderr around the answer hides the answer', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.play('key-closed-around-answer')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).not.toContain(KEY_BODY)
    expect(w.files.get('.relay/runs/coder/001.packet.json')).not.toContain(KEY_BODY)
    expect(w.files.get('.relay/runs/coder/001.full.md')).not.toContain(KEY_BODY)
    expect(w.submitted[0]).toContain(KEY_STILL_OPEN)
  })

  test('N121: a closed key around a codex error event keeps the body out of the whole live.log', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.play('key-closed-around-event')
    if (!(await w.start($))) return
    await w.send($, { role: 'cx', task: 't', backend: 'codex' })
    await w.until(() => w.submitted.length === 1)
    const live = w.files.get('.relay/runs/cx/live.log')!
    expect(live).not.toContain(KEY_BODY)
    expect(live).toContain('error (text hidden: a private key marker was in the output)')
    expect(w.submitted[0]).not.toContain(KEY_BODY)
  })

  test('N122: a credential option split from its value in werkbankBin runs nothing', { options: { ...WB, werkbankBin: '["werkbank-relay","--token","opaque0value0x7"]' } }, async ($: any, on: any) => {
    const w = world(on)
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.spawns).toHaveLength(0)
    expect(w.runs.some((r: { argv: string[] }) => r.argv.includes('opaque0value0x7'))).toBe(false)
    expect(w.submitted[0]).toContain('werkbankBin looks like it contains a credential')
    expect(w.submitted[0]).not.toContain('opaque0value0x7')
  })

  test('N123: an example relay block is no packet when the redaction removed the real one', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.play('key-example-block')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).not.toContain('example only')
    expect(w.submitted[0]).not.toContain('Status: done')
  })

  test('N124: a queue write that fails after the delivery keeps the kept message', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    if (!(await w.start($))) return
    w.io.failWrite = (p: string) => p === '.relay/queue.json' && w.submitted.length >= 1
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    await w.clock.settle()
    expect(w.files.get('.relay/runs/coder/undelivered-1.md')).toMatch(/^<!-- relay job \S+ length \d+ -->\n/)
  })

  test('N125: worker_send redacts a refusal whose path check failed with a credential in its error', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.io.failExists = (p: string) => (p === '.relay' ? `EACCES: token=${SECRETS.token}` : false)
    if (!(await w.start($))) return
    const r = String((await w.send($, { role: 'coder', task: 't' })).result)
    expect(r).toContain('relay takes no tasks in this session')
    expect(r).not.toContain(SECRETS.token)
  })

  test('N127: a key marker in a stdout field hides the error message holding the body', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.play('key-marker-error')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).not.toContain(KEY_BODY)
    expect(w.files.get('.relay/runs/coder/001.packet.json')).not.toContain(KEY_BODY)
    expect(w.submitted[0]).toContain("(text hidden: the run's output contains a private key marker)")
  })

  test('N128: an unfinished stdout line with a key marker holds back a stderr line in live.log', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.play('key-fragment')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.files.get('.relay/runs/coder/live.log')).not.toContain(KEY_BODY)
  })

  test('N129: a slot whose packet.json names a later run is not written', { options: { ...WB, keepRuns: 1 } }, async ($: any, on: any) => {
    const later = JSON.stringify({ run: 2, backend: 'werkbank', usage: {}, status: 'done', summary: 'run two did it' })
    const w = world(on, { files: { '.relay/runs/coder/001.packet.json': later, '.relay/runs/coder/001.full.md': '# coder · run 2' } })
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.files.get('.relay/runs/coder/001.packet.json')).toBe(later)
    expect(w.files.get('.relay/runs/coder/001.full.md')).toBe('# coder · run 2')
    expect(w.submitted[0]).toContain('Not stored: a later run holds this slot.')
  })

  test('N130: a message rebuilt from packet.json after a restart is redacted', { options: { ...WB, relayDir: `.relay_token=${SECRETS.token}` } }, async ($: any, on: any) => {
    const dir = `.relay_token=${SECRETS.token}`
    const envelope = { run: 1, backend: 'werkbank', usage: {}, status: 'done', summary: 'stored packet', decisions: [], facts: [], artifacts: [], open_questions: [], needs_from_main: [], risks: [], next_suggested: [], sections: [] }
    const w = world(on, {
      files: { [`${dir}/queue.json`]: JSON.stringify(runningJob(1, 'stored')), [`${dir}/runs/coder/001.packet.json`]: JSON.stringify(envelope) },
      store: { 'roles:/w': { coder: { name: 'coder', runs: 1, isBusy: true } } },
    })
    await w.clock.set(10 * 60_000)
    if (!(await w.start($))) return
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).toContain('stored packet')
    expect(w.submitted[0]).not.toContain(SECRETS.token)
  })

  test('N131: worker_expand does not show another run in the slot as the asked one', { options: { ...WB, keepRuns: 1 } }, async ($: any, on: any) => {
    const stale = JSON.stringify({ run: 1, backend: 'werkbank', usage: {}, status: 'done', summary: 'run one did it' })
    const w = world(on, {
      files: { '.relay/runs/coder/001.packet.json': stale, '.relay/runs/coder/001.full.md': '# coder · run 1\n\n## Answer\n\nrun one did it\n' },
      store: { 'roles:/w': { coder: { name: 'coder', runs: 2, isBusy: false } } },
    })
    if (!(await w.start($))) return
    for (const section of [undefined, 'packet']) {
      const r = String((await $.tool.call({ tool: 'mcp__relay__worker_expand', role: 'coder', run: 2, ...(section ? { section } : {}) })).result)
      expect(r).not.toContain('run one did it')
      expect(r).toContain('the slot holds another run')
    }
    const future = String((await $.tool.call({ tool: 'mcp__relay__worker_expand', role: 'coder', run: 5 })).result)
    expect(future).toContain('has no run 5 yet')
  })

  test('N132: a protocol file that could not be cleared is named and cleared with a later heartbeat', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    const path = '.relay/tmp/coder-1.protocol.md'
    let writes = 0
    let isFull = true
    w.io.failWrite = (p: string) => p === path && ++writes >= 2 && isFull
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).toContain(`${path} could not be cleared`)
    expect(w.files.get(path)).not.toBe('')
    isFull = false
    for (let i = 0; i < 5 && w.files.get(path) !== ''; i++) await w.clock.advance(60_000)
    expect(w.files.get(path)).toBe('')
  })

  test('N133: a run with a key marker and exit 0 never ends live.log with finished', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.play('key-lines')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    const live = w.files.get('.relay/runs/coder/live.log')!
    expect(live).toContain('# failed (answer hidden: a private key marker was in the output)')
    expect(live).not.toContain('# finished')
  })

  test('N134: after a key marker on stdout, a stderr line finished after the key closed stays out of live.log', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.play('key-split-fragment')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.files.get('.relay/runs/coder/live.log')).not.toContain(KEY_BODY)
  })

  test('N135: a key marker in the answer hides verify.command of the werkbank job', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.play('key-verify-command')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).not.toContain(KEY_BODY)
    expect(w.files.get('.relay/runs/coder/001.packet.json')).not.toContain(KEY_BODY)
    expect(w.submitted[0]).toContain('write check incomplete')
  })

  test('N136: a slot whose packet.json cannot be read is not written', { options: { ...WB, keepRuns: 1 } }, async ($: any, on: any) => {
    const later = JSON.stringify({ run: 2, backend: 'werkbank', usage: {}, status: 'done', summary: 'run two did it' })
    const w = world(on, { files: { '.relay/runs/coder/001.packet.json': later, '.relay/runs/coder/001.full.md': '# coder · run 2' } })
    w.io.failRead = (p: string) => p === '.relay/runs/coder/001.packet.json'
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.files.get('.relay/runs/coder/001.packet.json')).toBe(later)
    expect(w.files.get('.relay/runs/coder/001.full.md')).toBe('# coder · run 2')
    expect(w.submitted[0]).toContain('Not stored: the slot could not be checked')
  })

  test('N137: a roles file that cannot be parsed keeps the job queued, not started without owns', { options: WB }, async ($: any, on: any) => {
    // queued while the file was fine (since N151 a send with a broken file is refused)
    const w = world(on, {
      files: { '.relay/queue.json': JSON.stringify(waitingJob), '.relay/roles.json': '{ "roles": { "coder": { "owns": ["src"] } }' },
      store: { 'roles:/w': { coder: { name: 'coder', runs: 0, isBusy: false } } },
    })
    await w.clock.set(10 * 60_000)
    if (!(await w.start($))) return
    for (let i = 0; i < 3; i++) await w.clock.advance(60_000)
    expect(w.spawns).toHaveLength(0)
    expect(await w.status($)).toContain('the roles file .relay/roles.json could not be read')
    // fixed: the job starts with its owns
    w.files.set('.relay/roles.json', JSON.stringify({ roles: { coder: { owns: ['src'] } } }))
    for (let i = 0; i < 3 && !w.spawns.length; i++) await w.clock.advance(60_000)
    await w.until(() => w.spawns.length === 1)
    const a = w.spawns[0]!.argv
    expect(a[a.indexOf('--owns') + 1]).toBe('src')
  })

  test('N138: worker_expand refuses a slot whose two files name different runs', { options: { ...WB, keepRuns: 1 } }, async ($: any, on: any) => {
    const w = world(on, {
      files: {
        '.relay/runs/coder/001.packet.json': JSON.stringify({ run: 1, backend: 'werkbank', usage: {}, status: 'done', summary: 'run one did it' }),
        '.relay/runs/coder/001.full.md': '# coder · run 2\n\n## Answer\n\nrun two answer\n',
      },
      store: { 'roles:/w': { coder: { name: 'coder', runs: 2, isBusy: false } } },
    })
    if (!(await w.start($))) return
    const r = String((await $.tool.call({ tool: 'mcp__relay__worker_expand', role: 'coder', run: 2 })).result)
    expect(r).not.toContain('run two answer')
    expect(r).toContain('its two files do not match')
  })

  test('N139: a temp file is cleared again even while the queue cannot be written', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    const path = '.relay/tmp/coder-1.protocol.md'
    let writes = 0
    let isFull = true
    w.io.failWrite = (p: string) => (p === path && ++writes >= 2 && isFull) || (p === '.relay/queue.json' && w.submitted.length >= 1)
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.files.get(path)).not.toBe('')
    isFull = false
    for (let i = 0; i < 5 && w.files.get(path) !== ''; i++) await w.clock.advance(60_000)
    expect(w.files.get(path)).toBe('')
  })

  test('N141: a key marker keeps a reported session id and model name out of reports and the next run', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.play('key-session-model')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 'one' })
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).not.toContain(KEY_BODY)
    expect(w.files.get('.relay/runs/coder/001.packet.json')).not.toContain(KEY_BODY)
    await w.send($, { role: 'coder', task: 'two' })
    await w.until(() => w.submitted.length === 2)
    expect(w.spawns[1]!.argv.join(' ')).not.toContain(KEY_BODY)
  })

  test('N142: a generic key= value in the model starts nothing', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't', model: 'key=opaque0value0x7' })
    await w.until(() => w.submitted.length === 1)
    expect(w.spawns).toHaveLength(0)
    expect(w.submitted[0]).not.toContain('opaque0value0x7')
  })

  test('N142: a quoted Authorization value on stderr stays out of live.log', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.play('quoted-auth')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.files.get('.relay/runs/coder/live.log')).not.toContain('opaque0value0x8')
  })

  test('N143: a roles file whose roles is no object keeps the job queued', { options: WB }, async ($: any, on: any) => {
    const w = world(on, {
      files: { '.relay/queue.json': JSON.stringify(waitingJob), '.relay/roles.json': '{"roles":"broken"}' },
      store: { 'roles:/w': { coder: { name: 'coder', runs: 0, isBusy: false } } },
    })
    await w.clock.set(10 * 60_000)
    if (!(await w.start($))) return
    for (let i = 0; i < 3; i++) await w.clock.advance(60_000)
    expect(w.spawns).toHaveLength(0)
    expect(await w.status($)).toContain('roles is no JSON object')
  })

  test('N144: a live.log a later run began is not overwritten', { options: WB }, async ($: any, on: any) => {
    const later = '# coder · run 5 · werkbank · started 2026-11-20T00:00:00.000Z\nlater run\n'
    const w = world(on, { files: { '.relay/runs/coder/live.log': later } })
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.files.get('.relay/runs/coder/live.log')).toBe(later)
    expect(w.submitted[0]).toContain('live.log was not written: a later run holds it')
  })

  test('N145: a slot whose packet.json names run 0.5 is not written', { options: { ...WB, keepRuns: 1 } }, async ($: any, on: any) => {
    const odd = JSON.stringify({ run: 0.5, backend: 'werkbank', usage: {}, status: 'done', summary: 'odd' })
    const w = world(on, { files: { '.relay/runs/coder/001.packet.json': odd } })
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.files.get('.relay/runs/coder/001.packet.json')).toBe(odd)
    expect(w.submitted[0]).toContain('names no valid run')
  })

  test('N146: a queued job finds its role once the roles file is repaired', { options: WB }, async ($: any, on: any) => {
    const waiting = {
      version: 1,
      owner: { session: 'old', heartbeatAt: '1970-01-01T00:00:00.000Z' },
      jobs: [{ id: 'j_1', role: 'coder', task: 't', enqueuedAt: '1970-01-01T00:00:00.000Z', state: 'queued', backend: 'werkbank' }],
    }
    const w = world(on, { files: { '.relay/queue.json': JSON.stringify(waiting), '.relay/roles.json': '{ broken' } })
    await w.clock.set(10 * 60_000)
    if (!(await w.start($))) return
    for (let i = 0; i < 2; i++) await w.clock.advance(60_000)
    expect(w.spawns).toHaveLength(0)
    w.files.set('.relay/roles.json', JSON.stringify({ roles: { coder: { owns: ['src'] } } }))
    for (let i = 0; i < 3 && !w.spawns.length; i++) await w.clock.advance(60_000)
    await w.until(() => w.spawns.length === 1)
    expect(w.spawns).toHaveLength(1)
  })

  test('N147: worker_expand names a full.md that is a link when the packet is asked for', { options: WB }, async ($: any, on: any) => {
    const w = world(on, {
      files: {
        '.relay/runs/coder/001.packet.json': JSON.stringify({ run: 1, backend: 'werkbank', usage: {}, status: 'done', summary: 'x' }),
        '.relay/runs/coder/001.full.md': '# coder · run 1\n',
      },
      store: { 'roles:/w': { coder: { name: 'coder', runs: 1, isBusy: false } } },
    })
    w.links.set('.relay/runs/coder/001.full.md', '/home/u/x.md')
    if (!(await w.start($))) return
    const r = String((await $.tool.call({ tool: 'mcp__relay__worker_expand', role: 'coder', run: 1, section: 'packet' })).result)
    expect(r).toContain('relay does not read .relay/runs/coder/001.full.md')
  })

  test('N148: an invalid roles entry with an empty name keeps the job queued', { options: WB }, async ($: any, on: any) => {
    const w = world(on, {
      files: { '.relay/queue.json': JSON.stringify(waitingJob), '.relay/roles.json': JSON.stringify({ roles: { '': 'broken', coder: { owns: 7 } } }) },
      store: { 'roles:/w': { coder: { name: 'coder', runs: 0, isBusy: false } } },
    })
    await w.clock.set(10 * 60_000)
    if (!(await w.start($))) return
    for (let i = 0; i < 3; i++) await w.clock.advance(60_000)
    expect(w.spawns).toHaveLength(0)
    expect(await w.status($)).toContain('role "(empty name)" has an invalid entry')
  })

  test('N149: a quoted Authorization value with an escaped quote is redacted whole', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.play('quoted-auth-escaped')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.files.get('.relay/runs/coder/live.log')).not.toContain('opaque0tail0x9')
  })

  test('N150: after a key marker the job id is hidden and an unknown state means failed', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.play('key-bad-state')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).not.toContain('opaque0job0x10')
    expect(w.submitted[0]).not.toContain('opaque0state0x11')
    expect(w.files.get('.relay/runs/coder/001.packet.json')).not.toContain('opaque0job0x10')
    expect(w.submitted[0]).toContain('Status: failed')
  })

  test('N151: worker_send refuses a task while the roles file cannot be read', { options: WB }, async ($: any, on: any) => {
    const w = world(on, { files: { '.relay/roles.json': '{ broken' } })
    if (!(await w.start($))) return
    const r = String((await w.send($, { role: 'coder', task: 't' })).result)
    expect(r).toContain('relay takes no task now: the roles file .relay/roles.json could not be read')
    expect(w.queueFile().jobs).toHaveLength(0)
  })

  test('N152: after a restart that delivered run 1, the next task gets run 2', { options: WB }, async ($: any, on: any) => {
    const kept = '[relay] coder · run 1 finished (werkbank)\nStatus: done\nrun one did it'
    const running = {
      version: 1,
      owner: { session: 'old', heartbeatAt: '1970-01-01T00:00:00.000Z' },
      jobs: [{ id: 'j_1', role: 'coder', task: 't', enqueuedAt: '1970-01-01T00:00:00.000Z', state: 'running', run: 1, backend: 'werkbank' }],
    }
    const w = world(on, {
      files: { '.relay/queue.json': JSON.stringify(running), '.relay/runs/coder/undelivered-1.md': `<!-- relay job j_1 length ${kept.length} -->\n${kept}` },
    })
    await w.clock.set(10 * 60_000)
    if (!(await w.start($))) return
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).toContain('run one did it')
    await w.send($, { role: 'coder', task: 'next' })
    await w.until(() => w.spawns.length === 1)
    const a = w.spawns[0]!.argv
    expect(a[a.indexOf('--run') + 1]).toBe('2')
  })

  test('N153: a split --key option in werkbankBin runs nothing', { options: { ...WB, werkbankBin: '["werkbank-relay","--key","opaque0value0x12"]' } }, async ($: any, on: any) => {
    const w = world(on)
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.spawns).toHaveLength(0)
    expect(w.runs.some((r: { argv: string[] }) => r.argv.includes('opaque0value0x12'))).toBe(false)
  })

  test('N154: worker_expand names a missing companion file', { options: WB }, async ($: any, on: any) => {
    const w = world(on, {
      files: { '.relay/runs/coder/001.packet.json': JSON.stringify({ run: 1, backend: 'werkbank', usage: {}, status: 'done', summary: 'x' }) },
      store: { 'roles:/w': { coder: { name: 'coder', runs: 1, isBusy: false } } },
    })
    if (!(await w.start($))) return
    const r = String((await $.tool.call({ tool: 'mcp__relay__worker_expand', role: 'coder', run: 1, section: 'packet' })).result)
    expect(r).toContain('.relay/runs/coder/001.full.md is missing or unreadable')
  })

  test('N155: a key marker in a stream read error hides the answer', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.play('key-read-error')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).not.toContain('opaque0answer0x16')
    expect(w.submitted[0]).toContain(KEY_STILL_OPEN)
    expect(w.files.get('.relay/runs/coder/001.full.md') ?? '').not.toContain('opaque0answer0x16')
    expect(w.files.get('.relay/runs/coder/001.packet.json') ?? '').not.toContain('opaque0answer0x16')
  })

  test('N156: once-escaped JSON values are replaced whole, a sibling field stays', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.play('quoted-escaped-json')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    const log = w.files.get('.relay/runs/coder/live.log') ?? ''
    expect(log).not.toContain('opaque0head')
    expect(log).not.toContain('opaque0tail0x13')
    expect(log).not.toContain('opaque0auth0x14')
    expect(log).toContain('keep0me0x15')
    expect(log).toContain('\\"next\\": 1')
  })

  test('N157: every worker_expand answer is redacted, the missing-file one too', { options: { ...WB, relayDir: `.relay_token=${SECRETS.token}` } }, async ($: any, on: any) => {
    const dir = `.relay_token=${SECRETS.token}`
    const w = world(on, {
      files: { [`${dir}/runs/coder/001.packet.json`]: JSON.stringify({ run: 1, backend: 'werkbank', usage: {}, status: 'done', summary: 'x' }) },
      store: { 'roles:/w': { coder: { name: 'coder', runs: 1, isBusy: false } } },
    })
    if (!(await w.start($))) return
    const r = String((await $.tool.call({ tool: 'mcp__relay__worker_expand', role: 'coder', run: 1, section: 'packet' })).result)
    expect(r).toContain('is missing or unreadable')
    expect(r).not.toContain(SECRETS.token)
  })

  test('N158: a stored report of a role unknown everywhere is delivered and its run kept', { options: WB }, async ($: any, on: any) => {
    const envelope = { run: 1, backend: 'werkbank', usage: {}, status: 'done', summary: 'stored ghost report', decisions: [], facts: [], artifacts: [], open_questions: [], needs_from_main: [], risks: [], next_suggested: [], sections: [] }
    const w = world(on, {
      files: { '.relay/queue.json': JSON.stringify(runningJob(1, 'stored')), '.relay/runs/coder/001.packet.json': JSON.stringify(envelope) },
    })
    await w.clock.set(10 * 60_000)
    if (!(await w.start($))) return
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).toContain('stored ghost report')
    await w.send($, { role: 'coder', task: 'next' })
    await w.until(() => w.spawns.length === 1)
    const a = w.spawns[0]!.argv
    expect(a[a.indexOf('--run') + 1]).toBe('2')
  })

  test('N159: worker_expand refuses a run that is no whole number from 1', { options: WB }, async ($: any, on: any) => {
    const w = world(on, {
      files: { '.relay/runs/coder/001.packet.json': JSON.stringify({ run: 1.5, backend: 'werkbank', usage: {}, status: 'done', summary: 'half run' }) },
      store: { 'roles:/w': { coder: { name: 'coder', runs: 2, isBusy: false } } },
    })
    if (!(await w.start($))) return
    const r = String((await $.tool.call({ tool: 'mcp__relay__worker_expand', role: 'coder', run: 1.5, section: 'packet' })).result)
    expect(r).toContain('Run must be a whole number from 1')
    expect(r).not.toContain('half run')
  })

  test('N160: a \\u005c before a quote in once-escaped JSON does not end the value', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    w.play('quoted-unicode-escape')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    const log = w.files.get('.relay/runs/coder/live.log') ?? ''
    expect(log).not.toContain('opaque0head0x17')
    expect(log).not.toContain('opaque0tail0x18')
    expect(log).toContain('keep0me0x19')
  })

  test('N161: an earlier run never writes over a full.md a later run wrote first', { options: { ...WB, keepRuns: 1 } }, async ($: any, on: any) => {
    const later = '# coder · run 2\n\n## Answer\n\nrun two answer\n'
    const w = world(on, {
      files: {
        '.relay/queue.json': JSON.stringify(runningJob(1)),
        '.relay/runs/coder/001.packet.json': JSON.stringify({ run: 1, backend: 'werkbank', usage: {}, status: 'done', summary: 'run one' }),
        '.relay/runs/coder/001.full.md': later,
      },
      store: { 'roles:/w': { coder: { name: 'coder', runs: 1, isBusy: true } } },
    })
    await w.clock.set(10 * 60_000)
    if (!(await w.start($))) return
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).toContain('run 1 interrupted')
    expect(w.files.get('.relay/runs/coder/001.full.md')).toBe(later)
    expect(w.submitted[0]).toContain('Not stored: a later run holds this slot')
  })

  test('N162: a heartbeat during the roles file check writes no job as running', { options: WB }, async ($: any, on: any) => {
    const w = world(on, { files: { '.relay/roles.json': '{}' } })
    if (!(await w.start($))) return
    let isDelayed = false
    // the first roles file check after the job is queued waits five minutes
    w.io.existsDelay = (p: string) => (p === '.relay/roles.json' && !isDelayed && w.queueFile().jobs.length > 0 ? ((isDelayed = true), 5 * 60_000) : 0)
    const sent = w.send($, { role: 'coder', task: 't' })
    expect(await w.until(() => isDelayed)).toBe(true)
    // heartbeats while the roles file check waits
    for (let i = 0; i < 4; i++) {
      await w.clock.advance(60_000)
      expect(w.queueFile().jobs.map((j: { state: string }) => j.state)).toEqual(['queued'])
    }
    expect(isDelayed).toBe(true)
    await w.clock.advance(2 * 60_000)
    await sent
    await w.until(() => w.submitted.length === 1)
    expect(w.spawns).toHaveLength(1)
  })

  test('N163: a restart delivers nothing before the run number is stored', { options: WB }, async ($: any, on: any) => {
    const w = world(on, {
      files: { '.relay/queue.json': JSON.stringify(runningJob(1)), '.relay/runs/coder/undelivered-1.md': `<!-- relay job j_1 length ${kept.length} -->\n${kept}` },
    })
    // the first save that holds the coder role (its run number) fails
    let isFailed = false
    w.io.failStoreSet = (v: unknown) => (!isFailed && JSON.stringify(v).includes('"coder"') ? (isFailed = true) : false)
    await w.clock.set(10 * 60_000)
    if (!(await w.start($))) return
    await w.until(() => false, 20)
    expect(isFailed).toBe(true)
    expect(w.submitted).toHaveLength(0)
    expect(w.queueFile().jobs.map((j: { id: string }) => j.id)).toEqual(['j_1'])
    expect(w.files.get('.relay/runs/coder/undelivered-1.md')).toContain('run one did it')
    expect(await w.status($)).toContain('the run number could not be stored')
  })

  test('N164: an unreadable live.log is not written over, and the packet says why', { options: WB }, async ($: any, on: any) => {
    const later = '# coder · run 2 · werkbank · started 1970-01-01T00:00:00.000Z\nrun two line\n'
    const w = world(on, { files: { '.relay/runs/coder/live.log': later } })
    w.io.failRead = (p: string) => p === '.relay/runs/coder/live.log'
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.files.get('.relay/runs/coder/live.log')).toBe(later)
    expect(w.submitted[0]).toContain('live.log could not be read')
  })

  test('N165: with writeCheck off a werkbank run has no write check', { options: { ...WB, writeCheck: 'off' } }, async ($: any, on: any) => {
    const w = world(on)
    w.play('write-outside')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't', owns: ['src/'] })
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).not.toContain('wrote outside owns')
    expect(w.submitted[0]).toContain('Status: done')
    expect(JSON.parse(w.files.get('.relay/runs/coder/001.packet.json')!).write_check).toBeUndefined()
  })

  test('N165: a parallel werkbank run does not take over a local worker\'s outside write', { options: { maxParallel: 2 } }, async ($: any, on: any) => {
    const w = world(on)
    w.play('held', 'held')
    if (!(await w.start($))) return
    await w.send($, { role: 'remote', task: 'R', owns: ['src/'], backend: 'werkbank' })
    await w.send($, { role: 'local', task: 'L', owns: ['docs/'] })
    expect(await w.until(() => w.heldCount() === 2)).toBe(true)
    // the local worker writes in src/, which the werkbank role owns
    w.git.status.push({ code: '??', path: 'src/x.ts', hash: 'h1' })
    w.releaseOne()
    expect(await w.until(() => w.submitted.length === 1)).toBe(true)
    w.releaseHeld()
    expect(await w.until(() => w.submitted.length === 2)).toBe(true)
    const local = w.submitted.find(s => s.startsWith('[relay] local'))!
    expect(local).toContain('wrote outside owns: src/x.ts')
    expect(local).not.toContain('probably by remote')
  })

  test('N112: worker_status shows no worktree for werkbank', { options: WB }, async ($: any, on: any) => {
    const w = world(on)
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't', isolation: 'worktree' })
    await w.until(() => w.submitted.length === 1)
    const status = await w.status($)
    expect(status).toMatch(/ignored: [^\n]*isolation/)
    expect(status).not.toContain('· worktree')
  })
})

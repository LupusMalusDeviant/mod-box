// Regression tests for the second review of relay 0.4.0 (contract 0001,
// Nachtrag 1, rows N15–N27): each describe names the finding it guards.
import { describe, expect, test } from 'claude-code/testing'
import { SECRETS, fakeWorld } from './fakes.ts'

const T0 = '1970-01-01T00:00:00.000Z'
const job = (id: string, role: string, state: 'queued' | 'running', extra: Record<string, unknown> = {}) => ({
  id,
  role,
  task: `task of ${role}`,
  enqueuedAt: T0,
  state,
  backend: 'claude',
  ...(state === 'running' ? { run: 1 } : {}),
  ...extra,
})
const roleA = { 'roles:/w': { a: { name: 'a', runs: 1, isBusy: true } } }

describe('review 2, finding 1: no report is lost', () => {
  test('a failing fallback compressor gives a failed packet and keeps the answer', async ($: any, on: any) => {
    const w = fakeWorld(on)
    w.io.failModel = true
    w.play('no-packet')
    if (!(await w.start($))) return
    await w.send($, { role: 'a', task: 't' })
    expect(await w.until(() => w.submitted.length === 1)).toBe(true)
    expect(w.submitted[0]).toContain('Status: failed')
    expect(w.submitted[0]).toContain('fallback compression is off or failed: ')
    expect(w.files.get('.relay/runs/a/001.full.md')).toContain('Plain prose, no packet.')
    expect(w.queueFile().jobs).toEqual([])
  })

  test('run files that cannot be stored keep the job, and a heartbeat delivers it later', async ($: any, on: any) => {
    const w = fakeWorld(on)
    if (!(await w.start($))) return
    w.io.failWrite = p => p.endsWith('.full.md')
    await w.send($, { role: 'a', task: 't' })
    await w.until(() => w.spawns.length === 1)
    await w.until(() => false, 30)
    expect(w.submitted).toHaveLength(0)
    expect(w.queueFile().jobs.map(j => `${j.role}:${j.state}`)).toEqual(['a:running'])
    expect(await w.status($)).toContain('could not store a run 1')
    w.io.failWrite = () => false
    await w.clock.advance(60_000)
    expect(await w.until(() => w.submitted.length === 1)).toBe(true)
    expect(w.queueFile().jobs).toEqual([])
  })

  test('an interrupted report whose notification fails stays, marked as stored, and is sent later', { options: { notifyMode: 'note' } }, async ($: any, on: any) => {
    const queue = { version: 1, owner: { session: 'old', heartbeatAt: T0 }, jobs: [job('j_a', 'a', 'running')] }
    const w = fakeWorld(on, { files: { '.relay/queue.json': JSON.stringify(queue) }, store: roleA })
    let appends = 0
    w.io.failAppend = () => ++appends === 1
    await w.clock.set(10 * 60_000)
    if (!(await w.start($))) return
    await w.until(() => false, 30)
    expect(w.submitted).toHaveLength(0)
    expect(w.queueFile().jobs.map(j => `${j.id}:${(j as { delivery?: string }).delivery}`)).toEqual(['j_a:stored'])
    await w.clock.advance(60_000)
    expect(await w.until(() => w.submitted.length === 1)).toBe(true)
    expect(w.submitted[0]).toContain('[relay] a · run 1 interrupted')
    expect(w.queueFile().jobs).toEqual([])
  })

  test('after a restart a stored but undelivered packet is delivered, not called interrupted', async ($: any, on: any) => {
    const queue = { version: 1, owner: { session: 'old', heartbeatAt: T0 }, jobs: [job('j_a', 'a', 'running', { delivery: 'stored' })] }
    const packet = { run: 1, backend: 'claude', usage: {}, status: 'done', summary: 'It was done.', decisions: [], facts: [], artifacts: [], open_questions: [], needs_from_main: [], risks: [], next_suggested: [], sections: [] }
    const w = fakeWorld(on, { files: { '.relay/queue.json': JSON.stringify(queue), '.relay/runs/a/001.packet.json': JSON.stringify(packet) }, store: roleA })
    await w.clock.set(10 * 60_000)
    if (!(await w.start($))) return
    expect(await w.until(() => w.submitted.length === 1)).toBe(true)
    expect(w.submitted[0]).toContain('delivered after a restart')
    expect(w.submitted[0]).toContain('It was done.')
    expect(w.submitted[0]).not.toContain('interrupted')
  })
})

describe('review 2, finding 2: a claim never overwrites a fresher one', () => {
  test('a claim made while this session read the queue is respected, with its jobs', async ($: any, on: any) => {
    const w = fakeWorld(on, { files: { '.relay/queue.json': JSON.stringify({ version: 1, jobs: [] }) } })
    // The other session claims between this start's read and its claim.
    w.io.afterRegister = name => {
      if (name === 'worker_expand') {
        w.files.set('.relay/queue.json', JSON.stringify({ version: 1, owner: { session: 'other', heartbeatAt: T0, token: 'tok-other' }, jobs: [job('j_o', 'o', 'queued')] }))
      }
    }
    if (!(await w.start($))) return
    const r = await w.send($, { role: 'a', task: 't' })
    expect(String(r.result)).toContain('worked by another Claude Code session')
    expect(w.queueFile().owner?.token).toBe('tok-other')
    expect(w.queueFile().jobs.map(j => j.id)).toEqual(['j_o'])
    expect(w.spawns).toHaveLength(0)
  })
})

describe('review 2, finding 3: no write before the path is known to stay inside', () => {
  test('a linked worktrees folder: git worktree add never runs', async ($: any, on: any) => {
    const w = fakeWorld(on)
    if (!(await w.start($))) return
    w.links.set('.relay/worktrees', '/outside/wt')
    await w.send($, { role: 'coder', task: 't', isolation: 'worktree' })
    expect(await w.until(() => w.submitted.length === 1)).toBe(true)
    expect(w.runs.some(r => r.argv.join(' ').startsWith('git worktree add'))).toBe(false)
    expect(w.submitted[0]).toContain('.relay/worktrees resolves to /outside/wt, outside the project')
    expect(w.spawns).toHaveLength(0)
  })

  test('a linked relay folder: nothing is written at the start, sends are refused', async ($: any, on: any) => {
    const w = fakeWorld(on)
    w.links.set('.relay', '/elsewhere/.relay')
    if (!(await w.start($))) return
    const r = await w.send($, { role: 'a', task: 't' })
    expect(String(r.result)).toContain('outside the project')
    expect([...w.files.keys()].filter(k => k.startsWith('.relay/'))).toEqual([])
    expect(w.spawns).toHaveLength(0)
  })

  test('a linked runs folder: a shared role writes no run files there', async ($: any, on: any) => {
    const w = fakeWorld(on)
    if (!(await w.start($))) return
    w.links.set('.relay/runs', '/elsewhere/runs')
    await w.send($, { role: 'a', task: 't' })
    expect(await w.until(() => w.submitted.length === 1)).toBe(true)
    expect([...w.files.keys()].filter(k => k.startsWith('.relay/runs/'))).toEqual([])
    expect(w.submitted[0]).toContain('Not stored: .relay/runs resolves to /elsewhere/runs')
    expect(w.spawns).toHaveLength(0)
  })
})

describe('review 2, finding 5: a brief with credentials stays out of argv', () => {
  for (const backend of ['claude', 'codex', 'opencode'] as const) {
    test(`${backend}: the brief goes with the task, the system prompt gets it redacted`, { options: { defaultBackend: backend } }, async ($: any, on: any) => {
      const w = fakeWorld(on)
      if (!(await w.start($))) return
      const model = backend === 'opencode' ? { model: 'ollama/m' } : {}
      await w.send($, { role: 'r', task: 'Deploy', brief: `Deploy with API_TOKEN=${SECRETS.token}`, ...model })
      expect(await w.until(() => w.submitted.length === 1)).toBe(true)
      const call = w.spawns[0]!
      expect(call.argv.join(' ').includes(SECRETS.token)).toBe(false)
      expect(JSON.stringify(call.env).includes(SECRETS.token)).toBe(false)
      expect(String(call.input ?? call.attachment)).toContain(`API_TOKEN=${SECRETS.token}`)
    })
  }

  test('a brief without credentials keeps the 0.3.0 argv', async ($: any, on: any) => {
    const w = fakeWorld(on)
    if (!(await w.start($))) return
    await w.send($, { role: 'r', task: 'Do', brief: 'Writes the docs.' })
    expect(await w.until(() => w.submitted.length === 1)).toBe(true)
    expect(w.spawns[0]!.argv.join(' ')).toContain('Your role: Writes the docs.')
    expect(w.spawns[0]!.input).toBe('Do')
  })
})

describe('review 2, finding 6: an empty queue.json never replaces a good backup', () => {
  test('main empty, backup good, main not writable: the backup keeps the jobs', async ($: any, on: any) => {
    const bak = { version: 1, jobs: [job('j_9', 'a', 'queued')] }
    const w = fakeWorld(on, { files: { '.relay/queue.json': '', '.relay/queue.json.bak': JSON.stringify(bak) }, store: { 'roles:/w': { a: { name: 'a', runs: 0, isBusy: false } } } })
    w.io.failWrite = p => p === '.relay/queue.json'
    if (!(await w.start($))) return
    expect(JSON.parse(w.files.get('.relay/queue.json.bak')!).jobs[0].id).toBe('j_9')
    expect(w.spawns).toHaveLength(0)
    expect(await w.status($)).toContain('read queue.json.bak')
  })
})

describe('review 2, finding 8: no task file outlives its run', () => {
  test('an interrupted opencode run leaves no task in its file', async ($: any, on: any) => {
    const queue = { version: 1, owner: { session: 'old', heartbeatAt: T0 }, jobs: [job('j_a', 'a', 'running', { backend: 'opencode' })] }
    const w = fakeWorld(on, { files: { '.relay/queue.json': JSON.stringify(queue), '.relay/tmp/a-1.md': 'the raw task' }, store: roleA })
    await w.clock.set(10 * 60_000)
    if (!(await w.start($))) return
    expect(await w.until(() => w.submitted.length === 1)).toBe(true)
    expect(w.files.get('.relay/tmp/a-1.md')).toBe('')
  })
})

describe('review 2, finding 9: a failed dispatch is retried', () => {
  test('once the queue can be written again, the next heartbeat starts the job', async ($: any, on: any) => {
    const w = fakeWorld(on)
    if (!(await w.start($))) return
    let writes = 0
    w.io.failWrite = p => p === '.relay/queue.json' && ++writes === 2
    const r = await w.send($, { role: 'a', task: 't' })
    expect(String(r.result)).toContain('could not be started yet')
    expect(w.spawns).toHaveLength(0)
    await w.clock.advance(60_000)
    expect(await w.until(() => w.spawns.length === 1)).toBe(true)
    expect(await w.until(() => w.submitted.length === 1)).toBe(true)
  })
})

describe('review 2, finding 10: a role that finished first still counts', () => {
  test('changes of a role that finished earlier are attributed to it', { options: { maxParallel: 2 } }, async ($: any, on: any) => {
    const w = fakeWorld(on)
    w.play('held', 'held')
    if (!(await w.start($))) return
    await w.send($, { role: 'a', task: 'A', owns: ['src/'] })
    await w.send($, { role: 'b', task: 'B', owns: ['docs/'] })
    expect(await w.until(() => w.heldCount() === 2)).toBe(true)
    // a writes in src/ after both snapshots, then finishes first
    w.git.status.push({ code: '??', path: 'src/x.ts', hash: 'h1' })
    w.releaseOne()
    expect(await w.until(() => w.submitted.length === 1)).toBe(true)
    w.releaseHeld()
    expect(await w.until(() => w.submitted.length === 2)).toBe(true)
    const b = w.submitted.find(s => s.startsWith('[relay] b'))!
    expect(b).not.toContain('wrote outside owns')
    expect(b).toContain('changed src/x.ts, probably by a')
  })
})

describe('review 2, finding 11: a session stays in its folder', () => {
  test('switching to worktree isolation starts a fresh session', async ($: any, on: any) => {
    const w = fakeWorld(on)
    if (!(await w.start($))) return
    await w.send($, { role: 'r', task: 'one' })
    expect(await w.until(() => w.submitted.length === 1)).toBe(true)
    const r = await w.send($, { role: 'r', task: 'two', isolation: 'worktree' })
    expect(String(r.result)).toContain('isolation changed from shared to worktree')
    expect(await w.until(() => w.submitted.length === 2)).toBe(true)
    expect(w.spawns[1]!.argv).toContain('--session-id')
    expect(w.spawns[1]!.argv).not.toContain('--resume')
  })

  test('a stored session from the project folder is not resumed in a worktree', async ($: any, on: any) => {
    const w = fakeWorld(on, { store: { 'roles:/w': { r: { name: 'r', runs: 1, isBusy: false, sessionId: 'c-old', isolation: 'worktree' } } } })
    if (!(await w.start($))) return
    await w.send($, { role: 'r', task: 'two' })
    expect(await w.until(() => w.submitted.length === 1)).toBe(true)
    expect(w.spawns[0]!.argv).not.toContain('--resume')
    expect(w.submitted[0]).toContain('The working folder changed')
  })
})

describe('review 2, finding 12: a backend error after the packet is no success', () => {
  for (const [backend, scenario] of [['codex', 'done-then-error'], ['opencode', 'done-then-error'], ['codex', 'answer-exit1'], ['opencode', 'answer-exit1']] as const) {
    test(`${backend} ${scenario}: partial, and the error is named`, { options: { defaultBackend: backend } }, async ($: any, on: any) => {
      const w = fakeWorld(on)
      w.play(scenario)
      if (!(await w.start($))) return
      await w.send($, { role: 'r', task: 't', ...(backend === 'opencode' ? { model: 'ollama/m' } : {}) })
      expect(await w.until(() => w.submitted.length === 1)).toBe(true)
      expect(w.submitted[0]).toContain('Status: partial')
      expect(w.submitted[0]).toContain(`${backend} reported an error after the answer`)
    })
  }
})

describe('review 2, finding 13: a project inside a repository', () => {
  test('paths are taken relative to the project, hashed from the repository top', async ($: any, on: any) => {
    const w = fakeWorld(on)
    w.git.toplevel = '/repo'
    w.git.prefix = 'packages/app/'
    w.git.status.push(
      { code: ' M', path: 'packages/app/src/a.ts', hash: 'h1' },
      { code: ' M', path: 'packages/app/docs/b.md', hash: 'h1' },
      { code: ' M', path: 'other/c.md', hash: 'h1' },
    )
    if (!(await w.start($))) return
    w.during(() => {
      for (const s of w.git.status) s.hash = 'h2'
    })
    await w.send($, { role: 'a', task: 't', owns: ['src/'] })
    expect(await w.until(() => w.submitted.length === 1)).toBe(true)
    expect(w.submitted[0]).toContain('wrote outside owns: docs/b.md (modified)')
    expect(w.submitted[0]).toContain('wrote outside owns: ../../other/c.md (modified)')
    expect(w.submitted[0]).not.toContain('outside owns: src/a.ts')
    expect(w.submitted[0]).not.toContain('write check incomplete')
    expect(w.runs.filter(r => r.argv[1] === 'hash-object').every(r => r.cwd === '/repo')).toBe(true)
  })
})

describe('review 2, finding 14: a skipped write check is said', () => {
  test('without git: once per session, in the packet and in worker_status', async ($: any, on: any) => {
    const w = fakeWorld(on, { isGit: false })
    if (!(await w.start($))) return
    await w.send($, { role: 'a', task: 'one' })
    expect(await w.until(() => w.submitted.length === 1)).toBe(true)
    await w.send($, { role: 'a', task: 'two' })
    expect(await w.until(() => w.submitted.length === 2)).toBe(true)
    expect(w.submitted[0]).toContain('write check skipped: the project is no git repository')
    expect(w.submitted[1]).not.toContain('write check skipped')
    expect(w.submitted[0]).toContain('Status: done')
    expect(await w.status($)).toContain('write check skipped')
  })

  test('when git itself fails, the check is incomplete, every time', async ($: any, on: any) => {
    const w = fakeWorld(on)
    w.git.isBroken = true
    if (!(await w.start($))) return
    await w.send($, { role: 'a', task: 't' })
    expect(await w.until(() => w.submitted.length === 1)).toBe(true)
    expect(w.submitted[0]).toContain('⚠ write check incomplete')
    expect(w.submitted[0]).toContain('dubious ownership')
  })
})

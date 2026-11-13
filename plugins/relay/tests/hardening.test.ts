// Regression tests for the review of relay 0.4.0 (contract 0001, Nachtrag 1):
// each describe names the finding it guards.
import { describe, expect, test } from 'claude-code/testing'
import { EMPTY_TREE, SECRETS, fakeWorld } from './fakes.ts'

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

describe('finding 1 and 2: no credential in argv or in any output', () => {
  for (const backend of ['claude', 'codex', 'opencode'] as const) {
    test(`${backend}: argv, live.log, run files, packets, toasts and status stay clean`, { options: { defaultBackend: backend } }, async ($: any, on: any) => {
      const w = fakeWorld(on)
      if (!(await w.start($))) return
      const model = backend === 'opencode' ? { model: 'ollama/m' } : {}
      w.play('leak', 'leak-error')
      await w.send($, { role: 'r', task: `Deploy with token=${SECRETS.token}`, ...model })
      expect(await w.until(() => w.submitted.length === 1)).toBe(true)
      await w.send($, { role: 'r', task: 'again' })
      expect(await w.until(() => w.submitted.length === 2)).toBe(true)
      const status = await w.status($)
      // queue.json holds a waiting task as it was sent: relay needs it to run it.
      const stored = [...w.files].filter(([p]) => !/queue\.json(\.bak)?$/.test(p))
      const channels: [string, string][] = [
        ...w.spawns.map((s, i) => [`argv ${i}`, s.argv.join(' ')] as [string, string]),
        ...w.submitted.map((s, i) => [`packet ${i}`, s] as [string, string]),
        ...w.toasts.map((s, i) => [`toast ${i}`, s] as [string, string]),
        ['worker_status', status],
        ...stored,
      ]
      for (const [where, text] of channels) {
        for (const secret of Object.values(SECRETS)) expect(`${where}: ${text.includes(secret) ? secret : 'clean'}`).toBe(`${where}: clean`)
      }
      expect(w.submitted.join('\n')).toContain('[redacted]')
      expect(w.files.get('.relay/runs/r/001.full.md')).toContain('token=[redacted]')
    })
  }
})

describe('finding 3: one dispatch at a time', () => {
  test('two workers finishing together start a queued job once', { options: { maxParallel: 2 } }, async ($: any, on: any) => {
    const w = fakeWorld(on)
    w.play('held', 'held')
    if (!(await w.start($))) return
    await w.send($, { role: 'a', task: 'A' })
    await w.send($, { role: 'b', task: 'B' })
    const r = await w.send($, { role: 'c', task: 'C' })
    expect(String(r.result)).toContain('task queued')
    expect(await w.until(() => w.heldCount() === 2)).toBe(true)
    w.releaseHeld()
    expect(await w.until(() => w.submitted.length >= 3)).toBe(true)
    await w.until(() => false, 30)
    expect(w.spawns.filter(s => s.input === 'C')).toHaveLength(1)
    expect(w.submitted).toHaveLength(3)
  })
})

describe('finding 4: queue writes in order', () => {
  test('a slow write never lands over a newer one', async ($: any, on: any) => {
    const w = fakeWorld(on)
    w.always('held')
    if (!(await w.start($))) return
    let n = 0
    w.io.writeDelay = p => (p === '.relay/queue.json' && n++ === 0 ? 500 : 0)
    const p1 = w.send($, { role: 'a', task: 'A' })
    const p2 = w.send($, { role: 'b', task: 'B' })
    await w.clock.advance(600)
    await p1
    await p2
    expect(await w.until(() => w.heldCount() === 2)).toBe(true)
    // Once a job has left the file it never comes back; running never turns queued.
    const seen = new Map<string, string>()
    const gone = new Set<string>()
    for (const text of w.landed) {
      const jobs = (JSON.parse(text) as { jobs: { id: string; state: string }[] }).jobs
      const ids = new Set(jobs.map(j => j.id))
      for (const id of seen.keys()) if (!ids.has(id)) gone.add(id)
      for (const j of jobs) {
        expect(gone.has(j.id)).toBe(false)
        if (seen.get(j.id) === 'running') expect(j.state).toBe('running')
        seen.set(j.id, j.state)
      }
    }
    expect(w.queueFile().jobs.map(j => `${j.role}:${j.state}`).sort()).toEqual(['a:running', 'b:running'])
    w.releaseHeld()
    expect(await w.until(() => w.submitted.length === 2)).toBe(true)
  })
})

describe('finding 5: one owner per queue', () => {
  test('two sessions claiming together: the one whose claim stands works it, the other only reads', async ($: any, on: any) => {
    const w = fakeWorld(on)
    await w.boot($)
    if (!w.isRelayLoaded()) return
    await w.clock.settle()
    expect(w.queueFile().owner?.session).toBe('s1')
    // The other session's claim lands while this one waits to read its own back.
    w.files.set('.relay/queue.json', JSON.stringify({ version: 1, owner: { session: 'other', heartbeatAt: T0, token: 'tok-other' }, jobs: [] }))
    await w.clock.advance(2_000)
    const r = await w.send($, { role: 'a', task: 't' })
    expect(String(r.result)).toContain('worked by another Claude Code session')
    expect(w.spawns).toHaveLength(0)
    expect(w.queueFile().owner?.token).toBe('tok-other')
    expect(await w.status($)).toContain('claimed this project')
  })

  test('a heartbeat never overwrites a newer claim; this session steps down', async ($: any, on: any) => {
    const w = fakeWorld(on)
    if (!(await w.start($))) return
    expect(w.queueFile().owner?.session).toBe('s1')
    w.files.set('.relay/queue.json', JSON.stringify({ version: 1, owner: { session: 'other', heartbeatAt: new Date(50_000).toISOString(), token: 'tok-other' }, jobs: [] }))
    await w.clock.advance(60_000)
    expect(w.queueFile().owner?.token).toBe('tok-other')
    const r = await w.send($, { role: 'a', task: 't' })
    expect(String(r.result)).toContain('worked by another Claude Code session')
    expect(w.spawns).toHaveLength(0)
    expect(await w.status($)).toContain('took over')
  })
})

describe('finding 6: a queue that cannot be persisted', () => {
  test('a send that cannot be written is refused and nothing starts', async ($: any, on: any) => {
    const w = fakeWorld(on)
    if (!(await w.start($))) return
    w.io.failWrite = p => p === '.relay/queue.json'
    const r = await w.send($, { role: 'a', task: 't' })
    expect(String(r.result)).toContain('task not accepted')
    expect(String(r.result)).toContain('ENOSPC')
    expect(w.spawns).toHaveLength(0)
    expect(await w.status($)).toContain('queued 0')
  })

  test('a dispatch that cannot be written leaves the job queued and unstarted', async ($: any, on: any) => {
    const w = fakeWorld(on)
    if (!(await w.start($))) return
    let writes = 0
    w.io.failWrite = p => p === '.relay/queue.json' && ++writes > 1
    const r = await w.send($, { role: 'a', task: 't' })
    expect(String(r.result)).toContain('task queued')
    expect(String(r.result)).toContain('could not be started yet')
    expect(w.spawns).toHaveLength(0)
    expect(w.queueFile().jobs.map(j => j.state)).toEqual(['queued'])
  })

  test('a queue file that cannot be read is not taken for an empty one', async ($: any, on: any) => {
    const queue = { version: 1, jobs: [job('j_1', 'a', 'queued')] }
    const w = fakeWorld(on, { files: { '.relay/queue.json': JSON.stringify(queue) }, store: { 'roles:/w': { a: { name: 'a', runs: 0, isBusy: false } } } })
    w.io.failRead = p => p === '.relay/queue.json'
    if (!(await w.start($))) return
    const r = await w.send($, { role: 'b', task: 't' })
    expect(String(r.result)).toContain('could not be read')
    expect(w.spawns).toHaveLength(0)
    expect(JSON.parse(w.files.get('.relay/queue.json')!).jobs[0].task).toBe('task of a')
  })
})

describe('finding 7: requested isolation or no run', () => {
  test('worktree isolation without git fails the job before it starts', async ($: any, on: any) => {
    const w = fakeWorld(on, { isGit: false })
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't', isolation: 'worktree' })
    expect(await w.until(() => w.submitted.length === 1)).toBe(true)
    expect(w.spawns).toHaveLength(0)
    expect(w.submitted[0]).toContain('Status: failed')
    expect(w.submitted[0]).toContain('Worker was not started')
    expect(w.submitted[0]).toContain('needs a git repository')
  })

  test('a worktree git cannot create fails the job before it starts', async ($: any, on: any) => {
    const w = fakeWorld(on)
    w.git.worktreeAddError = "fatal: 'relay/coder' is already checked out at '/elsewhere'"
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't', isolation: 'worktree' })
    expect(await w.until(() => w.submitted.length === 1)).toBe(true)
    expect(w.spawns).toHaveLength(0)
    expect(w.submitted[0]).toContain('already checked out')
    // the next task, once git can, runs normally
    w.git.worktreeAddError = ''
    await w.send($, { role: 'coder', task: 'again' })
    expect(await w.until(() => w.submitted.length === 2)).toBe(true)
    expect(w.spawns[0]!.cwd).toBe('/w/.relay/worktrees/coder')
  })
})

describe('finding 8: a worktree must be the role\'s own', () => {
  test('a worktree folder that is a link is not used', async ($: any, on: any) => {
    const w = fakeWorld(on)
    w.files.set('.relay/worktrees/coder/.git', 'gitdir: x')
    w.links.set('.relay/worktrees/coder', '/other/checkout')
    w.git.worktrees.set('/other/checkout', 'refs/heads/relay/coder')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't', isolation: 'worktree' })
    expect(await w.until(() => w.submitted.length === 1)).toBe(true)
    expect(w.spawns).toHaveLength(0)
    expect(w.submitted[0]).toContain('resolves to /other/checkout, outside the project')
  })

  test('a folder that is no registered worktree, or on another branch, is not used', async ($: any, on: any) => {
    const w = fakeWorld(on)
    w.files.set('.relay/worktrees/coder/.git', 'gitdir: x')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't', isolation: 'worktree' })
    expect(await w.until(() => w.submitted.length === 1)).toBe(true)
    expect(w.submitted[0]).toContain('not a registered worktree')
    w.git.worktrees.set('/w/.relay/worktrees/coder', 'refs/heads/main')
    await w.send($, { role: 'coder', task: 't' })
    expect(await w.until(() => w.submitted.length === 2)).toBe(true)
    expect(w.submitted[1]).toContain('is on main, not on relay/coder')
    expect(w.spawns).toHaveLength(0)
  })

  test('a relay folder that resolves outside the project is not used for worktrees', async ($: any, on: any) => {
    const w = fakeWorld(on)
    if (!(await w.start($))) return
    w.links.set('.relay', '/elsewhere/.relay')
    await w.send($, { role: 'coder', task: 't', isolation: 'worktree' })
    expect(await w.until(() => w.submitted.length === 1)).toBe(true)
    expect(w.spawns).toHaveLength(0)
    expect(w.submitted[0]).toContain('outside the project')
  })

  test('a relayDir outside the project is replaced by .relay', { options: { relayDir: '../elsewhere' } }, async ($: any, on: any) => {
    const w = fakeWorld(on)
    if (!(await w.start($))) return
    await w.send($, { role: 'a', task: 't' })
    expect(await w.until(() => w.submitted.length === 1)).toBe(true)
    expect(w.files.has('.relay/runs/a/001.full.md')).toBe(true)
    expect([...w.files.keys()].some(k => k.includes('elsewhere'))).toBe(false)
    expect(await w.status($)).toContain('relayDir "../elsewhere" lies outside the project')
  })
})

describe('finding 9: renames', () => {
  test('a staged rename out of an unowned folder is a deletion there', async ($: any, on: any) => {
    const w = fakeWorld(on)
    if (!(await w.start($))) return
    w.during(() => w.git.status.push({ code: 'R ', path: 'src/protected.md', orig: 'docs/protected.md', hash: 'h5' }))
    await w.send($, { role: 'a', task: 't', owns: ['src/'] })
    expect(await w.until(() => w.submitted.length === 1)).toBe(true)
    expect(w.submitted[0]).toContain('wrote outside owns: docs/protected.md (deleted)')
    expect(w.submitted[0]).toContain('Status: partial')
  })

  test('a committed rename too', async ($: any, on: any) => {
    const w = fakeWorld(on)
    if (!(await w.start($))) return
    w.during(() => {
      w.git.head = 'bbb'
      w.git.committed.push({ status: 'R100', from: 'docs/protected.md', path: 'src/protected.md' })
    })
    await w.send($, { role: 'a', task: 't', owns: ['src/'] })
    expect(await w.until(() => w.submitted.length === 1)).toBe(true)
    expect(w.submitted[0]).toContain('wrote outside owns: docs/protected.md (deleted)')
  })
})

describe('finding 10: hashing', () => {
  test('a submodule git cannot hash does not hide the changes after it', async ($: any, on: any) => {
    const w = fakeWorld(on)
    w.git.status.push({ code: ' M', path: 'a-sub', hash: '' }, { code: ' M', path: 'docs/z.md', hash: 'h1' })
    w.git.unhashable.add('a-sub')
    if (!(await w.start($))) return
    w.during(() => {
      w.git.status.find(s => s.path === 'docs/z.md')!.hash = 'h2'
    })
    await w.send($, { role: 'a', task: 't', owns: ['src/'] })
    expect(await w.until(() => w.submitted.length === 1)).toBe(true)
    expect(w.submitted[0]).toContain('wrote outside owns: docs/z.md (modified)')
    expect(w.submitted[0]).toContain('⚠ write check incomplete')
    expect(w.submitted[0]).toContain('write check incomplete: a-sub')
  })

  test('a file name with a line break is hashed on its own', async ($: any, on: any) => {
    const w = fakeWorld(on)
    w.git.status.push({ code: ' M', path: 'docs/a\nb.md', hash: 'h1' })
    if (!(await w.start($))) return
    w.during(() => {
      w.git.status[0]!.hash = 'h2'
    })
    await w.send($, { role: 'a', task: 't', owns: ['src/'] })
    expect(await w.until(() => w.submitted.length === 1)).toBe(true)
    expect(w.submitted[0]).toContain('wrote outside owns: docs/a\nb.md (modified)')
    expect(w.runs.some(r => r.argv.join(' ') === 'git hash-object -- docs/a\nb.md')).toBe(true)
  })
})

describe('finding 11: unborn HEAD', () => {
  test('the first commit in an empty repository is checked against the empty tree', async ($: any, on: any) => {
    const w = fakeWorld(on)
    w.git.head = ''
    if (!(await w.start($))) return
    w.during(() => {
      w.git.head = 'c1'
      w.git.committed.push({ status: 'A', path: 'docs/new.md' })
    })
    await w.send($, { role: 'a', task: 't', owns: ['src/'] })
    expect(await w.until(() => w.submitted.length === 1)).toBe(true)
    expect(w.submitted[0]).toContain('wrote outside owns: docs/new.md (created)')
    expect(w.runs.some(r => r.argv.join(' ') === `git diff --name-status -z ${EMPTY_TREE} c1`)).toBe(true)
  })
})

describe('finding 12: case in owns', () => {
  test('SRC/ is not src/ on a case-sensitive filesystem', async ($: any, on: any) => {
    const w = fakeWorld(on)
    if (!(await w.start($))) return
    w.during(() => w.git.status.push({ code: '??', path: 'SRC/protected.ts', hash: 'h1' }))
    await w.send($, { role: 'a', task: 't', owns: ['src/'] })
    expect(await w.until(() => w.submitted.length === 1)).toBe(true)
    expect(w.submitted[0]).toContain('wrote outside owns: SRC/protected.ts (created)')
    expect(w.spawns[0]!.env.RELAY_OWNS_CASE).toBe('sensitive')
  })

  test('on a case-insensitive filesystem it is the same folder', async ($: any, on: any) => {
    const w = fakeWorld(on, { caseInsensitive: true })
    if (!(await w.start($))) return
    w.during(() => w.git.status.push({ code: '??', path: 'SRC/protected.ts', hash: 'h1' }))
    await w.send($, { role: 'a', task: 't', owns: ['src/'] })
    expect(await w.until(() => w.submitted.length === 1)).toBe(true)
    expect(w.submitted[0]).not.toContain('wrote outside owns')
    expect(w.spawns[0]!.env.RELAY_OWNS_CASE).toBe('insensitive')
  })

  for (const [mode, isDenied] of [['sensitive', true], ['insensitive', false]] as const) {
    test(`a worker's guard on a ${mode} filesystem ${isDenied ? 'refuses' : 'allows'} SRC/ for owns src/`, async ($: any, on: any) => {
      const w = fakeWorld(on, { env: { RELAY_WORKER: '1', RELAY_CWD: '/w', RELAY_OWNS: '["src/"]', RELAY_OWNS_CASE: mode } })
      on('tool.call', { tool: 'Write' }, () => ({ result: 'written' }))
      await w.boot($)
      if (!w.isRelay()) return
      const r = await $.tool.call({ tool: 'Write', file_path: '/w/SRC/x.ts', content: 'x' })
      expect(JSON.stringify(r).includes('not owned')).toBe(isDenied)
    })
  }
})

describe('finding 13: interrupted jobs that cannot be reported', () => {
  test('stay in the queue and are shown, the reported one leaves', async ($: any, on: any) => {
    const queue = {
      version: 1,
      owner: { session: 'old', heartbeatAt: T0 },
      jobs: [job('j_a', 'a', 'running'), job('j_ghost', 'ghost', 'running'), job('j_b', 'b', 'running')],
    }
    const w = fakeWorld(on, {
      files: { '.relay/queue.json': JSON.stringify(queue) },
      store: { 'roles:/w': { a: { name: 'a', runs: 1, isBusy: true }, b: { name: 'b', runs: 1, isBusy: true } } },
    })
    w.io.failWrite = p => p.startsWith('.relay/runs/b/')
    await w.clock.set(10 * 60_000)
    if (!(await w.start($))) return
    expect(await w.until(() => w.submitted.length === 1)).toBe(true)
    await w.until(() => false, 20)
    expect(w.submitted[0]).toContain('[relay] a · run 1 interrupted')
    expect(w.queueFile().jobs.map(j => `${j.id}:${j.state}`)).toEqual(['j_ghost:running', 'j_b:running'])
    const status = await w.status($)
    expect(status).toContain('interrupted ghost run 1 (claude), not reported yet · orphaned')
    expect(status).toContain('interrupted b run 1 (claude), not reported yet · reporting failed')
  })
})

describe('finding 14: a job runs on the backend it was queued for', () => {
  test('a queued claude job stays claude when the role moves to codex', { options: { maxParallel: 1 } }, async ($: any, on: any) => {
    const w = fakeWorld(on)
    w.play('held')
    if (!(await w.start($))) return
    await w.send($, { role: 'x', task: 'block' })
    await w.send($, { role: 'r', task: 'one', model: 'claude-opus-5-5' })
    await w.send($, { role: 'r', task: 'two', backend: 'codex', model: 'gpt-5.5-codex' })
    const q = w.queueFile().jobs.filter(j => j.role === 'r')
    expect(q.map(j => `${j.backend}:${j.model}`)).toEqual(['claude:claude-opus-5-5', 'codex:gpt-5.5-codex'])
    expect(await w.until(() => w.heldCount() === 1)).toBe(true)
    w.releaseHeld()
    expect(await w.until(() => w.submitted.length === 3)).toBe(true)
    const one = w.spawns.find(s => s.input === 'one')!
    const two = w.spawns.find(s => s.input === 'two')!
    expect(one.argv[0]).toBe('claude')
    expect(one.argv[one.argv.indexOf('--model') + 1]).toBe('claude-opus-5-5')
    expect(two.argv[0]).toBe('codex')
    expect(two.argv[two.argv.indexOf('-m') + 1]).toBe('gpt-5.5-codex')
  })
})

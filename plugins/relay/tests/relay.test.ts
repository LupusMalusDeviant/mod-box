import { describe, expect, test } from 'claude-code/testing'
import { protocolPrompt } from '../hooks/protocol.ts'
import { fakeWorld } from './fakes.ts'

const BASE = { maxBudgetUsd: 2, workerModel: 'claude-sonnet-5-5', workerEffort: 'medium' }

describe('claude backend', () => {
  test('argv is the one 0.3.0 built; the next task resumes the session', { options: BASE }, async ($: any, on: any) => {
    const w = fakeWorld(on)
    if (!(await w.start($))) return
    const r = await w.send($, { role: 'ingester', task: 'Ingest 3 links', owns: ['wiki/sources/'] })
    expect(String(r.result)).toContain('ingester run 1 started on claude')
    expect(await w.until(() => w.submitted.length === 1)).toBe(true)
    const first = w.spawns[0]!
    const sid = first.argv[first.argv.indexOf('--session-id') + 1]!
    expect(first.argv).toEqual([
      'claude', '-p', '--output-format', 'json', '--permission-mode', 'acceptEdits',
      '--append-system-prompt', protocolPrompt('ingester', '', ['wiki/sources/']),
      '--session-id', sid, '--model', 'claude-sonnet-5-5', '--effort', 'medium', '--max-budget-usd', '2',
      '--disallowedTools', 'Bash(git push:*)',
    ])
    expect(first.input).toBe('Ingest 3 links')
    expect(first.env).toMatchObject({ RELAY_WORKER: '1', RELAY_CWD: '/w', RELAY_OWNS: '["wiki/sources/"]' })
    expect(w.submitted[0]).toContain('[relay] ingester · run 1 finished (claude · 3 turns, $0.10)')
    expect(w.submitted[0]).toContain('Status: done')

    await w.send($, { role: 'ingester', task: 'More' })
    await w.until(() => w.submitted.length === 2)
    const second = w.spawns[1]!.argv
    expect(second[second.indexOf('--resume') + 1]).toBe(sid)
    const packet = JSON.parse(w.files.get('.relay/runs/ingester/002.packet.json')!)
    expect(packet.backend).toBe('claude')
    expect(packet.usage).toEqual({ costUsd: 0.1, turns: 3 })
    expect(await w.status($)).toContain('total $0.20')
  })

  test('a role stored by 0.3.0 resumes its claude session', async ($: any, on: any) => {
    const w = fakeWorld(on, { store: { 'roles:/w': { old: { name: 'old', runs: 4, isBusy: false, sessionId: 'c-old' } } } })
    if (!(await w.start($))) return
    await w.send($, { role: 'old', task: 't' })
    await w.until(() => w.submitted.length === 1)
    const argv = w.spawns[0]!.argv
    expect(argv[argv.indexOf('--resume') + 1]).toBe('c-old')
    expect(w.submitted[0]).toContain('old · run 5 finished')
  })

  test('a run stopped by the budget is partial', async ($: any, on: any) => {
    const w = fakeWorld(on)
    w.play('error')
    if (!(await w.start($))) return
    await w.send($, { role: 'a', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).toContain('worker error (error_max_budget_usd)')
    expect(w.submitted[0]).toContain('Status: partial')
  })

  test('a missing program points at the bin option', async ($: any, on: any) => {
    const w = fakeWorld(on)
    w.play('crash')
    if (!(await w.start($))) return
    await w.send($, { role: 'a', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).toContain('Status: failed')
  })
})

describe('codex backend', () => {
  test('starts in the sandbox, resumes the thread with the sandbox set, counts tokens', { options: { defaultBackend: 'codex' } }, async ($: any, on: any) => {
    const w = fakeWorld(on)
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 'Fix it', model: 'gpt-5.5-codex', effort: 'xhigh', owns: ['src/'] })
    await w.until(() => w.submitted.length === 1)
    const a = w.spawns[0]!
    expect(a.argv.slice(0, 7)).toEqual(['codex', 'exec', '--json', '--sandbox', 'workspace-write', '--cd', '/w'])
    expect(a.argv).toContain('approval_policy="never"')
    expect(a.argv).toContain('model_reasoning_effort="high"')
    expect(a.argv.at(-1)).toBe('-')
    expect(a.argv.join(' ')).not.toContain('danger')
    expect(a.input).toBe('Fix it')
    expect(w.submitted[0]).toContain('(codex · gpt-5.5-codex · 48.2k in (31.0k cached) / 3.1k out tokens)')

    await w.send($, { role: 'coder', task: 'Again' })
    await w.until(() => w.submitted.length === 2)
    const b = w.spawns[1]!.argv
    expect(b.slice(0, 5)).toEqual(['codex', 'exec', 'resume', '--json', 't-1'])
    expect(b).toContain('sandbox_mode="workspace-write"')
    expect(b).not.toContain('--sandbox')
    expect(b).not.toContain('--cd')
    expect(w.files.get('.relay/runs/coder/live.log')).toContain('agent_message')
  })

  test('a lost thread is forgotten and the next task starts fresh', { options: { defaultBackend: 'codex' } }, async ($: any, on: any) => {
    const w = fakeWorld(on)
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 'one' })
    await w.until(() => w.submitted.length === 1)
    w.play('session-not-found')
    await w.send($, { role: 'coder', task: 'two' })
    await w.until(() => w.submitted.length === 2)
    expect(w.submitted[1]).toContain('session is gone')
    await w.send($, { role: 'coder', task: 'three' })
    await w.until(() => w.submitted.length === 3)
    expect(w.spawns[2]!.argv[2]).toBe('--json')
  })

  test('the token limit stops a run', { options: { defaultBackend: 'codex', maxTokensPerRun: 25000 } }, async ($: any, on: any) => {
    const w = fakeWorld(on)
    w.play('slow-tokens')
    if (!(await w.start($))) return
    await w.send($, { role: 'coder', task: 't' })
    for (let i = 0; i < 5 && !w.submitted.length; i++) await w.clock.advance(1000)
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).toContain('stopped at 30.0k tokens')
  })
})

describe('opencode backend', () => {
  test('needs provider/model; passes the agent config; resumes the session', { options: { defaultBackend: 'opencode' } }, async ($: any, on: any) => {
    const w = fakeWorld(on)
    if (!(await w.start($))) return
    await w.send($, { role: 'scout', task: 'Look' })
    await w.until(() => w.submitted.length === 1)
    expect(w.spawns).toHaveLength(0)
    expect(w.submitted[0]).toContain('provider/model')

    await w.send($, { role: 'scout', task: 'Look', model: 'ollama/kimi-k3:cloud', disallowedTools: ['Bash(rm:*)'], owns: ['notes/'] })
    await w.until(() => w.submitted.length === 2)
    const a = w.spawns[0]!
    expect(a.argv).toEqual([
      'opencode', 'run', '--format', 'json', '--standalone', '--auto', '-m', 'ollama/kimi-k3:cloud', '--agent', 'relay-scout', '--title', 'relay scout',
      'The task is in the attached file.', '--file', '/w/.relay/tmp/scout-2.md',
    ])
    expect(a.attachment).toBe('Look')
    const cfg = JSON.parse(a.env.OPENCODE_CONFIG_CONTENT!)
    expect(cfg.permission.bash).toEqual({ 'git push*': 'deny', 'rm*': 'deny' })
    expect(cfg.permission.edit).toEqual({ 'notes/**': 'allow', '*': 'deny' })
    expect(cfg.agent['relay-scout'].prompt).toContain('"scout" worker')
    expect(w.submitted[1]).toContain('(opencode · ollama/kimi-k3:cloud · 12.4k in / 1.8k out tokens, $0.00)')

    await w.send($, { role: 'scout', task: 'More' })
    await w.until(() => w.submitted.length === 3)
    const b = w.spawns[1]!.argv
    expect(b[b.indexOf('--session') + 1]).toBe('ses_abc')
  })

  test('every task goes into a file, cleared after the run', { options: { defaultBackend: 'opencode' } }, async ($: any, on: any) => {
    const w = fakeWorld(on)
    if (!(await w.start($))) return
    await w.send($, { role: 'scout', task: 'x'.repeat(30_000), model: 'ollama/m' })
    await w.until(() => w.submitted.length === 1)
    const argv = w.spawns[0]!.argv
    expect(argv[argv.indexOf('--file') + 1]).toBe('/w/.relay/tmp/scout-1.md')
    expect(w.spawns[0]!.attachment).toBe('x'.repeat(30_000))
    expect(w.files.get('.relay/tmp/scout-1.md')).toBe('')
  })

  // Finding 1: a task that looks like an option never reaches argv.
  test('a task that looks like an option is not one', { options: { defaultBackend: 'opencode' } }, async ($: any, on: any) => {
    const w = fakeWorld(on)
    if (!(await w.start($))) return
    await w.send($, { role: 'scout', task: '--session=ses_other', model: 'ollama/m' })
    await w.until(() => w.submitted.length === 1)
    expect(w.spawns[0]!.argv.some(a => a.includes('ses_other'))).toBe(false)
    expect(w.spawns[0]!.attachment).toBe('--session=ses_other')
  })

  // Finding 15: in a worktree the worker reads the same file relay wrote.
  test('a worktree role gets an absolute task file it can read', { options: { defaultBackend: 'opencode' } }, async ($: any, on: any) => {
    const w = fakeWorld(on)
    if (!(await w.start($))) return
    await w.send($, { role: 'scout', task: 'Look in the worktree', model: 'ollama/m', isolation: 'worktree' })
    await w.until(() => w.submitted.length === 1)
    expect(w.spawns[0]!.cwd).toBe('/w/.relay/worktrees/scout')
    expect(w.spawns[0]!.attachment).toBe('Look in the worktree')
  })

  test('changing the backend drops the session', async ($: any, on: any) => {
    const w = fakeWorld(on)
    if (!(await w.start($))) return
    await w.send($, { role: 'r', task: 'one' })
    await w.until(() => w.submitted.length === 1)
    const r = await w.send($, { role: 'r', task: 'two', backend: 'opencode', model: 'ollama/m', allowedTools: ['Read'] })
    expect(String(r.result)).toContain('backend changed from claude to opencode')
    expect(String(r.result)).toContain('ignores: allowedTools')
    await w.until(() => w.submitted.length === 2)
    expect(w.spawns[1]!.argv).not.toContain('--session')
  })
})

describe('queue on disk', () => {
  test('waits for a slot and keeps queue.json current', { options: { maxParallel: 1 } }, async ($: any, on: any) => {
    const w = fakeWorld(on)
    w.play('hang')
    if (!(await w.start($))) return
    await w.send($, { role: 'a', task: 'first' })
    const r = await w.send($, { role: 'b', task: 'second' })
    expect(String(r.result)).toContain('task queued (position 1 of 1')
    const q = w.queueFile()
    expect(q.owner?.session).toBe('s1')
    expect(q.jobs.map(j => `${j.role}:${j.state}`)).toEqual(['a:running', 'b:queued'])
    expect(w.files.get('.gitignore') ?? '').toContain('.relay/queue.json')
  })

  test('after a restart: queued jobs run, running ones are reported interrupted', async ($: any, on: any) => {
    const queue = {
      version: 1,
      owner: { session: 'old', heartbeatAt: '1970-01-01T00:00:00.000Z' },
      jobs: [
        { id: 'j_1', role: 'a', task: 'was running', enqueuedAt: '1970-01-01T00:00:00.000Z', state: 'running', run: 1, backend: 'claude' },
        { id: 'j_2', role: 'b', task: 'was waiting', enqueuedAt: '1970-01-01T00:00:00.000Z', state: 'queued', backend: 'claude' },
      ],
    }
    const w = fakeWorld(on, {
      files: { '.relay/queue.json': JSON.stringify(queue) },
      store: { 'roles:/w': { a: { name: 'a', runs: 1, isBusy: true }, b: { name: 'b', runs: 0, isBusy: false } } },
    })
    await w.clock.set(10 * 60_000)
    if (!(await w.start($))) return
    await w.until(() => w.submitted.length === 2)
    expect(w.submitted[0]).toContain('[relay] a · run 1 interrupted')
    expect(w.submitted[0]).toContain('It was not restarted')
    expect(w.spawns.map(s => s.input)).toEqual(['was waiting'])
    expect(w.queueFile().jobs).toEqual([])
  })

  test('a broken queue.json falls back to the backup', async ($: any, on: any) => {
    const bak = { version: 1, jobs: [{ id: 'j_9', role: 'a', task: 'from backup', enqueuedAt: '1970-01-01T00:00:00.000Z', state: 'queued', backend: 'claude' }] }
    const w = fakeWorld(on, {
      files: { '.relay/queue.json': '{ broken', '.relay/queue.json.bak': JSON.stringify(bak) },
      store: { 'roles:/w': { a: { name: 'a', runs: 0, isBusy: false } } },
    })
    if (!(await w.start($))) return
    await w.until(() => w.submitted.length === 1)
    expect(w.spawns[0]!.input).toBe('from backup')
    expect(await w.status($)).toContain('read queue.json.bak')
  })

  test('a second session only reads', async ($: any, on: any) => {
    const queue = { version: 1, owner: { session: 'other', heartbeatAt: '1970-01-01T00:00:30.000Z' }, jobs: [] }
    const w = fakeWorld(on, { files: { '.relay/queue.json': JSON.stringify(queue) } })
    await w.clock.set(60_000)
    if (!(await w.start($))) return
    const r = await w.send($, { role: 'a', task: 't' })
    expect(String(r.result)).toContain('worked by another Claude Code session')
    expect(await w.status($)).toContain('only reads it')
    expect(w.spawns).toHaveLength(0)
  })

  test('a timeout stops the run and frees the slot', { options: { runTimeoutMin: 1, maxParallel: 1 } }, async ($: any, on: any) => {
    const w = fakeWorld(on)
    w.play('hang')
    if (!(await w.start($))) return
    await w.send($, { role: 'a', task: 'slow' })
    await w.send($, { role: 'b', task: 'next' })
    await w.clock.advance(61_000)
    await w.until(() => w.submitted.length === 2)
    expect(w.submitted[0]).toContain('stopped after 1 min')
    expect(w.submitted[0]).toContain('Status: failed')
    expect(w.spawns[1]!.input).toBe('next')
  })
})

describe('write check', () => {
  test('a write outside owns makes the run partial and is named', async ($: any, on: any) => {
    const w = fakeWorld(on)
    w.play('write-outside')
    if (!(await w.start($))) return
    await w.send($, { role: 'a', task: 't', owns: ['src/'] })
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).toContain('⚠ wrote outside owns (1)')
    expect(w.submitted[0]).toContain('wrote outside owns: other/x.md (created)')
    expect(w.submitted[0]).toContain('Status: partial')
    const packet = JSON.parse(w.files.get('.relay/runs/a/001.packet.json')!)
    expect(packet.write_check.outside).toEqual(['other/x.md'])
  })

  test('a commit during the run is seen', async ($: any, on: any) => {
    const w = fakeWorld(on)
    w.play('commit')
    if (!(await w.start($))) return
    await w.send($, { role: 'a', task: 't', owns: ['src/'] })
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).toContain('wrote outside owns: docs/c.md')
  })

  test('without git nothing is checked and the run is unchanged', async ($: any, on: any) => {
    const w = fakeWorld(on, { isGit: false })
    if (!(await w.start($))) return
    await w.send($, { role: 'a', task: 't', owns: ['src/'] })
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).toContain('Status: done')
  })

  test('a worktree role runs in its own folder and names its branch', async ($: any, on: any) => {
    const w = fakeWorld(on)
    if (!(await w.start($))) return
    w.play('write-outside')
    await w.send($, { role: 'coder', task: 't', isolation: 'worktree', owns: ['other/'] })
    await w.until(() => w.submitted.length === 1)
    expect(w.spawns[0]!.cwd).toBe('/w/.relay/worktrees/coder')
    expect(w.runs.some(r => r.argv.join(' ') === 'git worktree add -b relay/coder /w/.relay/worktrees/coder')).toBe(true)
    expect(w.submitted[0]).toContain('branch relay/coder')
  })
})

describe('fallback compressor', () => {
  test('ollama builds the missing packet', { options: { fallbackBackend: 'ollama', ollamaModel: 'qwen3:8b' } }, async ($: any, on: any) => {
    const w = fakeWorld(on)
    w.play('no-packet')
    if (!(await w.start($))) return
    await w.send($, { role: 'a', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).toContain('packet built by fallback compressor ollama/qwen3:8b')
    expect(w.submitted[0]).toContain('Built by ollama.')
    const call = w.runs.find(r => r.argv[0] === 'ollama')!
    expect(call.argv).toEqual(['ollama', 'run', 'qwen3:8b', '--format', 'json', '--hidethinking', '--nowordwrap'])
    expect(call.input).toContain('Plain prose, no packet.')
  })

  test('when ollama fails there is no packet, and no Haiku either', { options: { fallbackBackend: 'ollama', ollamaModel: 'qwen3:8b' } }, async ($: any, on: any) => {
    const w = fakeWorld(on)
    w.ollama.exitCode = 1
    w.play('no-packet')
    if (!(await w.start($))) return
    await w.send($, { role: 'a', task: 't' })
    await w.until(() => w.submitted.length === 1)
    expect(w.submitted[0]).toContain('Status: failed')
    expect(w.submitted[0]).not.toContain('haiku')
  })
})

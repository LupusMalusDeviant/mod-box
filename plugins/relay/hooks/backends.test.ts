import { describe, expect, test } from 'claude-code/testing'
import {
  BACKENDS,
  classifyError,
  ignoredRules,
  majorOf,
  opencodeBashDenials,
  parseBin,
  usageText,
  versionOf,
  type LaunchSpec,
  type ProcessResult,
} from './backends.ts'
import {
  applyWriteCheck,
  compareSnapshots,
  isOwnedPath,
  isSamePath,
  ownershipDenial,
  parseNameStatus,
  parsePorcelain,
  parseWorktreeList,
  redact,
  redactDeep,
  safeRelayDir,
  toProjectPath,
  UNHASHED,
  type Packet,
} from './protocol.ts'
import { isFresh, loadQueue, mayOwn, parseQueue, serializeQueue } from './queue.ts'

const spec = (over: Partial<LaunchSpec> = {}): LaunchSpec => ({
  role: 'r',
  run: 1,
  task: 'do it',
  protocol: 'PROTO',
  isNew: true,
  owns: [],
  allowedTools: [],
  disallowedTools: [],
  cwd: '/w',
  isGitRepo: true,
  bin: ['x'],
  settings: { permissionMode: 'acceptEdits', maxBudgetUsd: 0, codexSandbox: 'workspace-write', opencodeStandalone: true, tmpDir: '/w/.relay/tmp' },
  ...over,
})
const done = (stdout: string, exitCode = 0, stderr = ''): ProcessResult => ({ stdout, stderr, exitCode, isTimedOut: false, isStoppedByLimit: false })
const jsonl = (...e: unknown[]) => e.map(x => JSON.stringify(x)).join('\n')

describe('building', () => {
  test('codex: --skip-git-repo-check without git, effort mapped, read-only sandbox kept on resume', () => {
    const a = BACKENDS.codex.build(spec({ isGitRepo: false, effort: 'max', settings: { ...spec().settings, codexSandbox: 'read-only' } })).argv
    expect(a).toContain('--skip-git-repo-check')
    expect(a).toContain('model_reasoning_effort="high"')
    expect(a.slice(3, 5)).toEqual(['--sandbox', 'read-only'])
    const b = BACKENDS.codex.build(spec({ isNew: false, sessionId: 't-9', settings: { ...spec().settings, codexSandbox: 'read-only' } })).argv
    expect(b).toContain('sandbox_mode="read-only"')
    expect(b).toContain('t-9')
  })

  test('codex: developer_instructions is a JSON string (valid TOML)', () => {
    const a = BACKENDS.codex.build(spec({ protocol: 'say "hi"\nnow' })).argv
    expect(a).toContain('developer_instructions="say \\"hi\\"\\nnow"')
  })

  test('opencode: a model without a provider is refused before the start', () => {
    expect(() => BACKENDS.opencode.build(spec({ model: 'kimi' }))).toThrow('provider/model')
  })

  // Findings 1 and 15: the task never goes into argv; the file path is absolute.
  test('opencode: the task goes into an absolute file, argv holds a fixed message', () => {
    const task = '--session=ses_other Authorization: Bearer example-bearer-value-0001'
    const inv = BACKENDS.opencode.build(spec({ model: 'ollama/m', task, role: 'scout', run: 4 }))
    expect(inv.argv.some(a => a.includes('ses_other') || a.includes('example-bearer'))).toBe(false)
    expect(inv.argv.slice(-3)).toEqual(['The task is in the attached file.', '--file', '/w/.relay/tmp/scout-4.md'])
    expect(inv.tempFiles).toEqual([{ path: '/w/.relay/tmp/scout-4.md', content: task }])
    expect(inv.input).toBe(undefined)
    expect(() => BACKENDS.opencode.build(spec({ model: 'ollama/m', settings: { ...spec().settings, tmpDir: '.relay/tmp' } }))).toThrow('absolute')
  })

  test('a stored session id that could read as an option starts fresh', () => {
    const o = BACKENDS.opencode.build(spec({ model: 'ollama/m', isNew: false, sessionId: '--agent=build' })).argv
    expect(o).not.toContain('--session')
    expect(BACKENDS.opencode.build(spec({ model: 'ollama/m', isNew: false, sessionId: 'ses_1' })).argv).toContain('ses_1')
    const c = BACKENDS.codex.build(spec({ isNew: false, sessionId: '--dangerously-bypass-approvals-and-sandbox' })).argv
    expect(c[1]).toBe('exec')
    expect(c[2]).toBe('--json')
    expect(c.join(' ')).not.toContain('dangerously')
  })

  test('opencode: Bash rules become deny patterns, others are listed as ignored', () => {
    expect(opencodeBashDenials(['Bash(git push:*)', 'Bash(rm)', 'WebFetch'])).toEqual({ 'git push*': 'deny', 'rm*': 'deny' })
    expect(ignoredRules('opencode', { effort: 'high', allowedTools: ['Read'], disallowedTools: ['WebFetch'] })).toEqual([
      'allowedTools',
      'disallowedTools except Bash(...)',
      'effort',
    ])
    expect(ignoredRules('claude', { effort: 'high', allowedTools: ['Read'], disallowedTools: ['WebFetch'] })).toEqual([])
  })

  test('bin options take a name, a path or a JSON list', () => {
    expect(parseBin('', 'codex')).toEqual(['codex'])
    expect(parseBin('C:/x/codex.exe', 'codex')).toEqual(['C:/x/codex.exe'])
    expect(parseBin('["node", "C:/x/codex.js"]', 'codex')).toEqual(['node', 'C:/x/codex.js'])
  })
})

describe('reading', () => {
  test('codex: last agent message, tokens summed over turns, broken lines skipped', () => {
    const out = BACKENDS.codex.parse(
      done(
        [
          jsonl({ type: 'thread.started', thread_id: 't-1' }, { type: 'item.completed', item: { type: 'agent_message', text: 'first' } }),
          '{ not json',
          jsonl(
            { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1 } },
            { type: 'item.completed', item: { type: 'agent_message', text: 'last' } },
            { type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
          ),
        ].join('\n'),
      ),
    )
    expect(out).toEqual({ answer: 'last', sessionId: 't-1', usage: { inputTokens: 15, cachedInputTokens: 2, outputTokens: 4, reasoningTokens: 1, turns: 2 }, error: undefined })
  })

  test('codex: errors by kind', () => {
    const fail = (m: string) => BACKENDS.codex.parse(done(jsonl({ type: 'turn.failed', error: { message: m } }), 1)).error?.kind
    expect(fail('401 Unauthorized')).toBe('auth')
    expect(fail('thread abc not found')).toBe('session-not-found')
    expect(fail('sandbox denied write')).toBe('sandbox')
    expect(fail('something else')).toBe('unknown')
    expect(BACKENDS.codex.parse(done('', 3, 'boom')).error).toEqual({ kind: 'cli', message: 'boom' })
  })

  test('opencode: text parts joined, steps counted, cost summed, error mapped', () => {
    const out = BACKENDS.opencode.parse(
      done(
        jsonl(
          { type: 'step_start', sessionID: 'ses_1', part: {} },
          { type: 'text', sessionID: 'ses_1', part: { text: 'a' } },
          { type: 'step_finish', sessionID: 'ses_1', part: { cost: 0.01, tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 50 } } } },
          { type: 'step_start', sessionID: 'ses_1', part: {} },
          { type: 'text', sessionID: 'ses_1', part: { text: 'b' } },
          { type: 'step_finish', sessionID: 'ses_1', part: { cost: 0.02, tokens: { input: 200, output: 20, reasoning: 5, cache: { read: 0 } } } },
        ),
      ),
    )
    expect(out.answer).toBe('a\n\nb')
    expect(out.sessionId).toBe('ses_1')
    expect(out.usage).toEqual({ inputTokens: 300, outputTokens: 30, reasoningTokens: 5, cachedInputTokens: 50, costUsd: 0.03, turns: 2 })
    expect(BACKENDS.opencode.parse(done(jsonl({ type: 'error', error: { message: 'Model not found: x' } }), 1)).error?.kind).toBe('model')
  })

  test('claude: plain stdout is the answer; JSON gives session, turns, cost', () => {
    expect(BACKENDS.claude.parse(done('prose')).answer).toBe('prose')
    const out = BACKENDS.claude.parse(done(JSON.stringify({ result: 'ok', session_id: 's', num_turns: 2, total_cost_usd: 0.5, usage: { input_tokens: 9, output_tokens: 1 } })))
    expect(out).toEqual({ answer: 'ok', sessionId: 's', usage: { inputTokens: 9, outputTokens: 1, costUsd: 0.5, turns: 2 }, error: undefined })
  })

  test('usage text, versions and the auth classifier', () => {
    expect(usageText({ inputTokens: 48200, cachedInputTokens: 31000, outputTokens: 3100 }, 'tokens')).toBe('48.2k in (31.0k cached) / 3.1k out tokens')
    expect(usageText({ costUsd: 0 }, 'both')).toBe('')
    expect(usageText({ inputTokens: 5, outputTokens: 900, costUsd: 0 }, 'both')).toBe('5 in / 900 out tokens, $0.00')
    expect(versionOf('codex-cli 0.166.0')).toBe('0.166.0')
    expect(majorOf('0.166.2')).toBe('0.166')
    expect(majorOf('2.1.310')).toBe('2')
    expect(classifyError('Not logged in. Run codex login')).toBe('auth')
  })
})

describe('write check', () => {
  test('porcelain and name-status parsing, renames included', () => {
    expect(parsePorcelain(' M a.ts\0?? b/c.md\0R  new.ts\0old.ts\0 D gone.ts\0')).toEqual([
      { path: 'a.ts', code: ' M' },
      { path: 'b/c.md', code: '??' },
      { path: 'new.ts', code: 'R ', orig: 'old.ts' },
      { path: 'gone.ts', code: ' D' },
    ])
    expect(parseNameStatus('M\0a.ts\0R100\0old.ts\0new.ts\0A\0b.ts\0C75\0c.ts\0d.ts\0D\0e.ts\0')).toEqual([
      { path: 'a.ts', change: 'modified' },
      { path: 'old.ts', change: 'deleted' },
      { path: 'new.ts', change: 'created' },
      { path: 'b.ts', change: 'created' },
      { path: 'd.ts', change: 'created' },
      { path: 'e.ts', change: 'deleted' },
    ])
  })

  // Finding 9: a rename out of an unowned path is a deletion there.
  test('a rename keeps its source: deleted outside owns is reported', () => {
    const committed = parseNameStatus('R100\0docs/protected.md\0src/protected.md\0')
    const c = compareSnapshots({ head: 'a', dirty: {} }, { head: 'b', dirty: {} }, committed, ['src/'], [])
    expect(c.changed).toEqual([
      { path: 'docs/protected.md', change: 'deleted' },
      { path: 'src/protected.md', change: 'created' },
    ])
    expect(c.outside).toEqual(['docs/protected.md'])
  })

  // Finding 12: on a case-sensitive filesystem SRC/ is not src/.
  test('owns compares case by the filesystem', () => {
    expect(isOwnedPath('SRC/protected.ts', ['src/'])).toBe(false)
    expect(isOwnedPath('SRC/protected.ts', ['src/'], { caseInsensitive: true })).toBe(true)
    expect(ownershipDenial('/w/SRC/x.ts', '/w', ['src/'])?.includes('not owned')).toBe(true)
    expect(ownershipDenial('/W/src/x.ts', '/w', ['src/'])?.includes('outside the project')).toBe(true)
    expect(ownershipDenial('/W/src/x.ts', '/w', ['src/'], { caseInsensitive: true })).toBe(undefined)
    const c = compareSnapshots({ head: 'a', dirty: {} }, { head: 'a', dirty: { 'SRC/protected.ts': 'new:1' } }, [], ['src/'], [])
    expect(c.outside).toEqual(['SRC/protected.ts'])
    expect(isSamePath('C:\\Proj\\x', 'c:/proj/x/', { caseInsensitive: true })).toBe(true)
    expect(isSamePath('/w/X', '/w/x')).toBe(false)
  })

  // Finding 10: a path git could not hash is never silently equal.
  test('an unhashed path makes the check incomplete, and the packet says so', () => {
    const c = compareSnapshots({ head: 'a', dirty: { sub: UNHASHED, 'a.md': 'h1' } }, { head: 'a', dirty: { sub: UNHASHED, 'a.md': 'h2' } }, [], [], [])
    expect(c.changed).toEqual([{ path: 'a.md', change: 'modified' }])
    expect(c.incomplete?.[0]).toContain('sub: git could not hash it')
    const p: Packet = { status: 'done', summary: '', decisions: [], facts: [], artifacts: [], open_questions: [], needs_from_main: [], risks: [], next_suggested: [], sections: [] }
    applyWriteCheck(p, c)
    expect(p.risks[0]).toContain('write check incomplete: sub')
  })

  test('worktree list: path and branch per entry, detached without branch', () => {
    expect(parseWorktreeList('worktree /w\0HEAD a\0branch refs/heads/main\0\0worktree /w/.relay/worktrees/c\0HEAD b\0detached\0\0')).toEqual([
      { path: '/w', branch: 'refs/heads/main' },
      { path: '/w/.relay/worktrees/c' },
    ])
  })
  test('created, modified, deleted, changed again, committed; owned paths are fine', () => {
    const before = { head: 'a', dirty: { 'src/x.ts': 'h1', 'docs/old.md': 'h2' } }
    const after = { head: 'b', dirty: { 'src/x.ts': 'h3', 'docs/old.md': 'deleted', 'docs/new.md': 'new:h4' } }
    const c = compareSnapshots(before, after, [{ path: 'README.md', change: 'modified' }], ['src/'], [])
    expect(c.changed).toEqual([
      { path: 'README.md', change: 'modified' },
      { path: 'docs/new.md', change: 'created' },
      { path: 'docs/old.md', change: 'deleted' },
      { path: 'src/x.ts', change: 'modified' },
    ])
    expect(c.outside).toEqual(['README.md', 'docs/new.md', 'docs/old.md'])
  })

  test('roles in parallel: owned by another is attributed, owned by none is unattributed', () => {
    const c = compareSnapshots({ head: '', dirty: {} }, { head: '', dirty: { 'wiki/a.md': 'new:1', 'x.md': 'new:2' } }, [], ['src/'], [{ role: 'ingester', owns: ['wiki/'] }])
    expect(c.byOtherRole).toEqual([{ path: 'wiki/a.md', role: 'ingester' }])
    expect(c.unattributed).toEqual(['x.md'])
    expect(c.outside).toEqual([])
  })

  test('applying a check: partial, risks, unlisted files added; not for unattributed ones', () => {
    const p: Packet = { status: 'done', summary: '', decisions: [], facts: [], artifacts: [], open_questions: [], needs_from_main: [], risks: [], next_suggested: [], sections: [] }
    applyWriteCheck(p, { checked: true, changed: [{ path: 'x.md', change: 'created' }, { path: 'y.md', change: 'modified' }], outside: ['x.md'], unattributed: ['y.md'], byOtherRole: [] })
    expect(p.status).toBe('partial')
    expect(p.artifacts.map(a => a.path)).toEqual(['x.md'])
    expect(p.risks[0]).toBe('wrote outside owns: x.md (created)')
  })
})

// Finding 8: relayDir stays inside the project.
describe('relay folder', () => {
  test('a relayDir outside the project falls back to .relay', () => {
    expect(safeRelayDir('.relay/')).toEqual({ dir: '.relay' })
    expect(safeRelayDir('./work\\relay')).toEqual({ dir: 'work/relay' })
    for (const bad of ['../outside', '/tmp/relay', 'C:/relay', 'a/../../b', 'C:relay']) {
      expect(safeRelayDir(bad).dir).toBe('.relay')
      expect(safeRelayDir(bad).note).toContain('outside the project')
    }
  })
})

// Finding 2: credentials never leave relay.
describe('redaction', () => {
  test('header, key=value, URL user and private key are redacted; counters stay', () => {
    const text = [
      'curl -H "Authorization: Bearer example-bearer-value-0001"',
      'export API_KEY=example-token-value-0002',
      '{"password": "example-password-0003"}',
      'git push https://bot:example-password-0003@example.com/r.git',
      'max_tokens: 2000, token limit reached, input tokens: 48.2k',
    ].join('\n')
    const out = redact(text)
    for (const s of ['example-bearer-value-0001', 'example-token-value-0002', 'example-password-0003']) expect(out.includes(s)).toBe(false)
    expect(out).toContain('max_tokens: 2000, token limit reached, input tokens: 48.2k')
    expect(out).toContain('https://bot:[redacted]@example.com')
    expect(redactDeep({ a: ['token=example-token-value-0002'], n: 3 })).toEqual({ a: ['token=[redacted]'], n: 3 })
  })

  // Review 2, finding 4: numeric and quoted values are whole values.
  test('numeric credentials and quoted values with spaces are redacted whole; counters stay', () => {
    expect(redact('password=12345678')).toBe('password=[redacted]')
    expect(redact('client_secret: 4711')).not.toContain('4711')
    const quoted = redact('password="correct horse battery staple" next')
    expect(quoted).not.toContain('horse')
    expect(quoted).not.toContain('staple')
    expect(quoted).toContain('next')
    expect(redact("secret='a b c'")).not.toContain(' b ')
    const json = redact(JSON.stringify({ log: 'password="two words" end' }))
    expect(json).not.toContain('two words')
    expect(json).toContain('end')
    expect(redact('max_tokens: 2000, input tokens: 48.2k, tokens=31')).toBe('max_tokens: 2000, input tokens: 48.2k, tokens=31')
  })

  // Review 2, finding 13: diff paths are relative to the project, not the repo.
  test('repo paths become project paths', () => {
    expect(toProjectPath('sub/src/a.ts', '')).toBe('sub/src/a.ts')
    expect(toProjectPath('sub/src/a.ts', 'sub/')).toBe('src/a.ts')
    expect(toProjectPath('other/b.ts', 'sub/')).toBe('../other/b.ts')
    expect(toProjectPath('top.ts', 'a/b/')).toBe('../../top.ts')
  })
})

// Review 2, finding 12: a nonzero exit is a failure even with an answer.
describe('exit code', () => {
  test('codex and opencode: answer plus exit 1 reports an error', () => {
    const codex = BACKENDS.codex.parse(done(jsonl({ type: 'item.completed', item: { type: 'agent_message', text: 'half' } }), 1, 'crashed'))
    expect(codex.answer).toBe('half')
    expect(codex.error?.kind).toBe('cli')
    const oc = BACKENDS.opencode.parse(done(jsonl({ type: 'text', sessionID: 'ses_1', part: { text: 'half' } }), 1, 'crashed'))
    expect(oc.answer).toBe('half')
    expect(oc.error?.kind).toBe('cli')
    expect(BACKENDS.codex.parse(done(jsonl({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }))).error).toBeUndefined()
  })
})

describe('queue file', () => {
  test('backup when broken, ownership by heartbeat', () => {
    const q = { version: 1 as const, owner: { session: 'a', heartbeatAt: new Date(0).toISOString() }, jobs: [] }
    expect(loadQueue('{ x', serializeQueue(q))).toMatchObject({ isBroken: true, isFromBackup: true })
    expect(loadQueue(undefined, undefined).queue.jobs).toEqual([])
    // Review 2, finding 6: an empty main read from the backup says so, so the
    // backup is never overwritten by the empty main.
    expect(loadQueue('', serializeQueue(q))).toMatchObject({ isFromBackup: true })
    expect(loadQueue(undefined, serializeQueue(q)).isFromBackup).toBe(true)
    expect(mayOwn(q, 'b', 60_000)).toBe(false)
    expect(mayOwn(q, 'b', 4 * 60_000)).toBe(true)
    expect(mayOwn(q, 'a', 60_000)).toBe(true)
  })

  test('the owner token survives a round trip; freshness by heartbeat', () => {
    const q = { version: 1 as const, owner: { session: 'a', heartbeatAt: new Date(0).toISOString(), token: 't1' }, jobs: [] }
    expect(parseQueue(serializeQueue(q))?.owner?.token).toBe('t1')
    expect(isFresh(q.owner, 60_000)).toBe(true)
    expect(isFresh(q.owner, 4 * 60_000)).toBe(false)
    expect(isFresh({ heartbeatAt: 'nonsense' }, 0)).toBe(false)
  })
})

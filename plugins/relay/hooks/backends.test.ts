import { describe, expect, test } from 'claude-code/testing'
import {
  BACKENDS,
  BuildError,
  classifyError,
  ignoredRules,
  majorOf,
  opencodeBashDenials,
  parseBin,
  remoteEndLine,
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
  privateKeyFilter,
  REDACTED_KEY_LINE,
  remoteWriteCheck,
  safeRelayDir,
  toProjectPath,
  UNHASHED,
  type Packet,
} from './protocol.ts'
import * as protocol from './protocol.ts'
import { parsePacket } from './protocol.ts'
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

// ── werkbank (contract 0001, Nachtrag 2) ───────────────────────────────

const wbSettings = { ...spec().settings, werkbankLeitstand: 'http://100.73.150.87:5080', werkbankTokenFile: '/h/.werkbank/relay.token', runTimeoutMin: 30 }
const wb = (over: Partial<LaunchSpec> = {}) => spec({ bin: ['werkbank-relay'], settings: wbSettings, ...over })
const refused = (s: LaunchSpec) => {
  try {
    BACKENDS.werkbank.build(s)
  } catch (err) {
    return err instanceof BuildError ? `${err.kind}: ${err.message}` : `other: ${String(err)}`
  }
  return 'built'
}
const job = (over: Record<string, unknown> = {}) => ({
  jobId: 'wb-1',
  state: 'done',
  answer: 'A',
  sessionId: 'fsn1-5:9b1f',
  usage: { costUsd: 0.42, turns: 6, inputTokens: 10, outputTokens: 20, model: 'claude-opus-5-5' },
  branch: 'agent/relay/r',
  commits: ['abc1234'],
  changedFiles: ['src/a.ts'],
  verify: { command: 'npm test', exitCode: 0, tests: { total: 3, passed: 3, failed: 0 } },
  ...over,
})

describe('werkbank: building', () => {
  test('a new run: fixed order, everything given, task on stdin, protocol only in the file', () => {
    const inv = BACKENDS.werkbank.build(
      wb({ model: 'claude-opus-5-5', allowedTools: ['Read', 'Bash(npm test:*)'], disallowedTools: ['Bash(git push:*)'], owns: ['src/', 'docs/'] }),
    )
    expect(inv.argv).toEqual([
      'werkbank-relay', 'run', '--leitstand', 'http://100.73.150.87:5080', '--token-file', '/h/.werkbank/relay.token',
      '--role', 'r', '--run', '1', '--cwd', '/w', '--model', 'claude-opus-5-5', '--timeout-min', '30',
      '--allowed-tools', 'Read,Bash(npm test:*)', '--disallowed-tools', 'Bash(git push:*)', '--owns', 'src/,docs/',
      '--protocol-file', '/w/.relay/tmp/r-1.protocol.md',
    ])
    expect(inv.input).toBe('do it')
    expect(inv.tempFiles).toEqual([{ path: '/w/.relay/tmp/r-1.protocol.md', content: 'PROTO' }])
    expect(inv.argv).not.toContain('PROTO')
    expect(inv.presetSessionId).toBeUndefined()
  })

  test('resume passes a safe session; an unsafe one, a new run and timeout 0 leave flags out', () => {
    const a = BACKENDS.werkbank.build(wb({ isNew: false, sessionId: 'fsn1-5:9b1f' })).argv
    expect(a.slice(a.indexOf('--session'), a.indexOf('--session') + 2)).toEqual(['--session', 'fsn1-5:9b1f'])
    expect(BACKENDS.werkbank.build(wb({ isNew: false, sessionId: '--evil' })).argv).not.toContain('--session')
    expect(BACKENDS.werkbank.build(wb({ isNew: true, sessionId: 'fsn1-5:x' })).argv).not.toContain('--session')
    const b = BACKENDS.werkbank.build(wb({ settings: { ...wbSettings, runTimeoutMin: 0 } })).argv
    expect(b).not.toContain('--timeout-min')
    expect(b).not.toContain('--model')
    expect(b).not.toContain('--allowed-tools')
    expect(b).not.toContain('--owns')
  })

  test('N169: a resumed run has the whole argv in order, --session after --cwd, no empty list flags', () => {
    expect(BACKENDS.werkbank.build(wb({ isNew: false, sessionId: 'fsn1-5:9b1f', run: 2 })).argv).toEqual([
      'werkbank-relay', 'run', '--leitstand', 'http://100.73.150.87:5080', '--token-file', '/h/.werkbank/relay.token',
      '--role', 'r', '--run', '2', '--cwd', '/w', '--session', 'fsn1-5:9b1f', '--timeout-min', '30',
      '--protocol-file', '/w/.relay/tmp/r-2.protocol.md',
    ])
  })

  test('refused before the start: big task, option-like or comma values, a bad Leitstand, a relative tmp folder', () => {
    expect(refused(wb({ task: 'x'.repeat(16 * 1024) }))).toBe('built')
    expect(refused(wb({ task: 'x'.repeat(16 * 1024 + 1) }))).toContain('cli: werkbank: the task has 16385 bytes')
    expect(refused(wb({ task: 'ü'.repeat(8193) }))).toContain('16386 bytes')
    expect(refused(wb({ model: '--help' }))).toContain('cli: werkbank: model "--help" starts with "-"')
    expect(refused(wb({ owns: ['src/', '-x'] }))).toContain('owned path "-x"')
    expect(refused(wb({ allowedTools: ['Bash(a,b)'] }))).toContain('contains ","')
    expect(refused(wb({ settings: { ...wbSettings, werkbankLeitstand: 'fsn1-4:5080' } }))).toContain('werkbankLeitstand must be an http')
    // N50: no credentials in the URL, and the refusal does not echo them
    const withUser = refused(wb({ settings: { ...wbSettings, werkbankLeitstand: 'http://bot:s3cr3t-pass@100.73.150.87:5080' } }))
    expect(withUser).toContain('without user, password, query or fragment')
    expect(withUser).not.toContain('s3cr3t-pass')
    expect(refused(wb({ settings: { ...wbSettings, werkbankLeitstand: 'ftp://100.73.150.87' } }))).toContain('werkbankLeitstand')
    expect(refused(wb({ settings: { ...wbSettings, werkbankLeitstand: 'https://leitstand.tail1234.ts.net' } }))).toBe('built')
    expect(refused(wb({ settings: { ...wbSettings, werkbankTokenFile: '~/.werkbank/relay.token' } }))).toContain('werkbankTokenFile must be an absolute path')
    expect(refused(wb({ settings: { ...wbSettings, werkbankTokenFile: '--help' } }))).toContain('werkbankTokenFile')
    expect(refused(wb({ settings: { ...wbSettings, werkbankTokenFile: 'C:\\Users\\u\\.werkbank\\relay.token' } }))).toContain('werkbankTokenFile')
    // N64: Windows needs a drive or a UNC share, elsewhere a path from /
    const win = { ...wbSettings, isWindows: true }
    expect(refused(wb({ settings: { ...win, werkbankTokenFile: 'C:\\Users\\u\\.werkbank\\relay.token' } }))).toBe('built')
    expect(refused(wb({ settings: { ...win, werkbankTokenFile: 'C:/Users/u/.werkbank/relay.token' } }))).toBe('built')
    expect(refused(wb({ settings: { ...win, werkbankTokenFile: '\\\\nas\\share\\relay.token' } }))).toBe('built')
    expect(refused(wb({ settings: { ...win, werkbankTokenFile: '\\Users\\u\\relay.token' } }))).toContain('with a drive or a UNC share')
    expect(refused(wb({ settings: { ...win, werkbankTokenFile: '/h/.werkbank/relay.token' } }))).toContain('with a drive or a UNC share')
    // N58: no query or fragment, and no credential in any passed value; never echoed
    const query = refused(wb({ settings: { ...wbSettings, werkbankLeitstand: 'https://leitstand.example/?token=abcdef0123456789' } }))
    expect(query).toContain('without user, password, query or fragment')
    expect(query).not.toContain('abcdef0123456789')
    expect(refused(wb({ settings: { ...wbSettings, werkbankLeitstand: 'https://leitstand.example/#k' } }))).toContain('query or fragment')
    expect(refused(wb({ settings: { ...wbSettings, werkbankLeitstand: 'xhttps://leitstand.example' } }))).toContain('werkbankLeitstand')
    const rule = refused(wb({ allowedTools: ['Bash(curl -H "Authorization: Bearer abcdef0123456789abcdef":*)'] }))
    expect(rule).toBe('cli: werkbank: a value for --allowed-tools looks like a credential; it is not passed on.')
    expect(refused(wb({ model: 'm api_key=abcdef0123456789' }))).toContain('a value for --model looks like a credential')
    expect(refused(wb({ settings: { ...wbSettings, tmpDir: '.relay/tmp' } }))).toContain('absolute folder')
  })
})

describe('werkbank: parsing', () => {
  const parse = (o: unknown, exitCode = 0, stderr = '') => BACKENDS.werkbank.parse(done(typeof o === 'string' ? o : JSON.stringify(o), exitCode, stderr))

  test('done: answer, session, usage and the remote job', () => {
    const o = parse(job())
    expect(o.answer).toBe('A')
    expect(o.sessionId).toBe('fsn1-5:9b1f')
    expect(o.usage).toEqual({ costUsd: 0.42, turns: 6, inputTokens: 10, outputTokens: 20, model: 'claude-opus-5-5' })
    expect(o.error).toBeUndefined()
    expect(o.remote).toEqual({
      jobId: 'wb-1',
      state: 'done',
      branch: 'agent/relay/r',
      commits: ['abc1234'],
      changedFiles: ['src/a.ts'],
      verify: { command: 'npm test', exitCode: 0, tests: { total: 3, passed: 3, failed: 0 } },
    })
  })

  test('partial states carry their reason in remote, not as an error', () => {
    for (const state of ['red', 'needs-approval', 'timed-out', 'limit']) {
      const o = parse(job({ state, error: { kind: state === 'limit' ? 'limit' : 'cli', message: `why ${state}` } }))
      expect(o.error).toBeUndefined()
      expect(o.remote?.state).toBe(state)
      expect(o.remote?.reason).toBe(`why ${state}`)
    }
  })

  test('failed and cancelled jobs are errors', () => {
    expect(parse(job({ state: 'failed', error: { kind: 'cli', message: 'claude exited 1' } })).error).toEqual({ kind: 'cli', message: 'claude exited 1' })
    const c = parse(job({ state: 'cancelled' }))
    expect(c.error).toBeUndefined()
    expect(c.remote?.state).toBe('cancelled')
  })

  test('the program failed: every error kind maps onto a RunError', () => {
    const kinds: [string, string][] = [['auth', 'auth'], ['network', 'network'], ['repo', 'repo'], ['budget', 'budget'], ['limit', 'budget'], ['cli', 'cli'], ['odd', 'unknown']]
    for (const [kind, want] of kinds) {
      const o = parse({ error: { kind, message: `m ${kind}` } }, 2)
      expect(o.error).toEqual({ kind: want, message: `m ${kind}` })
      expect(o.remote).toBeUndefined()
      expect(o.answer).toBe('')
    }
  })

  test('no JSON, a nonzero exit without error, an unsafe session, no file list', () => {
    expect(parse('boom', 1, 'Unhandled exception')).toEqual({ answer: '', usage: {}, error: { kind: 'cli', message: 'Unhandled exception' } })
    expect(parse('', 0).error?.message).toBe('werkbank-relay printed no JSON')
    expect(parse('[1,2]', 0).error?.kind).toBe('cli')
    expect(BACKENDS.werkbank.parse({ stdout: '', stderr: '', isTimedOut: true, isStoppedByLimit: false }).error).toBeUndefined()
    expect(parse({ answer: 'x' }, 3, 'died').error).toEqual({ kind: 'cli', message: 'died (werkbank-relay reported no jobId)' })
    expect(parse(job({ sessionId: '-x' })).sessionId).toBeUndefined()
    const { changedFiles: _c, ...noList } = job()
    expect(parse(noList).remote?.changedFiles).toBeUndefined()
  })

  test('N48: a done job keeps a CLI error; no jobId is always an error', () => {
    expect(parse(job(), 1, 'crashed after the job').error).toEqual({ kind: 'cli', message: 'crashed after the job' })
    expect(parse(job({ error: { kind: 'network', message: 'lost the Leitstand' } })).error).toEqual({ kind: 'network', message: 'lost the Leitstand' })
    // a partial state keeps the JSON error as its reason, but a nonzero exit is still an error
    expect(parse(job({ state: 'red' }), 1, 'x').error).toEqual({ kind: 'cli', message: 'x' })
    const { jobId: _j, ...noJob } = job()
    expect(parse(noJob).error).toEqual({ kind: 'cli', message: 'werkbank-relay reported no jobId' })
    expect(parse(noJob).answer).toBe('A')
    expect(parse(noJob).remote).toBeUndefined()
  })

  test('N61: no done without a confirmed exit 0; a signal or a broken stream is an error', () => {
    const base = { stdout: JSON.stringify(job()), stderr: '', isTimedOut: false, isStoppedByLimit: false }
    expect(BACKENDS.werkbank.parse({ ...base, exitCode: 0 }).error).toBeUndefined()
    expect(BACKENDS.werkbank.parse({ ...base, signal: 'SIGKILL' }).error).toEqual({ kind: 'cli', message: 'ended by signal SIGKILL' })
    expect(BACKENDS.werkbank.parse({ ...base, streamError: 'EPIPE' }).error).toEqual({ kind: 'cli', message: 'reading the output failed: EPIPE' })
    expect(BACKENDS.werkbank.parse(base).error).toEqual({ kind: 'cli', message: 'werkbank-relay ended without an exit code' })
    // codex too; claude keeps 0.4.0 behaviour (3.1)
    const cx = jsonl({ type: 'item.completed', item: { type: 'agent_message', text: 'A' } })
    expect(BACKENDS.codex.parse({ stdout: cx, stderr: '', signal: 'SIGTERM', isTimedOut: false, isStoppedByLimit: false }).error?.message).toBe('ended by signal SIGTERM')
    expect(BACKENDS.claude.parse({ stdout: '', stderr: '', signal: 'SIGTERM', isTimedOut: false, isStoppedByLimit: false }).error).toBeUndefined()
    // a timeout is said by the timeout, not as a signal
    expect(BACKENDS.codex.parse({ stdout: cx, stderr: '', signal: 'SIGTERM', isTimedOut: true, isStoppedByLimit: false }).error).toBeUndefined()
  })

  test('N65: no jobId with an answer keeps the error kind and says so; partial reasons keep their kind', () => {
    const { jobId: _j, ...noJob } = job()
    expect(parse({ ...noJob, error: { kind: 'network', message: 'lost it' } })).toMatchObject({ error: { kind: 'network', message: 'lost it (werkbank-relay reported no jobId)' } })
    expect(parse({ error: { kind: 'auth', message: '401' } }, 2).error).toEqual({ kind: 'auth', message: '401' })
    const lim = parse(job({ state: 'limit', error: { kind: 'limit', message: 'usage limit' } })).remote!
    expect(remoteEndLine(lim)).toBe('werkbank job wb-1 ended limit (budget): usage limit')
  })

  test('N67: build reports the session it passed', () => {
    expect(BACKENDS.werkbank.build(wb({ isNew: false, sessionId: 'fsn1-5:9b1f' })).sessionArg).toBe('fsn1-5:9b1f')
    expect(BACKENDS.werkbank.build(wb({ isNew: false, sessionId: '-bad' })).sessionArg).toBeUndefined()
    // a wrapper with its own --session in bin is not the session
    expect(BACKENDS.werkbank.build(wb({ bin: ['wrap', '--session', 'w1', 'werkbank-relay'] })).sessionArg).toBeUndefined()
  })

  test('N54: the red reason puts the verify line first', () => {
    const o = parse(job({ state: 'red', verify: { command: 'npm test', exitCode: 1 }, error: { kind: 'cli', message: 'tests failed' } }))
    expect(remoteEndLine(o.remote!)).toBe('werkbank job wb-1 ended red (cli): verify: npm test → exit 1; tests failed')
    expect(remoteEndLine(parse(job({ state: 'timed-out' })).remote!)).toBe('werkbank job wb-1 ended timed-out')
    expect(remoteEndLine(parse(job()).remote!)).toBeUndefined()
  })

  test('N69: an error that is no object is a protocol failure; only own kinds count', () => {
    const malformed = { kind: 'cli', message: 'werkbank-relay sent a malformed error field' }
    expect(parse(job({ error: 'lost it' })).error).toEqual(malformed)
    expect(parse(job({ error: ['x'] })).error).toEqual(malformed)
    expect(parse(job({ error: 7 })).error).toEqual(malformed)
    // N224 (replaces N77): a null error is a missing one, no error
    expect(parse(job({ error: null })).error).toBeUndefined()
    expect(parse(job()).error).toBeUndefined()
    for (const kind of ['constructor', 'toString', 'hasOwnProperty']) {
      expect(parse({ error: { kind, message: 'm' } }, 2).error).toEqual({ kind: 'unknown', message: 'm' })
    }
  })

  test('N71: no JSON and a signal or a broken stream says so, not stderr', () => {
    const r = { stdout: '', stderr: 'queued\n', isTimedOut: false, isStoppedByLimit: false }
    // the cause comes first; stderr follows as context, as in N61
    expect(BACKENDS.werkbank.parse({ ...r, signal: 'SIGTERM' }).error?.message.startsWith('ended by signal SIGTERM')).toBe(true)
    expect(BACKENDS.werkbank.parse({ ...r, streamError: 'EPIPE' }).error?.message.startsWith('reading the output failed: EPIPE')).toBe(true)
    // with an exit code stderr stays the message
    expect(BACKENDS.werkbank.parse({ ...r, exitCode: 1 }).error).toEqual({ kind: 'cli', message: 'queued' })
  })

  test('N72: a session id the redaction would change is neither kept nor sent', () => {
    const id = 'token:abcdef0123456789abcd'
    expect(parse(job({ sessionId: id })).sessionId).toBeUndefined()
    const inv = BACKENDS.werkbank.build(wb({ isNew: false, sessionId: id }))
    expect(inv.argv).not.toContain('--session')
    expect(inv.sessionArg).toBeUndefined()
    expect(parse(job({ sessionId: 'fsn1-5:9b1f' })).sessionId).toBe('fsn1-5:9b1f')
  })

  test('error messages are redacted', () => {
    const o = parse({ error: { kind: 'auth', message: 'Authorization: Bearer abcdef0123456789abcdef' } }, 2)
    expect(o.error?.message).not.toContain('abcdef0123456789abcdef')
  })
})

describe('werkbank: write check and rules', () => {
  test('changedFiles against owns, case-sensitive, mapped from the repo top', () => {
    const c = remoteWriteCheck({ changedFiles: ['src/a.ts', 'SRC/b.ts', 'docs/x.md', 'src/a.ts'] }, ['src/'], '')
    expect(c.checked).toBe(true)
    expect(c.changed).toEqual([
      { path: 'SRC/b.ts', change: 'modified' },
      { path: 'docs/x.md', change: 'modified' },
      { path: 'src/a.ts', change: 'modified' },
    ])
    expect(c.outside).toEqual(['SRC/b.ts', 'docs/x.md'])
    expect(remoteWriteCheck({ changedFiles: ['app/src/a.ts', 'lib/x.ts'] }, ['src/'], 'app/').outside).toEqual(['../lib/x.ts'])
    expect(remoteWriteCheck({ changedFiles: ['x'] }, [], '').outside).toEqual([])
    const none = remoteWriteCheck({}, ['src/'], '')
    expect(none.checked).toBe(false)
    expect(none.incomplete).toEqual(['the werkbank job reported no list of changed files'])
  })

  test('N49: no sure footing, nothing checked; POSIX paths; escapes are always outside', () => {
    const unknown = remoteWriteCheck({ changedFiles: ['src/a.ts'] }, ['src/'], undefined)
    expect(unknown.checked).toBe(false)
    expect(unknown.incomplete?.[0]).toContain('project prefix unknown')
    const bad = remoteWriteCheck({ isFileListMalformed: true }, ['src/'], '')
    expect(bad.checked).toBe(false)
    expect(bad.incomplete).toEqual(['the werkbank job reported a malformed file list'])
    // a backslash is part of a Linux file name, not a folder separator
    expect(remoteWriteCheck({ changedFiles: ['src\\a.ts'] }, ['src/'], '').outside).toEqual(['src\\a.ts'])
    // owns cannot cover a path that leaves the project or is absolute
    expect(remoteWriteCheck({ changedFiles: ['src/../etc/x', '/etc/passwd', 'src/ok.ts'] }, ['src/'], '').outside).toEqual(['/etc/passwd', 'src/../etc/x'])
    expect(remoteWriteCheck({ changedFiles: ['../x', 'y'] }, [], '').outside).toEqual(['../x'])
    // N60: owns for werkbank are written with "/"; a backslash is a name character
    expect(remoteWriteCheck({ changedFiles: ['src/a.ts'] }, ['./src/'], '').outside).toEqual([])
    expect(remoteWriteCheck({ changedFiles: ['src/a.ts'] }, ['src\\'], '').outside).toEqual(['src/a.ts'])
  })

  test('N60: the prefix stays literal (backslash, leading space)', () => {
    // a Linux folder named "team\app": the sibling team/app/src is not the project
    expect(remoteWriteCheck({ changedFiles: ['team/app/src/x', 'team\\app/src/y'] }, ['src/'], 'team\\app/').outside).toEqual(['../team/app/src/x'])
    expect(remoteWriteCheck({ changedFiles: [' app/src/a.ts', 'app/src/b.ts'] }, ['src/'], ' app/').outside).toEqual(['../app/src/b.ts'])
  })

  test('N66: only real commit ids are kept, the rest is counted', () => {
    const r = BACKENDS.werkbank.parse(done(JSON.stringify(job({ commits: ['abc1234', 'ABCDEF0123', 'token=sk-live-123456', 'abc', 42] })))).remote!
    expect(r.commits).toEqual(['abc1234', 'ABCDEF0123'])
    expect(r.malformedCommits).toBe(3)
  })

  test('N49: parse marks a malformed file list, never a short one', () => {
    const p = (changedFiles: unknown) => BACKENDS.werkbank.parse(done(JSON.stringify(job({ changedFiles })))).remote
    expect(p([null])?.isFileListMalformed).toBe(true)
    expect(p(['a', ''])?.isFileListMalformed).toBe(true)
    expect(p('src/a.ts')?.isFileListMalformed).toBe(true)
    expect(p(['a', 'b'])?.changedFiles).toEqual(['a', 'b'])
    expect(p(['a', 'b'])?.isFileListMalformed).toBeUndefined()
    // N202: no file name has a NUL
    expect(p([`src/file${String.fromCharCode(0)}`])?.isFileListMalformed).toBe(true)
  })

  test('N223: shown werkbank fields stay within 120 characters, marks included', () => {
    const long = (c: string) => `${c}0x90\n${c.repeat(300)}`
    const r = BACKENDS.werkbank.parse(done(JSON.stringify(job({ jobId: long('j'), state: long('s'), branch: long('b') })))).remote!
    for (const v of [r.jobId, r.state, r.branch]) {
      expect(v.length).toBeLessThanOrEqual(120)
      expect(v).toContain('…')
    }
    expect(r.state).toContain('(not exact)')
    expect(r.branch).toContain('(not exact)')
  })

  test('N200: only a whole counter name keeps its number', () => {
    expect(redact('access_tokenSecret=123456')).not.toContain('123456')
    expect(redact('secret_tokens=123456')).not.toContain('123456')
    expect(redact('access_tokens: 123456')).not.toContain('123456')
    expect(redact('max_tokens=4096, input_tokens: 12, maxTokensPerRun=5000, token_count=7')).toBe('max_tokens=4096, input_tokens: 12, maxTokensPerRun=5000, token_count=7')
  })

  test('the outside write turns done into partial', () => {
    const p: Packet = { status: 'done', summary: '', decisions: [], facts: [], artifacts: [], open_questions: [], needs_from_main: [], risks: [], next_suggested: [], sections: [] }
    applyWriteCheck(p, remoteWriteCheck({ changedFiles: ['docs/x.md'] }, ['src/'], ''))
    expect(p.status).toBe('partial')
    expect(p.risks).toContain('wrote outside owns: docs/x.md (modified)')
  })

  test('N51: a private key over several lines is dropped from the log, marked once', () => {
    const f = privateKeyFilter()
    const out = ['before', '-----BEGIN OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXktdjEAAAAA', 'QyNTUxOQAAACDx', '-----END OPENSSH PRIVATE KEY-----', 'after']
      .map(f)
      .filter(x => x !== undefined)
    expect(out).toEqual(['before', REDACTED_KEY_LINE, 'after'])
    // a whole key on one line is redact()'s job, the filter leaves it
    const g = privateKeyFilter()
    expect(g('k=-----BEGIN RSA PRIVATE KEY-----abc-----END RSA PRIVATE KEY-----')).toContain('BEGIN')
    expect(g('next')).toBe('next')
    // no END: the rest of the run stays hidden
    const h = privateKeyFilter()
    expect(['-----BEGIN PRIVATE KEY-----', 'MIIE', 'more'].map(h)).toEqual([REDACTED_KEY_LINE, undefined, undefined])
    // N62: a whole key and the start of a second one on one line
    const k = privateKeyFilter()
    expect(
      ['x -----BEGIN RSA PRIVATE KEY-----a-----END RSA PRIVATE KEY----- y -----BEGIN EC PRIVATE KEY-----', 'secondKeyBody', '-----END EC PRIVATE KEY-----', 'after'].map(k),
    ).toEqual([REDACTED_KEY_LINE, undefined, undefined, 'after'])
    // the end of one key and the start of the next on one line
    const m = privateKeyFilter()
    expect(['-----BEGIN PRIVATE KEY-----', 'a', '-----END PRIVATE KEY----- -----BEGIN PRIVATE KEY-----', 'b', '-----END PRIVATE KEY-----', 'ok'].map(m)).toEqual([
      REDACTED_KEY_LINE,
      undefined,
      undefined,
      undefined,
      undefined,
      'ok',
    ])
  })

  test('N70: only an END of the open kind closes the key', () => {
    const f = privateKeyFilter()
    const lines = ['-----BEGIN RSA PRIVATE KEY-----', 'firstBodyLine', '-----END EC PRIVATE KEY-----', 'stillBody', '-----END RSA PRIVATE KEY-----', 'after']
    expect(lines.map(f)).toEqual([REDACTED_KEY_LINE, undefined, undefined, undefined, undefined, 'after'])
    // a mismatched END on the opening line leaves the key open
    const g = privateKeyFilter()
    expect(['x -----BEGIN RSA PRIVATE KEY-----a-----END EC PRIVATE KEY-----', 'body'].map(g)).toEqual([REDACTED_KEY_LINE, undefined])
    // an END without a BEGIN changes nothing
    const h = privateKeyFilter()
    expect(['-----END RSA PRIVATE KEY-----', 'next'].map(h)).toEqual(['-----END RSA PRIVATE KEY-----', 'next'])
  })

  test('N73: a packet status that is no string is partial, and the write check still turns it down', () => {
    const p = parsePacket('```relay\n{"status":["done"],"summary":"s"}\n```')!
    expect(p.status).toBe('partial')
    applyWriteCheck(p, remoteWriteCheck({ changedFiles: ['docs/x.md'] }, ['src/'], ''), { isLiteral: true })
    expect(p.status).toBe('partial')
    expect(parsePacket('```relay\n{"status":"done"}\n```')!.status).toBe('done')
  })

  test('N74: in a whole text a key ends only at the END of its own kind', () => {
    const text = ['-----BEGIN RSA PRIVATE KEY-----', 'firstBody', '-----END EC PRIVATE KEY-----', 'secondBodyLine', '-----END RSA PRIVATE KEY-----', 'after'].join('\n')
    const out = redact(text)
    expect(out).not.toContain('secondBodyLine')
    expect(out).not.toContain('firstBody')
    expect(out).toContain('after')
    // no END of its kind: hidden to the end of the text
    expect(redact(['-----BEGIN RSA PRIVATE KEY-----', 'a', '-----END EC PRIVATE KEY-----', 'tailBody'].join('\n'))).not.toContain('tailBody')
    // in a werkbank error message too
    const o = BACKENDS.werkbank.parse(done(JSON.stringify({ error: { kind: 'auth', message: text } }), 2))
    expect(o.error?.message).not.toContain('secondBodyLine')
  })

  test('N75: the temp file is checked by its last path part, line breaks included', () => {
    const baseName = (protocol as Record<string, unknown>).baseName as ((p: string) => string) | undefined
    expect(baseName?.('/w/odd\nname/.relay/tmp/coder-1.protocol.md')).toBe('coder-1.protocol.md')
    expect(baseName?.('C:\\w\\.relay\\tmp\\scout-1.md')).toBe('scout-1.md')
  })

  test('N76: a token file path that looks like a credential is refused, unnamed', () => {
    const s = wb({ settings: { ...wbSettings, werkbankTokenFile: '/tmp/password=synthetic-value/relay.token' } })
    const r = refused(s)
    expect(r).toBe('cli: werkbank: werkbankTokenFile looks like it contains a credential; it is not passed on.')
    expect(r).not.toContain('synthetic-value')
  })

  test('N78: a rejected session id is flagged, a kept or missing one is not', () => {
    const p = (o: Record<string, unknown>) => BACKENDS.werkbank.parse(done(JSON.stringify(job(o))))
    expect(p({ sessionId: 'token:abcdef0123456789abcd' }).isSessionRejected).toBe(true)
    expect(p({}).isSessionRejected).toBeUndefined()
    const { sessionId: _s, ...noSession } = job()
    expect(BACKENDS.werkbank.parse(done(JSON.stringify(noSession))).isSessionRejected).toBeUndefined()
  })

  test('N80: a werkbank write check keeps paths literal when adding artifacts', () => {
    const packet = (): Packet => ({ status: 'done', summary: '', decisions: [], facts: [], artifacts: [{ path: 'src/a\\b.ts', change: 'modified' }], open_questions: [], needs_from_main: [], risks: [], next_suggested: [], sections: [] })
    const check = remoteWriteCheck({ changedFiles: ['src/a/b.ts'] }, [], '')
    expect(applyWriteCheck(packet(), check, { isLiteral: true }).artifacts.map(a => a.path)).toEqual(['src/a\\b.ts', 'src/a/b.ts'])
    // local backends keep folding \ into /
    expect(applyWriteCheck(packet(), check).artifacts.map(a => a.path)).toEqual(['src/a\\b.ts'])
  })

  test('N81: loading the queue drops jobs with an unsafe role or run, and counts them', () => {
    const job = (role: string, run?: unknown) => ({ id: `j_${role}`, role, task: 't', enqueuedAt: 'x', state: 'running', ...(run !== undefined ? { run } : {}) })
    const text = JSON.stringify({ version: 1, jobs: [job('../../docs/release', 3), job('ok', 0), job('ok2', 1.5), job('ok3', '2'), job('Good', 1), job('coder', 2), job('scout')] })
    const l = loadQueue(text, undefined) as ReturnType<typeof loadQueue> & { dropped?: number }
    expect(l.queue.jobs.map(j => j.role)).toEqual(['coder', 'scout'])
    expect(l.dropped).toBe(5)
  })

  test('N82: no werkbank argument that looks like a credential, not even the bin', () => {
    expect(refused(wb({ cwd: '/w/password=sample-secret' }))).toBe('cli: werkbank: a value for --cwd looks like a credential; it is not passed on.')
    expect(refused(wb({ settings: { ...wbSettings, tmpDir: '/t/token=sample-secret/tmp' } }))).toBe(
      'cli: werkbank: a value for --protocol-file looks like a credential; it is not passed on.',
    )
    expect(refused(wb({ bin: ['/opt/apikey=sample-secret/werkbank-relay'] }))).toBe('cli: werkbank: werkbankBin looks like it contains a credential; it is not passed on.')
    expect(refused(wb())).toBe('built')
  })

  test('N83: a JSON line gives its decoded texts to the key filter', () => {
    const texts = (protocol as Record<string, unknown>).eventTexts as ((l: string) => string[]) | undefined
    expect(texts?.('{"a":"x\\u002dy","b":["z",{"c":"w"}],"n":1}')).toEqual(['x-y', 'z', 'w'])
    expect(texts?.('plain text')).toEqual([])
    expect(texts?.('{broken')).toEqual([])
  })

  test('N85: a JSON error keeps its kind and gets the signal or read error beside it', () => {
    const base = { stdout: JSON.stringify({ error: { kind: 'auth', message: 'not authorized' } }), stderr: '', isTimedOut: false, isStoppedByLimit: false }
    expect(BACKENDS.werkbank.parse({ ...base, signal: 'SIGTERM' }).error).toEqual({ kind: 'auth', message: 'not authorized · ended by signal SIGTERM' })
    expect(BACKENDS.werkbank.parse({ ...base, streamError: 'EPIPE' }).error).toEqual({ kind: 'auth', message: 'not authorized · reading the output failed: EPIPE' })
    expect(BACKENDS.werkbank.parse({ ...base, exitCode: 2 }).error).toEqual({ kind: 'auth', message: 'not authorized' })
  })

  test('N87: JSON-escaped key markers count like plain ones', () => {
    const esc = (s: string) => s.replace(/-/g, '\\u002d')
    const oneLine = `{"detail":"${esc('-----BEGIN RSA PRIVATE KEY-----')}\\nescapedBodyLine\\n${esc('-----END RSA PRIVATE KEY-----')}","x":1}`
    expect(redact(oneLine)).not.toContain('escapedBodyLine')
    const f = privateKeyFilter()
    expect([esc('-----BEGIN EC PRIVATE KEY-----'), 'escapedBodyLine', esc('-----END EC PRIVATE KEY-----'), 'after'].map(f)).toEqual([REDACTED_KEY_LINE, undefined, undefined, 'after'])
  })

  test('N90: a job id of only spaces is no job id', () => {
    const o = BACKENDS.werkbank.parse(done(JSON.stringify(job({ jobId: '   ' }))))
    expect(o.remote).toBeUndefined()
    expect(o.error).toEqual({ kind: 'cli', message: 'werkbank-relay reported no jobId' })
  })

  test('N91: a sent session id that is no usable text is rejected; a missing one is not', () => {
    const p = (o: Record<string, unknown>) => BACKENDS.werkbank.parse(done(JSON.stringify(job(o)))).isSessionRejected
    expect(p({ sessionId: '' })).toBe(true)
    expect(p({ sessionId: 5 })).toBe(true)
    // N224: null is a missing session id, not a rejected one
    expect(p({ sessionId: null })).toBeUndefined()
    expect(p({})).toBeUndefined()
  })

  test('N224: the real werkbank-relay output with its null fields', () => {
    // exactly what werkbank-relay.exe prints when its token file is missing (exit 2)
    const authFail =
      '{"jobId":null,"state":null,"answer":"","sessionId":null,"usage":null,"branch":null,"commits":null,"changedFiles":null,"verify":null,"error":{"kind":"auth","message":"Token-Datei fehlt: C:/nope/x.token."}}'
    const a = BACKENDS.werkbank.parse(done(authFail, 2))
    expect(a.error?.kind).toBe('auth')
    expect(a.error?.message).not.toContain('malformed')
    expect(a.isSessionRejected).toBeUndefined()
    // a done job as the real program writes it: every field, the empty ones null
    const ok = BACKENDS.werkbank.parse(
      done(JSON.stringify(job({ error: null, sessionId: null, verify: { command: 'npm test', exitCode: 0, tests: { total: 3, passed: 3, failed: 0, skipped: null } } }))),
    )
    expect(ok.error).toBeUndefined()
    expect(ok.isSessionRejected).toBeUndefined()
    expect(ok.remote?.state).toBe('done')
    // a job that failed after it was queued: its lists are null, not malformed
    const lost = BACKENDS.werkbank.parse(
      done(JSON.stringify({ jobId: 'wb-1', state: null, answer: '', sessionId: null, usage: null, branch: null, commits: null, changedFiles: null, verify: null, error: { kind: 'network', message: 'gone' } }), 2),
    )
    expect(lost.error?.kind).toBe('network')
    expect(lost.remote?.isFileListMalformed).toBeUndefined()
    expect(lost.remote?.changedFiles).toBeUndefined()
  })

  test('N93: every job dropped for its role or run is counted', () => {
    const j = (role: unknown, run?: unknown) => ({ id: `j_${String(role)}`, role, task: 't', enqueuedAt: 'x', state: 'queued', ...(run !== undefined ? { run } : {}) })
    const l = loadQueue(JSON.stringify({ version: 1, jobs: [j(5), j('../../x'), j('ok', -1), j('fine', 1)] }), undefined) as ReturnType<typeof loadQueue> & { dropped?: number }
    expect(l.queue.jobs.map(x => x.role)).toEqual(['fine'])
    expect(l.dropped).toBe(3)
  })

  test('werkbank ignores effort and isolation, nothing else', () => {
    expect(ignoredRules('werkbank', { effort: 'high', allowedTools: ['Read'], disallowedTools: ['WebFetch'], isolation: 'worktree' })).toEqual(['effort', 'isolation'])
    expect(ignoredRules('werkbank', { effort: '', allowedTools: ['Read'], disallowedTools: [], isolation: 'shared' })).toEqual([])
    expect(BACKENDS.werkbank.capabilities).toEqual({ budgetUsd: false, presetSessionId: false, inProcessOwnsGuard: false, sandbox: false, usage: 'both', streamsEvents: true })
    expect(BACKENDS.werkbank.onLine).toBeUndefined()
  })
})

describe('codex and opencode, Nachtrag 2i (ninth Codex review)', () => {
  test('N113: an error event keeps its kind beside a signal or a read error, on both backends', () => {
    const cases = [
      { id: 'codex' as const, stdout: jsonl({ type: 'turn.failed', error: { message: '401 Unauthorized: please login' } }), kind: 'auth', text: '401 Unauthorized: please login' },
      { id: 'opencode' as const, stdout: jsonl({ type: 'error', error: { message: 'Model not found: x' } }), kind: 'model', text: 'Model not found: x' },
    ]
    for (const c of cases) {
      const base = { stdout: c.stdout, stderr: '', isTimedOut: false, isStoppedByLimit: false }
      expect(BACKENDS[c.id].parse({ ...base, signal: 'SIGTERM' }).error).toEqual({ kind: c.kind, message: `${c.text} · ended by signal SIGTERM` })
      expect(BACKENDS[c.id].parse({ ...base, streamError: 'EPIPE' }).error).toEqual({ kind: c.kind, message: `${c.text} · reading the output failed: EPIPE` })
    }
  })
})

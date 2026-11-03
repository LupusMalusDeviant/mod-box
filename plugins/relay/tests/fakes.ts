// Fake worker CLIs for the relay tests (contract 0001, 10.1). `claude plugin
// test` starts no real processes, so these answer `process.spawn` and
// `process.run` the way claude, codex, opencode, ollama and git would.
import { mock } from 'claude-code/testing'

export type Scenario =
  | 'ok'
  | 'no-packet'
  | 'error'
  | 'auth'
  | 'session-not-found'
  | 'crash'
  | 'hang'
  | 'slow-tokens'
  | 'write-outside'
  | 'commit'

export type Call = { argv: string[]; cwd?: string; env: Record<string, string>; input?: string }

export const PACKET = (summary = 'Did the task.') =>
  ['## Work', 'Done.', '```relay', JSON.stringify({ status: 'done', summary, artifacts: [{ path: 'src/a.ts', change: 'modified' }], sections: ['Work'] }), '```'].join('\n')

const NL = '\n'
const jsonl = (...events: unknown[]) => events.map(e => JSON.stringify(e)).join(NL) + NL

export const CWD = '/w'

// Paths as the plugin names them: the kit resolves relative ones against the
// plugin's folder, absolute ones keep /w.
export const rel = (p: unknown) =>
  String(p)
    .split(String.fromCharCode(92))
    .join('/')
    .replace(/^[A-Za-z]:/, '')
    .replace(/^.*\/plugins\/relay\//, '')
    .replace(/^\/w\//, '')
    .replace(/^\.\//, '')

export type World = ReturnType<typeof fakeWorld>

export function fakeWorld(on: any, init: { files?: Record<string, string>; store?: Record<string, unknown>; isGit?: boolean } = {}) {
  const clock = mock.clock(on)
  mock.store(on, init.store)
  const files = new Map<string, string>(Object.entries(init.files ?? {}))
  const spawns: Call[] = []
  const runs: Call[] = []
  const submitted: string[] = []
  const toasts: string[] = []
  const scenarios: Scenario[] = []
  let fallback: Scenario = 'ok'
  const git = {
    isRepo: init.isGit ?? true,
    head: 'aaa',
    status: [] as { code: string; path: string; hash: string }[],
    committed: [] as string[],
  }
  const ollama = { answer: JSON.stringify({ status: 'done', summary: 'Built by ollama.' }), exitCode: 0 }
  let threads = 0

  on('session.id', () => ({ value: 's1' }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's1', cwd: e.cwd }))
  on('env.get', () => ({ value: undefined }))
  const tools: string[] = []
  on('tool.register', (_$: any, e: any) => (tools.push(String(e.name)), { value: {} }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_$: any, e: any) => (toasts.push(String(e.text ?? e.message ?? '')), { value: undefined }))
  on('prompt.submit', (_$: any, e: any) => (submitted.push(e.text), { text: e.text }))
  on('session.append', () => ({ value: undefined }))
  on('model.complete', () => ({
    value: { isAnswered: true, text: JSON.stringify({ status: 'done', summary: 'Built by haiku.' }), usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  }))
  on('fs.exists', (_$: any, e: any) => {
    const p = rel(e.path)
    return { value: files.has(p) || [...files.keys()].some(k => k.startsWith(`${p}/`)) || (p === '.git' && git.isRepo) }
  })
  on('fs.read', (_$: any, e: any) => (files.has(rel(e.path)) ? { value: files.get(rel(e.path)) } : { deny: 'no such file' }))
  on('fs.write', (_$: any, e: any) => (files.set(rel(e.path), e.text), { value: undefined }))

  const ok = (stdout = '', exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', (_$: any, e: any) => {
    const argv = [...e.argv] as string[]
    runs.push({ argv, cwd: e.init?.cwd, env: e.init?.env ?? {}, input: e.init?.stdin })
    const [bin, ...args] = argv
    if (args[0] === '--version') return ok(`${bin} 0.0.0-test`)
    if (bin === 'ollama') return ok(ollama.answer, ollama.exitCode)
    if (bin !== 'git') return ok('', 1)
    if (!git.isRepo) return ok('', 128, 'not a git repository')
    const sub = args[0]
    if (sub === 'rev-parse' && args[1] === '--is-inside-work-tree') return ok('true\n')
    if (sub === 'rev-parse' && args[1] === 'HEAD') return ok(`${git.head}\n`)
    if (sub === 'rev-parse') return ok('', 1)
    if (sub === 'status') return ok(git.status.map(s => `${s.code} ${s.path}\0`).join(''))
    if (sub === 'hash-object') {
      const paths = String(e.init?.stdin ?? '').split('\n').filter(Boolean)
      return ok(paths.map(p => git.status.find(s => s.path === p)?.hash ?? 'h0').join('\n') + '\n')
    }
    if (sub === 'diff') return ok(git.committed.map(p => `M\0${p}\0`).join(''))
    if (sub === 'worktree') {
      // worktree add <path> <branch> | worktree add -b <branch> <path>
      const path = rel(args[2] === '-b' ? args[4] : args[2])
      files.set(`${path}/.git`, 'gitdir: x')
      return ok(`Preparing worktree ${path}`)
    }
    return ok('')
  })

  on('process.spawn', async function* (_$: any, e: any) {
    const argv = [...e.argv] as string[]
    spawns.push({ argv, cwd: e.cwd, env: e.env ?? {}, input: e.input })
    const scenario = scenarios.shift() ?? fallback
    const cli = String(argv[0]).replace(/^.*[\\/]/, '').replace(/\.(exe|cmd)$/, '')
    if (scenario === 'write-outside') git.status.push({ code: '??', path: 'other/x.md', hash: 'h1' })
    if (scenario === 'commit') {
      git.head = 'bbb'
      git.committed.push('docs/c.md')
    }
    if (scenario === 'crash') return { value: { code: 2, signal: null } }
    if (scenario === 'hang') {
      for (;;) {
        await clock.sleep(1000)
        yield { stream: 'stderr', text: '.' }
      }
    }
    const answer = scenario === 'no-packet' ? 'Plain prose, no packet.' : PACKET()
    if (cli === 'claude') {
      if (scenario === 'error') return yield* out(JSON.stringify({ is_error: true, subtype: 'error_max_budget_usd', result: answer, session_id: 'c-1', num_turns: 2, total_cost_usd: 2 }), 0)
      if (scenario === 'session-not-found') return yield* out('', 1, 'No conversation found with session ID')
      return yield* out(JSON.stringify({ result: answer, session_id: argv[argv.indexOf('--session-id') + 1] || argv[argv.indexOf('--resume') + 1], num_turns: 3, total_cost_usd: 0.1 }), 0)
    }
    if (cli === 'codex') {
      const isResume = argv[2] === 'resume'
      const thread = isResume ? argv[4] : `t-${++threads}`
      if (scenario === 'session-not-found') return yield* out(jsonl({ type: 'error', message: `thread ${thread} not found` }), 1)
      if (scenario === 'auth') return yield* out(jsonl({ type: 'thread.started', thread_id: thread }, { type: 'turn.failed', error: { message: '401 Unauthorized: please login' } }), 1)
      yield { stream: 'stdout', text: jsonl({ type: 'thread.started', thread_id: thread }) }
      if (scenario === 'slow-tokens') {
        for (;;) {
          await clock.sleep(1000)
          yield { stream: 'stdout', text: jsonl({ type: 'turn.completed', usage: { input_tokens: 9000, cached_input_tokens: 0, output_tokens: 1000, reasoning_output_tokens: 0 } }) }
        }
      }
      return yield* out(
        jsonl(
          { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: answer } },
          { type: 'turn.completed', usage: { input_tokens: 48200, cached_input_tokens: 31000, output_tokens: 3100, reasoning_output_tokens: 500 } },
        ),
        0,
      )
    }
    if (cli === 'opencode') {
      const i = argv.indexOf('--session')
      const sid = i >= 0 ? argv[i + 1] : 'ses_abc'
      if (scenario === 'error') return yield* out(jsonl({ type: 'error', sessionID: sid, error: { message: 'Model not found: nope' } }), 1)
      return yield* out(
        jsonl(
          { type: 'step_start', sessionID: sid, part: { type: 'step-start' } },
          { type: 'text', sessionID: sid, part: { type: 'text', text: answer } },
          { type: 'step_finish', sessionID: sid, part: { type: 'step-finish', reason: 'stop', cost: 0, tokens: { input: 12400, output: 1800, reasoning: 0, cache: { read: 0, write: 0 } } } },
        ),
        0,
      )
    }
    return { value: { code: 127, signal: null } }
  })

  async function* out(stdout: string, code: number, stderr = '') {
    if (stdout) yield { stream: 'stdout', text: stdout }
    if (stderr) yield { stream: 'stderr', text: stderr }
    return { value: { code, signal: null } }
  }

  // Lets detached runs go on until `done` holds (or gives up).
  async function until(done: () => boolean, tries = 200) {
    for (let i = 0; i < tries && !done(); i++) await clock.settle()
    return done()
  }

  return {
    clock,
    files,
    spawns,
    runs,
    submitted,
    toasts,
    git,
    ollama,
    until,
    // Scenarios for the next spawns, in order; the rest use `fallback`.
    play: (...s: Scenario[]) => scenarios.push(...s),
    always: (s: Scenario) => {
      fallback = s
    },
    queueFile: () => JSON.parse(files.get('.relay/queue.json') ?? '{"jobs":[]}') as { owner?: { session: string }; jobs: { role: string; state: string }[] },
    // True when relay is the plugin under test. `claude plugin test .` at the
    // repository root tests the Mod Box instead, where relay is not loaded;
    // CI runs `claude plugin test plugins/relay` for these tests.
    start: async ($: any) => {
      await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
      return tools.includes('worker_send')
    },
    send: ($: any, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__relay__worker_send', ...input }),
    status: async ($: any) => String((await $.tool.call({ tool: 'mcp__relay__worker_status' })).result),
  }
}

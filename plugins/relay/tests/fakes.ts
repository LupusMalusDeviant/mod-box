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
  // waits until the test calls releaseHeld(), then answers like ok
  | 'held'
  // answers with credentials in every field it has (events, answer, stderr)
  | 'leak'
  // fails with credentials in the error message and on stderr
  | 'leak-error'

export type Call = { argv: string[]; cwd?: string; env: Record<string, string>; input?: string; attachment?: string }

// Placeholder credentials (no real ones) the leak scenarios put into every
// output channel, in the forms relay redacts: Authorization header,
// key=value, user:password in a URL.
export const SECRETS = {
  bearer: 'example-bearer-value-0001',
  token: 'example-token-value-0002',
  password: 'example-password-0003',
}

export const PACKET = (summary = 'Did the task.') =>
  ['## Work', 'Done.', '```relay', JSON.stringify({ status: 'done', summary, artifacts: [{ path: 'src/a.ts', change: 'modified' }], sections: ['Work'] }), '```'].join('\n')

const LEAKY_ANSWER = [
  '## Work',
  `Ran: export API_KEY=${SECRETS.token}`,
  '```relay',
  JSON.stringify({
    status: 'done',
    summary: `Deployed with access_token=${SECRETS.token}`,
    facts: [`password: ${SECRETS.password}`],
    risks: [`Authorization: Bearer ${SECRETS.bearer}`],
    sections: ['Work'],
  }),
  '```',
].join('\n')

const NL = '\n'
const jsonl = (...events: unknown[]) => events.map(e => JSON.stringify(e)).join(NL) + NL

export const CWD = '/w'
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

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

type StatusEntry = { code: string; path: string; hash: string; orig?: string }
type Committed = string | { status: string; path: string; from?: string }

export function fakeWorld(
  on: any,
  init: { files?: Record<string, string>; store?: Record<string, unknown>; isGit?: boolean; caseInsensitive?: boolean; env?: Record<string, string> } = {},
) {
  const clock = mock.clock(on)
  mock.store(on, init.store)
  const files = new Map<string, string>(Object.entries(init.files ?? {}))
  const spawns: Call[] = []
  const runs: Call[] = []
  const submitted: string[] = []
  const toasts: string[] = []
  const scenarios: Scenario[] = []
  const envAsked: string[] = []
  // Every text that landed in queue.json, in the order the writes finished.
  const landed: string[] = []
  const held: (() => void)[] = []
  const during: ((call: Call) => void)[] = []
  let fallback: Scenario = 'ok'
  const git = {
    isRepo: init.isGit ?? true,
    // '' is an unborn HEAD (no commit yet)
    head: 'aaa',
    status: [] as StatusEntry[],
    committed: [] as Committed[],
    // paths git cannot hash (a submodule folder): hash-object stops there
    unhashable: new Set<string>(),
    // registered worktrees: absolute path → branch ref
    worktrees: new Map<string, string>(),
    worktreeAddError: '',
  }
  // Paths that are links: rel path → where they resolve.
  const links = new Map<string, string>()
  const io = {
    failRead: (_path: string) => false,
    failWrite: (_path: string) => false,
    // clock ms a write waits before it lands
    writeDelay: (_path: string) => 0,
  }
  const ollama = { answer: JSON.stringify({ status: 'done', summary: 'Built by ollama.' }), exitCode: 0 }
  let threads = 0

  // The files map as the filesystem sees it: exact, or ignoring case.
  const keyOf = (p: string) => (init.caseInsensitive ? ([...files.keys()].find(k => k.toLowerCase() === p.toLowerCase()) ?? p) : p)
  const has = (p: string) => files.has(keyOf(p))
  const isDir = (p: string) =>
    p === '/w' || p === '' || [...files.keys()].some(k => (init.caseInsensitive ? k.toLowerCase().startsWith(`${p.toLowerCase()}/`) : k.startsWith(`${p}/`)))

  on('session.id', () => ({ value: 's1' }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's1', cwd: e.cwd }))
  on('env.get', (_$: any, e: any) => (envAsked.push(String(e.name)), { value: init.env?.[String(e.name)] }))
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
    return { value: has(p) || isDir(p) || links.has(p) || (p === '.git' && git.isRepo) }
  })
  on('fs.stat', (_$: any, e: any) => {
    const p = rel(e.path)
    const link = links.get(p)
    if (link) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: true, ...(e.resolve ? { realPath: link } : {}) } }
    if (!has(p) && !isDir(p)) return { deny: 'ENOENT: no such file or directory' }
    const real = p === '/w' || p === '' ? '/w' : `/w/${p}`
    return { value: { kind: has(p) ? 'file' : 'dir', size: 0, mtimeMs: 0, isLink: false, ...(e.resolve ? { realPath: real } : {}) } }
  })
  on('fs.read', (_$: any, e: any) => {
    const p = rel(e.path)
    if (io.failRead(p)) return { deny: 'EIO: i/o error, read' }
    return has(p) ? { value: files.get(keyOf(p)) } : { deny: 'no such file' }
  })
  on('fs.write', async (_$: any, e: any) => {
    const p = rel(e.path)
    if (io.failWrite(p)) return { deny: 'ENOSPC: no space left on device, write' }
    const ms = io.writeDelay(p)
    if (ms > 0) await clock.sleep(ms)
    files.set(keyOf(p), e.text)
    if (p === '.relay/queue.json') landed.push(e.text)
    return { value: undefined }
  })

  const ok = (stdout = '', exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
  const hashOf = (p: string) => git.status.find(s => s.path === p)?.hash ?? 'h0'
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
    if (sub === 'rev-parse' && args[1] === 'HEAD') return git.head ? ok(`${git.head}\n`) : ok('HEAD\n', 128, "fatal: ambiguous argument 'HEAD': unknown revision")
    if (sub === 'rev-parse') return ok('', 1)
    if (sub === 'status') return ok(git.status.map(s => `${s.code} ${s.path}\0${s.orig ? `${s.orig}\0` : ''}`).join(''))
    if (sub === 'hash-object') {
      if (args[1] === '-t' && args[2] === 'tree') return ok(`${EMPTY_TREE}\n`)
      if (args[1] === '--') {
        const p = args[2] ?? ''
        return git.unhashable.has(p) ? ok('', 128, `fatal: Unable to hash ${p}`) : ok(`${hashOf(p)}\n`)
      }
      // --stdin-paths: one path per line, stops at the first it cannot hash
      const out: string[] = []
      for (const p of String(e.init?.stdin ?? '').split('\n').filter(Boolean)) {
        if (git.unhashable.has(p)) return ok(out.map(h => `${h}\n`).join(''), 128, `fatal: Unable to hash ${p}`)
        out.push(hashOf(p))
      }
      return ok(out.map(h => `${h}\n`).join(''))
    }
    if (sub === 'diff') {
      const [from, to] = args.slice(-2)
      if (!from || !to) return ok('', 128, 'fatal: bad revision')
      return ok(git.committed.map(c => (typeof c === 'string' ? `M\0${c}\0` : c.from ? `${c.status}\0${c.from}\0${c.path}\0` : `${c.status}\0${c.path}\0`)).join(''))
    }
    if (sub === 'worktree' && args[1] === 'list') {
      const all: [string, string][] = [['/w', 'refs/heads/main'], ...git.worktrees]
      return ok(all.map(([p, b]) => `worktree ${p}\0HEAD ${git.head || '0'.repeat(40)}\0${b ? `branch ${b}\0` : 'detached\0'}\0`).join(''))
    }
    if (sub === 'worktree') {
      if (git.worktreeAddError) return ok('', 128, git.worktreeAddError)
      // worktree add <path> <branch> | worktree add -b <branch> <path>
      const isNewBranch = args[2] === '-b'
      const path = rel(isNewBranch ? args[4] : args[2])
      const branch = args[3]
      files.set(`${path}/.git`, 'gitdir: x')
      git.worktrees.set(`/w/${path}`, `refs/heads/${branch}`)
      return ok(`Preparing worktree ${path}`)
    }
    return ok('')
  })

  on('process.spawn', async function* (_$: any, e: any) {
    const argv = [...e.argv] as string[]
    const call: Call = { argv, cwd: e.cwd, env: e.env ?? {}, input: e.input }
    // What opencode would read through --file: absolute, or against its cwd.
    const fi = argv.indexOf('--file')
    if (fi >= 0) {
      const raw = String(argv[fi + 1])
      const p = /^([A-Za-z]:)?[\\/]/.test(raw) ? rel(raw) : rel(`${e.cwd}/${raw}`)
      call.attachment = has(p) ? files.get(keyOf(p)) : undefined
    }
    spawns.push(call)
    for (const fn of during.splice(0)) fn(call)
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
    if (scenario === 'held') await new Promise<void>(r => held.push(r))
    const answer = scenario === 'no-packet' ? 'Plain prose, no packet.' : scenario === 'leak' ? LEAKY_ANSWER : PACKET()
    const leakErr = `401 Unauthorized: Authorization: Bearer ${SECRETS.bearer}`
    const leakStderr = `warning: GITHUB_TOKEN=${SECRETS.token}`
    if (cli === 'claude') {
      if (scenario === 'error') return yield* out(JSON.stringify({ is_error: true, subtype: 'error_max_budget_usd', result: answer, session_id: 'c-1', num_turns: 2, total_cost_usd: 2 }), 0)
      if (scenario === 'session-not-found') return yield* out('', 1, 'No conversation found with session ID')
      if (scenario === 'leak-error') return yield* out('', 1, `${leakErr}\n${leakStderr}`)
      return yield* out(JSON.stringify({ result: answer, session_id: argv[argv.indexOf('--session-id') + 1] || argv[argv.indexOf('--resume') + 1], num_turns: 3, total_cost_usd: 0.1 }), 0)
    }
    if (cli === 'codex') {
      const isResume = argv[2] === 'resume'
      const thread = isResume ? argv[4] : `t-${++threads}`
      if (scenario === 'session-not-found') return yield* out(jsonl({ type: 'error', message: `thread ${thread} not found` }), 1)
      if (scenario === 'auth') return yield* out(jsonl({ type: 'thread.started', thread_id: thread }, { type: 'turn.failed', error: { message: '401 Unauthorized: please login' } }), 1)
      if (scenario === 'leak-error') return yield* out(jsonl({ type: 'thread.started', thread_id: thread }, { type: 'turn.failed', error: { message: leakErr } }), 1, leakStderr)
      yield { stream: 'stdout', text: jsonl({ type: 'thread.started', thread_id: thread }) }
      if (scenario === 'slow-tokens') {
        for (;;) {
          await clock.sleep(1000)
          yield { stream: 'stdout', text: jsonl({ type: 'turn.completed', usage: { input_tokens: 9000, cached_input_tokens: 0, output_tokens: 1000, reasoning_output_tokens: 0 } }) }
        }
      }
      if (scenario === 'leak') {
        yield {
          stream: 'stdout',
          text: jsonl(
            { type: 'item.started', item: { id: 'c1', type: 'command_execution', command: `curl -H "Authorization: Bearer ${SECRETS.bearer}" https://api.example.com` } },
            { type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: `git push https://bot:${SECRETS.password}@example.com/r.git` } },
          ),
        }
      }
      return yield* out(
        jsonl(
          { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: answer } },
          { type: 'turn.completed', usage: { input_tokens: 48200, cached_input_tokens: 31000, output_tokens: 3100, reasoning_output_tokens: 500 } },
        ),
        0,
        scenario === 'leak' ? leakStderr : '',
      )
    }
    if (cli === 'opencode') {
      const i = argv.indexOf('--session')
      const sid = i >= 0 ? argv[i + 1] : 'ses_abc'
      if (scenario === 'error') return yield* out(jsonl({ type: 'error', sessionID: sid, error: { message: 'Model not found: nope' } }), 1)
      if (scenario === 'leak-error') return yield* out(jsonl({ type: 'error', sessionID: sid, error: { message: leakErr } }), 1, leakStderr)
      return yield* out(
        jsonl(
          { type: 'step_start', sessionID: sid, part: { type: 'step-start' } },
          ...(scenario === 'leak' ? [{ type: 'tool_use', sessionID: sid, part: { tool: 'bash', state: { input: { command: `echo password=${SECRETS.password}` } } } }] : []),
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

  // Starts the session only; the queue claim still waits for the clock.
  const boot = async ($: any) => {
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
  }

  // Whether relay is the plugin under test: it asks for RELAY_WORKER at every
  // session start. `claude plugin test .` at the repository root tests the Mod
  // Box instead, where relay is not loaded; CI runs `claude plugin test
  // plugins/relay` for these tests, and there the tools must register.
  const isRelayLoaded = () => envAsked.includes('RELAY_WORKER')
  const requireTools = () => {
    if (!isRelayLoaded()) return false
    for (const t of ['worker_send', 'worker_status', 'worker_expand']) {
      if (!tools.includes(t)) throw new Error(`relay is loaded but did not register ${t} (registered: ${tools.join(', ') || 'none'})`)
    }
    return true
  }

  return {
    clock,
    files,
    spawns,
    runs,
    submitted,
    toasts,
    git,
    links,
    io,
    landed,
    ollama,
    until,
    // Scenarios for the next spawns, in order; the rest use `fallback`.
    play: (...s: Scenario[]) => scenarios.push(...s),
    always: (s: Scenario) => {
      fallback = s
    },
    // Runs `fn` when the next worker starts (to change git's answers as a
    // worker would).
    during: (fn: (call: Call) => void) => during.push(fn),
    releaseHeld: () => held.splice(0).forEach(r => r()),
    heldCount: () => held.length,
    queueFile: () =>
      JSON.parse(files.get('.relay/queue.json') ?? '{"jobs":[]}') as {
        owner?: { session: string; token?: string; heartbeatAt?: string }
        jobs: { id: string; role: string; state: string; backend?: string; model?: string }[]
      },
    boot,
    // Session start plus the queue claim. False only when relay is not the
    // plugin under test; a loaded relay that fails to register throws.
    start: async ($: any) => {
      await boot($)
      if (!isRelayLoaded()) return false
      await clock.advance(2_000)
      await clock.settle()
      return requireTools()
    },
    // Whether relay is loaded at all (a worker session registers no tools).
    isRelay: () => isRelayLoaded(),
    // For tests that drive the claim themselves (boot, then advance).
    isRelayLoaded: () => requireTools(),
    send: ($: any, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__relay__worker_send', ...input }),
    status: async ($: any) => String((await $.tool.call({ tool: 'mcp__relay__worker_status' })).result),
  }
}

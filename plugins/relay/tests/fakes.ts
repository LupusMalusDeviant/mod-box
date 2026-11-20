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
  // a done packet, then an error event and exit 1 (codex, opencode)
  | 'done-then-error'
  // a done packet, no error event, but exit 1
  | 'answer-exit1'
  // werkbank-relay: the job's end states (contract 0002, section 1)
  | 'red'
  | 'needs-approval'
  | 'timed-out'
  | 'limit'
  | 'failed'
  | 'cancelled'
  // werkbank-relay: the job ran fresh on another worker (new sessionId)
  | 'session-moved'
  // werkbank-relay: the program itself could not work (exit 2, error only)
  | 'error-auth'
  | 'error-network'
  | 'error-repo'
  | 'error-budget'
  // werkbank-relay: text instead of JSON on stdout
  | 'not-json'
  // werkbank-relay: a red job whose answer is prose without a packet
  | 'red-prose'
  // codex (stdout) and werkbank-relay (stderr): a private key printed over
  // several lines, its body inside an event, then an ok answer
  | 'key-lines'
  // werkbank-relay: two progress lines a clock tick apart, then waits for
  // releaseHeld() before it answers like ok
  | 'progress-held'
  // werkbank-relay: all progress at once, then silent until releaseHeld()
  | 'progress-quiet'
  // werkbank-relay: a done object, then the process is killed (no exit code)
  | 'signal-after-done'
  // werkbank-relay: commits with entries that are no commit ids
  | 'bad-commits'
  // werkbank-relay: a done job whose error field is a string, not an object
  | 'error-malformed'
  // werkbank-relay: progress on stderr, then killed before any JSON
  | 'killed-early'
  // werkbank-relay: a session id that looks like a credential
  | 'session-token'
  // werkbank-relay: a packet with status ["done"] and a write outside owns
  | 'status-array'
  // werkbank-relay: an answer with a key whose END is of another kind
  | 'key-mismatch'
  // codex: key markers JSON-escaped, each in its own event, then an ok answer
  | 'key-escaped'
  // werkbank-relay: a whole JSON-escaped key in one stderr line, then exit 1
  // without JSON on stdout
  | 'key-escaped-stderr'
  // werkbank-relay: a failed job (repo error), then killed by SIGTERM
  | 'failed-signal'
  // werkbank-relay: a whole key in one stderr JSON line, a letter of its
  // markers escaped (BEGIN), then exit 1 without JSON on stdout
  | 'key-letter-stderr'
  // werkbank-relay: a packet whose risks hold a key's start, body and end
  | 'key-split-risks'
  // werkbank-relay: a packet whose JSON holds a key's start in decisions, its
  // body in summary and its end in risks (N100)
  | 'key-across-fields'
  // codex: one event with a key's start, body and end in three fields; the
  // shown field holds only the body (N101)
  | 'key-fields-event'
  // werkbank-relay: a key opens on stderr and never ends; the JSON error
  // carries the body (N101)
  | 'key-open-error'
  // codex: an error event, then killed by SIGTERM (N106)
  | 'error-signal'
  // werkbank-relay: a key opens in the answer's prose and goes on in the
  // packet's summary (N107)
  | 'key-into-packet'
  // codex: a key opens on stderr, its body is an error event on stdout (N114)
  | 'key-stderr-event'
  // werkbank-relay: a key opens on stderr, its body is in the answer (N114)
  | 'key-stderr-answer'
  // werkbank-relay: a JSON example in the prose, then a key around the relay
  // block; the redaction removes the block (N117)
  | 'key-fence-example'
  // werkbank-relay: BEGIN on stderr, the body in the answer, END on stderr
  // after it (N120)
  | 'key-closed-around-answer'
  // codex: BEGIN on stderr, the body as an error event, END on stderr (N121)
  | 'key-closed-around-event'
  // werkbank-relay: an example relay block marked done, then a key around the
  // real one (N123)
  | 'key-example-block'
  // werkbank-relay: a key marker in a stdout field, the body as the error
  // message (N127)
  | 'key-marker-error'
  // werkbank-relay: BEGIN on stdout without its line end, the body on stderr
  // before the stdout line ends (N128)
  | 'key-fragment'
  // werkbank-relay: stdout opens a key, stderr gets the body without its line
  // end, stdout closes the key, then stderr ends the line (N134)
  | 'key-split-fragment'
  // werkbank-relay: a key marker in the answer, the body as verify.command
  // (N135)
  | 'key-verify-command'
  // werkbank-relay: a key marker on stderr, the body in sessionId and
  // usage.model (N141)
  | 'key-session-model'
  // werkbank-relay: a quoted Authorization value on stderr (N142)
  | 'quoted-auth'
  // werkbank-relay: quoted Authorization values with an escaped quote inside,
  // plain and as JSON (N149)
  | 'quoted-auth-escaped'
  // werkbank-relay: a key marker on stderr, placeholders in jobId and state
  // (N150)
  | 'key-bad-state'
  // werkbank-relay: a whole answer, then the stream read fails with an error
  // that holds a key marker (N155)
  | 'key-read-error'
  // werkbank-relay: once-escaped JSON on stderr, a key value with a quote
  // inside and an Authorization value ending in a backslash (N156)
  | 'quoted-escaped-json'
  // werkbank-relay: once-escaped JSON on stderr whose key value holds a
  // \ before a quote (N160)
  | 'quoted-unicode-escape'
  // werkbank-relay: once-escaped JSON on stderr whose values are quoted with
  // " (N166)
  | 'quoted-unicode-quotes'
  // werkbank-relay: a failed job whose usage.model holds a line break and a
  // Status: done line (N168)
  | 'multiline-model'
  // werkbank-relay: a job in a state relay does not know, with an error (N171)
  | 'unknown-state'
  // werkbank-relay: a key marker on stderr, changed files, no valid commit id
  // (N172)
  | 'key-files-no-commit'
  // werkbank-relay: the read fails at once, with no output (a missing
  // executable, N173)
  | 'no-start-read-error'
  // werkbank-relay: a key marker on stderr, then output without JSON (N174)
  | 'key-no-json'
  // werkbank-relay: an unusable file list and only invalid commit ids (N175)
  | 'malformed-both'
  // werkbank-relay: a state of several thousand characters over many lines
  // (N176)
  | 'long-state'
  // werkbank-relay: a job without state, with an error (N177)
  | 'no-state'
  // werkbank-relay: a done job whose state has a line break at its end (N178)
  | 'padded-state'
  // werkbank-relay: a job whose branch and jobId are long and span lines (N179)
  | 'long-branch-job'
  // werkbank-relay: one stderr line, then the read fails (N181)
  | 'read-error-after-output'
  // werkbank-relay: the job id as a whole number, and as a fraction (N183)
  | 'numeric-job'
  | 'fraction-job'
  // werkbank-relay: a credential name escaped as w on stderr (N185)
  | 'escaped-name'
  // werkbank-relay: a packet with an extra numeric password field (N187)
  | 'packet-numeric-password'
  // werkbank-relay: a key marker on stderr, then it hangs (N190)
  | 'key-then-hang'

export type Call = { argv: string[]; cwd?: string; env: Record<string, string>; input?: string; attachment?: string; protocolFile?: string }

// A made-up private key over several lines (no real key), for N51.
export const KEY_LINES = ['-----BEGIN RSA PRIVATE KEY-----', '-----END RSA PRIVATE KEY-----'] as const
export const KEY_BODY = 'MIIEexampleNotARealKeyBody0001'

// What the fake werkbank-relay reports, so tests can change it per world.
export const WERKBANK_JOB = 'wb-20261118-7'
export const WERKBANK_COMMIT = 'abc1234def5678'
// A made-up key (no real one) whose first END is of another kind, for N74.
export const MISMATCHED_BODY = 'afterTheWrongEndNotARealKey0002'
const MISMATCHED_KEY = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIEexample', '-----END EC PRIVATE KEY-----', MISMATCHED_BODY, '-----END RSA PRIVATE KEY-----'].join('\n')

// A made-up session id the redaction would change (no real token), for N72.
export const WERKBANK_TOKEN_SESSION = 'token:abcdef0123456789abcd'

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
  const store = new Map<string, unknown>(Object.entries(init.store ?? {}))
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
    // the project inside its repository: git's top and the project's prefix
    toplevel: '/w',
    prefix: '',
    // git itself fails (not 'not a git repository')
    isBroken: false,
  }
  // Paths that are links: rel path → where they resolve.
  const links = new Map<string, string>()
  const io = {
    failRead: (_path: string) => false,
    // $.store.set rejects this value (N163)
    failStoreSet: (_value: unknown) => false,
    // fs.exists itself fails for this path (N115); a string is its error (N125)
    failExists: (_path: string): boolean | string => false,
    // clock ms an fs.exists waits before it answers (N126)
    existsDelay: (_path: string) => 0,
    // clock ms an fs.stat waits before it answers (N116)
    statDelay: (_path: string) => 0,
    failWrite: (_path: string) => false,
    // clock ms a write waits before it lands
    writeDelay: (_path: string) => 0,
    // a session.append (notifyMode note) that is refused
    failAppend: () => false,
    // $.model.complete (the Haiku fallback) rejects
    failModel: false,
    // runs after a tool registered (between the start's queue read and the claim)
    afterRegister: (_name: string) => {},
  }
  const ollama = { answer: JSON.stringify({ status: 'done', summary: 'Built by ollama.' }), exitCode: 0 }
  let threads = 0

  // The files map as the filesystem sees it: exact, or ignoring case.
  const keyOf = (p: string) => (init.caseInsensitive ? ([...files.keys()].find(k => k.toLowerCase() === p.toLowerCase()) ?? p) : p)
  const has = (p: string) => files.has(keyOf(p))
  const isDir = (p: string) =>
    p === '/w' || p === '' || [...files.keys()].some(k => (init.caseInsensitive ? k.toLowerCase().startsWith(`${p.toLowerCase()}/`) : k.startsWith(`${p}/`)))

  // the plugin store, kept here so a write can fail (N163)
  on('store.get', (_$: any, e: any) => ({ value: structuredClone(store.get(String(e.key))) }))
  on('store.set', (_$: any, e: any) => {
    if (io.failStoreSet(e.value)) return { deny: 'the store could not be written' }
    store.set(String(e.key), structuredClone(e.value))
    return { value: undefined }
  })
  on('session.id', () => ({ value: 's1' }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's1', cwd: e.cwd }))
  on('env.get', (_$: any, e: any) => (envAsked.push(String(e.name)), { value: init.env?.[String(e.name)] }))
  const tools: string[] = []
  on('tool.register', (_$: any, e: any) => (tools.push(String(e.name)), io.afterRegister(String(e.name)), { value: {} }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_$: any, e: any) => (toasts.push(String(e.text ?? e.message ?? '')), { value: undefined }))
  on('prompt.submit', (_$: any, e: any) => (submitted.push(e.text), { text: e.text }))
  // notifyMode note: an appended packet counts as submitted
  on('session.append', (_$: any, e: any, next: any) => (io.failAppend() ? { deny: 'the session could not be appended to' } : (submitted.push(String(e.message?.content?.[0]?.text ?? '')), next(e))))
  on('model.complete', () => io.failModel ? { deny: 'model unavailable' } : ({
    value: { isAnswered: true, text: JSON.stringify({ status: 'done', summary: 'Built by haiku.' }), usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  }))
  on('fs.exists', async (_$: any, e: any) => {
    const p = rel(e.path)
    const wait = io.existsDelay(p)
    if (wait > 0) await clock.sleep(wait)
    const failed = io.failExists(p)
    if (failed) return { deny: typeof failed === 'string' ? failed : 'EACCES: permission denied, access' }
    return { value: has(p) || isDir(p) || links.has(p) || (p === '.git' && git.isRepo) }
  })
  on('fs.stat', async (_$: any, e: any) => {
    const p = rel(e.path)
    const wait = io.statDelay(p)
    if (wait > 0) await clock.sleep(wait)
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
    if (git.isBroken) return ok('', 1, 'fatal: detected dubious ownership in repository')
    if (!git.isRepo) return ok('', 128, 'fatal: not a git repository (or any of the parent directories): .git')
    const sub = args[0]
    if (sub === 'rev-parse' && args[1] === '--is-inside-work-tree') return ok('true\n')
    if (sub === 'rev-parse' && args[1] === 'HEAD') return git.head ? ok(`${git.head}\n`) : ok('HEAD\n', 128, "fatal: ambiguous argument 'HEAD': unknown revision")
    if (sub === 'rev-parse' && args[1] === '--show-toplevel') return ok(`${git.toplevel}\n`)
    if (sub === 'rev-parse' && args[1] === '--show-prefix') return ok(`${git.prefix}\n`)
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
    // What werkbank-relay would read through --protocol-file.
    const pi = argv.indexOf('--protocol-file')
    if (pi >= 0) {
      const p = rel(String(argv[pi + 1]))
      call.protocolFile = has(p) ? files.get(keyOf(p)) : undefined
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
      // werkbank waits for an hour: one progress line a minute keeps the test fast
      const step = cli === 'werkbank-relay' ? 60_000 : 1000
      for (;;) {
        await clock.sleep(step)
        yield { stream: 'stderr', text: cli === 'werkbank-relay' ? 'running auf fsn1-5\n' : '.' }
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
      if (scenario === 'key-escaped') {
        // the markers JSON-escaped (- for -), each in its own event
        const esc = (s: string) => s.replace(/-/g, '\\u002d')
        const ev = (id: string, text: string) => `{"type":"item.completed","item":{"id":"${id}","type":"agent_message","text":"${text}"}}`
        yield { stream: 'stdout', text: `${ev('e1', esc(KEY_LINES[0]))}\n${ev('e2', KEY_BODY)}\n${ev('e3', esc(KEY_LINES[1]))}\n${ev('e4', 'after the key')}\n` }
      }
      if (scenario === 'key-fields-event') {
        yield { stream: 'stdout', text: jsonl({ type: 'item.completed', item: { a: KEY_LINES[0], id: 'k2', type: 'command_execution', command: KEY_BODY, z: KEY_LINES[1] } }) }
      }
      if (scenario === 'key-closed-around-event') {
        yield { stream: 'stderr', text: `${KEY_LINES[0]}\n` }
        yield { stream: 'stdout', text: jsonl({ type: 'error', message: KEY_BODY }) }
        yield { stream: 'stderr', text: `${KEY_LINES[1]}\n` }
        return { value: { code: 1, signal: null } }
      }
      if (scenario === 'key-stderr-event') {
        yield { stream: 'stderr', text: `${KEY_LINES[0]}\n` }
        yield { stream: 'stdout', text: jsonl({ type: 'error', message: KEY_BODY }) }
        return { value: { code: 1, signal: null } }
      }
      if (scenario === 'error-signal') {
        yield { stream: 'stdout', text: jsonl({ type: 'error', message: 'stream disconnected before completion' }) }
        return { value: { code: null, signal: 'SIGTERM' } }
      }
      if (scenario === 'key-lines') {
        yield {
          stream: 'stdout',
          text: `${KEY_LINES[0]}\n${jsonl({ type: 'item.completed', item: { id: 'k1', type: 'command_execution', command: KEY_BODY } })}${KEY_LINES[1]}\n`,
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
          ...(scenario === 'done-then-error' ? [{ type: 'error', message: 'stream disconnected before completion' }] : []),
        ),
        scenario === 'done-then-error' || scenario === 'answer-exit1' ? 1 : 0,
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
          { type: 'step_start', sessionID: sid, part: { type: 'step-start', ...(scenario === 'leak' ? { model: `ollama/m access_token=${SECRETS.token}` } : {}) } },
          ...(scenario === 'leak' ? [{ type: 'tool_use', sessionID: sid, part: { tool: 'bash', state: { input: { command: `echo password=${SECRETS.password}` } } } }] : []),
          { type: 'text', sessionID: sid, part: { type: 'text', text: answer } },
          { type: 'step_finish', sessionID: sid, part: { type: 'step-finish', reason: 'stop', cost: 0, tokens: { input: 12400, output: 1800, reasoning: 0, cache: { read: 0, write: 0 } } } },
          ...(scenario === 'done-then-error' ? [{ type: 'error', sessionID: sid, error: { message: 'provider connection reset' } }] : []),
        ),
        scenario === 'done-then-error' || scenario === 'answer-exit1' ? 1 : 0,
      )
    }
    if (cli === 'werkbank-relay') {
      const arg = (flag: string) => {
        const i = argv.indexOf(flag)
        return i >= 0 ? argv[i + 1] : undefined
      }
      const role = arg('--role') ?? 'x'
      const progress = 'queued\nrunning auf fsn1-5\nverifying\n'
      const fail = (kind: string, message: string) => out(JSON.stringify({ error: { kind, message } }), 2, `${progress}error: ${message}\n`)
      if (scenario === 'error-auth') return yield* fail('auth', '401: relay token rejected')
      if (scenario === 'error-network') return yield* fail('network', 'Leitstand http://100.73.150.87:5080 not reachable')
      if (scenario === 'error-repo') return yield* fail('repo', 'git@github.com:o/n.git is not in the repo list')
      if (scenario === 'error-budget') return yield* fail('budget', 'relay day budget used up (8 jobs)')
      if (scenario === 'not-json') return yield* out('Unhandled exception. System.Exception: boom\n', 1, 'boom\n')
      if (scenario === 'key-escaped-stderr') {
        const esc = (s: string) => s.replace(/-/g, '\\u002d')
        yield { stream: 'stderr', text: `{"level":"error","detail":"${esc(KEY_LINES[0])}\\n${KEY_BODY}\\n${esc(KEY_LINES[1])}"}\n` }
        return { value: { code: 1, signal: null } }
      }
      if (scenario === 'key-letter-stderr') {
        const esc = (s: string) => s.replace('BEGIN', '\\u0042EGIN').replace('END', '\\u0045ND')
        yield { stream: 'stderr', text: `{"level":"error","detail":"${esc(KEY_LINES[0])}\\n${KEY_BODY}\\n${esc(KEY_LINES[1])}"}\n` }
        return { value: { code: 1, signal: null } }
      }
      if (scenario === 'key-open-error') {
        return yield* out(JSON.stringify({ error: { kind: 'cli', message: KEY_BODY } }), 2, `queued\n${KEY_LINES[0]}\n`)
      }
      if (scenario === 'key-marker-error') {
        yield { stream: 'stdout', text: JSON.stringify({ jobId: WERKBANK_JOB, state: 'failed', answer: '', note: KEY_LINES[0], sessionId: 'fsn1-5:9b1f', branch: `agent/relay/${role}`, commits: [], changedFiles: [], error: { kind: 'repo', message: KEY_BODY } }) }
        return { value: { code: 1, signal: null } }
      }
      if (scenario === 'key-session-model') {
        yield { stream: 'stderr', text: `${KEY_LINES[0]}\n` }
        yield { stream: 'stdout', text: JSON.stringify({ jobId: WERKBANK_JOB, state: 'done', answer: 'done', sessionId: `fsn1-5:${KEY_BODY}`, usage: { inputTokens: 10, outputTokens: 5, model: KEY_BODY }, branch: `agent/relay/${role}`, commits: [], changedFiles: [] }) }
        return { value: { code: 0, signal: null } }
      }
      if (scenario === 'quoted-auth') {
        yield { stream: 'stderr', text: '{"Authorization": "opaque0value0x8"}\n' }
        yield { stream: 'stdout', text: JSON.stringify({ jobId: WERKBANK_JOB, state: 'done', answer: PACKET(), sessionId: 'fsn1-5:9b1f', branch: `agent/relay/${role}`, commits: [], changedFiles: [] }) }
        return { value: { code: 0, signal: null } }
      }
      if (scenario === 'quoted-auth-escaped') {
        yield { stream: 'stderr', text: 'Authorization: "a\\"opaque0tail0x9"\n{"Authorization": "b\\"opaque0tail0x9"}\n' }
        yield { stream: 'stdout', text: JSON.stringify({ jobId: WERKBANK_JOB, state: 'done', answer: PACKET(), sessionId: 'fsn1-5:9b1f', branch: `agent/relay/${role}`, commits: [], changedFiles: [] }) }
        return { value: { code: 0, signal: null } }
      }
      if (scenario === 'key-read-error') {
        yield { stream: 'stdout', text: JSON.stringify({ jobId: WERKBANK_JOB, state: 'done', answer: PACKET('opaque0answer0x16'), sessionId: 'fsn1-5:9b1f', branch: `agent/relay/${role}`, commits: [], changedFiles: [] }) }
        return { deny: `stream reset ${KEY_LINES[0]}` }
      }
      if (scenario === 'quoted-escaped-json') {
        yield { stream: 'stderr', text: '{"detail":"{\\"api_key\\": \\"opaque0head\\\\\\"opaque0tail0x13\\", \\"next\\": 1}"}\n' }
        yield { stream: 'stderr', text: '{"detail":"{\\"Authorization\\": \\"opaque0auth0x14\\\\\\\\\\", \\"sibling\\": \\"keep0me0x15\\"}"}\n' }
        yield { stream: 'stdout', text: JSON.stringify({ jobId: WERKBANK_JOB, state: 'done', answer: PACKET(), sessionId: 'fsn1-5:9b1f', branch: `agent/relay/${role}`, commits: [], changedFiles: [] }) }
        return { value: { code: 0, signal: null } }
      }
      if (scenario === 'quoted-unicode-escape') {
        const bs = '\\'
        yield { stream: 'stderr', text: `{"detail":"{${bs}"api_key${bs}": ${bs}"opaque0head0x17${bs}u005c${bs}"opaque0tail0x18${bs}", ${bs}"next${bs}": ${bs}"keep0me0x19${bs}"}"}\n` }
        yield { stream: 'stdout', text: JSON.stringify({ jobId: WERKBANK_JOB, state: 'done', answer: PACKET(), sessionId: 'fsn1-5:9b1f', branch: `agent/relay/${role}`, commits: [], changedFiles: [] }) }
        return { value: { code: 0, signal: null } }
      }
      if (scenario === 'quoted-unicode-quotes') {
        const q = '\\u0022'
        yield { stream: 'stderr', text: `{"detail":"{${q}password${q}: ${q}opaque0pw0x20${q}, ${q}next${q}: ${q}keep0me0x21${q}}"}\n` }
        yield { stream: 'stderr', text: `{"detail":"{${q}Authorization${q}: ${q}Bearer opaque0auth0x22${q}, ${q}sibling${q}: 1}"}\n` }
        yield { stream: 'stdout', text: JSON.stringify({ jobId: WERKBANK_JOB, state: 'done', answer: PACKET(), sessionId: 'fsn1-5:9b1f', branch: `agent/relay/${role}`, commits: [], changedFiles: [] }) }
        return { value: { code: 0, signal: null } }
      }
      if (scenario === 'no-start-read-error') return { deny: 'spawn werkbank-relay ENOENT' }
      if (scenario === 'padded-state') {
        yield { stream: 'stdout', text: JSON.stringify({ jobId: WERKBANK_JOB, state: 'done\n', answer: PACKET(), sessionId: 'fsn1-5:9b1f', branch: `agent/relay/${role}`, commits: [], changedFiles: [] }) }
        return { value: { code: 0, signal: null } }
      }
      if (scenario === 'long-branch-job') {
        yield { stream: 'stdout', text: JSON.stringify({ jobId: `job0x25\n${'j'.repeat(300)}`, state: 'done', answer: PACKET(), sessionId: 'fsn1-5:9b1f', branch: `branch0x26\n${'b'.repeat(300)}`, commits: [WERKBANK_COMMIT], changedFiles: [] }) }
        return { value: { code: 0, signal: null } }
      }
      if (scenario === 'escaped-name') {
        yield { stream: 'stderr', text: '{"pass\\u0077ord": "opaque0pw0x28"}\n' }
        yield { stream: 'stdout', text: JSON.stringify({ jobId: WERKBANK_JOB, state: 'done', answer: PACKET(), sessionId: 'fsn1-5:9b1f', branch: `agent/relay/${role}`, commits: [], changedFiles: [] }) }
        return { value: { code: 0, signal: null } }
      }
      if (scenario === 'packet-numeric-password') {
        const answer = ['## Work', 'Done.', '```relay', '{"status":"done","summary":"Did it.","facts":["fact0x27"],"sections":["Work"],"password":123}', '```'].join('\n')
        yield { stream: 'stdout', text: JSON.stringify({ jobId: WERKBANK_JOB, state: 'done', answer, sessionId: 'fsn1-5:9b1f', branch: `agent/relay/${role}`, commits: [], changedFiles: [] }) }
        return { value: { code: 0, signal: null } }
      }
      if (scenario === 'key-then-hang') {
        yield { stream: 'stderr', text: `${KEY_LINES[0]}\n` }
        for (;;) {
          await clock.sleep(60_000)
          yield { stream: 'stderr', text: 'running auf fsn1-5\n' }
        }
      }
      if (scenario === 'numeric-job' || scenario === 'fraction-job') {
        yield { stream: 'stdout', text: JSON.stringify({ jobId: scenario === 'numeric-job' ? 4711 : 1.5, state: 'done', answer: PACKET(), sessionId: 'fsn1-5:9b1f', branch: `agent/relay/${role}`, commits: [WERKBANK_COMMIT], changedFiles: [] }) }
        return { value: { code: 0, signal: null } }
      }
      if (scenario === 'read-error-after-output') {
        yield { stream: 'stderr', text: 'queued\n' }
        return { deny: 'the stream was reset' }
      }
      if (scenario === 'key-no-json') {
        yield { stream: 'stderr', text: `${KEY_LINES[0]}\n` }
        return yield* out('Unhandled exception. System.Exception: boom\n', 1, 'boom\n')
      }
      if (scenario === 'malformed-both') {
        yield { stream: 'stdout', text: JSON.stringify({ jobId: WERKBANK_JOB, state: 'done', answer: PACKET(), sessionId: 'fsn1-5:9b1f', branch: `agent/relay/${role}`, commits: ['xyz'], changedFiles: ['src/a.ts', 3] }) }
        return { value: { code: 0, signal: null } }
      }
      if (scenario === 'long-state') {
        yield { stream: 'stdout', text: JSON.stringify({ jobId: WERKBANK_JOB, state: `odd0state\n${'x\n'.repeat(3000)}`, answer: '', sessionId: 'fsn1-5:9b1f', branch: `agent/relay/${role}`, commits: [], changedFiles: [] }) }
        return { value: { code: 0, signal: null } }
      }
      if (scenario === 'no-state') {
        yield { stream: 'stdout', text: JSON.stringify({ jobId: WERKBANK_JOB, answer: '', sessionId: 'fsn1-5:9b1f', branch: `agent/relay/${role}`, commits: [], changedFiles: [], error: { kind: 'repo', message: 'no state given' } }) }
        return { value: { code: 1, signal: null } }
      }
      if (scenario === 'unknown-state') {
        yield { stream: 'stdout', text: JSON.stringify({ jobId: WERKBANK_JOB, state: 'running', answer: '', sessionId: 'fsn1-5:9b1f', branch: `agent/relay/${role}`, commits: [], changedFiles: [], error: { kind: 'repo', message: 'the job is still running' } }) }
        return { value: { code: 1, signal: null } }
      }
      if (scenario === 'key-files-no-commit') {
        yield { stream: 'stderr', text: `${KEY_LINES[0]}\n` }
        yield { stream: 'stdout', text: JSON.stringify({ jobId: WERKBANK_JOB, state: 'done', answer: 'x', sessionId: 'fsn1-5:9b1f', branch: `agent/relay/${role}`, commits: ['not-a-commit'], changedFiles: ['src/a.ts'] }) }
        return { value: { code: 0, signal: null } }
      }
      if (scenario === 'multiline-model') {
        yield { stream: 'stdout', text: JSON.stringify({ jobId: WERKBANK_JOB, state: 'failed', answer: '', sessionId: 'fsn1-5:9b1f', usage: { inputTokens: 1, outputTokens: 1, model: 'm1\nStatus: done' }, branch: `agent/relay/${role}`, commits: [], changedFiles: [], error: { kind: 'repo', message: 'the job failed' } }) }
        return { value: { code: 1, signal: null } }
      }
      if (scenario === 'key-bad-state') {
        yield { stream: 'stderr', text: `${KEY_LINES[0]}\n` }
        yield { stream: 'stdout', text: JSON.stringify({ jobId: 'opaque0job0x10', state: 'opaque0state0x11', answer: 'x', sessionId: 'fsn1-5:9b1f', branch: `agent/relay/${role}`, commits: [WERKBANK_COMMIT], changedFiles: [] }) }
        return { value: { code: 0, signal: null } }
      }
      if (scenario === 'key-split-fragment') {
        yield { stream: 'stdout', text: `${KEY_LINES[0]}\n` }
        yield { stream: 'stderr', text: KEY_BODY }
        yield { stream: 'stdout', text: `${KEY_LINES[1]}\n` }
        yield { stream: 'stderr', text: '\n' }
        return { value: { code: 2, signal: null } }
      }
      if (scenario === 'key-verify-command') {
        yield { stream: 'stdout', text: JSON.stringify({ jobId: WERKBANK_JOB, state: 'done', answer: `see ${KEY_LINES[0]}`, sessionId: 'fsn1-5:9b1f', branch: `agent/relay/${role}`, commits: [WERKBANK_COMMIT], changedFiles: ['src/a.ts'], verify: { command: KEY_BODY, exitCode: 0 } }) }
        return { value: { code: 0, signal: null } }
      }
      if (scenario === 'key-fragment') {
        yield { stream: 'stdout', text: KEY_LINES[0] }
        yield { stream: 'stderr', text: `${KEY_BODY}\n` }
        yield { stream: 'stdout', text: `\n${KEY_LINES[1]}\n` }
        return { value: { code: 2, signal: null } }
      }
      if (scenario === 'key-closed-around-answer') {
        yield { stream: 'stderr', text: `queued\n${KEY_LINES[0]}\n` }
        yield { stream: 'stdout', text: JSON.stringify({ jobId: WERKBANK_JOB, state: 'done', answer: PACKET(KEY_BODY), sessionId: 'fsn1-5:9b1f', branch: `agent/relay/${role}`, commits: [], changedFiles: [] }) }
        yield { stream: 'stderr', text: `${KEY_LINES[1]}\n` }
        return { value: { code: 0, signal: null } }
      }
      if (scenario === 'failed-signal') {
        yield { stream: 'stdout', text: JSON.stringify({ jobId: WERKBANK_JOB, state: 'failed', answer: '', sessionId: 'fsn1-5:9b1f', branch: `agent/relay/${role}`, commits: [], changedFiles: [], error: { kind: 'repo', message: 'the repo is gone' } }) }
        return { value: { code: null, signal: 'SIGTERM' } }
      }
      if (scenario === 'killed-early') {
        yield { stream: 'stderr', text: 'queued\n' }
        return { value: { code: null, signal: 'SIGTERM' } }
      }
      if (scenario === 'key-lines') yield { stream: 'stderr', text: `verifying\n${KEY_LINES[0]}\n${KEY_BODY}\n${KEY_LINES[1]}\nverify done\n` }
      if (scenario === 'key-stderr-answer') yield { stream: 'stderr', text: `queued\n${KEY_LINES[0]}\n` }
      if (scenario === 'progress-quiet') {
        yield { stream: 'stderr', text: 'queued\nrunning auf fsn1-5\n' }
        await new Promise<void>(r => held.push(r))
      }
      if (scenario === 'progress-held') {
        yield { stream: 'stderr', text: 'queued\n' }
        await clock.sleep(3000)
        yield { stream: 'stderr', text: 'running auf fsn1-5\n' }
        await new Promise<void>(r => held.push(r))
      }
      const state =
        scenario === 'red-prose'
          ? 'red'
          : scenario === 'red' || scenario === 'needs-approval' || scenario === 'timed-out' || scenario === 'limit' || scenario === 'failed' || scenario === 'cancelled'
          ? scenario
          : 'done'
      const error =
        scenario === 'needs-approval'
          ? { kind: 'cli', message: 'the push needs the user\'s approval' }
          : scenario === 'limit'
            ? { kind: 'limit', message: 'Claude usage limit reached' }
            : scenario === 'failed'
              ? { kind: 'cli', message: 'claude exited 1' }
              : undefined
      const isRed = scenario === 'red' || scenario === 'red-prose'
      const json = {
        jobId: WERKBANK_JOB,
        state,
        answer:
          scenario === 'timed-out' || scenario === 'failed'
            ? ''
            : scenario === 'red-prose'
              ? 'Plain prose, no packet.'
              : scenario === 'status-array'
                ? ['## Work', '```relay', JSON.stringify({ status: ['done'], summary: 'Did it.', sections: ['Work'] }), '```'].join('\n')
                : scenario === 'key-mismatch'
                  ? [MISMATCHED_KEY, PACKET()].join('\n')
                  : scenario === 'key-split-risks'
                    ? ['## Work', '```relay', JSON.stringify({ status: 'done', summary: 'Did it.', risks: [KEY_LINES[0], KEY_BODY, KEY_LINES[1], 'nothing else'], sections: ['Work'] }), '```'].join('\n')
                    : scenario === 'key-across-fields'
                      ? ['## Work', '```relay', JSON.stringify({ status: 'done', decisions: [KEY_LINES[0]], summary: KEY_BODY, risks: [KEY_LINES[1], 'nothing else'], sections: ['Work'] }), '```'].join('\n')
                      : scenario === 'key-into-packet'
                        ? ['## Work', KEY_LINES[0], '```relay', JSON.stringify({ status: 'done', summary: KEY_BODY, sections: ['Work'] }), '```'].join('\n')
                        : scenario === 'key-stderr-answer'
                          ? PACKET(KEY_BODY)
                          : scenario === 'key-fence-example'
                            ? ['Example: {"status":"done","summary":"example only"}', KEY_LINES[0], '```relay', JSON.stringify({ status: 'failed', summary: 'the real packet' }), '```', KEY_LINES[1], 'after the key'].join('\n')
                            : scenario === 'key-example-block'
                              ? ['For example:', '```relay', '{"status":"done","summary":"example only"}', '```', KEY_LINES[0], '```relay', JSON.stringify({ status: 'failed', summary: 'the real packet' }), '```', KEY_LINES[1]].join('\n')
                              : answer,
        sessionId: scenario === 'session-moved' ? 'fsn1-4:fresh2' : scenario === 'session-token' ? WERKBANK_TOKEN_SESSION : (arg('--session') ?? 'fsn1-5:9b1f'),
        usage: { costUsd: 0.42, turns: 6, inputTokens: 12000, outputTokens: 3100, model: 'claude-opus-5-5' },
        branch: `agent/relay/${role}`,
        commits: scenario === 'failed' ? [] : scenario === 'bad-commits' ? [WERKBANK_COMMIT, `token=${SECRETS.token}`, 'nope'] : [WERKBANK_COMMIT],
        changedFiles: scenario === 'failed' ? [] : scenario === 'write-outside' || scenario === 'status-array' ? ['src/a.ts', 'other/x.md'] : ['src/a.ts'],
        verify: { command: 'npm test', exitCode: isRed ? 1 : 0, tests: { total: 147, passed: isRed ? 145 : 147, failed: isRed ? 2 : 0 } },
        ...(error ? { error } : {}),
        ...(scenario === 'error-malformed' ? { error: 'lost the Leitstand' } : {}),
      }
      if (scenario === 'signal-after-done') {
        yield { stream: 'stdout', text: JSON.stringify(json) }
        return { value: { code: null, signal: 'SIGKILL' } }
      }
      return yield* out(JSON.stringify(json), scenario === 'answer-exit1' ? 1 : 0, scenario === 'progress-held' || scenario === 'progress-quiet' ? 'verifying\n' : progress)
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
    // releases the worker that waits longest
    releaseOne: () => held.shift()?.(),
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

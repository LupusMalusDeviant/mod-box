// How each worker CLI is started, continued and read. Pure functions only (no
// `$`), so building and parsing can be tested without processes; register.ts
// does the starting.

import { redact } from './protocol.ts'

export type BackendId = 'claude' | 'codex' | 'opencode' | 'werkbank'

export const BACKEND_IDS: readonly BackendId[] = ['claude', 'codex', 'opencode', 'werkbank']

export type BackendSettings = {
  permissionMode: string
  maxBudgetUsd: number
  codexSandbox: 'workspace-write' | 'read-only'
  opencodeStandalone: boolean
  tmpDir: string // absolute folder for opencode's task files and werkbank's protocol file
  // werkbank only (contract 0001, Nachtrag 2)
  werkbankLeitstand?: string
  werkbankTokenFile?: string // `~` already resolved
  runTimeoutMin?: number // the worker's own run limit on the server
  isWindows?: boolean // relay runs on Windows: path rules for the token file (N64)
}

// A failure while building the invocation: the run never starts.
export class BuildError extends Error {
  constructor(
    message: string,
    readonly kind: RunError['kind'],
  ) {
    super(message)
  }
}

// What a run needs; relay fills it from the role, the roles file and the options.
export type LaunchSpec = {
  role: string
  run: number
  task: string
  protocol: string
  isNew: boolean
  sessionId?: string
  model?: string
  effort?: string
  owns: string[]
  allowedTools: string[]
  disallowedTools: string[]
  cwd: string
  isGitRepo: boolean
  bin: string[]
  settings: BackendSettings
}

// What gets started. Never through a shell.
export type Invocation = {
  argv: string[]
  input?: string
  env: Record<string, string>
  presetSessionId?: string
  tempFiles?: { path: string; content: string }[]
  // the session id build really passed to the program (N67)
  sessionArg?: string
}

export type Usage = {
  inputTokens?: number
  cachedInputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  costUsd?: number
  turns?: number
  model?: string
}

export type RunError = {
  kind: 'budget' | 'auth' | 'session-not-found' | 'model' | 'sandbox' | 'cli' | 'network' | 'repo' | 'unknown'
  message: string
}

// The verify command the Werkbank worker ran after the job.
export type RemoteVerify = { command?: string; exitCode?: number; tests?: { total?: number; passed?: number; failed?: number } }

// A job that ran on the Werkbank servers (contract 0001, N36).
export type RemoteRun = {
  jobId: string
  state: string
  branch: string
  commits: string[]
  // absent: the job reported no list (the write check says so)
  changedFiles?: string[]
  // the list held something other than non-empty strings (N49)
  isFileListMalformed?: true
  verify?: RemoteVerify
  // why the job did not end done (error.message), redacted and cut
  reason?: string
  // the kind of that error, mapped as in N35 (N65)
  reasonKind?: RunError['kind']
  // entries of `commits` that were no commit id; never shown (N66)
  malformedCommits?: number
}

export type RunOutcome = {
  answer: string
  sessionId?: string
  // the backend reported a session id relay does not keep (werkbank, N78)
  isSessionRejected?: boolean
  usage: Usage
  error?: RunError
  remote?: RemoteRun
}

export type ProcessResult = {
  stdout: string
  stderr: string
  exitCode?: number
  // why there is no exit code (N61): the signal that ended the process, or
  // the error that broke reading its output
  signal?: string
  streamError?: string
  isTimedOut: boolean
  isStoppedByLimit: boolean
}

export interface Backend {
  id: BackendId
  capabilities: {
    budgetUsd: boolean
    presetSessionId: boolean
    inProcessOwnsGuard: boolean
    sandbox: boolean
    usage: 'cost' | 'tokens' | 'both'
    streamsEvents: boolean
  }
  build(spec: LaunchSpec): Invocation
  onLine?(line: string, acc: Usage): Usage
  parse(result: ProcessResult): RunOutcome
  versionArgv(bin: string[]): string[]
}

// The versions this contract was checked against (contract 0001, section 1).
export const CHECKED_VERSIONS: Record<BackendId | 'ollama', string> = {
  claude: '2.1.310',
  codex: '0.166.0',
  opencode: '2.2.5',
  // expected, not yet checked against the built program (contract 0001, N46)
  werkbank: '0.1',
  ollama: '0.40.13',
}

// The only text opencode gets as its message argument; the task is in the file.
export const OPENCODE_TASK_MESSAGE = 'The task is in the attached file.'

// Redacted before it is cut: a cut never leaves half a credential behind.
const cut = (text: string, n = 500) => {
  const s = redact(text)
  return s.length > n ? `${s.slice(0, n)}…` : s
}

export const isAbsolutePath = (p: string) => /^([a-zA-Z]:)?[\\/]/.test(p)

// A session id a CLI reported, safe to pass as an argument value: it can
// never read as an option. Anything else starts a fresh session.
export const isSafeId = (id: string) => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id)

// A bin option: a program name, a full path, or a JSON list (program plus
// fixed leading arguments).
export function parseBin(value: string, fallback: string): string[] {
  const v = value.trim()
  if (v.startsWith('[')) {
    try {
      const list = JSON.parse(v) as unknown
      if (Array.isArray(list) && list.length && list.every(x => typeof x === 'string' && x)) return list as string[]
    } catch {
      // not a list: treat as a path
    }
  }
  return [v || fallback]
}

// Error text → kind, for the CLIs that only give a message.
export function classifyError(message: string): RunError['kind'] {
  const m = message.toLowerCase()
  if (/session.*not found|no (such )?(session|thread|conversation)|thread.*not found/.test(m)) return 'session-not-found'
  if (/\b401\b|unauthori[sz]ed|not logged in|login|api key|authenticat/.test(m)) return 'auth'
  if (/model.*not found|unknown model|model not supported|provider.*not found|unknown provider/.test(m)) return 'model'
  if (/sandbox/.test(m)) return 'sandbox'
  return 'unknown'
}

function addUsage(acc: Usage, add: Usage): Usage {
  const sum = (a?: number, b?: number) => (a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0))
  return {
    inputTokens: sum(acc.inputTokens, add.inputTokens),
    cachedInputTokens: sum(acc.cachedInputTokens, add.cachedInputTokens),
    outputTokens: sum(acc.outputTokens, add.outputTokens),
    reasoningTokens: sum(acc.reasoningTokens, add.reasoningTokens),
    costUsd: sum(acc.costUsd, add.costUsd),
    turns: sum(acc.turns, add.turns),
    model: add.model ?? acc.model,
  }
}

function clean<T extends object>(u: T): T {
  return Object.fromEntries(Object.entries(u).filter(([, v]) => v !== undefined)) as T
}

function jsonLines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      const v = JSON.parse(t) as unknown
      if (v && typeof v === 'object') out.push(v as Record<string, unknown>)
    } catch {
      // a broken line is skipped
    }
  }
  return out
}

const obj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

// A nonzero exit (claude keeps exactly this, contract 0001, 3.1).
function exitFailure(r: ProcessResult): RunError | undefined {
  if (r.exitCode === undefined || r.exitCode === 0 || r.isTimedOut || r.isStoppedByLimit) return undefined
  return { kind: 'cli', message: cut(r.stderr.trim() || `exit code ${r.exitCode}`) }
}

// codex, opencode, werkbank: a nonzero exit, or no exit code because a
// signal ended the process or its output could not be read (N61).
function cliFailure(r: ProcessResult): RunError | undefined {
  if (r.isTimedOut || r.isStoppedByLimit) return undefined
  if (r.exitCode !== undefined) return exitFailure(r)
  if (r.signal) return { kind: 'cli', message: cut(`ended by signal ${r.signal}${r.stderr.trim() ? `: ${r.stderr.trim()}` : ''}`) }
  if (r.streamError) return { kind: 'cli', message: cut(`reading the output failed: ${r.streamError}`) }
  return undefined
}

// A signal or broken stream beside an error the CLI reported itself: kept
// with it, the error keeps its kind (N85, N106).
function processFailure(r: ProcessResult): string | undefined {
  if (r.isTimedOut || r.isStoppedByLimit || r.exitCode !== undefined) return undefined
  if (r.signal) return `ended by signal ${r.signal}`
  if (r.streamError) return `reading the output failed: ${r.streamError}`
  return undefined
}
function reported(message: string, r: ProcessResult): RunError {
  const extra = processFailure(r)
  return { kind: classifyError(message), message: extra ? `${cut(message)} · ${extra}` : cut(message) }
}

// ── claude ──────────────────────────────────────────────────────────────

const claude: Backend = {
  id: 'claude',
  capabilities: { budgetUsd: true, presetSessionId: true, inProcessOwnsGuard: true, sandbox: false, usage: 'both', streamsEvents: false },
  // The argv is the one 0.3.0 built, character for character.
  build(spec) {
    const sessionId = spec.sessionId ?? crypto.randomUUID()
    const argv = [
      ...spec.bin,
      '-p',
      '--output-format',
      'json',
      '--permission-mode',
      spec.settings.permissionMode,
      '--append-system-prompt',
      spec.protocol,
      ...(spec.isNew ? ['--session-id', sessionId] : ['--resume', sessionId]),
      ...(spec.model ? ['--model', spec.model] : []),
      ...(spec.effort ? ['--effort', spec.effort] : []),
      ...(spec.settings.maxBudgetUsd > 0 ? ['--max-budget-usd', String(spec.settings.maxBudgetUsd)] : []),
      ...(spec.allowedTools.length ? ['--allowedTools', ...spec.allowedTools] : []),
      ...(spec.disallowedTools.length ? ['--disallowedTools', ...spec.disallowedTools] : []),
    ]
    return { argv, input: spec.task, env: {}, presetSessionId: sessionId }
  },
  parse(r) {
    let json: Record<string, unknown>
    try {
      json = obj(JSON.parse(r.stdout))
    } catch {
      return { answer: r.stdout, usage: {}, error: r.stdout.trim() ? undefined : exitFailure(r) }
    }
    const u = obj(json.usage)
    const usage = clean({
      inputTokens: num(u.input_tokens),
      cachedInputTokens: num(u.cache_read_input_tokens),
      outputTokens: num(u.output_tokens),
      costUsd: num(json.total_cost_usd),
      turns: num(json.num_turns),
    })
    const subtype = str(json.subtype)
    const error: RunError | undefined = json.is_error
      ? subtype === 'error_max_budget_usd'
        ? { kind: 'budget', message: `worker error (${subtype})` }
        : { kind: 'cli', message: `worker error${subtype ? ` (${subtype})` : ''}` }
      : undefined
    return { answer: str(json.result) ?? '', sessionId: str(json.session_id), usage, error }
  },
  versionArgv: bin => [...bin, '--version'],
}

// ── codex ───────────────────────────────────────────────────────────────

const CODEX_EFFORT: Record<string, string> = { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' }

function codexUsage(e: Record<string, unknown>): Usage {
  const u = obj(e.usage)
  return clean({
    inputTokens: num(u.input_tokens),
    cachedInputTokens: num(u.cached_input_tokens),
    outputTokens: num(u.output_tokens),
    reasoningTokens: num(u.reasoning_output_tokens),
    turns: 1,
  })
}

const codex: Backend = {
  id: 'codex',
  capabilities: { budgetUsd: false, presetSessionId: false, inProcessOwnsGuard: false, sandbox: true, usage: 'tokens', streamsEvents: true },
  build(spec) {
    const sandbox = spec.settings.codexSandbox === 'read-only' ? 'read-only' : 'workspace-write'
    const effort = spec.effort ? CODEX_EFFORT[spec.effort] : undefined
    const shared = [
      '-c',
      'approval_policy="never"',
      '-c',
      `developer_instructions=${JSON.stringify(spec.protocol)}`,
      ...(spec.model ? ['-m', spec.model] : []),
      ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
      ...(spec.isGitRepo ? [] : ['--skip-git-repo-check']),
    ]
    // `codex exec resume` knows neither --sandbox nor --cd in 0.166.0: the
    // sandbox goes through -c, the folder through the process's cwd.
    const argv =
      spec.isNew || !spec.sessionId || !isSafeId(spec.sessionId)
        ? [...spec.bin, 'exec', '--json', '--sandbox', sandbox, '--cd', spec.cwd, ...shared, '-']
        : [...spec.bin, 'exec', 'resume', '--json', spec.sessionId, '-c', `sandbox_mode="${sandbox}"`, ...shared, '-']
    return { argv, input: spec.task, env: {} }
  },
  onLine(line, acc) {
    const [e] = jsonLines(line)
    return e?.type === 'turn.completed' ? addUsage(acc, codexUsage(e)) : acc
  },
  parse(r) {
    let sessionId: string | undefined
    let answer = ''
    let usage: Usage = {}
    let message: string | undefined
    for (const e of jsonLines(r.stdout)) {
      if (e.type === 'thread.started') sessionId ??= str(e.thread_id)
      else if (e.type === 'item.completed') {
        const item = obj(e.item)
        if (item.type === 'agent_message' && typeof item.text === 'string') answer = item.text
      } else if (e.type === 'turn.completed') usage = addUsage(usage, codexUsage(e))
      else if (e.type === 'turn.failed') message = str(obj(e.error).message) ?? 'turn failed'
      else if (e.type === 'error') message = str(e.message) ?? 'error'
    }
    const error: RunError | undefined = message
      ? reported(message, r)
      : // a nonzero exit is a failure even when an answer came first
        cliFailure(r)
    return { answer, sessionId, usage: clean(usage), error }
  },
  versionArgv: bin => [...bin, '--version'],
}

// ── opencode ────────────────────────────────────────────────────────────

// A Claude rule `Bash(git push:*)` → opencode's `git push*`; other rules have
// no counterpart.
export function opencodeBashDenials(rules: readonly string[]): Record<string, 'deny'> {
  const out: Record<string, 'deny'> = {}
  for (const rule of rules) {
    const m = rule.trim().match(/^Bash\((.+?)(?::\*)?\)$/)
    if (m?.[1]) out[`${m[1].trim()}*`] = 'deny'
  }
  return out
}

export function opencodeConfig(spec: LaunchSpec): Record<string, unknown> {
  const bash = { 'git push*': 'deny', ...opencodeBashDenials(spec.disallowedTools) }
  const permission: Record<string, unknown> = { bash }
  if (spec.owns.length) {
    const edit: Record<string, string> = {}
    for (const o of spec.owns) edit[`${o.replace(/\\/g, '/').replace(/\/+$/, '')}/**`] = 'allow'
    edit['*'] = 'deny'
    permission.edit = edit
  }
  return { agent: { [`relay-${spec.role}`]: { mode: 'primary', prompt: spec.protocol } }, permission }
}

const opencode: Backend = {
  id: 'opencode',
  // Whether opencode takes an ID relay picks is unchecked (K2), so a new run
  // lets opencode pick one and relay takes it from the first event.
  capabilities: { budgetUsd: false, presetSessionId: false, inProcessOwnsGuard: false, sandbox: false, usage: 'both', streamsEvents: true },
  build(spec) {
    if (!spec.model || !spec.model.includes('/')) {
      throw new Error(`opencode needs a model as provider/model (e.g. ollama/kimi-k3:cloud), got "${spec.model ?? ''}".`)
    }
    // The task never goes into argv (contract 0001, Nachtrag 1): there it could
    // be read as an option and shows in every process list. It goes into a file
    // at an absolute path, the same one for relay and for a worker that runs in
    // its own worktree; argv carries only a fixed message.
    if (!isAbsolutePath(spec.settings.tmpDir)) throw new Error(`opencode needs an absolute folder for the task file, got "${spec.settings.tmpDir}".`)
    const path = `${spec.settings.tmpDir.replace(/[\\/]+$/, '')}/${spec.role}-${spec.run}.md`
    const sessionId = !spec.isNew && spec.sessionId && isSafeId(spec.sessionId) ? spec.sessionId : undefined
    const argv = [
      ...spec.bin,
      'run',
      '--format',
      'json',
      ...(spec.settings.opencodeStandalone ? ['--standalone'] : []),
      '--auto',
      '-m',
      spec.model,
      '--agent',
      `relay-${spec.role}`,
      ...(sessionId ? ['--session', sessionId] : []),
      '--title',
      `relay ${spec.role}`,
      OPENCODE_TASK_MESSAGE,
      '--file',
      path,
    ]
    return {
      argv,
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig(spec)) },
      tempFiles: [{ path, content: spec.task }],
    }
  },
  onLine(line, acc) {
    const [e] = jsonLines(line)
    return e?.type === 'step_finish' ? addUsage(acc, opencodeStep(e)) : acc
  },
  parse(r) {
    let sessionId: string | undefined
    const texts: string[] = []
    let usage: Usage = {}
    let message: string | undefined
    for (const e of jsonLines(r.stdout)) {
      sessionId ??= str(e.sessionID)
      const part = obj(e.part)
      if (e.type === 'text' && typeof part.text === 'string' && part.text.trim()) texts.push(part.text)
      else if (e.type === 'step_finish') usage = addUsage(usage, opencodeStep(e))
      else if (e.type === 'step_start') usage = addUsage(usage, { turns: 1, model: str(part.model) ?? str(e.model) })
      else if (e.type === 'error') message = str(obj(e.error).message) ?? str(e.message) ?? 'error'
    }
    const answer = texts.join('\n\n')
    const error: RunError | undefined = message
      ? reported(message, r)
      : // a nonzero exit is a failure even when an answer came first
        cliFailure(r)
    return { answer, sessionId, usage: clean(usage), error }
  },
  versionArgv: bin => [...bin, '--version'],
}

function opencodeStep(e: Record<string, unknown>): Usage {
  const part = obj(e.part)
  const t = obj(part.tokens)
  return clean({
    inputTokens: num(t.input),
    outputTokens: num(t.output),
    reasoningTokens: num(t.reasoning),
    cachedInputTokens: num(obj(t.cache).read),
    costUsd: num(part.cost),
  })
}

// ── werkbank (contract 0001, Nachtrag 2) ───────────────────────────────

// The Leitstand takes a task of at most this many UTF-8 bytes.
export const WERKBANK_MAX_TASK_BYTES = 16 * 1024

// Job states that end the run as partial (commits may be on the branch) and
// the ones that end it failed; any other state that is not done counts as partial.
export const WERKBANK_FAILED_STATES: readonly string[] = ['failed', 'cancelled']

const WERKBANK_ERRORS: Record<string, RunError['kind']> = {
  auth: 'auth',
  network: 'network',
  repo: 'repo',
  budget: 'budget',
  limit: 'budget',
  cli: 'cli',
}

// A literal http(s) URL with neither user, password, query nor fragment, and
// nothing the redaction would touch (N50, N58).
export function isLeitstandUrl(value: string): boolean {
  if (/\s|[?#]/.test(value) || !/^https?:\/\//.test(value) || redact(value) !== value) return false
  try {
    const u = new URL(value)
    return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password && !u.search && !u.hash && !!u.hostname
  } catch {
    return false
  }
}

// An absolute token file path that means one file (N64): on Windows with a
// drive or a UNC share, elsewhere from `/`.
export function isTokenFilePath(path: string, isWindows: boolean): boolean {
  if (path.startsWith('-')) return false
  return isWindows ? /^([A-Za-z]:[\\/]|(\\\\|\/\/)[^\\/]+[\\/][^\\/]+)/.test(path) : path.startsWith('/')
}

// A value werkbank-relay could read as an option, a list entry the comma
// join would split, or one that looks like a credential: refused before the
// start (N32, N58). A credential is never echoed, only its option named.
function werkbankValue(flag: string, what: string, v: string, isList: boolean) {
  if (redact(v) !== v) throw new BuildError(`werkbank: a value for ${flag} looks like a credential; it is not passed on.`, 'cli')
  if (v.startsWith('-')) throw new BuildError(`werkbank: ${what} "${v}" starts with "-" and could be read as an option.`, 'cli')
  if (isList && v.includes(',')) throw new BuildError(`werkbank: ${what} "${v}" contains ",", which would split the list.`, 'cli')
  return v
}

const werkbankList = (flag: string, what: string, list: readonly string[]) =>
  list.length ? [flag, list.map(v => werkbankValue(flag, what, v, true)).join(',')] : []

const COMMIT_ID = /^[0-9a-f]{7,64}$/i

// A werkbank session id safe as an argument value and nothing the redaction
// would touch: never stored from a reply, never sent on resume (N72).
export const isSafeSession = (id: string) => isSafeId(id) && redact(id) === id

// werkbankBin without anything the redaction would change: else neither a
// run nor the version probe starts (N82).
export const isWerkbankBinSafe = (bin: readonly string[]) => bin.every(p => redact(p) === p)

const werkbank: Backend = {
  id: 'werkbank',
  capabilities: { budgetUsd: false, presetSessionId: false, inProcessOwnsGuard: false, sandbox: false, usage: 'both', streamsEvents: true },
  build(spec) {
    const s = spec.settings
    const leitstand = (s.werkbankLeitstand ?? '').trim()
    // The value is never echoed: it may hold credentials (N50).
    if (!isLeitstandUrl(leitstand)) {
      throw new BuildError('werkbank: werkbankLeitstand must be an http:// or https:// URL without user, password, query or fragment.', 'cli')
    }
    const tokenFile = (s.werkbankTokenFile ?? '').trim()
    if (!isTokenFilePath(tokenFile, !!s.isWindows)) {
      throw new BuildError(
        `werkbank: werkbankTokenFile must be an absolute path${s.isWindows ? ' with a drive or a UNC share' : ''} (a leading ~ needs USERPROFILE or HOME).`,
        'cli',
      )
    }
    // a path the redaction would change never reaches argv; its value is not named (N76)
    if (redact(tokenFile) !== tokenFile) {
      throw new BuildError('werkbank: werkbankTokenFile looks like it contains a credential; it is not passed on.', 'cli')
    }
    if (!isAbsolutePath(s.tmpDir)) throw new BuildError(`werkbank needs an absolute folder for the protocol file, got "${s.tmpDir}".`, 'cli')
    const bytes = new TextEncoder().encode(spec.task).length
    if (bytes > WERKBANK_MAX_TASK_BYTES) {
      throw new BuildError(`werkbank: the task has ${bytes} bytes; the Leitstand takes at most ${WERKBANK_MAX_TASK_BYTES} (16 KiB). Shorten it or point to a file in the repo.`, 'cli')
    }
    // The protocol never goes into argv: it is a file at an absolute path (N31).
    const path = `${s.tmpDir.replace(/[\\/]+$/, '')}/${spec.role}-${spec.run}.protocol.md`
    const sessionId = !spec.isNew && spec.sessionId && isSafeSession(spec.sessionId) ? spec.sessionId : undefined
    const timeoutMin = s.runTimeoutMin ?? 0
    const argv = [
      ...spec.bin,
      'run',
      '--leitstand',
      leitstand,
      '--token-file',
      tokenFile,
      '--role',
      spec.role,
      '--run',
      String(spec.run),
      '--cwd',
      spec.cwd,
      ...(sessionId ? ['--session', sessionId] : []),
      ...(spec.model ? ['--model', werkbankValue('--model', 'model', spec.model, false)] : []),
      ...(timeoutMin > 0 ? ['--timeout-min', String(timeoutMin)] : []),
      ...werkbankList('--allowed-tools', 'allowed tool rule', spec.allowedTools),
      ...werkbankList('--disallowed-tools', 'disallowed tool rule', spec.disallowedTools),
      ...werkbankList('--owns', 'owned path', spec.owns),
      '--protocol-file',
      path,
    ]
    // No argument that looks like a credential reaches werkbank-relay; only
    // its field is named (N82).
    if (!isWerkbankBinSafe(spec.bin)) throw new BuildError('werkbank: werkbankBin looks like it contains a credential; it is not passed on.', 'cli')
    for (let i = spec.bin.length + 1; i < argv.length; i++) {
      const flag = argv[i - 1]!
      if (flag.startsWith('--') && redact(argv[i]!) !== argv[i]) {
        throw new BuildError(`werkbank: a value for ${flag} looks like a credential; it is not passed on.`, 'cli')
      }
    }
    return { argv, input: spec.task, env: {}, tempFiles: [{ path, content: spec.protocol }], ...(sessionId ? { sessionArg: sessionId } : {}) }
  },
  parse(r) {
    let json: Record<string, unknown> | undefined
    try {
      const v = JSON.parse(r.stdout.trim()) as unknown
      if (v && typeof v === 'object' && !Array.isArray(v)) json = v as Record<string, unknown>
    } catch {
      json = undefined
    }
    if (!json) {
      // A run relay stopped prints nothing; the timeout says enough.
      if (r.isTimedOut) return { answer: '', usage: {} }
      // a signal or a broken stream is named as such, not as stderr (N71)
      const cause = r.exitCode === undefined && (r.signal || r.streamError) ? cliFailure(r) : undefined
      return { answer: '', usage: {}, error: cause ?? { kind: 'cli', message: cut(r.stderr.trim() || 'werkbank-relay printed no JSON') } }
    }
    const u = obj(json.usage)
    const usage = clean({
      costUsd: num(u.costUsd),
      turns: num(u.turns),
      inputTokens: num(u.inputTokens),
      outputTokens: num(u.outputTokens),
      model: str(u.model),
    })
    const e = json.error && typeof json.error === 'object' && !Array.isArray(json.error) ? obj(json.error) : undefined
    // an error that is there but no object is a protocol failure (N69)
    // a present key with anything but an object, null included (N69, N77)
    const isErrorMalformed = Object.prototype.hasOwnProperty.call(json, 'error') && !e
    // only the table's own keys count, anything else is unknown (N69)
    const errKind = str(e?.kind) ?? ''
    const kind = e ? (Object.prototype.hasOwnProperty.call(WERKBANK_ERRORS, errKind) ? WERKBANK_ERRORS[errKind] : 'unknown') : undefined
    const errText = e ? cut(str(e.message) || `werkbank error (${str(e.kind) ?? 'unknown'})`) : undefined
    const sid = str(json.sessionId)
    // only spaces is no job id (N90)
    const jobId = str(json.jobId)?.trim() || undefined
    const state = str(json.state) ?? 'unknown'
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
    let remote: RemoteRun | undefined
    if (jobId) {
      const v = json.verify && typeof json.verify === 'object' ? obj(json.verify) : undefined
      const t = v ? obj(v.tests) : {}
      // only real commit ids; the rest is counted, never shown (N66)
      const rawCommits: unknown[] = Array.isArray(json.commits) ? json.commits : []
      const commits = strings(rawCommits).filter(c => COMMIT_ID.test(c))
      remote = {
        jobId,
        state,
        branch: str(json.branch) ?? '',
        commits,
        ...(rawCommits.length > commits.length ? { malformedCommits: rawCommits.length - commits.length } : {}),
        // A list with anything but non-empty strings is malformed, never a short list (N49).
        ...(json.changedFiles === undefined
          ? {}
          : Array.isArray(json.changedFiles) && json.changedFiles.every(x => typeof x === 'string' && x !== '')
            ? { changedFiles: json.changedFiles as string[] }
            : { isFileListMalformed: true as const }),
        ...(v
          ? {
              verify: clean<RemoteVerify>({
                command: str(v.command),
                exitCode: num(v.exitCode),
                ...(v.tests && typeof v.tests === 'object' ? { tests: clean({ total: num(t.total), passed: num(t.passed), failed: num(t.failed) }) } : {}),
              }),
            }
          : {}),
        ...(errText ? { reason: errText } : {}),
        ...(kind && errText ? { reasonKind: kind } : {}),
      }
    }
    // A job that ended partial carries the JSON error as its reason in
    // `remote`. Everything else keeps it as an error: the program's own
    // failure, no jobId, a failed job, a done job with an error. A nonzero
    // exit is always an error (N48); a done job needs a confirmed exit 0 (N61).
    const answer = str(json.answer) ?? ''
    const isPartialState = !!remote && state !== 'done' && !WERKBANK_FAILED_STATES.includes(state)
    const jsonError: RunError | undefined = kind && errText && !isPartialState ? { kind, message: errText } : undefined
    const fromJson = jsonError ?? (isErrorMalformed ? { kind: 'cli' as const, message: 'werkbank-relay sent a malformed error field' } : undefined)
    // a signal or broken stream after a JSON error is kept beside it (N85)
    const failure = processFailure(r)
    let error: RunError | undefined = fromJson
      ? { kind: fromJson.kind, message: failure ? `${fromJson.message} · ${failure}` : fromJson.message }
      : cliFailure(r)
    if (!error && remote && state === 'done' && r.exitCode !== 0 && !r.isTimedOut) {
      error = { kind: 'cli', message: 'werkbank-relay ended without an exit code' }
    }
    if (!remote) {
      // no jobId: always an error; with an answer the message says so (N65)
      const missing = 'werkbank-relay reported no jobId'
      error = error ? (answer.trim() ? { kind: error.kind, message: `${error.message} (${missing})` } : error) : { kind: 'cli', message: missing }
    }
    return {
      answer,
      ...(sid && isSafeSession(sid) ? { sessionId: sid } : {}),
      // reported but not kept: the old session must not stay either (N78)
      // a sent key with anything unusable, "" included, counts too (N91)
      ...(Object.prototype.hasOwnProperty.call(json, 'sessionId') && !(sid && isSafeSession(sid)) ? { isSessionRejected: true } : {}),
      usage,
      ...(error ? { error } : {}),
      ...(remote ? { remote } : {}),
    }
  },
  versionArgv: bin => [...bin, '--version'],
}

// The stream a backend's live.log is read from: werkbank-relay reports its
// progress on stderr, stdout only carries the final JSON (N43).
export const liveStream = (id: BackendId): 'stdout' | 'stderr' => (id === 'werkbank' ? 'stderr' : 'stdout')

// What a werkbank job adds to the packet (N37, N38, N40). Returns the risk
// line naming why the job did not end done, or undefined.
export function remoteVerifyLine(v: RemoteVerify): string {
  const t = v.tests
  const tests = t && t.total !== undefined ? `, tests ${t.passed ?? 0}/${t.total} passed, ${t.failed ?? 0} failed` : ''
  return `verify: ${v.command ?? '(command not reported)'} → exit ${v.exitCode ?? '?'}${tests}`
}

export function remoteEndLine(r: RemoteRun): string | undefined {
  if (r.state === 'done') return undefined
  // red: the verify line first, then the error message (N54)
  const why = [r.state === 'red' && r.verify ? remoteVerifyLine(r.verify) : '', r.reason ?? ''].filter(Boolean).join('; ')
  // the kind of a reported error goes with it (N65)
  const kind = r.reason && r.reasonKind ? ` (${r.reasonKind})` : ''
  return `werkbank job ${r.jobId} ended ${r.state}${kind}${why ? `: ${why}` : ''}`
}

export const isRemoteFailed = (r: RemoteRun) => WERKBANK_FAILED_STATES.includes(r.state)

export const BACKENDS: Record<BackendId, Backend> = { claude, codex, opencode, werkbank }

// ── shared helpers ──────────────────────────────────────────────────────

// Which of a role's rules the backend cannot apply (shown in worker_status).
export function ignoredRules(id: BackendId, eff: { effort: string; allowedTools: string[]; disallowedTools: string[]; isolation?: string }): string[] {
  if (id === 'claude') return []
  // werkbank passes model, tools and owns on; the worker has its own worktree (N33).
  if (id === 'werkbank') return [...(eff.effort ? ['effort'] : []), ...(eff.isolation === 'worktree' ? ['isolation'] : [])]
  const out: string[] = []
  if (eff.allowedTools.length) out.push('allowedTools')
  if (id === 'codex' && eff.disallowedTools.length) out.push('disallowedTools')
  if (id === 'opencode') {
    if (eff.disallowedTools.some(r => !/^Bash\(.+\)$/.test(r.trim()))) out.push('disallowedTools except Bash(...)')
    if (eff.effort) out.push('effort')
  }
  return out
}

export function tokens(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`
}

// "48.2k in (31.0k cached) / 3.1k out tokens", "$0.42", or both.
export function usageText(u: Usage, kind: Backend['capabilities']['usage']): string {
  const parts: string[] = []
  if (u.inputTokens !== undefined || u.outputTokens !== undefined) {
    const cached = u.cachedInputTokens ? ` (${tokens(u.cachedInputTokens)} cached)` : ''
    if (kind !== 'cost') parts.push(`${tokens(u.inputTokens ?? 0)} in${cached} / ${tokens(u.outputTokens ?? 0)} out tokens`)
  }
  const hasTokens = (u.inputTokens ?? 0) + (u.outputTokens ?? 0) > 0
  if (u.costUsd !== undefined && (u.costUsd > 0 || hasTokens)) parts.push(`$${u.costUsd.toFixed(2)}`)
  return parts.join(', ')
}

export function sumUsage(a: Usage, b: Usage): Usage {
  const { model: _model, ...rest } = addUsage(a, b)
  return clean(rest)
}

export function totalTokens(u: Usage): number {
  return (u.inputTokens ?? 0) + (u.outputTokens ?? 0)
}

// "codex-cli 0.166.0" → "0.166.0"
export function versionOf(text: string): string | undefined {
  return text.match(/\d+\.\d+(?:\.\d+)?/)?.[0]
}

// The part of a version that must match: "2" for 2.x, "0.166" for 0.x.
export function majorOf(version: string): string {
  const [a = '', b = ''] = version.split('.')
  return a === '0' ? `0.${b}` : a
}

// The fallback compressor through ollama (contract 0001, section 6).
export function ollamaArgv(bin: string[], model: string): string[] {
  return [...bin, 'run', model, '--format', 'json', '--hidethinking', '--nowordwrap']
}

// One readable live.log line per JSONL event; undefined for noise.
export function liveLine(id: BackendId, line: string): string | undefined {
  // werkbank-relay's stderr: one plain progress line per state change.
  if (id === 'werkbank') {
    const t = line.trim()
    return t ? cut(t, 300) : undefined
  }
  const [e] = jsonLines(line)
  if (!e) return undefined
  const type = String(e.type ?? '')
  const part = obj(e.part)
  const short = (s: unknown) => cut(String(s ?? '').replace(/\s+/g, ' ').trim(), 160)
  if (id === 'codex') {
    if (type === 'item.completed' || type === 'item.started') {
      const item = obj(e.item)
      return `${type === 'item.started' ? '→' : '✓'} ${String(item.type ?? 'item')}: ${short(item.text ?? item.command ?? '')}`
    }
    if (type === 'turn.completed') {
      const u = codexUsage(e)
      return `turn done: ${tokens(u.inputTokens ?? 0)} in / ${tokens(u.outputTokens ?? 0)} out`
    }
    if (type === 'turn.failed' || type === 'error') return `error: ${short(obj(e.error).message ?? e.message)}`
    return type ? `${type}` : undefined
  }
  if (type === 'text') return `text: ${short(part.text)}`
  if (type === 'tool_use') return `tool ${String(part.tool ?? '')}: ${short(obj(obj(part.state).input).command ?? obj(part.state).title ?? '')}`
  if (type === 'step_finish') {
    const u = opencodeStep(e)
    return `step done: ${tokens(u.inputTokens ?? 0)} in / ${tokens(u.outputTokens ?? 0)} out`
  }
  if (type === 'error') return `error: ${short(obj(e.error).message ?? e.message)}`
  return type || undefined
}

// How each worker CLI is started, continued and read. Pure functions only (no
// `$`), so building and parsing can be tested without processes; register.ts
// does the starting.

export type BackendId = 'claude' | 'codex' | 'opencode'

export const BACKEND_IDS: readonly BackendId[] = ['claude', 'codex', 'opencode']

export type BackendSettings = {
  permissionMode: string
  maxBudgetUsd: number
  codexSandbox: 'workspace-write' | 'read-only'
  opencodeStandalone: boolean
  tmpDir: string // where long opencode tasks go (relative to the project)
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
  kind: 'budget' | 'auth' | 'session-not-found' | 'model' | 'sandbox' | 'cli' | 'unknown'
  message: string
}

export type RunOutcome = {
  answer: string
  sessionId?: string
  usage: Usage
  error?: RunError
}

export type ProcessResult = {
  stdout: string
  stderr: string
  exitCode?: number
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
  ollama: '0.40.13',
}

// Longest task opencode gets as an argument; Windows allows 32767 per command line.
export const MAX_ARG_TASK = 24_000

const cut = (s: string, n = 500) => (s.length > n ? `${s.slice(0, n)}…` : s)

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

function clean(u: Usage): Usage {
  return Object.fromEntries(Object.entries(u).filter(([, v]) => v !== undefined)) as Usage
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

function cliFailure(r: ProcessResult): RunError | undefined {
  if (r.exitCode === undefined || r.exitCode === 0 || r.isTimedOut || r.isStoppedByLimit) return undefined
  return { kind: 'cli', message: cut(r.stderr.trim() || `exit code ${r.exitCode}`) }
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
      return { answer: r.stdout, usage: {}, error: r.stdout.trim() ? undefined : cliFailure(r) }
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
      spec.isNew || !spec.sessionId
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
      ? { kind: classifyError(message), message: cut(message) }
      : answer
        ? undefined
        : cliFailure(r)
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
    const tempFiles: Invocation['tempFiles'] = []
    let taskArgs = [spec.task]
    if (spec.task.length > MAX_ARG_TASK) {
      const path = `${spec.settings.tmpDir}/${spec.role}-${spec.run}.md`
      tempFiles.push({ path, content: spec.task })
      taskArgs = ['--file', path, 'The task is in the attached file.']
    }
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
      ...(!spec.isNew && spec.sessionId ? ['--session', spec.sessionId] : []),
      '--title',
      `relay ${spec.role}`,
      ...taskArgs,
    ]
    return {
      argv,
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig(spec)) },
      ...(tempFiles.length ? { tempFiles } : {}),
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
      ? { kind: classifyError(message), message: cut(message) }
      : answer
        ? undefined
        : cliFailure(r)
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

export const BACKENDS: Record<BackendId, Backend> = { claude, codex, opencode }

// ── shared helpers ──────────────────────────────────────────────────────

// Which of a role's rules the backend cannot apply (shown in worker_status).
export function ignoredRules(id: BackendId, eff: { effort: string; allowedTools: string[]; disallowedTools: string[] }): string[] {
  if (id === 'claude') return []
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

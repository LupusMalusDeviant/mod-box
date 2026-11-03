import type { Register, EngineInterface } from 'claude-code'
import {
  BACKEND_IDS,
  BACKENDS,
  CHECKED_VERSIONS,
  ignoredRules,
  liveLine,
  majorOf,
  ollamaArgv,
  parseBin,
  sumUsage,
  totalTokens,
  tokens,
  usageText,
  versionOf,
  type BackendId,
  type Invocation,
  type LaunchSpec,
  type ProcessResult,
  type RunOutcome,
  type Usage,
} from './backends.ts'
import {
  applyWriteCheck,
  compareSnapshots,
  extractSection,
  fallbackPrompt,
  isSamePath,
  ownershipDenial,
  parseNameStatus,
  parsePacket,
  parsePorcelain,
  parseWorktreeList,
  protocolPrompt,
  redact,
  redactDeep,
  safeRelayDir,
  renderPacket,
  stripPacket,
  toList,
  UNHASHED,
  type Change,
  type Packet,
  type PathCase,
  type Snapshot,
  type WriteCheck,
} from './protocol.ts'
import {
  CLAIM_SETTLE_MS,
  HEARTBEAT_MS,
  emptyQueue,
  isFresh,
  loadQueue,
  mayOwn,
  newJobId,
  newToken,
  parseQueue,
  serializeQueue,
  type QueueFile,
  type QueuedJob,
} from './queue.ts'

type Isolation = 'shared' | 'worktree'

// What a role is made of. A role's own values (set through worker_send) win
// over the roles file, which wins over the mod's options.
type RoleDef = {
  brief?: string
  owns?: string[]
  model?: string
  effort?: string
  allowedTools?: string[]
  disallowedTools?: string[]
  backend?: BackendId
  isolation?: Isolation
}

type Role = RoleDef & {
  name: string
  sessionId?: string
  // The backend the stored session belongs to.
  sessionBackend?: BackendId
  runs: number
  isBusy: boolean
  lastStatus?: Packet['status']
  lastSummary?: string
  totals?: Usage
}

const ROLE_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/

const config = {
  claudeBin: 'claude',
  permissionMode: 'acceptEdits',
  workerModel: '',
  workerEffort: 'default',
  maxBudgetUsd: 0,
  maxParallel: 3,
  runTimeoutMin: 30,
  allowedTools: [] as string[],
  disallowedTools: [] as string[],
  enforceOwns: true,
  notifyMode: 'prompt',
  packetDetail: 'full' as 'full' | 'lean',
  fallbackCompress: true,
  fallbackModel: 'claude-haiku-5-5',
  relayDir: '.relay',
  rolesFile: '.relay/roles.json',
  gitignore: true,
  keepRuns: 20,
  defaultBackend: 'claude' as BackendId,
  codexBin: 'codex',
  codexSandbox: 'workspace-write' as 'workspace-write' | 'read-only',
  opencodeBin: 'opencode',
  opencodeStandalone: true,
  writeCheck: 'report' as 'report' | 'off',
  isolation: 'shared' as Isolation,
  maxTokensPerRun: 0,
  fallbackBackend: 'claude' as 'claude' | 'ollama' | 'off',
  ollamaModel: '',
  ollamaBin: 'ollama',
}

let cwd = ''
let roles: Record<string, Role> = {}
let queue: QueueFile = emptyQueue()
let running = 0
let unread: string[] = []
let isGitignoreChecked = false
// This session works the project's queue; another one only reads it.
let isOwner = false
// This module's claim in queue.json (owner.token).
let ownerToken = ''
// Resolves once this session knows whether it works the queue.
let claim: Promise<void> = Promise.resolve()
// Why the queue cannot be worked here at all (a file that cannot be read).
let queueError: string | undefined
// Why the last dispatch could not be persisted.
let dispatchError: string | undefined
let session = ''
let lastQueueText: string | undefined
let notices: string[] = []
let configNotes: string[] = []
let heartbeat: { cancel: () => void } | undefined
// Interrupted jobs that could not be reported (no such role, or reporting
// failed): they stay in queue.json and are retried at the next start.
const unreported = new Map<string, string>()
const versions: Partial<Record<BackendId, string>> = {}
// How owns compares paths on this project's filesystem.
let pathCase: PathCase = {}
// Set in a worker session: the paths it may write (empty: unrestricted).
let workerOwns: string[] = []
let workerCwd = ''
let workerCase: PathCase = {}

class NotOwnerError extends Error {}

const isBackend = (v: unknown): v is BackendId => BACKEND_IDS.includes(v as BackendId)
const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

// Roles stored by 0.3.0 carry a session but no backend: it was claude's.
const sessionBackendOf = (role: Role): BackendId | undefined => role.sessionBackend ?? (role.sessionId ? 'claude' : undefined)
const isIsolation = (v: unknown): v is Isolation => v === 'shared' || v === 'worktree'

function storeKey() {
  return `roles:${cwd}`
}

function relayPath(p: string) {
  return `${config.relayDir}/${p}`
}

function absolute(p: string) {
  return /^([a-zA-Z]:)?[\\/]/.test(p) ? p : `${cwd.replace(/[\\/]+$/, '')}/${p}`
}

async function save($: EngineInterface) {
  await $.store.set(storeKey(), roles)
}

const queued = () => queue.jobs.filter(j => j.state === 'queued')

// ── the queue file ──────────────────────────────────────────────────────

// One queue write at a time, each serializing the queue as it stands when it
// begins: the newest state always lands last (contract 0001, Nachtrag 1).
let queueChain: Promise<void> = Promise.resolve()
function serialized(fn: () => Promise<void>): Promise<void> {
  const run = queueChain.then(fn)
  queueChain = run.catch(() => undefined)
  return run
}

// A missing file is undefined; a file that exists but cannot be read throws.
async function readText($: EngineInterface, path: string) {
  if (!(await $.fs.exists(path))) return undefined
  return String(await $.fs.read(path))
}

async function readQueue($: EngineInterface) {
  const text = await readText($, relayPath('queue.json'))
  const loaded = loadQueue(text, await readText($, relayPath('queue.json.bak')))
  return { ...loaded, text }
}

async function writeQueueText($: EngineInterface) {
  await ensureGitignore($)
  const text = serializeQueue(queue)
  if (text === lastQueueText) return
  if (lastQueueText !== undefined) await $.fs.write(relayPath('queue.json.bak'), lastQueueText)
  await $.fs.write(relayPath('queue.json'), text)
  lastQueueText = text
}

function stepDown(who: string) {
  if (!isOwner) return
  isOwner = false
  heartbeat?.cancel()
  heartbeat = undefined
  notices.push(`${who} took over this project's relay queue; this session stopped working it. Runs already started here still report here.`)
}

// Before each write: is the file still ours? Another session's fresh claim
// wins, and this one steps down instead of overwriting it.
async function fence($: EngineInterface) {
  const text = await readText($, relayPath('queue.json'))
  if (text === undefined || text === lastQueueText) return
  const owner = parseQueue(text)?.owner
  if (!owner || owner.token === ownerToken) return
  if (!isFresh(owner, await $.clock.now())) return
  stepDown(owner.session === session ? 'Another relay instance of this session' : `Session ${owner.session}`)
  throw new NotOwnerError('another session works this queue now')
}

// Persists the queue; rejects when it could not (the caller decides what that
// means: a send is refused, a dispatch rolled back).
async function writeQueue($: EngineInterface) {
  await serialized(async () => {
    if (!isOwner) throw new NotOwnerError('this session does not work the queue')
    await fence($)
    await writeQueueText($)
  })
}

// Claims the queue: writes this module's token, waits, reads the file back.
// $.fs has no exclusive create (V3), so a claim holds only when nobody else
// wrote theirs meanwhile; every later write is fenced against the file.
async function claimQueue($: EngineInterface) {
  try {
    ownerToken = newToken()
    queue.owner = { session, heartbeatAt: await iso($), token: ownerToken }
    await serialized(() => writeQueueText($))
    await $.clock.sleep(CLAIM_SETTLE_MS)
    const disk = parseQueue(await readText($, relayPath('queue.json')))
    if (disk?.owner?.token !== ownerToken) {
      if (disk) queue = disk
      notices.push(`Session ${disk?.owner?.session ?? 'unknown'} claimed this project's relay queue at the same time; this session only reads it.`)
      return
    }
  } catch (err) {
    queueError = `${relayPath('queue.json')} could not be claimed (${message(err)})`
    notices.push(`${queueError}; this session does not work the queue.`)
    return
  }
  isOwner = true
  heartbeat = $.clock.every(HEARTBEAT_MS, () => void beat($))
  showStatus($)
  await recover($).catch(err => notices.push(`relay could not finish taking over the queue (${message(err)}).`))
}

async function beat($: EngineInterface) {
  if (!isOwner) return
  queue.owner = { session, heartbeatAt: await iso($), token: ownerToken }
  await writeQueue($).catch(err => {
    if (!(err instanceof NotOwnerError)) notices.push(`relay could not renew its claim on the queue (${message(err)}).`)
  })
}

// Runs the last module left behind: report the dead ones, start the rest.
async function recover($: EngineInterface) {
  const dead = queue.jobs.filter(j => j.state === 'running')
  for (const job of dead) {
    const why = await reportInterrupted($, job).catch(err => `reporting failed (${message(err)})`)
    // A reported job left the queue in deliver; the rest stay and are shown.
    if (why) unreported.set(job.id, why)
  }
  const defs = await loadRoleDefs($)
  for (const job of queued()) {
    if (!roles[job.role] && defs[job.role]) roles[job.role] = { name: job.role, runs: 0, isBusy: false }
  }
  await save($)
  await writeQueue($).catch(err => notices.push(`relay could not write the queue after the restart (${message(err)}).`))
  await pump($)
}

function showStatus($: EngineInterface) {
  const busy = Object.values(roles).filter(r => r.isBusy).map(r => r.name)
  const waiting = queued().length ? ` · ${queued().length} queued` : ''
  $.ui.status(busy.length || queued().length ? `relay: ${busy.join(', ') || 'none'} working${waiting}` : undefined)
}

function slotOf(run: number) {
  return config.keepRuns > 0 ? ((run - 1) % config.keepRuns) + 1 : run
}

function runPath(role: string, run: number, kind: 'full.md' | 'packet.json') {
  return relayPath(`runs/${role}/${String(slotOf(run)).padStart(3, '0')}.${kind}`)
}

function isRotatedOut(role: Role, run: number) {
  return config.keepRuns > 0 && run <= role.runs - config.keepRuns
}

async function loadRoleDefs($: EngineInterface): Promise<Record<string, RoleDef>> {
  try {
    if (!(await $.fs.exists(config.rolesFile))) return {}
    const parsed = JSON.parse(await $.fs.read(config.rolesFile)) as Record<string, unknown>
    const map = (parsed.roles ?? parsed) as Record<string, Record<string, unknown>>
    const defs: Record<string, RoleDef> = {}
    for (const [name, d] of Object.entries(map)) {
      if (!ROLE_NAME.test(name) || typeof d !== 'object' || d === null) continue
      defs[name] = {
        ...(typeof d.brief === 'string' ? { brief: d.brief } : {}),
        ...(d.owns !== undefined ? { owns: toList(d.owns) } : {}),
        ...(typeof d.model === 'string' ? { model: d.model } : {}),
        ...(typeof d.effort === 'string' ? { effort: d.effort } : {}),
        ...(d.allowedTools !== undefined ? { allowedTools: toList(d.allowedTools) } : {}),
        ...(d.disallowedTools !== undefined ? { disallowedTools: toList(d.disallowedTools) } : {}),
        ...(isBackend(d.backend) ? { backend: d.backend } : {}),
        ...(isIsolation(d.isolation) ? { isolation: d.isolation } : {}),
      }
    }
    return defs
  } catch {
    return {}
  }
}

function effective(role: Role, def: RoleDef | undefined) {
  const effort = role.effort ?? def?.effort ?? config.workerEffort
  const backend = role.backend ?? def?.backend ?? config.defaultBackend
  return {
    brief: role.brief || def?.brief || '',
    owns: role.owns?.length ? role.owns : (def?.owns ?? []),
    // workerModel names a Claude model; other backends need their own.
    model: role.model || def?.model || (backend === 'claude' ? config.workerModel : ''),
    effort: effort === 'default' ? '' : effort,
    allowedTools: role.allowedTools ?? def?.allowedTools ?? config.allowedTools,
    disallowedTools: role.disallowedTools ?? def?.disallowedTools ?? config.disallowedTools,
    backend,
    isolation: role.isolation ?? def?.isolation ?? config.isolation,
  }
}

function binOf(id: BackendId) {
  return parseBin(id === 'codex' ? config.codexBin : id === 'opencode' ? config.opencodeBin : config.claudeBin, id)
}

async function ensureGitignore($: EngineInterface) {
  if (isGitignoreChecked || !config.gitignore) return
  isGitignoreChecked = true
  const entries = ['runs/', 'queue.json', 'queue.json.bak', 'tmp/', 'worktrees/'].map(e => `${config.relayDir}/${e}`)
  try {
    if (await $.fs.exists('.gitignore')) {
      const text = await $.fs.read('.gitignore')
      const have = new Set(text.split(/\r?\n/).map(l => l.trim()))
      const missing = entries.filter(e => !have.has(e))
      if (missing.length) await $.fs.write('.gitignore', `${text}${text.endsWith('\n') || !text ? '' : '\n'}${missing.join('\n')}\n`)
    } else if (await $.fs.exists('.git')) {
      await $.fs.write('.gitignore', `${entries.join('\n')}\n`)
    }
  } catch {
    // not worth failing a run over
  }
}

// Whether the project's filesystem tells `a` from `A`: a file written under
// a lower-case name and read back under the upper-case one.
async function probeCase($: EngineInterface): Promise<PathCase> {
  const token = newToken()
  try {
    await ensureGitignore($)
    await $.fs.write(relayPath('tmp/case-probe'), token)
    const upper = relayPath('tmp/CASE-PROBE')
    const seen = (await $.fs.exists(upper)) ? String(await $.fs.read(upper)) : ''
    return { caseInsensitive: seen === token }
  } catch {
    return {}
  }
}

// ── git: working folder and write check ─────────────────────────────────

async function git($: EngineInterface, dir: string, args: string[], stdin?: string) {
  try {
    return await $.process.run(['git', ...args], { cwd: dir, timeoutMs: 60_000, ...(stdin !== undefined ? { stdin } : {}) })
  } catch (err) {
    return { exitCode: 1, stdout: '', stderr: String(err) }
  }
}

async function isGitRepo($: EngineInterface, dir: string) {
  const r = await git($, dir, ['rev-parse', '--is-inside-work-tree'])
  return r.exitCode === 0 && r.stdout.trim() === 'true'
}

type Workdir = { dir: string; isGit: boolean; worktree?: { path: string; branch: string }; error?: string }

async function realOf($: EngineInterface, path: string) {
  return (await $.fs.stat(path, { resolve: true }).catch(() => undefined))?.realPath
}

// Why the folder at `rel` is not the role's own worktree, or undefined: it
// must resolve to its place inside the project, be no link, be registered with
// this repository and stand on the role's branch.
async function worktreeProblem($: EngineInterface, rel: string, branch: string): Promise<string | undefined> {
  const root = await realOf($, cwd)
  if (!root) return 'the project folder could not be resolved'
  const want = `${root.replace(/[\\/]+$/, '')}/${rel}`
  const st = await $.fs.stat(rel, { resolve: true }).catch(() => undefined)
  if (!st) return `${rel} does not exist`
  if (st.isLink) return `${rel} is a link; relay only works in a worktree it created inside the project`
  if (st.kind !== 'dir') return `${rel} is no folder`
  if (!st.realPath || !isSamePath(st.realPath, want, pathCase)) return `${rel} resolves to ${st.realPath ?? 'nowhere'}, not to ${want}`
  const list = await git($, cwd, ['worktree', 'list', '--porcelain', '-z'])
  if (list.exitCode !== 0) return `git worktree list failed (${list.stderr.trim().slice(0, 200)})`
  const entry = parseWorktreeList(list.stdout).find(e => isSamePath(e.path, want, pathCase))
  if (!entry) return `${rel} is not a registered worktree of this repository`
  if (entry.branch !== `refs/heads/${branch}`) {
    return `${rel} is on ${entry.branch ? entry.branch.replace(/^refs\/heads\//, '') : 'a detached HEAD'}, not on ${branch}`
  }
  return undefined
}

// The folder a run works in: the project, or the role's own worktree. A
// worktree that was asked for and cannot be had fails the run before it
// starts (contract 0001, Nachtrag 1).
async function workdirOf($: EngineInterface, role: string, isolation: Isolation): Promise<Workdir> {
  const isGit = await isGitRepo($, cwd)
  if (isolation !== 'worktree') return { dir: cwd, isGit }
  if (!isGit) return { dir: cwd, isGit, error: 'it needs a git repository, and the project is none' }
  const rel = relayPath(`worktrees/${role}`)
  const branch = `relay/${role}`
  if (await $.fs.exists(config.relayDir)) {
    const root = await realOf($, cwd)
    const real = await realOf($, config.relayDir)
    if (!root || !real || !isSamePath(real, `${root.replace(/[\\/]+$/, '')}/${config.relayDir}`, pathCase)) {
      return { dir: cwd, isGit, error: `${config.relayDir} resolves to ${real ?? 'nowhere'}, outside the project` }
    }
  }
  if (!(await $.fs.exists(rel))) {
    await ensureGitignore($)
    const hasBranch = (await git($, cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).exitCode === 0
    const path = absolute(rel)
    const r = await git($, cwd, hasBranch ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path])
    if (r.exitCode !== 0) return { dir: cwd, isGit, error: `git worktree add failed (${r.stderr.trim().slice(0, 300)})` }
  }
  const problem = await worktreeProblem($, rel, branch)
  if (problem) return { dir: cwd, isGit, error: problem }
  return { dir: absolute(rel), isGit: true, worktree: { path: rel, branch } }
}

const isHash = (h: string | undefined): h is string => !!h && /^[0-9A-Za-z]+$/.test(h)

// git hash-object for each path; a path git cannot hash is left out. Paths
// with a line break cannot go through --stdin-paths and go one by one, and so
// does every path when the batch fails (a submodule makes it stop early).
async function hashPaths($: EngineInterface, dir: string, paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const batch = paths.filter(p => !/[\r\n]/.test(p))
  let single = paths.filter(p => /[\r\n]/.test(p))
  if (batch.length) {
    const r = await git($, dir, ['hash-object', '--stdin-paths'], `${batch.join('\n')}\n`)
    const hashes = r.stdout.split(/\r?\n/).filter(Boolean)
    if (r.exitCode === 0 && hashes.length === batch.length && hashes.every(isHash)) batch.forEach((p, i) => out.set(p, hashes[i] as string))
    else single = [...batch, ...single]
  }
  for (const p of single) {
    const r = await git($, dir, ['hash-object', '--', p])
    const h = r.stdout.trim()
    if (r.exitCode === 0 && isHash(h)) out.set(p, h)
  }
  return out
}

async function takeSnapshot($: EngineInterface, dir: string): Promise<Snapshot | undefined> {
  const head = await git($, dir, ['rev-parse', 'HEAD'])
  const status = await git($, dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (status.exitCode !== 0) return undefined
  const prefix = `${config.relayDir}/`
  const isMine = (p: string) => !p.startsWith(prefix)
  const dirty: Record<string, string> = {}
  const present: { path: string; code: string }[] = []
  for (const e of parsePorcelain(status.stdout)) {
    // A rename moves its source away: that is a deletion there.
    if (e.orig && e.code.includes('R') && isMine(e.orig)) dirty[e.orig] = 'deleted'
    if (!isMine(e.path)) continue
    if (e.code.includes('D')) dirty[e.path] = 'deleted'
    else present.push(e)
  }
  const hashes = await hashPaths($, dir, present.map(e => e.path))
  for (const e of present) {
    const h = hashes.get(e.path)
    const isNew = e.code === '??' || /^[ARC]/.test(e.code)
    dirty[e.path] = h === undefined ? UNHASHED : isNew ? `new:${h}` : h
  }
  return { head: head.exitCode === 0 ? head.stdout.trim() : '', dirty }
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

// The tree an unborn HEAD stands for, in the repository's own hash format.
async function emptyTree($: EngineInterface, dir: string) {
  const r = await git($, dir, ['hash-object', '-t', 'tree', '--stdin'], '')
  const h = r.stdout.trim()
  return r.exitCode === 0 && isHash(h) ? h : EMPTY_TREE
}

async function writeCheckOf($: EngineInterface, role: string, owns: string[], dir: string, before: Snapshot | undefined, isGit: boolean): Promise<WriteCheck> {
  const none = (reason: string, isGap: boolean): WriteCheck => ({
    checked: false,
    reason,
    changed: [],
    outside: [],
    unattributed: [],
    byOtherRole: [],
    ...(isGap ? { incomplete: [reason] } : {}),
  })
  if (!before) return none(isGit ? 'git status failed before the run' : 'no snapshot before the run', isGit)
  const after = await takeSnapshot($, dir)
  if (!after) return none('git status failed after the run', true)
  let committed: { path: string; change: Change }[] = []
  const gaps: string[] = []
  if (before.head !== after.head) {
    // A first commit has no parent: compare it with the empty tree.
    const empty = before.head && after.head ? '' : await emptyTree($, dir)
    const r = await git($, dir, ['diff', '--name-status', '-z', before.head || empty, after.head || empty])
    if (r.exitCode === 0) committed = parseNameStatus(r.stdout)
    else gaps.push(`git diff of the commits made during the run failed (${r.stderr.trim().slice(0, 200)}); what they changed is unknown`)
  }
  // Roles in their own worktree cannot have written here.
  const others = Object.values(roles)
    .filter(r => r.isBusy && r.name !== role && runningIn[r.name] === dir)
    .map(r => ({ role: r.name, owns: ownsOf[r.name] ?? [] }))
  const check = compareSnapshots(before, after, committed, owns, others, pathCase)
  if (gaps.length) check.incomplete = [...(check.incomplete ?? []), ...gaps]
  return check
}

// Where each busy role runs and what it owns, for attributing changes.
const runningIn: Record<string, string> = {}
const ownsOf: Record<string, string[]> = {}

// ── runs ────────────────────────────────────────────────────────────────

// Starts queued jobs while there is room and their role is idle. One pump at
// a time; a call while one runs makes it look again before it ends.
let pumping: Promise<void> | undefined
let isPumpAsked = false
function pump($: EngineInterface): Promise<void> {
  if (pumping) {
    isPumpAsked = true
    return pumping
  }
  pumping = (async () => {
    try {
      do {
        isPumpAsked = false
        await pumpOnce($)
      } while (isPumpAsked)
    } finally {
      pumping = undefined
      showStatus($)
    }
  })()
  return pumping
}

async function pumpOnce($: EngineInterface) {
  while (isOwner && running < Math.max(1, config.maxParallel)) {
    const job = queue.jobs.find(j => j.state === 'queued' && roles[j.role] && !roles[j.role]?.isBusy)
    const role = job && roles[job.role]
    if (!job || !role) break
    // Reserved before the first await: the job, its role and the slot.
    const run = role.runs + 1
    role.isBusy = true
    role.runs = run
    running++
    job.state = 'running'
    job.run = run
    if (!(await start($, job, role, run))) break
  }
}

async function iso($: EngineInterface) {
  return new Date(await $.clock.now()).toISOString()
}

function snapshotPath(role: string, run: number) {
  return relayPath(`tmp/${role}-${run}.snapshot.json`)
}

// Starts a reserved job; false (and the reservation undone) when the queue
// could not be persisted, so nothing runs that the file does not know.
async function start($: EngineInterface, job: QueuedJob, role: Role, run: number): Promise<boolean> {
  let eff: ReturnType<typeof effective>
  try {
    eff = effective(role, (await loadRoleDefs($))[role.name])
    job.startedAt = await iso($)
    ownsOf[role.name] = eff.owns
    await save($)
    await writeQueue($)
  } catch (err) {
    role.isBusy = false
    role.runs = run - 1
    running--
    job.state = 'queued'
    delete job.run
    delete job.startedAt
    delete ownsOf[role.name]
    await save($).catch(() => undefined)
    dispatchError = err instanceof NotOwnerError ? 'another session took over the queue' : message(err)
    if (!(err instanceof NotOwnerError)) {
      notices.push(`relay could not persist the queue before starting ${role.name} (${dispatchError}); the job stays queued and starts once the queue can be written.`)
    }
    return false
  }
  dispatchError = undefined
  showStatus($)

  // The backend the job was queued for, not the role's latest one.
  const id = job.backend
  const backend = BACKENDS[id]
  const model = job.model ?? (id === eff.backend ? eff.model : id === 'claude' ? config.workerModel : '')

  // The child outlives the tool call that queued it: this loop runs on.
  void (async () => {
    const proc: ProcessResult = { stdout: '', stderr: '', isTimedOut: false, isStoppedByLimit: false }
    let outcome: RunOutcome = { answer: '', usage: {} }
    let check: WriteCheck | undefined
    let inv: Invocation | undefined
    let notStarted: string | undefined
    const notes: string[] = []
    const live = liveLog($, role.name, run, id)
    let work: Workdir = { dir: cwd, isGit: false }
    try {
      work = await workdirOf($, role.name, eff.isolation)
      if (work.error) {
        notStarted = `isolation "worktree" could not be set up: ${work.error}`
        outcome = { answer: '', usage: {}, error: { kind: 'cli', message: notStarted } }
      } else {
        runningIn[role.name] = work.dir
        await checkVersion($, id)
        const before = config.writeCheck === 'report' && work.isGit ? await takeSnapshot($, work.dir) : undefined
        if (before) await $.fs.write(snapshotPath(role.name, run), JSON.stringify(before))

        const isNew = role.sessionId === undefined || sessionBackendOf(role) !== id
        const spec: LaunchSpec = {
          role: role.name,
          run,
          task: job.task,
          protocol: protocolPrompt(role.name, eff.brief, eff.owns),
          isNew,
          ...(isNew ? {} : { sessionId: role.sessionId }),
          ...(model ? { model } : {}),
          effort: eff.effort,
          owns: eff.owns,
          allowedTools: eff.allowedTools,
          disallowedTools: eff.disallowedTools,
          cwd: work.dir,
          isGitRepo: work.isGit,
          bin: binOf(id),
          settings: {
            permissionMode: config.permissionMode,
            maxBudgetUsd: config.maxBudgetUsd,
            codexSandbox: config.codexSandbox,
            opencodeStandalone: config.opencodeStandalone,
            tmpDir: absolute(relayPath('tmp')),
          },
        }
        try {
          inv = backend.build(spec)
        } catch (err) {
          outcome = { answer: '', usage: {}, error: { kind: 'model', message: message(err) } }
        }
        if (inv) {
          if (inv.presetSessionId) {
            role.sessionId = inv.presetSessionId
            role.sessionBackend = id
            await save($)
          }
          for (const f of inv.tempFiles ?? []) await $.fs.write(f.path, f.content)
          await spawnRun($, role.name, eff.owns, work.dir, inv, backend.onLine?.bind(backend), proc, live)
          for (const f of inv.tempFiles ?? []) await $.fs.write(f.path, '').catch(() => undefined)
          outcome = backend.parse(proc)
          if (!outcome.answer.trim() && !proc.stdout.trim() && proc.exitCode === undefined && outcome.error?.kind === 'cli') {
            outcome.error.message += ` · could not start ${inv.argv[0]}; set ${id}Bin to the full path of the executable`
          }
        }
        check = config.writeCheck === 'report' ? await writeCheckOf($, role.name, eff.owns, work.dir, before, work.isGit) : undefined
      }
    } catch (err) {
      proc.stderr += `\n${String(err)}`
      outcome.error ??= { kind: 'unknown', message: redact(String(err)).slice(0, 500) }
    }
    delete runningIn[role.name]
    running--
    try {
      await finish($, { role, run, job, id, model: model || outcome.usage.model || '', outcome, proc, check, work, notes, notStarted, presetSessionId: inv?.presetSessionId })
      await live.close(outcome, proc)
    } catch (err) {
      // The report itself failed: free the role, drop the job, say so.
      role.isBusy = false
      queue.jobs = queue.jobs.filter(j => j.id !== job.id)
      await writeQueue($).catch(() => undefined)
      notices.push(redact(`relay could not store or deliver ${role.name} run ${run} (${message(err)}).`))
    } finally {
      await pump($)
    }
  })()
  return true
}

// Starts the child and reads it to its end; stops it at the timeout or the
// token limit.
async function spawnRun(
  $: EngineInterface,
  role: string,
  owns: string[],
  dir: string,
  inv: Invocation,
  onLine: ((line: string, acc: Usage) => Usage) | undefined,
  proc: ProcessResult,
  live: ReturnType<typeof liveLog>,
) {
  const env: Record<string, string> = { RELAY_WORKER: '1', RELAY_CWD: dir }
  if (config.enforceOwns && owns.length) {
    env.RELAY_OWNS = JSON.stringify(owns)
    env.RELAY_OWNS_CASE = pathCase.caseInsensitive ? 'insensitive' : 'sensitive'
  }
  const child = $.process.spawn({ argv: inv.argv, cwd: dir, ...(inv.input !== undefined ? { input: inv.input } : {}), env: { ...env, ...inv.env } })
  const stop = () => void child.return(undefined as never)
  const timer =
    config.runTimeoutMin > 0
      ? $.clock.after(config.runTimeoutMin * 60_000, () => {
          proc.isTimedOut = true
          stop()
        })
      : undefined
  let usage: Usage = {}
  let rest = ''
  try {
    for (;;) {
      const step = await child.next()
      if (step.done) {
        proc.exitCode = step.value?.code ?? undefined
        break
      }
      const chunk = step.value
      if (chunk.stream === 'stderr') {
        proc.stderr += chunk.text
        continue
      }
      proc.stdout += chunk.text
      const lines = (rest + chunk.text).split('\n')
      rest = lines.pop() ?? ''
      for (const line of lines) {
        live.line(line)
        if (onLine) usage = onLine(line, usage)
      }
      if (config.maxTokensPerRun > 0 && onLine && totalTokens(usage) > config.maxTokensPerRun && !proc.isStoppedByLimit) {
        proc.isStoppedByLimit = true
        stop()
      }
    }
  } catch (err) {
    if (!proc.isTimedOut && !proc.isStoppedByLimit) proc.stderr += `\n${String(err)}`
  }
  if (rest) live.line(rest)
  timer?.cancel()
}

// <relayDir>/runs/<role>/live.log: one readable line per event, written in
// batches (the plugin API cannot append). Every line is redacted first.
function liveLog($: EngineInterface, role: string, run: number, id: BackendId) {
  const path = relayPath(`runs/${role}/live.log`)
  const lines = [`# ${role} · run ${run} · ${id} · started ${new Date().toISOString()}`]
  let flushedAt = 0
  const flush = async () => {
    flushedAt = Date.now()
    await $.fs.write(path, `${lines.join('\n')}\n`).catch(() => undefined)
  }
  void flush()
  return {
    line(raw: string) {
      if (id === 'claude') return
      const text = liveLine(id, raw)
      if (!text) return
      lines.push(redact(text))
      if (Date.now() - flushedAt >= 2000) void flush()
    },
    async close(outcome: RunOutcome, proc: ProcessResult) {
      const state = proc.isTimedOut ? 'stopped (timeout)' : proc.isStoppedByLimit ? 'stopped (token limit)' : outcome.error ? `error: ${outcome.error.message}` : 'finished'
      lines.push(redact(`# ${state} · ${new Date().toISOString()}`))
      await flush()
    },
  }
}

async function checkVersion($: EngineInterface, id: BackendId) {
  if (versions[id] !== undefined) return
  versions[id] = ''
  try {
    const r = await $.process.run(BACKENDS[id].versionArgv(binOf(id)), { timeoutMs: 15_000 })
    const v = versionOf(`${r.stdout} ${r.stderr}`)
    if (!v) return
    versions[id] = v
    if (majorOf(v) !== majorOf(CHECKED_VERSIONS[id])) {
      notices.push(`${id} ${v} differs from the checked version ${CHECKED_VERSIONS[id]}; runs still start, but its output format may have changed.`)
    }
  } catch {
    // the run itself reports a missing program
  }
}

type RunResult = {
  role: Role
  run: number
  job: QueuedJob
  id: BackendId
  model: string
  outcome: RunOutcome
  proc: ProcessResult
  check?: WriteCheck
  work: Workdir
  notes: string[]
  // Why the worker never started (its working folder could not be had).
  notStarted?: string
  presetSessionId?: string
}

function failedPacket(summary: string): Packet {
  return {
    status: 'failed',
    summary,
    decisions: [],
    facts: [],
    artifacts: [],
    open_questions: [],
    needs_from_main: [],
    risks: [],
    next_suggested: [],
    sections: [],
    compressed_by: 'none',
  }
}

// Builds the packet when the worker forgot it: Haiku, an ollama model, or none.
async function compress($: EngineInterface, role: string, answer: string): Promise<{ packet?: Packet; by?: string }> {
  const backend = !config.fallbackCompress ? 'off' : config.fallbackBackend
  if (backend === 'claude') {
    const r = await $.model.complete({ model: config.fallbackModel, system: fallbackPrompt(role), prompt: answer })
    return { packet: r.isAnswered ? parsePacket(r.text) : undefined, by: config.fallbackModel }
  }
  if (backend === 'ollama' && config.ollamaModel.trim()) {
    try {
      const r = await $.process.run(ollamaArgv(parseBin(config.ollamaBin, 'ollama'), config.ollamaModel.trim()), {
        stdin: `${fallbackPrompt(role)}\n\n---\n${answer}`,
        timeoutMs: 120_000,
      })
      return { packet: r.exitCode === 0 ? parsePacket(r.stdout) : undefined, by: `ollama/${config.ollamaModel.trim()}` }
    } catch {
      return { by: `ollama/${config.ollamaModel.trim()}` }
    }
  }
  return {}
}

function headMeta(r: RunResult): string {
  const u = r.outcome.usage
  const parts: string[] = [r.id]
  if (r.id === 'claude') {
    const inner = [u.turns !== undefined ? `${u.turns} turns` : '', u.costUsd !== undefined ? `$${u.costUsd.toFixed(2)}` : '']
      .filter(Boolean)
      .join(', ')
    if (inner) parts.push(inner)
  } else {
    if (r.model) parts.push(r.model)
    const used = usageText(u, BACKENDS[r.id].capabilities.usage)
    if (used) parts.push(used)
  }
  const tail = [
    r.notStarted ? 'not started' : r.outcome.error ? (r.id === 'claude' ? r.outcome.error.message : `error (${r.outcome.error.kind})`) : '',
    r.proc.isTimedOut ? `stopped after ${config.runTimeoutMin} min` : '',
    r.proc.isStoppedByLimit ? `stopped at ${tokens(totalTokens(u))} tokens` : '',
  ].filter(Boolean)
  return [parts.join(' · '), ...tail].join(', ')
}

async function finish($: EngineInterface, r: RunResult) {
  const { role, run, outcome, proc } = r
  const answer = outcome.answer
  let packet = parsePacket(answer)
  let compressedBy: string | undefined
  if (packet) packet.compressed_by = 'worker'
  else if (answer.trim()) {
    const c = await compress($, role.name, answer)
    packet = c.packet
    if (packet) {
      packet.compressed_by = 'fallback'
      compressedBy = c.by
    }
  }
  const isGone = outcome.error?.kind === 'session-not-found'
  packet ??= failedPacket(
    r.notStarted
      ? `Worker was not started: ${r.notStarted}.`
      : isGone
        ? `The worker's ${r.id} session is gone; the next task for this role starts fresh. (${outcome.error?.message ?? ''})`
        : proc.isTimedOut
          ? `Worker was stopped after ${config.runTimeoutMin} minutes without a packet.`
          : proc.isStoppedByLimit
            ? `Worker was stopped at the token limit (${config.maxTokensPerRun}) without a packet.`
            : answer.trim()
              ? 'Worker answered without a relay packet (fallback compression is off or failed); read the full text.'
              : outcome.error
                ? `Worker failed (${outcome.error.kind}): ${outcome.error.message}`
                : `Worker produced no usable answer.${proc.stderr.trim() ? ` stderr: ${redact(proc.stderr.trim()).slice(0, 500)}` : ''}`,
  )
  if ((proc.isTimedOut || proc.isStoppedByLimit || outcome.error?.kind === 'budget') && packet.status === 'done') packet.status = 'partial'

  // The role's session for its next run; a run that never started keeps it.
  if (isGone) {
    role.sessionId = undefined
    role.sessionBackend = undefined
  } else if (!r.notStarted) {
    const next = outcome.sessionId ?? r.presetSessionId ?? (sessionBackendOf(role) === r.id ? role.sessionId : undefined)
    role.sessionId = next
    role.sessionBackend = next ? r.id : undefined
    if (!next && r.id !== 'claude') packet.risks.push(`No ${r.id} session id was reported; the next task for ${role.name} starts a fresh session.`)
  }

  if (r.check) applyWriteCheck(packet, r.check)
  if (r.work.worktree && (!r.check || r.check.changed.length)) {
    packet.needs_from_main.push(`The changes are on branch ${r.work.worktree.branch} (worktree ${r.work.worktree.path}); relay does not merge them.`)
  }
  for (const n of r.notes) packet.risks.push(n)

  role.totals = sumUsage(role.totals ?? {}, outcome.usage)
  const outside = r.check?.outside.length ?? 0
  let head = `[relay] ${role.name} · run ${run} finished (${headMeta(r)})`
  if (compressedBy) head += ` (packet built by fallback compressor ${compressedBy})`
  if (outside) head += ` ⚠ wrote outside owns (${outside})`
  if (r.check?.incomplete?.length) head += ' ⚠ write check incomplete'
  await deliver($, role, run, r.job, answer, packet, head, { backend: r.id, usage: outcome.usage })
}

// Stores the run's files, updates the role, drops the job and reports. All
// that leaves relay here is redacted (contract 0001, Nachtrag 1).
async function deliver(
  $: EngineInterface,
  role: Role,
  run: number,
  job: QueuedJob,
  answer: string,
  raw: Packet,
  rawHead: string,
  extra: { backend: BackendId; usage: Usage },
) {
  const packet = redactDeep(raw)
  const head = redact(rawHead)
  await ensureGitignore($)
  const fullPath = runPath(role.name, run, 'full.md')
  await $.fs.write(fullPath, `# ${role.name} · run ${run}\n\n## Task\n\n${redact(job.task)}\n\n## Answer\n\n${redact(stripPacket(answer))}\n`)
  await $.fs.write(runPath(role.name, run, 'packet.json'), JSON.stringify({ run, backend: extra.backend, usage: extra.usage, ...packet }, null, 2))

  role.isBusy = false
  role.lastStatus = packet.status
  role.lastSummary = packet.summary
  roles[role.name] = role
  await save($)
  queue.jobs = queue.jobs.filter(j => j.id !== job.id)
  await writeQueue($).catch(err => {
    if (!(err instanceof NotOwnerError)) notices.push(`relay could not write the queue after ${role.name} run ${run} (${message(err)}).`)
  })

  const text = renderPacket(head, packet, fullPath, config.packetDetail)
  if (config.notifyMode === 'note') {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
    $.ui.toast(`relay: ${role.name} run ${run} ${packet.status}`)
  } else if (config.notifyMode === 'toast') {
    unread.push(text)
    $.ui.toast(`relay: ${role.name} run ${run} ${packet.status} – worker_status shows it`)
  } else {
    await $.prompt.submit({ text })
  }
}

// A job the file still marks running died with the last module: report it
// as failed, with the write check against its snapshot, and never restart it.
// Returns why it could not be reported, or undefined once it was (the job
// then left the queue).
async function reportInterrupted($: EngineInterface, job: QueuedJob): Promise<string | undefined> {
  const defs = await loadRoleDefs($)
  let role = roles[job.role]
  if (!role && defs[job.role]) role = roles[job.role] = { name: job.role, runs: job.run ?? 0, isBusy: false }
  if (!role) return 'orphaned: the role exists neither in the store nor in the roles file'
  const run = job.run ?? role.runs
  role.runs = Math.max(role.runs, run)
  const eff = effective(role, defs[role.name])
  const packet = failedPacket('Interrupted: the plugin was reloaded or the session ended while this run was working. It was not restarted.')
  if (config.writeCheck === 'report') {
    let before: Snapshot | undefined
    try {
      before = JSON.parse(await $.fs.read(snapshotPath(role.name, run))) as Snapshot
    } catch {
      before = undefined
    }
    const dir = eff.isolation === 'worktree' ? absolute(relayPath(`worktrees/${role.name}`)) : cwd
    applyWriteCheck(packet, await writeCheckOf($, role.name, eff.owns, dir, before, false))
  }
  await deliver($, role, run, job, '', packet, `[relay] ${role.name} · run ${run} interrupted (${job.backend})`, { backend: job.backend, usage: {} })
  return undefined
}

// A worker may only write what it owns, when the main agent asked for that.
function denyUnowned(path: string | undefined) {
  const reason = ownershipDenial(path, workerCwd, workerOwns, workerCase)
  return reason ? { deny: `relay: ${reason}` } : undefined
}

function roleLine(name: string, r: Role | undefined, def: RoleDef | undefined) {
  const eff = effective(r ?? { name, runs: 0, isBusy: false }, def)
  const waiting = queue.jobs.filter(j => j.role === name && j.state === 'queued').length
  const state = r?.isBusy ? 'working' : waiting ? 'queued' : r ? 'idle' : 'defined, never run'
  const total = r?.totals ? usageText(r.totals, BACKENDS[eff.backend].capabilities.usage) : ''
  const ignored = ignoredRules(eff.backend, eff)
  return (
    `${name}: ${state}${waiting ? ` (${waiting} waiting)` : ''}, ${r?.runs ?? 0} run(s)` +
    (r?.lastStatus ? `, last ${r.lastStatus}: ${r.lastSummary ?? ''}` : '') +
    ` · ${eff.backend}${versions[eff.backend] ? ` ${versions[eff.backend]}` : ''}` +
    (eff.model ? ` · ${eff.model}` : '') +
    (eff.isolation === 'worktree' ? ' · worktree' : '') +
    (eff.owns.length ? ` · owns ${eff.owns.join(', ')}` : '') +
    (total ? ` · total ${total}` : '') +
    (ignored.length ? ` · ignored: ${ignored.join(', ')}` : '')
  )
}

export const register: Register = (on, options) => {
  const str = (k: string, d: string) => (typeof options[k] === 'string' ? String(options[k]) : d)
  const num = (k: string, d: number) => (typeof options[k] === 'number' ? Number(options[k]) : d)
  const bool = (k: string, d: boolean) => (typeof options[k] === 'boolean' ? Boolean(options[k]) : d)
  configNotes = []
  config.claudeBin = str('claudeBin', config.claudeBin)
  config.permissionMode = str('permissionMode', config.permissionMode)
  config.workerModel = str('workerModel', config.workerModel).trim()
  config.workerEffort = str('workerEffort', config.workerEffort)
  config.maxBudgetUsd = num('maxBudgetUsd', config.maxBudgetUsd)
  config.maxParallel = num('maxParallel', config.maxParallel)
  config.runTimeoutMin = num('runTimeoutMin', config.runTimeoutMin)
  config.allowedTools = toList(options.allowedTools)
  config.disallowedTools = toList(options.disallowedTools)
  config.enforceOwns = bool('enforceOwns', config.enforceOwns)
  config.notifyMode = str('notifyMode', config.notifyMode)
  config.packetDetail = str('packetDetail', config.packetDetail) === 'lean' ? 'lean' : 'full'
  config.fallbackCompress = bool('fallbackCompress', config.fallbackCompress)
  config.fallbackModel = str('fallbackModel', config.fallbackModel)
  const relayDir = safeRelayDir(str('relayDir', config.relayDir))
  config.relayDir = relayDir.dir
  if (relayDir.note) configNotes.push(relayDir.note)
  config.rolesFile = str('rolesFile', config.rolesFile).trim() || `${config.relayDir}/roles.json`
  config.gitignore = bool('gitignore', config.gitignore)
  config.keepRuns = num('keepRuns', config.keepRuns)
  const backend = str('defaultBackend', config.defaultBackend)
  config.defaultBackend = isBackend(backend) ? backend : 'claude'
  config.codexBin = str('codexBin', config.codexBin)
  config.codexSandbox = str('codexSandbox', config.codexSandbox) === 'read-only' ? 'read-only' : 'workspace-write'
  config.opencodeBin = str('opencodeBin', config.opencodeBin)
  config.opencodeStandalone = bool('opencodeStandalone', config.opencodeStandalone)
  config.writeCheck = str('writeCheck', config.writeCheck) === 'off' ? 'off' : 'report'
  config.isolation = str('isolation', config.isolation) === 'worktree' ? 'worktree' : 'shared'
  config.maxTokensPerRun = num('maxTokensPerRun', config.maxTokensPerRun)
  const fb = str('fallbackBackend', config.fallbackBackend)
  config.fallbackBackend = fb === 'ollama' || fb === 'off' ? fb : 'claude'
  config.ollamaModel = str('ollamaModel', config.ollamaModel)
  config.ollamaBin = str('ollamaBin', config.ollamaBin)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // A worker session must not become an orchestrator itself; it only
    // carries the ownership guard.
    if ((await $.env.get('RELAY_WORKER')) === '1') {
      workerCwd = (await $.env.get('RELAY_CWD')) ?? e.cwd
      workerCase = { caseInsensitive: (await $.env.get('RELAY_OWNS_CASE')) === 'insensitive' }
      try {
        workerOwns = toList(JSON.parse((await $.env.get('RELAY_OWNS')) ?? '[]'))
      } catch {
        workerOwns = []
      }
      return started
    }
    cwd = e.cwd
    session = started?.sessionId ?? (await $.session.id().catch(() => '')) ?? ''
    roles = ((await $.store.get(storeKey())) as Record<string, Role> | undefined) ?? {}
    // Children die with the module: a role still marked busy is stale.
    for (const r of Object.values(roles)) r.isBusy = false
    running = 0
    notices = [...configNotes]
    heartbeat?.cancel()
    heartbeat = undefined
    isOwner = false
    ownerToken = ''
    queueError = undefined
    dispatchError = undefined
    unreported.clear()
    pathCase = await probeCase($)

    let loaded: Awaited<ReturnType<typeof readQueue>> | undefined
    try {
      loaded = await readQueue($)
    } catch (err) {
      queueError = `${relayPath('queue.json')} could not be read (${message(err)})`
      notices.push(`${queueError}; this session does not work the queue, so nothing in it is lost or overwritten.`)
    }
    if (loaded?.isBroken) notices.push(loaded.isFromBackup ? 'queue.json was broken; relay read queue.json.bak instead.' : 'queue.json was broken and had no usable backup; the queue starts empty.')
    queue = loaded?.queue ?? emptyQueue()
    lastQueueText = loaded && !loaded.isBroken ? loaded.text : undefined
    await save($)

    await $.tool.register({
      name: 'worker_send',
      isDeferred: false,
      description:
        'Send a task to a persistent worker session (its own Claude Code, Codex or OpenCode session, started via CLI). ' +
        'Returns immediately; the worker runs in the background (or waits in the queue) and its compact relay packet arrives later. ' +
        'The same role keeps its context across tasks unless fresh is true. Roles may be predefined in the roles file; ' +
        'brief/owns/model/effort/tools/backend/isolation given here are stored for the role and win over the file.',
      inputSchema: {
        type: 'object',
        properties: {
          role: { type: 'string', description: 'Role name, e.g. ingester, architect, researcher (lowercase).' },
          task: { type: 'string', description: 'The task, self-contained: what to do and what done looks like.' },
          brief: { type: 'string', description: 'Standing role description; stored.' },
          owns: { type: 'array', items: { type: 'string' }, description: 'Paths this role may write; stored and enforced.' },
          model: { type: 'string', description: 'Model for this role in the format of its backend (opencode: provider/model); stored.' },
          effort: { type: 'string', enum: ['default', 'low', 'medium', 'high', 'xhigh', 'max'], description: 'Effort for this role; stored.' },
          allowedTools: { type: 'array', items: { type: 'string' }, description: 'Tool rules allowed without asking; stored.' },
          disallowedTools: { type: 'array', items: { type: 'string' }, description: 'Tool rules the role may never use; stored.' },
          backend: { type: 'string', enum: [...BACKEND_IDS], description: 'Worker CLI for this role; stored. Changing it drops the old session.' },
          isolation: { type: 'string', enum: ['shared', 'worktree'], description: 'shared: the project folder. worktree: its own git worktree on branch relay/<role>. Stored.' },
          fresh: { type: 'boolean', description: 'Start a new worker session, dropping the old context.' },
        },
        required: ['role', 'task'],
      },
    })
    await $.tool.register({
      name: 'worker_status',
      isDeferred: false,
      description:
        'List worker roles (stored and from the roles file): working, queued or idle, runs, last status, backend and usage. ' +
        'Also returns packets that arrived unread (notify mode "toast").',
      inputSchema: { type: 'object', properties: {} },
    })
    await $.tool.register({
      name: 'worker_expand',
      isDeferred: false,
      description:
        "Fetch details behind a relay packet: one section of a worker run's full answer by heading, " +
        'section "packet" for the complete packet, or the whole answer. Prefer a section; the full text costs context.',
      inputSchema: {
        type: 'object',
        properties: {
          role: { type: 'string' },
          run: { type: 'number', description: 'Run number; latest when absent.' },
          section: { type: 'string', description: 'Heading to fetch (as listed under sections), or "packet".' },
          maxChars: { type: 'number', description: 'Cut-off, default 12000.' },
        },
        required: ['role'],
      },
    })

    // The claim settles in the background; worker_send waits for it.
    claim = loaded && mayOwn(queue, session, await $.clock.now()) ? claimQueue($) : Promise.resolve()
    showStatus($)
    return started
  })

  on('tool.call', { tool: 'Edit' }, ($, e, next) => denyUnowned(e.file_path) ?? next(e)).catch(($, e, next) =>
    next.called ? next(e) : { deny: 'relay: the ownership guard failed.' },
  )
  on('tool.call', { tool: 'Write' }, ($, e, next) => denyUnowned(e.file_path) ?? next(e)).catch(($, e, next) =>
    next.called ? next(e) : { deny: 'relay: the ownership guard failed.' },
  )
  on('tool.call', { tool: 'NotebookEdit' }, ($, e, next) => denyUnowned(e.notebook_path) ?? next(e)).catch(($, e, next) =>
    next.called ? next(e) : { deny: 'relay: the ownership guard failed.' },
  )

  on('tool.call', { tool: 'mcp__relay__worker_status' }, async $ => {
    const defs = await loadRoleDefs($)
    if (!isOwner && !queueError) {
      try {
        queue = (await readQueue($)).queue
      } catch (err) {
        notices.push(`${relayPath('queue.json')} could not be read (${message(err)}).`)
      }
    }
    const names = [...new Set([...Object.keys(roles), ...Object.keys(defs)])].sort()
    const lines = names.map(name => roleLine(name, roles[name], defs[name]))
    const out = [
      lines.length ? lines.join('\n') : 'No worker roles yet. Create one with worker_send or in the roles file.',
      `Running ${running}/${Math.max(1, config.maxParallel)}, queued ${queued().length}.`,
    ]
    const now = await $.clock.now()
    for (const j of queued()) {
      const waited = Math.max(0, Math.round((now - Date.parse(j.enqueuedAt)) / 60_000))
      const orphan = !roles[j.role] && !defs[j.role]
      out.push(`- queued ${j.role} (${j.backend}) for ${waited} min${orphan ? ' · orphaned: the role exists neither in the store nor in the roles file' : ''}`)
    }
    for (const j of queue.jobs.filter(x => x.state === 'running' && unreported.has(x.id))) {
      out.push(`- interrupted ${j.role} run ${j.run ?? '?'} (${j.backend}), not reported yet · ${unreported.get(j.id)}; kept in the queue, reported at the next start`)
    }
    if (!isOwner) out.push(queueError ? `This session does not work the queue: ${queueError}.` : "This project's queue is worked by another session; this one only reads it.")
    if (notices.length) {
      out.push('', ...notices.map(n => `Note: ${n}`))
      notices = []
    }
    if (unread.length) {
      out.push('', `Unread packets (${unread.length}):`, '', unread.join('\n\n'))
      unread = []
    }
    return { result: redact(out.join('\n')) }
  })

  on('tool.call', { tool: 'mcp__relay__worker_expand' }, async ($, e) => {
    const input = e as unknown as { role: string; run?: number; section?: string; maxChars?: number }
    const role = roles[input.role]
    if (!role || role.runs === 0) return { result: `No runs for role "${input.role}".` }
    const run = input.run ?? (role.isBusy ? role.runs - 1 : role.runs)
    if (run < 1) return { result: `${role.name} has no finished run yet.` }
    if (isRotatedOut(role, run)) return { result: `${role.name} run ${run} was rotated out (keepRuns ${config.keepRuns}).` }
    if (input.section?.trim().toLowerCase() === 'packet') {
      try {
        const packet = parsePacket(await $.fs.read(runPath(role.name, run, 'packet.json')))
        if (packet) return { result: renderPacket(`[relay] ${role.name} · run ${run}`, packet, runPath(role.name, run, 'full.md'), 'full') }
      } catch {
        // fall through
      }
      return { result: `No stored packet for ${role.name} run ${run}.` }
    }
    let text: string
    try {
      text = await $.fs.read(runPath(role.name, run, 'full.md'))
    } catch {
      return { result: `No stored answer for ${role.name} run ${run}.` }
    }
    let out = text
    if (input.section) {
      const found = extractSection(text, input.section)
      if (!found) return { result: `No section "${input.section}" in ${role.name} run ${run}.` }
      out = found
    }
    const max = input.maxChars ?? 12000
    return { result: out.length > max ? `${out.slice(0, max)}\n… [cut at ${max} of ${out.length} chars]` : out }
  })

  on('tool.call', { tool: 'mcp__relay__worker_send' }, async ($, e) => {
    const input = e as unknown as {
      role: string
      task: string
      brief?: string
      owns?: string[]
      model?: string
      effort?: string
      allowedTools?: string[]
      disallowedTools?: string[]
      backend?: string
      isolation?: string
      fresh?: boolean
    }
    await claim
    if (!isOwner) {
      if (queueError) return { result: `relay takes no tasks in this session: ${queueError}. Fix the file (or its permissions) and reload the plugin.` }
      const fresh = await readQueue($).catch(() => undefined)
      if (fresh && mayOwn(fresh.queue, session, await $.clock.now())) {
        return { result: 'The session that worked this project\'s queue is gone; reload the plugin (or start a new session) to take it over.' }
      }
      return { result: 'This project\'s relay queue is worked by another Claude Code session; worker_send is refused here. Use that session, or worker_status to read.' }
    }
    const name = input.role.trim().toLowerCase()
    if (!ROLE_NAME.test(name)) return { result: `Invalid role name "${input.role}": use a-z, 0-9, - and _.` }
    if (input.backend !== undefined && !isBackend(input.backend)) return { result: `Unknown backend "${input.backend}": use ${BACKEND_IDS.join(', ')}.` }
    const role: Role = roles[name] ?? { name, runs: 0, isBusy: false }
    const inFlight = role.isBusy || queue.jobs.some(j => j.role === name && j.state === 'queued')
    const def = (await loadRoleDefs($))[name]
    const backendBefore = effective(role, def).backend
    if (input.brief !== undefined) role.brief = input.brief
    if (input.owns !== undefined) role.owns = toList(input.owns)
    if (input.model !== undefined) role.model = input.model
    if (input.effort !== undefined) role.effort = input.effort
    if (input.allowedTools !== undefined) role.allowedTools = toList(input.allowedTools)
    if (input.disallowedTools !== undefined) role.disallowedTools = toList(input.disallowedTools)
    if (isBackend(input.backend)) role.backend = input.backend
    if (isIsolation(input.isolation)) role.isolation = input.isolation
    const eff = effective(role, def)
    const notes: string[] = []
    if (input.fresh) {
      if (inFlight) return { result: `${name} has work in flight; fresh is only possible when it is idle.` }
      role.sessionId = undefined
      role.sessionBackend = undefined
    }
    if (eff.backend !== backendBefore && role.sessionId) {
      role.sessionId = undefined
      role.sessionBackend = undefined
      notes.push(`backend changed from ${backendBefore} to ${eff.backend}: the old session was dropped`)
    }
    const ignored = ignoredRules(eff.backend, eff)
    if (ignored.length) notes.push(`${eff.backend} ignores: ${ignored.join(', ')}`)
    roles[name] = role
    await save($)

    // The job keeps the backend and model it was sent for (contract 0001, 7.1).
    const job: QueuedJob = { id: newJobId(), role: name, task: input.task, model: eff.model, enqueuedAt: await iso($), state: 'queued', backend: eff.backend }
    queue.jobs.push(job)
    try {
      await writeQueue($)
    } catch (err) {
      // Not on disk, not accepted: a restart would lose it.
      queue.jobs = queue.jobs.filter(j => j !== job)
      const why = err instanceof NotOwnerError ? 'another session took over this project\'s queue' : `${relayPath('queue.json')} could not be written (${message(err)})`
      return { result: redact(`${name}: task not accepted, nothing was started: ${why}.`) }
    }
    const before = running
    await pump($)
    const waiting = queued()
    const isStarted = running > before && role.isBusy && !waiting.some(j => j.role === name)
    if (dispatchError && !isStarted) notes.push(`it could not be started yet: ${dispatchError}`)
    const tail = notes.length ? ` (${notes.join('; ')})` : ''
    return {
      result: redact(
        isStarted
          ? `${name} run ${role.runs} started on ${eff.backend}. Its relay packet will arrive later (${config.notifyMode}); continue with other work.${tail}`
          : `${name}: task queued (position ${waiting.findIndex(j => j.role === name) + 1} of ${waiting.length}; ` +
              `${role.isBusy ? 'the role is still working' : `all ${config.maxParallel} slots are busy`}).${tail}`,
      ),
    }
  })
}

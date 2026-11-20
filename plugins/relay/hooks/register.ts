import type { Register, EngineInterface } from 'claude-code'
import {
  BACKEND_IDS,
  BuildError,
  isRemoteFailed,
  WERKBANK_STATES,
  liveStream,
  remoteEndLine,
  remoteVerifyLine,
  BACKENDS,
  CHECKED_VERSIONS,
  ignoredRules,
  isWerkbankBinSafe,
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
  baseName,
  eventTexts,
  hasKeyBegin,
  credentialValueCarry,
  REDACTED_KEY_LINE,
  compareSnapshots,
  extractSection,
  fallbackPrompt,
  isSamePath,
  ownershipDenial,
  parseNameStatus,
  parsePacket,
  parsePorcelain,
  parseWorktreeList,
  notChecked,
  privateKeyFilter,
  remoteWriteCheck,
  toProjectPath,
  protocolPrompt,
  hasCredential,
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
  isRunNumber,
  parseQueue,
  ROLE_NAME,
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
  // The folder the stored session works in; absent (0.3.0, shared) is the
  // project. A run in another folder starts a fresh session.
  sessionDir?: string
  runs: number
  isBusy: boolean
  lastStatus?: Packet['status']
  lastSummary?: string
  totals?: Usage
}


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
  werkbankBin: 'werkbank-relay',
  werkbankLeitstand: 'http://100.73.150.87:5080',
  werkbankTokenFile: '~/.werkbank/relay.token',
  // relay's own timeout for a werkbank run: wait in the Leitstand plus the run
  werkbankTimeoutMin: 60,
}

// The timeout relay applies to a run of this backend (contract 0001, N44).
const timeoutOf = (id: BackendId) => (id === 'werkbank' ? config.werkbankTimeoutMin : config.runTimeoutMin)

// `~/x` → <home>/x: children start without a shell, nothing else expands it.
async function expandHome($: EngineInterface, path: string) {
  if (!/^~(?=$|[\\/])/.test(path)) return path
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
  return home ? `${home.replace(/[\\/]+$/, '')}${path.slice(1)}` : path
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
// what the next write keeps as queue.json.bak (N193)
let lastBackupText: string | undefined
let notices: string[] = []
let configNotes: string[] = []
let heartbeat: { cancel: () => void } | undefined
// Interrupted jobs that could not be reported (no such role, or reporting
// failed): they stay in queue.json and are retried at the next start.
const unreported = new Map<string, string>()
const versions: Partial<Record<BackendId, string>> = {}
// Whether this session already said that the project is no git repository.
let isNoGitNoticed = false
// The project folder as the filesystem resolves it.
let projectRoot: string | undefined
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

// Both queue files are checked like relay's other files before every read
// and write: a link or a place outside the project locks them (N197).
async function checkQueueFile($: EngineInterface, name: 'queue.json' | 'queue.json.bak') {
  const path = relayPath(name)
  const why = await storageProblem($, path)
  if (why) throw new Error(why)
  return path
}

async function readQueueFile($: EngineInterface, name: 'queue.json' | 'queue.json.bak') {
  return readText($, await checkQueueFile($, name))
}

async function readQueue($: EngineInterface) {
  const text = await readQueueFile($, 'queue.json')
  const loaded = loadQueue(text, await readQueueFile($, 'queue.json.bak'))
  return { ...loaded, text }
}

// Takes a queue as read: only a main file that parsed may become the backup
// of the next write, never an empty or broken one over a good .bak.
// The backup is the checked queue as relay writes it, never the raw text,
// so a job left out as unsafe never reaches it (N193).
function adopt(loaded: Awaited<ReturnType<typeof readQueue>>) {
  queue = loaded.queue
  lastQueueText = loaded.isBroken || loaded.isFromBackup ? undefined : loaded.text
  lastBackupText = lastQueueText !== undefined || loaded.dropped ? serializeQueue(loaded.queue) : undefined
}

async function writeQueueText($: EngineInterface) {
  await ensureGitignore($)
  const text = serializeQueue(queue)
  if (text === lastQueueText) return
  // both files are checked before either is written (N197)
  const main = await checkQueueFile($, 'queue.json')
  const backup = lastBackupText !== undefined ? await checkQueueFile($, 'queue.json.bak') : undefined
  if (backup !== undefined && lastBackupText !== undefined) await $.fs.write(backup, lastBackupText)
  await $.fs.write(main, text)
  lastQueueText = text
  lastBackupText = text
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
  const text = await readQueueFile($, 'queue.json')
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

// Claims the queue: reads the file again right before writing (a fresh claim
// of another session is respected, its jobs kept), writes this module's
// token, waits, reads it back. $.fs has no exclusive create (V3): between
// that last read and the write a few milliseconds stay open, where two
// claims can still cross; every later write is fenced against the file
// (contract 0001, N5, N16).
async function claimQueue($: EngineInterface) {
  try {
    ownerToken = newToken()
    let holder: string | undefined
    await serialized(async () => {
      const fresh = await readQueue($)
      const owner = fresh.queue.owner
      adopt(fresh)
      if (owner && owner.token !== ownerToken && owner.session !== session && isFresh(owner, await $.clock.now())) {
        holder = owner.session
        return
      }
      queue.owner = { session, heartbeatAt: await iso($), token: ownerToken }
      await writeQueueText($)
    })
    if (holder) {
      notices.push(`Session ${holder} works this project's relay queue; this session only reads it.`)
      return
    }
    await $.clock.sleep(CLAIM_SETTLE_MS)
    const disk = parseQueue(await readQueueFile($, 'queue.json'))
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
  // the claim is renewed from now on, but nothing starts before every
  // interrupted run is handled and its run number taken over (N167)
  isRecovering = true
  heartbeat = $.clock.every(HEARTBEAT_MS, () => void beat($))
  showStatus($)
  await recover($).catch(err => notices.push(`relay could not finish taking over the queue (${message(err)}).`))
  isRecovering = false
}

async function beat($: EngineInterface) {
  if (!isOwner) return
  // a temp file that could not be cleared is tried again, whether or not the
  // queue can be written (N132, N139), but only while no other session holds
  // the queue now (N144)
  const isStillOwner = await fence($).then(
    () => true,
    () => false,
  )
  if (!isStillOwner) return
  await retryTempClears($)
  queue.owner = { session, heartbeatAt: await iso($), token: ownerToken }
  const isWritten = await writeQueue($).then(
    () => true,
    err => {
      if (!(err instanceof NotOwnerError)) notices.push(`relay could not renew its claim on the queue (${message(err)}).`)
      return false
    },
  )
  if (!isWritten) return
  // The queue can be written again: retry what waits on it (N15, N28).
  await retryDeliveries($)
  if (queued().length) await pump($)
}

// Runs the last module left behind: report the dead ones, start the rest.
async function recover($: EngineInterface) {
  const dead = queue.jobs.filter(j => j.state === 'running')
  for (const job of dead) {
    // the role comes from the job and keeps its run number before anything
    // is delivered, known to the roles file or not (N158)
    if (isRunNumber(job.run)) {
      const role = (roles[job.role] ??= { name: job.role, runs: job.run, isBusy: false })
      if (role.runs < job.run) role.runs = job.run
      // nothing is delivered before the run number is stored; the job, its
      // kept message and packet.json stay for the next start (N163)
      const notSaved = await save($).then(
        () => undefined,
        err => `the run number could not be stored (${message(err)})`,
      )
      if (notSaved) {
        unreported.set(job.id, redact(notSaved))
        continue
      }
    }
    // An opencode task file or a werkbank protocol file the dead run left
    // behind is cleared first, each checked like a live run's (N52, N53).
    for (const name of [`${job.role}-${job.run ?? 0}.md`, `${job.role}-${job.run ?? 0}.protocol.md`]) {
      const attachment = relayPath(`tmp/${name}`)
      if (await $.fs.exists(attachment).catch(() => false)) await clearTempFile($, attachment)
    }
    // the kept message of this very job first, stored or not (N103); a kept
    // file that is a link out means interrupted, without files (N118)
    const kept = await keptMessageOf($, job).catch(() => undefined)
    const why = await (
      kept && 'unsafe' in kept
        ? reportInterrupted($, job, redact(`the kept message was not read: ${kept.unsafe}`), { noFiles: 'its stored files are not safe to use' })
        : kept !== undefined
          ? deliverKept($, job, kept)
          : job.delivery === 'stored'
            ? deliverStored($, job)
            : reportInterrupted($, job)
    ).catch(err => `reporting failed (${message(err)})`)
    // A reported job left the queue in deliver; the rest stay and are shown.
    if (why) unreported.set(job.id, why)
  }
  const defs = await loadRoleDefs($)
  for (const job of queued()) {
    if (!roles[job.role] && defs[job.role]) roles[job.role] = { name: job.role, runs: 0, isBusy: false }
  }
  await save($)
  await writeQueue($).catch(err => notices.push(`relay could not write the queue after the restart (${message(err)}).`))
  // the restart is done: waiting jobs may start (N167)
  isRecovering = false
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

// Not rotated: one file per run whose message waits for delivery (N97).
function undeliveredPath(role: string, run: number) {
  return relayPath(`runs/${role}/undelivered-${run}.md`)
}

function isRotatedOut(role: Role, run: number) {
  return config.keepRuns > 0 && run <= role.runs - config.keepRuns
}

// Why the slot may not be written for `run`, or undefined: only a confirmed
// missing packet.json, or a readable one of this run or an earlier one, lets
// relay write there; a later, unsafe, unreadable or invalid one does not
// (N108, N129, N136).
async function slotProblem($: EngineInterface, role: string, run: number): Promise<string | undefined> {
  const path = runPath(role, run, 'packet.json')
  const unsafe = await storageProblem($, path)
  if (unsafe) return unsafe
  let isThere: boolean
  try {
    isThere = await $.fs.exists(path)
  } catch (err) {
    return `the slot could not be checked (${message(err)})`
  }
  if (isThere) {
    try {
      const stored = (JSON.parse(String(await $.fs.read(path))) as { run?: unknown }).run
      // only a whole run number from 1 counts (N145)
      if (typeof stored !== 'number' || !Number.isSafeInteger(stored) || stored < 1) return 'the slot could not be checked (its packet.json names no valid run)'
      if (stored > run) return 'a later run holds this slot'
    } catch (err) {
      return `the slot could not be checked (${message(err)})`
    }
  }
  // full.md too: a later run may have written it first (N161)
  const full = runPath(role, run, 'full.md')
  const fullUnsafe = await storageProblem($, full)
  if (fullUnsafe) return fullUnsafe
  try {
    if (!(await $.fs.exists(full))) return undefined
    const head = new RegExp(`^# ${role.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} · run (\\d+)\\n`).exec(String(await $.fs.read(full)))
    const stored = head ? Number(head[1]) : NaN
    if (!Number.isSafeInteger(stored) || stored < 1) return 'the slot could not be checked (its full.md names no valid run)'
    return stored > run ? 'a later run holds this slot' : undefined
  } catch (err) {
    return `the slot could not be checked (${message(err)})`
  }
}

// A roles file that exists but cannot be read or parsed (N137).
class RoleFileError extends Error {}

// Missing roles file: no definitions. With isStrict, a file that exists but
// cannot be read or parsed throws instead of counting as empty (N137).
async function loadRoleDefs($: EngineInterface, opts: { isStrict?: boolean } = {}): Promise<Record<string, RoleDef>> {
  try {
    if (!(await $.fs.exists(config.rolesFile))) return {}
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(await $.fs.read(config.rolesFile)) as Record<string, unknown>
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('no JSON object')
    } catch (err) {
      if (opts.isStrict) throw new RoleFileError(`the roles file ${config.rolesFile} could not be read (${message(err)})`)
      return {}
    }
    const map = (parsed.roles ?? parsed) as Record<string, Record<string, unknown>>
    // before a start, the map and every rule that limits a worker must have
    // its shape; else the job waits (N143)
    if (opts.isStrict) {
      const isObject = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v)
      const isListish = (v: unknown) => v === undefined || typeof v === 'string' || (Array.isArray(v) && v.every(x => typeof x === 'string'))
      // any invalid entry counts, also one with an empty name (N148)
      const invalid = isObject(map)
        ? Object.entries(map).find(([, d]) => !isObject(d) || !isListish(d.owns) || !isListish(d.allowedTools) || !isListish(d.disallowedTools))
        : undefined
      const bad = !isObject(map) ? 'roles is no JSON object' : invalid ? `role "${invalid[0] || '(empty name)'}" has an invalid entry` : undefined
      if (bad !== undefined) throw new RoleFileError(`the roles file ${config.rolesFile} could not be read (${bad})`)
    }
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
  } catch (err) {
    if (opts.isStrict) throw err instanceof RoleFileError ? err : new RoleFileError(`the roles file ${config.rolesFile} could not be checked (${message(err)})`)
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
  if (id === 'werkbank') return parseBin(config.werkbankBin, 'werkbank-relay')
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

// Whether `dir` is in a git work tree: yes, a confirmed no ("not a git
// repository"), or an error (git missing, refused, broken repository), which
// the write check reports as a gap instead of a quiet skip.
type GitState = { state: 'yes' | 'no' | 'error'; detail?: string }

async function gitStateOf($: EngineInterface, dir: string): Promise<GitState> {
  const r = await git($, dir, ['rev-parse', '--is-inside-work-tree'])
  if (r.exitCode === 0 && r.stdout.trim() === 'true') return { state: 'yes' }
  if ((r.exitCode === 0 && r.stdout.trim() === 'false') || /not a git repository/i.test(r.stderr)) return { state: 'no' }
  return { state: 'error', detail: redact(r.stderr.trim()).slice(0, 200) || `exit code ${r.exitCode}` }
}

type Workdir = { dir: string; isGit: boolean; git: GitState; worktree?: { path: string; branch: string }; error?: string }

async function realOf($: EngineInterface, path: string) {
  return (await $.fs.stat(path, { resolve: true }).catch(() => undefined))?.realPath
}

// Why writing under the project-relative `rel` could land outside the
// project, or undefined: every part of it that exists must be no link and
// resolve to its own place in the project. Checked before the first write
// to relay's folders and before `git worktree add` (contract 0001, N17).
async function storageProblem($: EngineInterface, rel: string): Promise<string | undefined> {
  projectRoot ??= await realOf($, cwd)
  if (!projectRoot) return 'the project folder could not be resolved'
  const root = projectRoot.replace(/[\\/]+$/, '')
  const parts = rel.replace(/\\/g, '/').split('/').filter(Boolean)
  for (let i = 1; i <= parts.length; i++) {
    const p = parts.slice(0, i).join('/')
    // only a confirmed "missing" lets relay create it; a failed query locks (N115)
    let isThere: boolean
    try {
      isThere = await $.fs.exists(p)
    } catch (err) {
      return `${p} could not be checked (${message(err)})`
    }
    if (!isThere) return undefined
    const st = await $.fs.stat(p, { resolve: true }).catch(() => undefined)
    if (!st?.realPath) return `${p} could not be resolved`
    // Each part is spelled as on disk, so case does not decide here.
    if (st.isLink || !isSamePath(st.realPath, `${root}/${p}`, { caseInsensitive: true })) {
      return `${p} resolves to ${st.realPath}, outside the project; relay writes nothing there`
    }
  }
  return undefined
}

// Temp files (opencode's task, werkbank's protocol) live in <relayDir>/tmp/;
// the file itself is checked like its folder before relay writes it. $.fs
// cannot create exclusively or refuse to follow a link (V3): a short window
// between check and write remains (contract 0001, N52).
const tempRel = (path: string) => relayPath(`tmp/${baseName(path)}`)

async function tempFilesProblem($: EngineInterface, inv: Invocation): Promise<string | undefined> {
  for (const f of inv.tempFiles ?? []) {
    const problem = await storageProblem($, tempRel(f.path))
    if (problem) return problem
  }
  return undefined
}

// Writes exactly the path it checked (N81).
// Returns why the file was not cleared; a failed write is tried again with
// each heartbeat of this session, a path that is no longer safe never (N132).
const uncleared = new Set<string>()
async function clearTempFile($: EngineInterface, path: string): Promise<string | undefined> {
  const rel = tempRel(path)
  const unsafe = await storageProblem($, rel)
  if (unsafe) {
    uncleared.delete(rel)
    return unsafe
  }
  try {
    await $.fs.write(rel, '')
    uncleared.delete(rel)
    return undefined
  } catch (err) {
    uncleared.add(rel)
    return message(err)
  }
}

async function retryTempClears($: EngineInterface) {
  for (const rel of [...uncleared]) await clearTempFile($, rel)
}

// The project's place in its repository, or undefined when git cannot say
// (never silently the top, contract 0001, N49).
async function prefixOf($: EngineInterface, dir: string): Promise<string | undefined> {
  const r = await git($, dir, ['rev-parse', '--show-prefix'])
  // only git's line ending goes; the prefix itself stays literal (N60)
  return r.exitCode === 0 ? r.stdout.replace(/\r?\n$/, '') : undefined
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
  const g = await gitStateOf($, cwd)
  const isGit = g.state === 'yes'
  if (isolation !== 'worktree') return { dir: cwd, isGit, git: g }
  if (g.state === 'no') return { dir: cwd, isGit, git: g, error: 'it needs a git repository, and the project is none' }
  if (g.state === 'error') return { dir: cwd, isGit, git: g, error: `git could not tell whether the project is a repository (${g.detail})` }
  const rel = relayPath(`worktrees/${role}`)
  const branch = `relay/${role}`
  const escape = await storageProblem($, rel)
  if (escape) return { dir: cwd, isGit, git: g, error: escape }
  if (!(await $.fs.exists(rel))) {
    await ensureGitignore($)
    const hasBranch = (await git($, cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).exitCode === 0
    const path = absolute(rel)
    const r = await git($, cwd, hasBranch ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path])
    if (r.exitCode !== 0) return { dir: cwd, isGit, git: g, error: `git worktree add failed (${r.stderr.trim().slice(0, 300)})` }
  }
  const problem = await worktreeProblem($, rel, branch)
  if (problem) return { dir: cwd, isGit, git: g, error: problem }
  return { dir: absolute(rel), isGit: true, git: g, worktree: { path: rel, branch } }
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

// git names paths from the repository's top; the project may be a folder
// inside it. Snapshot keys are project-relative (contract 0001, N24).
async function repoOf($: EngineInterface, dir: string) {
  const top = await git($, dir, ['rev-parse', '--show-toplevel'])
  const pre = await git($, dir, ['rev-parse', '--show-prefix'])
  return { top: top.exitCode === 0 && top.stdout.trim() ? top.stdout.trim() : dir, prefix: pre.exitCode === 0 ? pre.stdout.trim() : '' }
}

async function takeSnapshot($: EngineInterface, dir: string): Promise<Snapshot | undefined> {
  const head = await git($, dir, ['rev-parse', 'HEAD'])
  const status = await git($, dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (status.exitCode !== 0) return undefined
  const repo = await repoOf($, dir)
  const mine = (repoPath: string) => toProjectPath(repoPath, repo.prefix)
  const relayPrefix = `${config.relayDir}/`
  const isMine = (p: string) => !p.startsWith(relayPrefix)
  const dirty: Record<string, string> = {}
  const present: { repoPath: string; path: string; code: string }[] = []
  for (const e of parsePorcelain(status.stdout)) {
    const path = mine(e.path)
    // A rename moves its source away: that is a deletion there.
    if (e.orig && e.code.includes('R') && isMine(mine(e.orig))) dirty[mine(e.orig)] = 'deleted'
    if (!isMine(path)) continue
    if (e.code.includes('D')) dirty[path] = 'deleted'
    else present.push({ repoPath: e.path, path, code: e.code })
  }
  // Hashed from the top, where git's paths start.
  const hashes = await hashPaths($, repo.top, present.map(e => e.repoPath))
  for (const e of present) {
    const h = hashes.get(e.repoPath)
    const isNew = e.code === '??' || /^[ARC]/.test(e.code)
    dirty[e.path] = h === undefined ? UNHASHED : isNew ? `new:${h}` : h
  }
  return { head: head.exitCode === 0 ? head.stdout.trim() : '', dirty, ...(repo.prefix ? { prefix: repo.prefix } : {}) }
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

// The tree an unborn HEAD stands for, in the repository's own hash format.
async function emptyTree($: EngineInterface, dir: string) {
  const r = await git($, dir, ['hash-object', '-t', 'tree', '--stdin'], '')
  const h = r.stdout.trim()
  return r.exitCode === 0 && isHash(h) ? h : EMPTY_TREE
}

// The roles that ran in the same folder at some point since this run's
// snapshot, finished ones included: for attributing changes (contract 0001,
// N22). Kept until no running run started before they ended.
type Activity = { role: string; owns: string[]; dir: string; from: number; to?: number }
const activity: Activity[] = []
let tick = 0

function othersSince(mine: Activity | undefined) {
  if (!mine) return []
  return activity
    .filter(a => a !== mine && a.role !== mine.role && a.dir === mine.dir && (a.to === undefined || a.to > mine.from))
    .map(a => ({ role: a.role, owns: a.owns }))
}

function pruneActivity() {
  const open = activity.filter(a => a.to === undefined).map(a => a.from)
  const oldest = open.length ? Math.min(...open) : Infinity
  for (let i = activity.length - 1; i >= 0; i--) {
    const a = activity[i] as Activity
    if (a.to !== undefined && a.to < oldest) activity.splice(i, 1)
  }
}

async function writeCheckOf($: EngineInterface, owns: string[], dir: string, before: Snapshot | undefined, g: GitState, mine?: Activity): Promise<WriteCheck> {
  const none = (reason: string, isGap: boolean): WriteCheck => ({
    checked: false,
    reason,
    changed: [],
    outside: [],
    unattributed: [],
    byOtherRole: [],
    ...(isGap ? { incomplete: [reason] } : {}),
  })
  if (!before) {
    if (g.state === 'no') return none('the project is no git repository', false)
    if (g.state === 'error') return none(`git could not be run or found no repository (${g.detail})`, true)
    return none('git status failed before the run, or no snapshot was taken', true)
  }
  const after = await takeSnapshot($, dir)
  if (!after) return none('git status failed after the run', true)
  let committed: { path: string; change: Change }[] = []
  const gaps: string[] = []
  if (before.head !== after.head) {
    // A first commit has no parent: compare it with the empty tree.
    const empty = before.head && after.head ? '' : await emptyTree($, dir)
    const r = await git($, dir, ['diff', '--name-status', '-z', before.head || empty, after.head || empty])
    if (r.exitCode === 0) committed = parseNameStatus(r.stdout).map(c => ({ ...c, path: toProjectPath(c.path, after.prefix ?? '') }))
    else gaps.push(`git diff of the commits made during the run failed (${r.stderr.trim().slice(0, 200)}); what they changed is unknown`)
  }
  // Roles in their own worktree cannot have written here.
  const check = compareSnapshots(before, after, committed, owns, othersSince(mine), pathCase)
  if (gaps.length) check.incomplete = [...(check.incomplete ?? []), ...gaps]
  return check
}

// ── runs ────────────────────────────────────────────────────────────────

// Starts queued jobs while there is room and their role is idle. One pump at
// a time; a call while one runs makes it look again before it ends.
let pumping: Promise<void> | undefined
let isPumpAsked = false
// roles already named as having no safe next run number (N194)
const exhaustedNoted = new Set<string>()
// true while the restart handles the interrupted runs (N167)
let isRecovering = false
function pump($: EngineInterface): Promise<void> {
  // no start during the restart; it pumps itself once it is done (N167)
  if (isRecovering) return Promise.resolve()
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
  // a waiting job whose role is not in the store looks for it in the roles
  // file again on every try, e.g. once that file is repaired (N146)
  if (queued().some(j => !roles[j.role])) {
    const defs = await loadRoleDefs($)
    for (const j of queued()) {
      if (!roles[j.role] && defs[j.role]) roles[j.role] = { name: j.role, runs: 0, isBusy: false }
    }
  }
  // a role with no safe next run number is skipped, named once, and the
  // others still start (N188, N194)
  for (const j of queued()) {
    const r = roles[j.role]
    if (r && !isRunNumber(r.runs + 1) && !exhaustedNoted.has(r.name)) {
      exhaustedNoted.add(r.name)
      dispatchError = `${r.name} has no safe next run number (${r.runs} runs counted)`
      notices.push(redact(`relay did not start ${r.name}: ${dispatchError}; its jobs stay queued.`))
    }
  }
  const isStartable = (j: QueuedJob) => j.state === 'queued' && !!roles[j.role] && !roles[j.role]?.isBusy && isRunNumber(roles[j.role]!.runs + 1)
  while (isOwner && running < Math.max(1, config.maxParallel)) {
    const candidate = queue.jobs.find(isStartable)
    if (!candidate) break
    // the roles file is checked and the start time taken before anything is
    // reserved, so no heartbeat writes a job as running before (N162); a roles
    // file that exists but cannot be read keeps the job queued (N137)
    let defs: Record<string, RoleDef>
    let startedAt: string
    try {
      defs = await loadRoleDefs($, { isStrict: true })
      startedAt = await iso($)
    } catch (err) {
      dispatchError = message(err)
      const name = candidate.role
      if (err instanceof RoleFileError) notices.push(redact(`relay did not start ${name}: ${dispatchError}; the job stays queued and starts once the roles file can be read.`))
      else notices.push(redact(`relay did not start ${name} (${dispatchError}); the job stays queued.`))
      break
    }
    // looked for again after the awaits; reserved with no await in between:
    // the job, its role and the slot
    const job = queue.jobs.find(isStartable)
    const role = job && roles[job.role]
    if (!isOwner || !job || !role || running >= Math.max(1, config.maxParallel)) break
    const run = role.runs + 1
    role.isBusy = true
    role.runs = run
    running++
    job.state = 'running'
    job.run = run
    job.startedAt = startedAt
    if (!(await start($, job, role, run, defs))) break
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
async function start($: EngineInterface, job: QueuedJob, role: Role, run: number, defs: Record<string, RoleDef>): Promise<boolean> {
  // the roles file was read strictly before the reservation (N137, N162)
  const eff = effective(role, defs[role.name])
  try {
    await save($)
    await writeQueue($)
  } catch (err) {
    role.isBusy = false
    role.runs = run - 1
    running--
    job.state = 'queued'
    delete job.run
    delete job.startedAt
    await save($).catch(() => undefined)
    dispatchError = err instanceof NotOwnerError ? 'another session took over the queue' : message(err)
    if (err instanceof RoleFileError) {
      notices.push(redact(`relay did not start ${role.name}: ${dispatchError}; the job stays queued and starts once the roles file can be read.`))
    } else if (!(err instanceof NotOwnerError)) {
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
    // one rule for "the child ran": output, an exit code, a signal or the
    // timeout; a read error with no output is no start (N173)
    let hasStarted = false
    let mine: Activity | undefined
    let passedSessionId: string | undefined
    const isRemote = id === 'werkbank'
    const notes: string[] = []
    // Nothing is written where it could leave the project (N17).
    const escape = (await storageProblem($, relayPath('tmp'))) ?? (await storageProblem($, relayPath(`runs/${role.name}`)))
    const live = liveLog($, role.name, run, id, !escape)
    let work: Workdir = { dir: cwd, isGit: false, git: { state: 'no' } }
    try {
      if (escape) {
        notStarted = escape
        outcome = { answer: '', usage: {}, error: { kind: 'cli', message: escape } }
        // A werkbank worker has its own worktree on the server (N33).
      } else work = await workdirOf($, role.name, isRemote ? 'shared' : eff.isolation)
      if (notStarted) {
        // already decided
      } else if (work.error) {
        notStarted = `isolation "worktree" could not be set up: ${work.error}`
        outcome = { answer: '', usage: {}, error: { kind: 'cli', message: notStarted } }
      } else {
        // A werkbank run writes nothing here: no snapshot, and it takes no part
        // in attributing what parallel runs wrote (N39).
        if (!isRemote) {
          mine = { role: role.name, owns: eff.owns, dir: work.dir, from: ++tick }
          activity.push(mine)
        }
        await checkVersion($, id)
        const before = config.writeCheck === 'report' && work.isGit && !isRemote ? await takeSnapshot($, work.dir) : undefined
        if (before) await $.fs.write(snapshotPath(role.name, run), JSON.stringify(before))

        // A session lives in one folder: a run elsewhere starts a fresh one (N23).
        const sessionDir = role.sessionDir ?? cwd
        const isMoved = role.sessionId !== undefined && !isSamePath(sessionDir, work.dir, pathCase)
        if (isMoved) notes.push(`The working folder changed (${sessionDir} → ${work.dir}); ${role.name} started a fresh ${id} session.`)
        const isNew = role.sessionId === undefined || sessionBackendOf(role) !== id || isMoved
        // A brief that holds credentials stays out of argv (N20): the system
        // prompt gets it redacted, the task (stdin or file) carries it whole.
        // written-out escapes alone do not count as a credential (N195)
        const safeBrief = redact(eff.brief)
        const isBriefPrivate = hasCredential(eff.brief)
        const spec: LaunchSpec = {
          role: role.name,
          run,
          task: isBriefPrivate ? `Your role brief, in full (kept off the command line):\n${eff.brief}\n\n---\n\n${job.task}` : job.task,
          protocol: protocolPrompt(role.name, isBriefPrivate ? `${safeBrief} (the full brief comes with the task)` : eff.brief, eff.owns),
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
            ...(isRemote
              ? {
                  werkbankLeitstand: config.werkbankLeitstand,
                  werkbankTokenFile: await expandHome($, config.werkbankTokenFile.trim()),
                  runTimeoutMin: config.runTimeoutMin,
                  isWindows: (await $.env.get('OS')) === 'Windows_NT',
                }
              : {}),
          },
        }
        try {
          inv = backend.build(spec)
        } catch (err) {
          // A refused werkbank call never starts and keeps the session (N32).
          if (err instanceof BuildError) notStarted = message(err).replace(/\.$/, '')
          outcome = { answer: '', usage: {}, error: { kind: err instanceof BuildError ? err.kind : 'model', message: message(err) } }
        }
        // The session that really went along, for "session moved" (N55).
        if (inv && isRemote) passedSessionId = inv.sessionArg
        // Each temp file itself must stay in the project, not only its folder (N52).
        const tempProblem = inv ? await tempFilesProblem($, inv) : undefined
        if (inv && tempProblem) {
          notStarted = tempProblem
          outcome = { answer: '', usage: {}, error: { kind: 'cli', message: tempProblem } }
          inv = undefined
        }
        if (inv) {
          if (inv.presetSessionId) {
            role.sessionId = inv.presetSessionId
            role.sessionBackend = id
            role.sessionDir = work.dir
            await save($)
          }
          let sawOutput = false
          try {
            for (const f of inv.tempFiles ?? []) await $.fs.write(f.path, f.content)
            sawOutput = (await spawnRun($, id, eff.owns, work.dir, inv, backend.onLine?.bind(backend), proc, live)).sawOutput
          } finally {
            // The task file never outlives its run, whatever ended it (N25),
            // and is checked again before it is cleared (N52).
            for (const f of inv.tempFiles ?? []) {
              const failed = await clearTempFile($, f.path)
              // named, and tried again with each heartbeat (N132)
              if (failed) notes.push(`${tempRel(f.path)} could not be cleared (${failed})${uncleared.has(tempRel(f.path)) ? "; relay tries again with each heartbeat of this session" : ""}`)
            }
          }
          outcome = backend.parse(proc)
          hasStarted = sawOutput || proc.exitCode !== undefined || !!proc.signal || proc.isTimedOut
          // only when the child never ran (N71, N173)
          if (!hasStarted && !outcome.answer.trim() && outcome.error?.kind === 'cli') {
            outcome.error.message += ` · could not start ${inv.argv[0]}; set ${id}Bin to the full path of the executable`
          }
        }
        if (config.writeCheck !== 'report') check = undefined
        else if (!isRemote) check = await writeCheckOf($, eff.owns, work.dir, before, work.git, mine)
        // The files the job changed on its branch, against owns (N39).
        else if (outcome.remote) check = remoteWriteCheck(outcome.remote, eff.owns, await prefixOf($, work.dir))
        // no JSON at all from a run that did start: the job may have been
        // handed in and run on (N170); a JSON error without jobId or a start
        // that never happened has no check (N39, N71)
        else if (!notStarted && hasStarted && !hasJsonObject(proc.stdout)) {
          check = notChecked(`the werkbank job may still be running on the server; its changes would be on agent/relay/${role.name}`)
        }
      }
    } catch (err) {
      proc.stderr += `\n${String(err)}`
      outcome.error ??= { kind: 'unknown', message: redact(String(err)).slice(0, 500) }
    }
    if (mine) mine.to = ++tick
    pruneActivity()
    running--
    try {
      // the log's own writes may still be queued: let them run first (N88)
      // live.log is finished, its end line written, before the report goes;
      // a problem with it is still in the report (N88, N96)
      await live.close(outcome, proc)
      if (live.problem) notes.push(`live.log was not written: ${live.problem}`)
      await finish($, { role, run, job, id, model: model || outcome.usage.model || '', outcome, proc, check, work, notes, notStarted, presetSessionId: inv?.presetSessionId, passedSessionId })
    } catch (err) {
      // The report itself failed: free the role, keep the job, which the
      // next start reports as interrupted.
      role.isBusy = false
      notices.push(redact(`relay could not report ${role.name} run ${run} (${message(err)}); the job stays in the queue and is reported at the next start.`))
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
  id: BackendId,
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
  const timeoutMin = timeoutOf(id)
  const timer =
    timeoutMin > 0
      ? $.clock.after(timeoutMin * 60_000, () => {
          proc.isTimedOut = true
          stop()
        })
      : undefined
  // werkbank reports its progress on stderr; the others on stdout (N43).
  const isLiveErr = liveStream(id) === 'stderr'
  let usage: Usage = {}
  let rest = ''
  let errRest = ''
  // whether the child printed anything at all (N71)
  let sawOutput = false
  // one key state over stdout and stderr, in the order they arrive (N114)
  const keys = privateKeyFilter()
  let isKeySeen = false
  // an unfinished line with a key marker holds live.log back (N128)
  const isFragmentKeyed = () => hasKeyBegin(rest) || hasKeyBegin(errRest)
  const track = (line: string) => {
    const seen = [line, ...eventTexts(line)].join('\n')
    if (hasKeyBegin(seen)) isKeySeen = true
    keys(seen)
  }
  try {
    for (;;) {
      const step = await child.next()
      if (step.done) {
        proc.exitCode = step.value?.code ?? undefined
        // no exit code: say why (N61)
        if (step.value?.signal) proc.signal = String(step.value.signal)
        break
      }
      const chunk = step.value
      if (chunk.text) sawOutput = true
      if (chunk.stream === 'stderr') {
        proc.stderr += chunk.text
        const errLines = (errRest + chunk.text).split('\n')
        errRest = errLines.pop() ?? ''
        const isHeld = isFragmentKeyed()
        if (isHeld) live.seal()
        for (const line of errLines) {
          track(line)
          // the stream not shown still moves live.log's key state (N114)
          if (isLiveErr) live.line(line, isHeld)
          else live.other(line)
        }
        continue
      }
      proc.stdout += chunk.text
      const lines = (rest + chunk.text).split('\n')
      rest = lines.pop() ?? ''
      const isHeld = isFragmentKeyed()
      if (isHeld) live.seal()
      for (const line of lines) {
        track(line)
        if (!isLiveErr) live.line(line, isHeld)
        else live.other(line)
        if (onLine) usage = onLine(line, usage)
      }
      if (config.maxTokensPerRun > 0 && onLine && totalTokens(usage) > config.maxTokensPerRun && !proc.isStoppedByLimit) {
        proc.isStoppedByLimit = true
        stop()
      }
    }
  } catch (err) {
    // a read error stops the child like the timeout does, before its slot
    // under maxParallel is given back (N180)
    // (a stream that already failed may refuse the stop; that is no new error)
    // the stop is waited for before the slot is given back (N186)
    if (!proc.isTimedOut && !proc.isStoppedByLimit) {
      try {
        await child.return(undefined as never)
      } catch {
        // already ended
      }
    }
    // the read error's text goes into the key check like a line (N155)
    for (const line of String(err).split('\n')) {
      track(line)
      live.other(line)
    }
    if (!proc.isTimedOut && !proc.isStoppedByLimit) {
      proc.stderr += `\n${String(err)}`
      proc.streamError = redact(String(err)).slice(0, 300)
    }
  }
  // a rest with a key marker first, so its key state applies to the other (N128)
  const lastParts = [[errRest, isLiveErr], [rest, !isLiveErr]] as const
  for (const [last, isShown] of [...lastParts].sort((x, y) => Number(hasKeyBegin(y[0])) - Number(hasKeyBegin(x[0])))) {
    if (!last) continue
    track(last)
    if (isShown) live.line(last)
    else live.other(last)
  }
  // a key still open at the end: its answer is passed on nowhere (N114)
  proc.isKeyOpen = keys.isOpen
  // any key marker at all: the answer is passed on nowhere (N120)
  proc.isKeySeen = isKeySeen || keys.isOpen
  timer?.cancel()
  return { sawOutput }
}

// <relayDir>/runs/<role>/live.log: one readable line per event, written in
// batches (the plugin API cannot append). Every line is redacted first.
const liveChains = new Map<string, Promise<void>>()
const liveOwners = new Map<string, number>()
function liveLog($: EngineInterface, role: string, run: number, id: BackendId, isEnabled = true) {
  const path = relayPath(`runs/${role}/live.log`)
  const lines = [`# ${role} · run ${run} · ${id} · started ${new Date().toISOString()}`]
  // A private key over several lines never reaches the log (N51).
  const keyFilter = privateKeyFilter()
  // a credential list left open by one line is replaced in the next ones (N198)
  const carry = credentialValueCarry()
  // After the first key marker the log takes no more lines (N134).
  let isSealed = false
  const seal = () => {
    if (isSealed) return
    isSealed = true
    lines.push(REDACTED_KEY_LINE)
    void flushSoon()
  }
  // Timed by the plugin's clock: at most every 2 seconds, and at the end.
  const now = () => $.clock.now().catch(() => Date.now())
  let flushedAt = 0
  // The log belongs to the role's newest run: an older run never writes over
  // it, and a closed run writes nothing more (N68).
  liveOwners.set(role, run)
  let isClosed = false
  // Writes of all runs of a role run one after another, each with the lines
  // of its moment (N63, N68).
  let problem: string | undefined
  const write = (isFinal = false) => {
    const next = (liveChains.get(role) ?? Promise.resolve()).then(async () => {
      if (!isEnabled || problem || (isClosed && !isFinal) || liveOwners.get(role) !== run) return
      // the file itself, not only its folder: a link out stops the log (N88)
      const why = await storageProblem($, path).catch(err => `live.log could not be checked (${String(err)})`)
      if (why) {
        problem = why
        return
      }
      // a live.log a later run of this role began (in any session) is left
      // alone (N144)
      // only a confirmed missing live.log counts as empty; one that cannot be
      // checked or read is left alone, and the packet says why (N164)
      let current = ''
      try {
        if (await $.fs.exists(path)) current = String(await $.fs.read(path))
      } catch (err) {
        problem = `live.log could not be read (${message(err)})`
        return
      }
      const head = /^# \S+ · run (\d+) · /.exec(current)
      if (head && Number(head[1]) > run) {
        problem = 'a later run holds it'
        return
      }
      // a failed write is named like a link out (N104)
      await $.fs.write(path, `${lines.join('\n')}\n`).catch(err => {
        problem = `the write failed (${message(err)})`
      })
    })
    liveChains.set(role, next)
    return next
  }
  // A line within the 2 seconds gets one write at their end, so progress
  // never waits for the next line or the run's end (N63); close cancels it.
  let trailing: { cancel(): void } | undefined
  const flushSoon = async () => {
    const t = await now()
    if (isClosed) return
    if (t - flushedAt >= 2000) {
      flushedAt = t
      return write()
    }
    if (trailing) return
    trailing = $.clock.after(flushedAt + 2000 - t, () => {
      trailing = undefined
      if (isClosed) return
      void now().then(at => {
        flushedAt = at
        return write()
      })
    })
  }
  void now().then(t => {
    flushedAt = t
    return write()
  })
  return {
    line(raw: string, isHeld = false) {
      // the raw line and every decoded text of its event, before any cut (N83)
      const seen = [raw, ...eventTexts(raw)].join('\n')
      // Claude's output stays out of the log; a key marker in it still
      // seals the log with its one line (N203)
      if (id === 'claude') {
        if (isHeld || hasKeyBegin(seen)) seal()
        return
      }
      const kept = keyFilter(seen)
      if (kept === undefined) return
      // from the first key marker on (any stream, also in an unfinished
      // line) live.log shows one [redacted private key] line and nothing
      // more of the run but its end line (N101, N128, N134)
      if (isHeld || hasKeyBegin(seen)) seal()
      if (isSealed) return
      // the carry reads the raw line, before liveLine cuts and redacts it (N198)
      const text = kept === seen ? liveLine(id, carry(raw)) : kept
      if (!text) return
      lines.push(redact(text))
      void flushSoon()
    },
    // a line of the stream not shown: it moves the key state and seals (N114, N134)
    other(raw: string) {
      const seen = [raw, ...eventTexts(raw)].join('\n')
      if (id === 'claude') {
        if (hasKeyBegin(seen)) seal()
        return
      }
      keyFilter(seen)
      if (hasKeyBegin(seen)) seal()
    },
    seal,
    // why live.log is not written, once known (N88)
    get problem() {
      return problem
    },
    async close(outcome: RunOutcome, proc: ProcessResult) {
      // a stopped run names a key marker too (N190)
      // a marker seen anywhere in the run seals the log before its end line (N203)
      if (proc.isKeySeen) seal()
      const keyNote = keyFilter.isOpen || proc.isKeySeen ? '; answer hidden: a private key marker was in the output' : ''
      const state = proc.isTimedOut ? `stopped (timeout)${keyNote}` : proc.isStoppedByLimit ? `stopped (token limit)${keyNote}` : outcome.error
            ? // any key marker in either stream or in the error itself hides
              // the error text, closed or not (N101, N121)
              keyFilter.isOpen || proc.isKeySeen || hasKeyBegin(outcome.error.message)
              ? 'error (text hidden: a private key marker was in the output)'
              : `error: ${outcome.error.message}`
            : proc.isKeySeen
              ? 'failed (answer hidden: a private key marker was in the output)' // never "finished" (N133)
              : 'finished'
      lines.push(redact(`# ${state} · ${new Date().toISOString()}`))
      isClosed = true
      trailing?.cancel()
      trailing = undefined
      await write(true)
    },
  }
}

async function checkVersion($: EngineInterface, id: BackendId) {
  if (versions[id] !== undefined) return
  versions[id] = ''
  // a werkbankBin that looks like a credential is never run, not even for --version (N82)
  if (id === 'werkbank' && !isWerkbankBinSafe(binOf(id))) return
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
  // the session the run was asked to continue (werkbank reports a move, N41)
  passedSessionId?: string
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
    r.proc.isTimedOut ? `stopped after ${timeoutOf(r.id)} min` : '',
    r.proc.isStoppedByLimit ? `stopped at ${tokens(totalTokens(u))} tokens` : '',
  ].filter(Boolean)
  return [parts.join(' · '), ...tail].join(', ')
}

// A run whose output shows a key marker anywhere: its error texts and stderr
// are passed on nowhere, since a key may open in one stream and go on in
// another (N107).
const KEY_HIDDEN = "(text hidden: the run's output contains a private key marker)"
// the werkbank job states of N37 (N150, N171)
const KNOWN_REMOTE_STATES = WERKBANK_STATES
// a whole relay block, as parsePacket looks for it (N117)
const RELAY_FENCE = /```relay\s*\n[\s\S]*?```/g
const fencesIn = (text: string) => [...text.matchAll(RELAY_FENCE)].length
function withoutKeyTexts(r: RunResult): RunResult {
  const { outcome, proc } = r
  const texts = [proc.stderr, outcome.answer, outcome.error?.message, outcome.remote?.reason]
  // the run-wide verdict counts too, not only these fields (N127)
  if (!proc.isKeySeen && !texts.some(t => t && hasKeyBegin(t))) return r
  return {
    ...r,
    // a model name taken from the output goes too (N141)
    model: outcome.usage.model !== undefined && r.model === outcome.usage.model ? '' : r.model,
    outcome: {
      ...outcome,
      error: outcome.error && { ...outcome.error, message: KEY_HIDDEN },
      // no reported session id and no model name: the role keeps its own
      // session or starts fresh; numbers stay (N141)
      sessionId: undefined,
      usage: { ...outcome.usage, model: undefined },
      // every free text of the werkbank job goes too; state, commit ids and
      // numbers stay; without its file list the write check is incomplete
      // (N135)
      remote: outcome.remote && {
        ...outcome.remote,
        // the job id is hidden, the state kept only as a known one (N150)
        jobId: '(hidden)',
        state: KNOWN_REMOTE_STATES.includes(outcome.remote.state) ? outcome.remote.state : 'unknown',
        ...(outcome.remote.reason ? { reason: KEY_HIDDEN } : {}),
        branch: outcome.remote.branch === `agent/relay/${r.role.name}` ? outcome.remote.branch : KEY_HIDDEN,
        ...(outcome.remote.verify ? { verify: { ...outcome.remote.verify, ...(outcome.remote.verify.command !== undefined ? { command: KEY_HIDDEN } : {}) } } : {}),
        changedFiles: undefined,
        // whether it reported changed files is kept, for its branch line (N172)
        ...(outcome.remote.changedFiles?.length ? { hadChangedFiles: true as const } : {}),
      },
    },
    // only a file list werkbank reported is replaced; any other check, the
    // one of N170 say, stays (N174)
    check: r.check && r.id === 'werkbank' && outcome.remote?.changedFiles ? notChecked('the run printed a private key marker, so the file list werkbank reported is not shown') : r.check,
    proc: { ...proc, stderr: proc.stderr.trim() ? KEY_HIDDEN : '' },
  }
}

async function finish($: EngineInterface, raw: RunResult) {
  const r = withoutKeyTexts(raw)
  const { role, run, outcome, proc } = r
  // the whole answer is redacted before its packet is read: a key opened in
  // the prose may go on in the packet (N107); a key still open at the end of
  // the output hides the answer entirely (N114)
  const answer = proc.isKeySeen ? '' : redact(outcome.answer)
  // a relay block the redaction destroyed is a missing packet, never a bare
  // JSON object from the prose (N117);
  // fewer relay blocks after the redaction: no packet, not even an earlier
  // example block (N117, N123)
  const isFenceLost = fencesIn(answer) < fencesIn(outcome.answer)
  let packet = isFenceLost ? undefined : parsePacket(answer)
  let compressedBy: string | undefined
  let compressError: string | undefined
  const remote = r.notStarted ? undefined : outcome.remote
  // A werkbank job that did not end done gets no fallback compression (N54).
  const isRemoteEnd = !!remote && remote.state !== 'done'
  if (packet) packet.compressed_by = 'worker'
  else if (answer.trim() && !isRemoteEnd) {
    // A failing compressor is a missing packet, never a lost answer (N15).
    const c = await compress($, role.name, answer).catch(err => ((compressError = message(err)), {} as { packet?: Packet; by?: string }))
    packet = c.packet
    if (packet) {
      packet.compressed_by = 'fallback'
      compressedBy = c.by
    }
  }
  if (proc.isKeySeen) packet = failedPacket('answer hidden: the output contains a private key marker')
  const isGone = outcome.error?.kind === 'session-not-found'
  // A werkbank job that did not end done and left no packet: partial, since
  // commits may be on its branch; failed only when the job failed (N37, N54).
  if (!packet && remote && isRemoteEnd) {
    packet = failedPacket(`werkbank job ${remote.jobId} ended ${remote.state} without a relay packet; the full answer is in full.md.`)
    if (!isRemoteFailed(remote)) packet.status = 'partial'
  }
  packet ??= failedPacket(
    r.notStarted
      ? `Worker was not started: ${r.notStarted}.`
      : isGone
        ? `The worker's ${r.id} session is gone; the next task for this role starts fresh. (${outcome.error?.message ?? ''})`
        : proc.isTimedOut
          ? `Worker was stopped after ${timeoutOf(r.id)} minutes without a packet.`
          : proc.isStoppedByLimit
            ? `Worker was stopped at the token limit (${config.maxTokensPerRun}) without a packet.`
            : answer.trim()
              ? `Worker answered without a relay packet (fallback compression is off or failed${compressError ? `: ${compressError}` : ''}); read the full text.`
              : outcome.error
                ? `Worker failed (${outcome.error.kind}): ${outcome.error.message}`
                : `Worker produced no usable answer.${proc.stderr.trim() ? ` stderr: ${redact(proc.stderr.trim()).slice(0, 500)}` : ''}`,
  )
  if ((proc.isTimedOut || proc.isStoppedByLimit || outcome.error?.kind === 'budget') && packet.status === 'done') packet.status = 'partial'
  // A backend that failed after the packet: never done, and the error is named (N26).
  // A werkbank job's end is reported below instead.
  if (outcome.error && !isGone && !r.notStarted && !remote && packet.compressed_by !== 'none') {
    if (packet.status === 'done') packet.status = 'partial'
    packet.risks.push(`${r.id} reported an error after the answer (${outcome.error.kind}): ${outcome.error.message}`)
  }
  if (remote) {
    // N37: why the job did not end done; N38: its verify command; N40: its branch.
    const end = remoteEndLine(remote)
    if (end) packet.risks.push(end)
    // a state relay does not know, missing or hidden after a key marker, is
    // failed: isRemoteFailed says so (N150, N171)
    if (isRemoteFailed(remote)) packet.status = 'failed'
    else if (remote.state !== 'done' && packet.status === 'done') packet.status = 'partial'
    // N48: a CLI error never leaves a job done, and is named
    if (outcome.error && !isRemoteFailed(remote)) {
      if (packet.status === 'done') packet.status = 'partial'
      packet.risks.push(`werkbank-relay reported an error (${outcome.error.kind}): ${outcome.error.message}`)
    }
    // a failed or cancelled job: the error beyond its reason (a signal, a
    // broken stream) stays visible too (N85, N89)
    if (outcome.error && isRemoteFailed(remote) && outcome.error.message !== remote.reason) {
      packet.risks.push(`werkbank-relay reported an error (${outcome.error.kind}): ${outcome.error.message}`)
    }
    if (remote.verify) packet.facts.push({ id: `F${packet.facts.length + 1}`, text: remoteVerifyLine(remote.verify) })
    // N66: only real commit ids are shown; the rest is counted
    if (remote.malformedCommits) packet.risks.push(`werkbank reported ${remote.malformedCommits} malformed commit id(s) (not shown)`)
    const shas = remote.commits.map(c => c.slice(0, 7))
    for (const sha of shas) packet.artifacts.push({ path: `commit ${sha}`, change: 'created', note: `on ${remote.branch || 'the werkbank branch'}` })
    // also when its file list or commit ids were unusable (N175)
    if (remote.commits.length || remote.changedFiles?.length || remote.hadChangedFiles || remote.isFileListMalformed || remote.malformedCommits) {
      packet.needs_from_main.push(
        `The changes are on branch ${remote.branch || '(not reported)'} (werkbank job ${remote.jobId}${shas.length ? `, commits ${shas.join(', ')}` : ''}); relay does not merge them.`,
      )
    }
  }

  // The role's session for its next run; a run that never started keeps it.
  if (isGone) {
    role.sessionId = undefined
    role.sessionBackend = undefined
    role.sessionDir = undefined
  } else if (!r.notStarted) {
    // a reported id relay does not keep drops the old one too (N78)
    const next = outcome.isSessionRejected
      ? undefined
      : (outcome.sessionId ?? r.presetSessionId ?? (sessionBackendOf(role) === r.id ? role.sessionId : undefined))
    role.sessionId = next
    role.sessionBackend = next ? r.id : undefined
    role.sessionDir = next ? r.work.dir : undefined
    if (outcome.isSessionRejected) packet.risks.push(`werkbank reported a session id relay does not keep; the next task for ${role.name} starts a fresh session.`)
    else if (!next && r.id !== 'claude') packet.risks.push(`No ${r.id} session id was reported; the next task for ${role.name} starts a fresh session.`)
    // The role's worker was gone: the job ran fresh elsewhere (N41).
    if (r.id === 'werkbank' && r.passedSessionId && outcome.sessionId && outcome.sessionId !== r.passedSessionId) {
      packet.risks.push(`the werkbank session moved (${r.passedSessionId} → ${outcome.sessionId}); the worker started fresh, repeat the context it needs.`)
    }
  }

  if (r.check) applyWriteCheck(packet, r.check, { isLiteral: r.id === 'werkbank' })
  // Without git the check is skipped; that is said once per session (N27).
  if (r.check && !r.check.checked && !r.check.incomplete?.length && r.work.git.state === 'no' && !isNoGitNoticed) {
    isNoGitNoticed = true
    const note = 'write check skipped: the project is no git repository, so relay cannot see what workers write (said once per session).'
    packet.risks.push(note)
    notices.push(note)
  }
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

// A run's report on its way: its files, then its notification. The job
// leaves the queue only when both went through (N15).
type Delivery = {
  role: Role
  run: number
  job: QueuedJob
  files: [string, string][]
  text: string
  status: Packet['status']
  isStored: boolean
  // undelivered-<run>.md holds the message until it is delivered (N97)
  hasUndelivered?: boolean
}
const pendingDeliveries: Delivery[] = []

// Stores the run's files, updates the role and reports; true once the job
// could leave the queue. All that leaves relay here is redacted, the
// packet.json envelope included (N2, N19).
async function deliver(
  $: EngineInterface,
  role: Role,
  run: number,
  job: QueuedJob,
  answer: string,
  raw: Packet,
  rawHead: string,
  // a slot a later run holds: no files there, only the message (N102)
  extra: { backend: BackendId; usage: Usage; noFiles?: string },
): Promise<boolean> {
  const packet = redactDeep(raw)
  // the headline is always one line: a line break in its fields (usage.model,
  // say) becomes a space (N168)
  const head = redact(rawHead).replace(/[\r\n]+/g, ' ')
  // a later run holds the slot (N102, N110) or a file there is unsafe (N108)
  const noFiles = extra.noFiles ?? (isRotatedOut(role, run) ? 'a later run holds this slot' : undefined)
  const fullPath = noFiles ? `(not stored: ${noFiles})` : runPath(role.name, run, 'full.md')
  const files: [string, string][] = noFiles ? [] : [
    [fullPath, `# ${role.name} · run ${run}\n\n## Task\n\n${redact(job.task)}\n\n## Answer\n\n${redact(stripPacket(answer))}\n`],
    // the headline is kept for a delivery after a restart (N92)
    [runPath(role.name, run, 'packet.json'), JSON.stringify(redactDeep({ run, backend: extra.backend, usage: extra.usage, head, ...packet }), null, 2)],
  ]
  role.isBusy = false
  role.lastStatus = packet.status
  role.lastSummary = packet.summary
  roles[role.name] = role
  await save($).catch(() => undefined)
  return attemptDelivery($, { role, run, job, files, text: renderPacket(head, packet, fullPath, config.packetDetail), status: packet.status, isStored: false })
}

async function notify($: EngineInterface, d: Delivery) {
  // redacted where it leaves relay, whatever built it (N130)
  const text = redact(d.text)
  if (config.notifyMode === 'note') {
    // A refused append or a dropped prompt is no delivery: it is retried.
    const r = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
    if (r?.deny) throw new Error(`the packet could not be appended (${r.deny})`)
    $.ui.toast(`relay: ${d.role.name} run ${d.run} ${d.status}`)
  } else if (config.notifyMode === 'toast') {
    unread.push(text)
    $.ui.toast(`relay: ${d.role.name} run ${d.run} ${d.status} – worker_status shows it`)
  } else {
    const r = await $.prompt.submit({ text })
    if (r?.drop) throw new Error(`the packet prompt was dropped (${r.drop})`)
  }
}

async function attemptDelivery($: EngineInterface, d: Delivery): Promise<boolean> {
  try {
    if (!d.isStored) {
      await ensureGitignore($)
      // Never written where a check fails; the notification still goes out,
      // its warnings rebuilt on every attempt.
      const warnings = new Set<string>()
      const escape = await storageProblem($, relayPath(`runs/${d.role.name}`))
      if (escape) warnings.add(escape)
      else {
        // every file is checked itself right before it is written (N99), and
        // never into a slot a later run holds, on any attempt (N110)
        for (const [path, text] of d.files) {
          // the slot is checked again after the awaited path check (N116)
          // and the slot's packet.json may name a later run, written by any
          // session (N129); the rotation check stays last, with no await after it
          const why =
            (await storageProblem($, path)) ??
            (await slotProblem($, d.role.name, d.run)) ??
            (isRotatedOut(d.role, d.run) ? 'a later run holds this slot' : undefined)
          if (why) warnings.add(why)
          else await $.fs.write(path, text)
        }
      }
      // redacted once its warnings are in: they may name a resolved path (N109)
      const withWarnings = () => redact(d.text + [...warnings].map(w => `\nNot stored: ${w}.`).join(''))
      let text = withWarnings()
      if (!escape) {
        // the message itself, outside the rotation, until it is delivered,
        // under its job's id and length (N97, N103, N111)
        const keptPath = undeliveredPath(d.role.name, d.run)
        const why = await storageProblem($, keptPath)
        if (why) {
          warnings.add(why)
          text = withWarnings()
        } else {
          await $.fs.write(keptPath, `${jobLine(d.job.id, text.length, d.status)}\n${text}`)
          d.hasUndelivered = true
        }
      }
      d.text = text
      d.isStored = true
      // Durable: a restart now delivers the stored packet, not "interrupted".
      d.job.delivery = 'stored'
      await writeQueue($).catch(() => undefined)
    }
    await notify($, d)
  } catch (err) {
    if (!pendingDeliveries.includes(d)) {
      pendingDeliveries.push(d)
      notices.push(
        redact(`relay could not ${d.isStored ? 'deliver' : 'store'} ${d.role.name} run ${d.run} (${message(err)}); its job stays in the queue and relay tries again with the next heartbeat.`),
      )
    }
    return false
  }
  const i = pendingDeliveries.indexOf(d)
  if (i >= 0) pendingDeliveries.splice(i, 1)
  unreported.delete(d.job.id)
  queue.jobs = queue.jobs.filter(j => j.id !== d.job.id)
  // the queue first: only once the job is gone from it is the kept message
  // cleared, so a crash in between delivers twice, never "interrupted" (N124)
  const isQueueWritten = await writeQueue($).then(
    () => true,
    err => {
      if (!(err instanceof NotOwnerError)) notices.push(`relay could not write the queue after ${d.role.name} run ${d.run} (${message(err)}).`)
      return false
    },
  )
  // delivered: the kept message is cleared, checked like any relay file (N97)
  if (isQueueWritten && d.hasUndelivered && !(await storageProblem($, undeliveredPath(d.role.name, d.run)))) {
    await $.fs.write(undeliveredPath(d.role.name, d.run), '').catch(() => undefined)
  }
  return true
}

async function retryDeliveries($: EngineInterface) {
  for (const d of [...pendingDeliveries]) await attemptDelivery($, d)
}

// A job whose files were stored but whose packet never arrived: deliver the
// stored packet; when it is gone, report the run as interrupted.
// The headline packet.json kept, only when it is this run's own one line.
function storedHeadOf(text: string, role: string, run: number): string | undefined {
  try {
    const head = (JSON.parse(text) as { head?: unknown }).head
    return typeof head === 'string' && !head.includes('\n') && head.startsWith(`[relay] ${role} · run ${run} `) ? redact(head) : undefined
  } catch {
    return undefined
  }
}

// Whether packet.json is the envelope of this run on this backend (N97).
function isEnvelopeOf(text: string, run: number, backend: BackendId): boolean {
  try {
    const v = JSON.parse(text) as { run?: unknown; backend?: unknown }
    return v.run === run && v.backend === backend
  } catch {
    return false
  }
}

// Whether werkbank-relay printed a JSON object, as its parse reads it (N170).
function hasJsonObject(stdout: string): boolean {
  try {
    const v = JSON.parse(stdout.trim()) as unknown
    return !!v && typeof v === 'object' && !Array.isArray(v)
  } catch {
    return false
  }
}

// Whether packet.json names this run (N131).
function isEnvelopeRun(text: string, run: number): boolean {
  try {
    return (JSON.parse(text) as { run?: unknown }).run === run
  } catch {
    return false
  }
}

// The first line of undelivered-<run>.md: whose message it is and how long,
// so a partly written one is told apart (N103, N111).
// It carries the checked packet status too, so a restart never reads it from
// the text (N168).
const jobLine = (id: string, length: number, status?: Packet['status']) => `<!-- relay job ${id} length ${length}${status ? ` status ${status}` : ''} -->`
const JOB_LINE = /^<!-- relay job (\S+) length (\d+)(?: status (done|partial|blocked|failed))? -->$/
type KeptMessage = { body: string; status?: Packet['status'] }
const RESTART_MARK = ' · delivered after a restart'

// The kept message of this job, without its id line; undefined when the file
// is missing, empty, unsafe, carries another (or no) job id or is not as
// long as its id line says (N103, N111).
async function keptMessageOf($: EngineInterface, job: QueuedJob): Promise<KeptMessage | { unsafe: string } | undefined> {
  if (job.run === undefined) return undefined
  const path = undeliveredPath(job.role, job.run)
  // a link out is no missing file: the run is reported as interrupted (N118)
  const unsafe = await storageProblem($, path)
  if (unsafe) return { unsafe }
  const text = String(await $.fs.read(path).catch(() => ''))
  const nl = text.indexOf('\n')
  const body = text.slice(nl + 1)
  const line = nl < 0 ? undefined : JOB_LINE.exec(text.slice(0, nl))
  if (!line || line[1] !== job.id || Number(line[2]) !== body.length) return undefined
  return body.trim() ? { body, status: line[3] as Packet['status'] | undefined } : undefined
}

// Delivers a kept message; its headline says it came after a restart (N105).
async function deliverKept($: EngineInterface, job: QueuedJob, kept: KeptMessage): Promise<string | undefined> {
  const body = kept.body
  const run = job.run ?? 0
  // the role is kept with at least this run, before any later task starts (N152)
  const role = (roles[job.role] ??= { name: job.role, runs: run, isBusy: false })
  role.runs = Math.max(role.runs, run)
  await save($).catch(() => undefined)
  const nl = body.indexOf('\n')
  const text = nl < 0 ? `${body}${RESTART_MARK}` : `${body.slice(0, nl)}${RESTART_MARK}${body.slice(nl)}`
  // the status of the id line; a file from before 2r: only the line right
  // after the headline (N168)
  const second = nl < 0 ? '' : (body.slice(nl + 1).split('\n')[0] ?? '')
  const status = kept.status ?? ((/^Status: (done|partial|blocked|failed)\b/.exec(second)?.[1] ?? 'partial') as Packet['status'])
  const d: Delivery = { role, run, job, files: [], text: redact(text), status, isStored: true, hasUndelivered: true }
  return (await attemptDelivery($, d)) ? undefined : 'reporting failed (the stored packet could not be delivered)'
}

async function deliverStored($: EngineInterface, job: QueuedJob): Promise<string | undefined> {
  const role = roles[job.role]
  const run = job.run ?? 0
  // the run number is kept before any later task starts (N152)
  if (role && role.runs < run) {
    role.runs = run
    await save($).catch(() => undefined)
  }
  // the kept message was looked for first, in recover (N97, N103); the
  // stored packet is read only when it is no link out (N108)
  const unsafe = role ? await storageProblem($, runPath(job.role, run, 'packet.json')) : undefined
  if (unsafe) return reportInterrupted($, job, redact(`the stored report was not read: ${unsafe}`), { noFiles: 'its stored files are not safe to use' })
  const text = role ? String(await $.fs.read(runPath(job.role, run, 'packet.json')).catch(() => '')) : ''
  // packet.json only when it is this run's: a later run may have taken its
  // slot, whose files then stay as they are (N97, N102)
  if (role && text.trim() && !isEnvelopeOf(text, run, job.backend)) {
    return reportInterrupted($, job, 'the stored report was overwritten by a later run (keepRuns)', { noFiles: 'a later run holds this slot' })
  }
  const stored = role ? parsePacket(text) : undefined
  if (!role || !stored) return reportInterrupted($, job)
  // the stored headline with its warnings, else the plain one (N92)
  const storedHead = storedHeadOf(text, role.name, run)
  const head = storedHead ? `${storedHead} · delivered after a restart` : `[relay] ${role.name} · run ${run} finished (${job.backend}, delivered after a restart)`
  const d: Delivery = { role, run, job, files: [], text: renderPacket(head, stored, runPath(role.name, run, 'full.md'), config.packetDetail), status: stored.status, isStored: true }
  return (await attemptDelivery($, d)) ? undefined : 'reporting failed (the stored packet could not be delivered)'
}

// worker_expand without the final redaction, which its handler applies (N157)
async function expandRun($: EngineInterface, e: unknown): Promise<{ result: string }> {
  const input = e as { role: string; run?: number; section?: string; maxChars?: number }
  const role = roles[input.role]
  if (!role || role.runs === 0) return { result: `No runs for role "${input.role}".` }
  // only whole run numbers from 1 (N159)
  if (input.run !== undefined && !(Number.isSafeInteger(input.run) && input.run >= 1)) {
    return { result: `Run must be a whole number from 1 (got ${String(input.run).slice(0, 40)}).` }
  }
  const run = input.run ?? (role.isBusy ? role.runs - 1 : role.runs)
  if (run < 1) return { result: `${role.name} has no finished run yet.` }
  // no run that has not begun (N131)
  if (run > role.runs) return { result: `${role.name} has no run ${run} yet (${role.runs} begun).` }
  if (isRotatedOut(role, run)) return { result: `${role.name} run ${run} was rotated out (keepRuns ${config.keepRuns}).` }
  // a slot file that belongs to another run is never shown as this one (N131)
  const otherRun = { result: `No stored report for ${role.name} run ${run} (the slot holds another run, or its two files do not match).` }
  // both files of the slot must name this run before either is shown (N138)
  // a missing or unreadable file of the pair is named itself (N154)
  const pairProblem = async () => {
    const p = runPath(role.name, run, 'packet.json')
    const f = runPath(role.name, run, 'full.md')
    if ((await storageProblem($, p)) || (await storageProblem($, f))) return otherRun
    const texts: string[] = []
    for (const path of [p, f]) {
      try {
        texts.push(String(await $.fs.read(path)))
      } catch {
        return { result: `No stored report for ${role.name} run ${run} (${path} is missing or unreadable).` }
      }
    }
    return isEnvelopeRun(texts[0]!, run) && texts[1]!.startsWith(`# ${role.name} · run ${run}\n`) ? undefined : otherRun
  }
  // a report file is read only when it is no link out, like before its
  // write (N99, N108)
  const refused = async (path: string) => {
    const why = await storageProblem($, path)
    return why ? { result: redact(`relay does not read ${path} (${why}).`) } : undefined
  }
  if (input.section?.trim().toLowerCase() === 'packet') {
    const path = runPath(role.name, run, 'packet.json')
    // either file of the slot that is unsafe is named itself (N147)
    const no = (await refused(path)) ?? (await refused(runPath(role.name, run, 'full.md')))
    if (no) return no
    try {
      const raw = String(await $.fs.read(path))
      if (!isEnvelopeRun(raw, run)) return otherRun
      const pair = await pairProblem()
      if (pair) return pair
      const packet = parsePacket(raw)
      if (packet) return { result: redact(renderPacket(`[relay] ${role.name} · run ${run}`, packet, runPath(role.name, run, 'full.md'), 'full')) }
    } catch {
      // fall through
    }
    return { result: `No stored packet for ${role.name} run ${run}.` }
  }
  const fullPath = runPath(role.name, run, 'full.md')
  const no = (await refused(fullPath)) ?? (await refused(runPath(role.name, run, 'packet.json')))
  if (no) return no
  let text: string
  try {
    // redacted before a section is looked for or the text is cut (N108)
    text = redact(String(await $.fs.read(fullPath)))
  } catch {
    return { result: `No stored answer for ${role.name} run ${run}.` }
  }
  if (!text.startsWith(`# ${role.name} · run ${run}\n`)) return otherRun
  const pair = await pairProblem()
  if (pair) return pair
  let out = text
  if (input.section) {
    const found = extractSection(text, input.section)
    if (!found) return { result: redact(`No section "${input.section}" in ${role.name} run ${run}.`) }
    out = found
  }
  const max = input.maxChars ?? 12000
  return { result: out.length > max ? `${out.slice(0, max)}\n… [cut at ${max} of ${out.length} chars]` : out }
}

// A job the file still marks running died with the last module: report it
// as failed, with the write check against its snapshot, and never restart it.
// Returns why it could not be reported yet, or undefined once it was (the job
// then left the queue).
async function reportInterrupted($: EngineInterface, job: QueuedJob, note?: string, opts: { noFiles?: string } = {}): Promise<string | undefined> {
  const defs = await loadRoleDefs($)
  let role = roles[job.role]
  if (!role && defs[job.role]) role = roles[job.role] = { name: job.role, runs: job.run ?? 0, isBusy: false }
  if (!role) return 'orphaned: the role exists neither in the store nor in the roles file'
  const run = job.run ?? role.runs
  role.runs = Math.max(role.runs, run)
  const eff = effective(role, defs[role.name])
  const packet = failedPacket('Interrupted: the plugin was reloaded or the session ended while this run was working. It was not restarted.')
  if (note) packet.risks.push(note)
  if (config.writeCheck === 'report' && job.backend === 'werkbank') {
    // No local snapshot exists; the job may still run on the server (N53).
    applyWriteCheck(packet, notChecked(`the werkbank job may still be running on the server; its changes would be on agent/relay/${role.name}`))
  } else if (config.writeCheck === 'report') {
    let before: Snapshot | undefined
    try {
      before = JSON.parse(await $.fs.read(snapshotPath(role.name, run))) as Snapshot
    } catch {
      before = undefined
    }
    const dir = eff.isolation === 'worktree' ? absolute(relayPath(`worktrees/${role.name}`)) : cwd
    applyWriteCheck(packet, await writeCheckOf($, eff.owns, dir, before, await gitStateOf($, dir)))
  }
  // the headline marks the check like a live report does (N10, N86)
  let head = `[relay] ${role.name} · run ${run} interrupted (${job.backend})`
  if (packet.write_check?.outside.length) head += ` ⚠ wrote outside owns (${packet.write_check.outside.length})`
  if (packet.write_check?.incomplete?.length) head += ' ⚠ write check incomplete'
  const isDone = await deliver($, role, run, job, '', packet, head, { backend: job.backend, usage: {}, noFiles: opts.noFiles })
  return isDone ? undefined : 'reporting failed (relay retries with the next heartbeat)'
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
    // only where the backend applies it (N112)
    (eff.isolation === 'worktree' && !ignored.includes('isolation') ? ' · worktree' : '') +
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
  config.werkbankBin = str('werkbankBin', config.werkbankBin)
  config.werkbankLeitstand = str('werkbankLeitstand', config.werkbankLeitstand).trim()
  config.werkbankTokenFile = str('werkbankTokenFile', config.werkbankTokenFile)
  config.werkbankTimeoutMin = num('werkbankTimeoutMin', config.werkbankTimeoutMin)
  if (config.werkbankTimeoutMin > 0 && config.runTimeoutMin > 0 && config.werkbankTimeoutMin <= config.runTimeoutMin) {
    configNotes.push(
      `werkbankTimeoutMin (${config.werkbankTimeoutMin}) is not above runTimeoutMin (${config.runTimeoutMin}): relay may stop a werkbank run before the worker on the server ends it.`,
    )
  }
  // a worker without a limit outlives any werkbankTimeoutMin (N182)
  if (config.werkbankTimeoutMin > 0 && config.runTimeoutMin === 0) {
    configNotes.push(
      `runTimeoutMin is 0 (no limit for the worker on the server), but werkbankTimeoutMin (${config.werkbankTimeoutMin}) stops werkbank-relay after ${config.werkbankTimeoutMin} min; the job may run on in the Leitstand.`,
    )
  }

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
    pendingDeliveries.length = 0
    isNoGitNoticed = false
    projectRoot = undefined
    // Nothing is written before the relay folder is known to stay inside the
    // project (N17): not the case probe, not the queue claim.
    const escape = await storageProblem($, config.relayDir)
    if (escape) {
      queueError = escape
      notices.push(`${escape}; this session writes no relay files and does not work the queue.`)
    } else pathCase = await probeCase($)

    let loaded: Awaited<ReturnType<typeof readQueue>> | undefined
    try {
      if (!escape) loaded = await readQueue($)
    } catch (err) {
      queueError = `${relayPath('queue.json')} could not be read (${message(err)})`
      notices.push(`${queueError}; this session does not work the queue, so nothing in it is lost or overwritten.`)
    }
    if (loaded?.isBroken) notices.push(loaded.isFromBackup ? 'queue.json was broken; relay read queue.json.bak instead.' : 'queue.json was broken and had no usable backup; the queue starts empty.')
    else if (loaded?.isFromBackup) notices.push('queue.json was empty or missing; relay read queue.json.bak instead.')
    if (loaded?.dropped) notices.push(`relay left out ${loaded.dropped} job(s) from the queue with an invalid role name, run number, id or field.`)
    if (loaded) adopt(loaded)
    else {
      queue = emptyQueue()
      lastQueueText = undefined
      lastBackupText = undefined
    }
    await save($)

    await $.tool.register({
      name: 'worker_send',
      isDeferred: false,
      description:
        'Send a task to a persistent worker session (its own Claude Code, Codex or OpenCode session, started via CLI, or a Claude session on the Werkbank servers with backend werkbank). ' +
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
    // every answer is redacted as a whole, diagnostics included (N157)
    const r = await expandRun($, e)
    return { result: redact(r.result) }
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
      if (queueError) return { result: redact(`relay takes no tasks in this session: ${queueError}. Fix the file (or its permissions) and reload the plugin.`) }
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
    // an unreadable roles file takes no task: its backend and rules are unknown (N151)
    let def: RoleDef | undefined
    try {
      def = (await loadRoleDefs($, { isStrict: true }))[name]
    } catch (err) {
      if (!(err instanceof RoleFileError)) throw err
      return { result: redact(`relay takes no task now: ${message(err)}; fix it and send again.`) }
    }
    const prior = effective(role, def)
    const backendBefore = prior.backend
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
    // A session belongs to its folder (N23).
    // werkbank does not use isolation, so its session stays (N55).
    if (eff.isolation !== prior.isolation && role.sessionId && eff.backend !== 'werkbank') {
      role.sessionId = undefined
      role.sessionBackend = undefined
      role.sessionDir = undefined
      notes.push(`isolation changed from ${prior.isolation} to ${eff.isolation}: the old session was dropped`)
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

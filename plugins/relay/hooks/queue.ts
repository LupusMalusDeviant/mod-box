// The queue on disk (contract 0001, section 7). Pure functions only.
import type { BackendId } from './backends.ts'
import { redact } from './protocol.ts'

export type QueuedJob = {
  id: string
  role: string
  task: string
  model?: string
  enqueuedAt: string
  state: 'queued' | 'running'
  run?: number
  startedAt?: string
  backend: BackendId
  // The run's files are stored but its packet was not delivered yet: the
  // next start delivers the stored packet instead of calling it interrupted.
  delivery?: 'stored'
}

export type QueueFile = {
  version: 1
  // token: this module's own claim; a session that finds another token there
  // stops working the queue (contract 0001, Nachtrag 1).
  owner?: { session: string; heartbeatAt: string; token?: string }
  jobs: QueuedJob[]
}

// A session that has not beaten its heart for this long gives up the queue.
export const OWNER_STALE_MS = 3 * 60_000
export const HEARTBEAT_MS = 60_000
// How long a fresh claim waits before it reads the file back to see whether
// it held ($.fs has no exclusive create, V3).
export const CLAIM_SETTLE_MS = 2_000

export function emptyQueue(): QueueFile {
  return { version: 1, jobs: [] }
}

export function newToken(): string {
  return crypto.randomUUID().replace(/-/g, '')
}

export function newJobId(): string {
  return `j_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}

// The names a role may have; they become folder and file names (N81).
export const ROLE_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/

// A run number: a whole number from 1 in the safe range (N188).
export const isRunNumber = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1

// A job id as relay makes them, which no redaction changes (N189).
const JOB_ID = /^j_[A-Za-z0-9_-]{1,40}$/

// A job from the file whose role, run or id could steer a path elsewhere or
// carry a credential into a file (N81, N188, N189).
const isSafeJob = (j: QueuedJob) =>
  typeof j.role === 'string' &&
  ROLE_NAME.test(j.role) &&
  (j.run === undefined || isRunNumber(j.run)) &&
  // a text id, checked whole and after its j_ too (N189, N193, N196)
  typeof j.id === 'string' &&
  JOB_ID.test(j.id) &&
  redact(j.id) === j.id &&
  redact(j.id.slice(2)) === j.id.slice(2)

// The queue in the text plus the number of jobs dropped as unsafe;
// undefined when the text is not a queue file.
function readQueueText(text: string | undefined): { queue: QueueFile; dropped: number } | undefined {
  if (!text?.trim()) return undefined
  try {
    const v = JSON.parse(text) as Partial<QueueFile>
    if (v?.version !== 1 || !Array.isArray(v.jobs)) return undefined
    const jobs = v.jobs.filter(
      (j): j is QueuedJob =>
        // the role and the id are judged by isSafeJob, so a bad one is
        // counted (N93, N196)
        !!j && typeof j.task === 'string' && (j.state === 'queued' || j.state === 'running'),
    )
    const safe = jobs.filter(isSafeJob)
    const owner =
      v.owner && typeof v.owner.session === 'string' && typeof v.owner.heartbeatAt === 'string' ? v.owner : undefined
    return { queue: { version: 1, ...(owner ? { owner } : {}), jobs: safe.map(j => ({ ...j, backend: j.backend ?? 'claude' })) }, dropped: jobs.length - safe.length }
  } catch {
    return undefined
  }
}

// undefined when the text is not a queue file.
export function parseQueue(text: string | undefined): QueueFile | undefined {
  return readQueueText(text)?.queue
}

// Reads queue.json, falling back to the copy written before the last change.
// `dropped`: jobs left out for an invalid role or run (N81).
export function loadQueue(
  main: string | undefined,
  backup: string | undefined,
): { queue: QueueFile; isFromBackup: boolean; isBroken: boolean; dropped: number } {
  const q = readQueueText(main)
  if (q) return { queue: q.queue, isFromBackup: false, isBroken: false, dropped: q.dropped }
  const isBroken = !!main?.trim()
  const b = readQueueText(backup)
  // Read from the backup whenever main gave nothing usable, empty included:
  // the caller then never backs that main text up over the good copy
  // (contract 0001, N21).
  if (b) return { queue: b.queue, isFromBackup: true, isBroken, dropped: b.dropped }
  return { queue: emptyQueue(), isFromBackup: false, isBroken, dropped: 0 }
}

// Whether `session` may work the queue: nobody owns it, it owns it, or the
// owner's heartbeat is stale.
export function mayOwn(q: QueueFile, session: string, now: number): boolean {
  if (!q.owner || q.owner.session === session) return true
  return !isFresh(q.owner, now)
}

// Whether an owner's heartbeat is recent enough to hold the queue.
export function isFresh(owner: { heartbeatAt: string }, now: number): boolean {
  const beat = Date.parse(owner.heartbeatAt)
  return Number.isFinite(beat) && now - beat <= OWNER_STALE_MS
}

export function serializeQueue(q: QueueFile): string {
  return `${JSON.stringify(q, null, 2)}\n`
}

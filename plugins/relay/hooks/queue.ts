// The queue on disk (contract 0001, section 7). Pure functions only.
import type { BackendId } from './backends.ts'

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

// undefined when the text is not a queue file.
export function parseQueue(text: string | undefined): QueueFile | undefined {
  if (!text?.trim()) return undefined
  try {
    const v = JSON.parse(text) as Partial<QueueFile>
    if (v?.version !== 1 || !Array.isArray(v.jobs)) return undefined
    const jobs = v.jobs.filter(
      (j): j is QueuedJob =>
        !!j && typeof j.id === 'string' && typeof j.role === 'string' && typeof j.task === 'string' && (j.state === 'queued' || j.state === 'running'),
    )
    const owner =
      v.owner && typeof v.owner.session === 'string' && typeof v.owner.heartbeatAt === 'string' ? v.owner : undefined
    return { version: 1, ...(owner ? { owner } : {}), jobs: jobs.map(j => ({ ...j, backend: j.backend ?? 'claude' })) }
  } catch {
    return undefined
  }
}

// Reads queue.json, falling back to the copy written before the last change.
export function loadQueue(main: string | undefined, backup: string | undefined): { queue: QueueFile; isFromBackup: boolean; isBroken: boolean } {
  const q = parseQueue(main)
  if (q) return { queue: q, isFromBackup: false, isBroken: false }
  const isBroken = !!main?.trim()
  const b = parseQueue(backup)
  // Read from the backup whenever main gave nothing usable, empty included:
  // the caller then never backs that main text up over the good copy
  // (contract 0001, N21).
  if (b) return { queue: b, isFromBackup: true, isBroken }
  return { queue: emptyQueue(), isFromBackup: false, isBroken }
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

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
}

export type QueueFile = {
  version: 1
  owner?: { session: string; heartbeatAt: string }
  jobs: QueuedJob[]
}

// A session that has not beaten its heart for this long gives up the queue.
export const OWNER_STALE_MS = 3 * 60_000
export const HEARTBEAT_MS = 60_000

export function emptyQueue(): QueueFile {
  return { version: 1, jobs: [] }
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
  if (b) return { queue: b, isFromBackup: isBroken, isBroken }
  return { queue: emptyQueue(), isFromBackup: false, isBroken }
}

// Whether `session` may work the queue: nobody owns it, it owns it, or the
// owner's heartbeat is stale.
export function mayOwn(q: QueueFile, session: string, now: number): boolean {
  if (!q.owner || q.owner.session === session) return true
  const beat = Date.parse(q.owner.heartbeatAt)
  return !Number.isFinite(beat) || now - beat > OWNER_STALE_MS
}

export function serializeQueue(q: QueueFile): string {
  return `${JSON.stringify(q, null, 2)}\n`
}

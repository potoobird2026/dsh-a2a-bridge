/**
 * Disk-backed store for finished A2A tasks.
 *
 * WHY DISK: `GetTask` used to be a stub that always answered `-32001`, so a peer
 * that received a task could never look it up again — the task state machine
 * existed in the card and nowhere else. Persisting to disk is what makes
 * `GetTask` / `CancelTask` meaningful ACROSS a DSH restart.
 *
 * Two properties matter more than throughput here, because this store sits on the
 * request path of a protocol the peer cannot debug:
 *
 *   1. A corrupt or half-written record must never fail a request. Records are
 *      written atomically (temp file + rename) and read defensively: anything
 *      unreadable is treated as absent and logged, never thrown.
 *   2. The id comes from the WIRE, so it is untrusted. It is validated against a
 *      strict character class BEFORE it reaches `path.join`, which is what keeps
 *      `../../etc/passwd` from becoming a filesystem path.
 *
 * Layering: imports only `../constants.js` + `../protocol/wire.js`.
 */

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { A2ATask } from '../protocol/wire.js'
import { DEFAULT_TASK_LIST_LIMIT, MAX_TASK_ID_LENGTH } from '../constants.js'

/** One persisted task plus the timestamps retention policy needs. */
export interface StoredTask {
  readonly task: A2ATask
  /** Epoch milliseconds when the record was first written. */
  readonly createdAt: number
  /** Epoch milliseconds of the most recent write. */
  readonly updatedAt: number
}

/** How long a record lives. A function is allowed so config changes apply live. */
export type NumberSource = number | (() => number)

export interface TaskStoreOptions {
  /** Absolute directory holding one JSON file per task. */
  readonly dir: string | (() => string)
  /** Records older than this (by `updatedAt`) are pruned. */
  readonly retentionMs: NumberSource
  /** Hard cap on stored records; the oldest are pruned past it. */
  readonly maxRecords: NumberSource
  /** Injectable clock, so retention tests do not sleep. */
  readonly now?: () => number
  /** Diagnostics sink; must never throw. */
  readonly log?: (message: string) => void
}

/**
 * Characters we are willing to see in a file name.
 *
 * The length cap is checked separately against `MAX_TASK_ID_LENGTH` so the bound
 * has one home (constants) instead of hiding inside a quantifier.
 */
const SAFE_TASK_ID_CHARS = /^[A-Za-z0-9._-]+$/

function sourceOf(value: NumberSource): number {
  const raw = typeof value === 'function' ? value() : value
  return Number.isFinite(raw) && raw > 0 ? raw : 0
}

/**
 * Read one volatile numeric config field into a number `TaskStore` can use.
 *
 * `.volatile()` makes the LIVE value an accessor, so it is unwrapped first. When the
 * value is unreadable (a throwing `.get()`, a partially-built config object) the
 * documented default is returned rather than collapsing to 0 — 0 means "no limit"
 * here, and silently converting an unreadable value into "keep everything forever"
 * is the worse failure.
 *
 * ZERO IS ACCEPTED, NOT FALLEN BACK. The schema is `Schema.natural()`, so 0 is a
 * legal operator choice ("no age pruning" / "no record cap"). A previous version
 * required `raw > 0`, which quietly rewrote an explicit 0 into the default: the UI
 * showed 0 while the running policy was the default.
 */
export function volatileNumberOr(
  value: unknown,
  fallback: number,
  unwrap: (input: unknown) => unknown,
): number {
  const raw = typeof value === 'function' ? (value as () => unknown)() : value
  const unwrapped = unwrap(raw)
  return typeof unwrapped === 'number' && Number.isFinite(unwrapped) && unwrapped >= 0
    ? unwrapped
    : fallback
}

function dirOf(value: string | (() => string)): string {
  return typeof value === 'function' ? value() : value
}

/**
 * True when an id is safe to use as a file name.
 *
 * Exported because callers must reject a forged id BEFORE a lookup, so the error
 * they return is the protocol's (`-32001`), not a filesystem error.
 */
export function isSafeTaskId(id: string): boolean {
  return (
    id.length > 0 &&
    id.length <= MAX_TASK_ID_LENGTH &&
    SAFE_TASK_ID_CHARS.test(id) &&
    !id.includes('..')
  )
}

export class TaskStore {
  constructor(private readonly options: TaskStoreOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private fileFor(taskId: string): string {
    return join(dirOf(this.options.dir), `${taskId}.json`)
  }

  private warn(message: string): void {
    try {
      this.options.log?.(message)
    } catch {
      // Diagnostics must never fail a request.
    }
  }

  /** Create the directory on demand; a missing directory is the normal first run. */
  private async ensureDir(): Promise<string> {
    const dir = dirOf(this.options.dir)
    await mkdir(dir, { recursive: true })
    return dir
  }

  /**
   * Write one record.
   *
   * Atomic by construction: the payload lands in `<id>.json.tmp` and is renamed
   * into place, so a crash mid-write leaves either the old record or none — never
   * a truncated JSON that would make `get` return a lie.
   */
  async save(task: A2ATask): Promise<void> {
    if (!isSafeTaskId(task.id)) {
      this.warn(`a2a: refusing to persist task with unsafe id: ${String(task.id).slice(0, 64)}`)
      return
    }
    await this.ensureDir()
    const target = this.fileFor(task.id)
    const temp = `${target}.tmp`
    const timestamp = this.now()
    const existing = await this.get(task.id)
    const record: StoredTask = {
      task,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    }
    const payload = JSON.stringify(record)
    await writeFile(temp, payload, 'utf8')
    await rename(temp, target)
    await this.prune()
  }

  /**
   * Read one record.
   *
   * Returns `undefined` for: an unsafe id, a missing file, unparsable JSON, a
   * shape that is not a task, or an expired record. Every one of those is the
   * same answer to the caller — "no such task" — which is why nothing here
   * throws.
   */
  async get(taskId: string): Promise<StoredTask | undefined> {
    if (!isSafeTaskId(taskId)) return undefined
    let raw: string
    try {
      raw = await readFile(this.fileFor(taskId), 'utf8')
    } catch {
      return undefined
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.warn(`a2a: task record could not be parsed and is treated as absent: ${taskId}`)
      return undefined
    }
    if (!isStoredTask(parsed)) {
      this.warn(`a2a: task record has an unexpected shape and is treated as absent: ${taskId}`)
      return undefined
    }
    const retention = sourceOf(this.options.retentionMs)
    if (retention > 0 && this.now() - parsed.updatedAt > retention) return undefined
    return parsed
  }

  /** Remove one record. A missing file is success, not an error. */
  async remove(taskId: string): Promise<void> {
    if (!isSafeTaskId(taskId)) return
    try {
      await rm(this.fileFor(taskId), { force: true })
    } catch (error) {
      this.warn(`a2a: could not remove task record ${taskId}: ${String(error)}`)
    }
  }

  /**
   * Enforce both halves of the retention policy: age first, then count.
   *
   * Called after every successful write, so the store stays bounded without a
   * timer — a background interval would keep the Cordis fiber alive and would
   * have to be disposed explicitly.
   */
  async prune(): Promise<void> {
    const dir = dirOf(this.options.dir)
    const retention = sourceOf(this.options.retentionMs)
    const maxRecords = sourceOf(this.options.maxRecords)
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return
    }

    const records: Array<{ path: string, updatedAt: number }> = []
    for (const name of names) {
      if (!name.endsWith('.json')) {
        // Stray `.tmp` files are leftovers from an interrupted write.
        if (name.endsWith('.json.tmp')) {
          const leftover = join(dir, name)
          try {
            await rm(leftover, { force: true })
          } catch {
            // Ignored: a leftover temp file is harmless.
          }
        }
        continue
      }
      const path = join(dir, name)
      let updatedAt = 0
      try {
        const raw = await readFile(path, 'utf8')
        const parsed: unknown = JSON.parse(raw)
        if (isStoredTask(parsed)) updatedAt = parsed.updatedAt
        else {
          await rm(path, { force: true })
          continue
        }
      } catch {
        try {
          await rm(path, { force: true })
        } catch {
          // Ignored.
        }
        continue
      }
      records.push({ path, updatedAt })
    }

    const now = this.now()
    const kept: Array<{ path: string, updatedAt: number }> = []
    for (const record of records) {
      if (retention > 0 && now - record.updatedAt > retention) {
        try {
          await rm(record.path, { force: true })
        } catch {
          // Ignored: the record will be retried on the next prune.
        }
        continue
      }
      kept.push(record)
    }

    if (maxRecords > 0 && kept.length > maxRecords) {
      kept.sort((a, b) => a.updatedAt - b.updatedAt)
      for (const record of kept.slice(0, kept.length - maxRecords)) {
        try {
          await rm(record.path, { force: true })
        } catch {
          // Ignored.
        }
      }
    }
  }

  /** Newest-first listing, bounded, for diagnostics and a future `ListTasks`. */
  async list(limit = DEFAULT_TASK_LIST_LIMIT): Promise<StoredTask[]> {
    const dir = dirOf(this.options.dir)
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return []
    }
    const found: StoredTask[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const id = name.slice(0, -'.json'.length)
      const record = await this.get(id)
      if (record !== undefined) found.push(record)
    }
    found.sort((a, b) => b.updatedAt - a.updatedAt)
    return found.slice(0, Math.max(0, limit))
  }

  /** Size of the on-disk directory, in bytes, for the settings page summary. */
  async size(): Promise<number> {
    const dir = dirOf(this.options.dir)
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return 0
    }
    let total = 0
    for (const name of names) {
      try {
        const info = await stat(join(dir, name))
        total += info.size
      } catch {
        // Ignored.
      }
    }
    return total
  }
}

function isStoredTask(value: unknown): value is StoredTask {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<StoredTask>
  if (typeof candidate.createdAt !== 'number' || typeof candidate.updatedAt !== 'number') return false
  const task = candidate.task as Partial<A2ATask> | undefined
  if (task === null || task === undefined || typeof task !== 'object') return false
  if (typeof task.id !== 'string' || task.id.length === 0) return false
  const status = task.status as { state?: unknown } | undefined
  return status !== undefined && status !== null && typeof status.state === 'string'
}

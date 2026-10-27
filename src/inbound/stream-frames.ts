/**
 * Frame construction and coalescing for `SendStreamingMessage`.
 *
 * Semantic decisions already fixed (the user picked the conservative pair and then
 * stopped answering; this is the smallest defensible reading of them):
 *
 *   C1 — STATUS-LEVEL frames, not token deltas. A peer learns *what is happening*
 *        (submitted → working → done) and that is what "看得见在做什么" asked for;
 *        streaming model tokens would require a much deeper integration for a
 *        benefit the local UI already provides.
 *   D1 — COALESCE by event boundary with a minimum interval. A turn can produce
 *        dozens of session events per second; one frame each would flood the socket
 *        and make the peer's own log unreadable. Latest-wins inside the window,
 *        and the terminal frame is never dropped.
 *
 * Everything here is pure except the two injected seams (clock, message id), so the
 * timing rules can be tested without sleeping.
 *
 * Layering: imports `../protocol/wire.js` only.
 */

import { randomUUID } from 'node:crypto'

import type {
  A2AArtifact,
  A2AMessage,
  A2AStreamResponse,
  A2ATask,
  A2ATaskStatus,
  TaskState,
} from '../protocol/wire.js'

export interface FrameFactoryOptions {
  /** ISO timestamp source. Injected so a test can pin the clock. */
  readonly now?: () => string
  /** Message-id source for progress messages. */
  readonly newMessageId?: () => string
}

export interface FrameFactory {
  /** First frame: the task as submitted. */
  initial(task: A2ATask): A2AStreamResponse
  /** Progress or terminal status; `progressText` rides on `status.message`. */
  status(task: A2ATask, state: TaskState, progressText?: string): A2AStreamResponse
  /** Final text artifact. v1.0 has no `final` flag: closing the stream ends it. */
  artifact(task: A2ATask, artifact: A2AArtifact, index: number): A2AStreamResponse
}

export function createFrameFactory(options: FrameFactoryOptions = {}): FrameFactory {
  const now = options.now ?? (() => new Date().toISOString())
  const newMessageId = options.newMessageId ?? (() => randomUUID())

  const progressMessage = (text: string, task: A2ATask): A2AMessage => ({
    messageId: newMessageId(),
    role: 'ROLE_AGENT',
    parts: [{ text }],
    taskId: task.id,
    ...(task.contextId === undefined ? {} : { contextId: task.contextId }),
  })

  return {
    initial: (task) => ({ task }),

    status: (task, state, progressText) => {
      const status: A2ATaskStatus = {
        state,
        timestamp: now(),
        ...(progressText === undefined
          ? {}
          : { message: progressMessage(progressText, task) }),
      }
      return {
        statusUpdate: {
          taskId: task.id,
          ...(task.contextId === undefined ? {} : { contextId: task.contextId }),
          status,
        },
      }
    },

    artifact: (task, artifact, index) => ({
      artifactUpdate: {
        taskId: task.id,
        ...(task.contextId === undefined ? {} : { contextId: task.contextId }),
        artifact,
        index,
        // One chunk per artifact today, so it is always the last one.
        lastChunk: true,
      },
    }),
  }
}

export interface Coalescer<T> {
  /** Offer an item; returns the items to emit right now (0 or 1). */
  push(item: T): T[]
  /** Emit whatever is pending. Used on the terminal path so nothing is lost. */
  flush(): T[]
  /** The item that would be emitted on the next flush, for tests/diagnostics. */
  pending(): T | undefined
}

export interface CoalescerOptions {
  /** Minimum gap between emissions. 0 disables coalescing. */
  readonly minIntervalMs: number
  readonly now?: () => number
}

/**
 * Latest-wins coalescer.
 *
 * Semantics, chosen so a peer never sees a stale state and never misses the end:
 *   - the FIRST item is emitted immediately (the peer should not wait to learn the
 *     turn started);
 *   - items arriving inside the window replace the pending one — a status stream is
 *     about the CURRENT state, so replaying every intermediate state is noise;
 *   - once the window has elapsed, the next item is emitted immediately and any
 *     pending item is discarded as superseded;
 *   - `flush()` always yields the pending item, which is how the terminal frame
 *     survives a burst.
 */
export function createCoalescer<T>(options: CoalescerOptions): Coalescer<T> {
  const now = options.now ?? Date.now
  const minIntervalMs = Number.isFinite(options.minIntervalMs) ? Math.max(0, options.minIntervalMs) : 0
  let lastEmitAt: number | undefined
  let pendingItem: T | undefined

  return {
    push(item: T): T[] {
      const at = now()
      if (minIntervalMs === 0) {
        lastEmitAt = at
        pendingItem = undefined
        return [item]
      }
      if (lastEmitAt === undefined || at - lastEmitAt >= minIntervalMs) {
        lastEmitAt = at
        pendingItem = undefined
        return [item]
      }
      pendingItem = item
      return []
    },

    flush(): T[] {
      if (pendingItem === undefined) return []
      const item = pendingItem
      pendingItem = undefined
      lastEmitAt = now()
      return [item]
    },

    pending(): T | undefined {
      return pendingItem
    },
  }
}

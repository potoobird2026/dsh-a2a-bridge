/**
 * Server side of the inbound SSE response.
 *
 * The encoder already exists (`sseFrame` / `sseHeartbeat` in `./../protocol/sse.ts`);
 * what was missing is the plumbing that turns a stream of A2A frames into an HTTP
 * response body. Keeping it here — instead of inline in `routes.ts` — is the same
 * reason dispatch was extracted: the route handler needs a real `http.ServerResponse`,
 * so anything inline in it cannot be unit-tested at all.
 *
 * Two properties matter more than elegance, because a streaming bug is invisible
 * until a peer hangs:
 *
 *   1. The response ALWAYS ends, including on client disconnect and on a throwing
 *      frame source. A stream that never closes holds a socket and a Cordis fiber
 *      open until the process dies.
 *   2. Backpressure is respected: `write()` returns false when the socket buffer is
 *      full, and we wait for 'drain' rather than piling frames into memory.
 *
 * Layering: imports `./../protocol/sse.js` only.
 */

import { HTTP_OK, SSE_HEARTBEAT_INTERVAL_MS } from '../constants.js'
import { sseFrame, sseHeartbeat } from '../protocol/sse.js'
import type { A2AStreamResponse } from '../protocol/wire.js'

/** The narrow slice of `http.ServerResponse` this module needs (and tests fake). */
export interface SseSink {
  writeHead(status: number, headers: Record<string, string>): unknown
  write(chunk: string): boolean
  /** Resolve when the socket drains. Optional: a fake may not model it. */
  once?(event: 'drain', listener: () => void): unknown
  end(): unknown
}

export interface PipeSseOptions {
  /** JSON-RPC id echoed into every frame's `id:` line. */
  readonly requestId: string | number | null
  /** Client disconnect / server shutdown. */
  readonly signal: AbortSignal
  /**
   * Emit a comment heartbeat when this long passed since the last write.
   *
   * Applied per frame rather than on a timer: a timer would need its own
   * add/remove bookkeeping (and cleanup on every exit path) for a case the frames
   * themselves already cover. A genuinely idle stream still needs the timer
   * variant — noted in the plan, not pretended here.
   *
   * Defaults to the shared `SSE_HEARTBEAT_INTERVAL_MS` so no second interval is
   * invented here.
   */
  readonly heartbeatMs?: number
  /** Injectable clock so heartbeat behaviour is testable without sleeping. */
  readonly now?: () => number
}

/** Headers that make intermediaries actually stream instead of buffering. */
export const SSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  // nginx and friends buffer proxied responses unless told otherwise; without
  // this a "stream" arrives as one chunk when the turn ends.
  'x-accel-buffering': 'no',
})

export interface PipeSseResult {
  /** Frames successfully written. */
  readonly written: number
  /** Why the loop stopped; `aborted` means the client went away. */
  readonly ended: 'complete' | 'aborted' | 'error'
}

/**
 * Write `frames` to `sink` as SSE, then always end the response.
 *
 * Never throws: the caller is a route handler whose only remaining option would be
 * to send a JSON error into a body that already started as `text/event-stream`.
 */
export async function pipeSseStream(
  sink: SseSink,
  frames: AsyncIterable<A2AStreamResponse>,
  options: PipeSseOptions,
): Promise<PipeSseResult> {
  const now = options.now ?? Date.now
  const heartbeatMs = options.heartbeatMs ?? SSE_HEARTBEAT_INTERVAL_MS
  let written = 0
  let lastWriteAt = now()
  let ended: PipeSseResult['ended'] = 'complete'

  const write = async (chunk: string): Promise<boolean> => {
    if (options.signal.aborted) return false
    const drained = sink.write(chunk)
    lastWriteAt = now()
    if (!drained && typeof sink.once === 'function') {
      await new Promise<void>((resolve) => {
        let settled = false
        const done = (): void => {
          if (settled) return
          settled = true
          resolve()
        }
        sink.once?.('drain', done)
        // A disconnect during a full buffer must not hang the loop forever.
        options.signal.addEventListener('abort', done, { once: true })
      })
    }
    return !options.signal.aborted
  }

  try {
    sink.writeHead(HTTP_OK, { ...SSE_HEADERS })
    for await (const frame of frames) {
      if (options.signal.aborted) {
        ended = 'aborted'
        break
      }
      if (heartbeatMs > 0 && now() - lastWriteAt >= heartbeatMs) {
        if (!(await write(sseHeartbeat()))) {
          ended = 'aborted'
          break
        }
      }
      if (!(await write(sseFrame(options.requestId, frame)))) {
        ended = 'aborted'
        break
      }
      written += 1
    }
  } catch {
    // A frame source that throws mid-stream cannot be reported as JSON: the status
    // line is already sent. Ending the response is the only honest signal.
    ended = options.signal.aborted ? 'aborted' : 'error'
  } finally {
    try {
      sink.end()
    } catch {
      // The socket may already be gone; nothing left to do.
    }
  }

  return { written, ended }
}

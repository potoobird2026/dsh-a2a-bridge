/**
 * Inbound SSE response plumbing.
 *
 * A streaming bug is invisible until a peer hangs, so the properties pinned here
 * are the failure modes rather than the happy path:
 *   - the response ALWAYS ends (client disconnect, throwing source, full buffer),
 *   - backpressure is respected instead of buffering frames in memory,
 *   - a heartbeat appears only when the stream actually went quiet.
 */

import { describe, expect, it } from 'vitest'

import { SSE_HEARTBEAT_FRAME } from '../../src/constants.js'
import { SSE_HEADERS, pipeSseStream, type SseSink } from '../../src/inbound/sse-response.js'
import type { A2AStreamResponse } from '../../src/protocol/wire.js'

interface SinkState {
  headers: Record<string, string> | undefined
  status: number | undefined
  ended: boolean
}

function makeSink(options: { drain?: boolean } = {}): {
  sink: SseSink
  chunks: string[]
  state: SinkState
  release: () => void
  drainRequested: Promise<void>
} {
  const chunks: string[] = []
  const state: SinkState = { headers: undefined, status: undefined, ended: false }
  let drainListener: (() => void) | undefined
  let markDrain!: () => void
  const drainRequested = new Promise<void>((resolve) => {
    markDrain = resolve
  })
  const sink: SseSink = {
    writeHead(status, headers) {
      state.status = status
      state.headers = headers
    },
    write(chunk) {
      chunks.push(chunk)
      // `drain: false` models a FULL buffer for the FIRST write only: after the
      // test releases it, the socket accepts the rest. Returning false forever
      // would make the pipe block on every frame, which is not what a real socket
      // does once drained.
      if (options.drain === false && chunks.length === 1) return false
      return true
    },
    once(_event, listener) {
      drainListener = listener
      // Tell the test the pipe is actually blocked; releasing before this point
      // would look like a passing test while the real code hung forever.
      markDrain()
    },
    end() {
      state.ended = true
    },
  }
  return { sink, chunks, state, release: () => drainListener?.(), drainRequested }
}

async function* frameSource(frames: A2AStreamResponse[]): AsyncIterable<A2AStreamResponse> {
  for (const frame of frames) yield frame
}

const OK_FRAME = { task: { id: 'task-1' } } as unknown as A2AStreamResponse
const FINAL_FRAME = {
  statusUpdate: { taskId: 'task-1', status: { state: 'TASK_STATE_COMPLETED' } },
} as unknown as A2AStreamResponse

describe('pipeSseStream', () => {
  it('sends SSE headers, then one well-formed frame per yielded item', async () => {
    const fake = makeSink()
    const result = await pipeSseStream(fake.sink, frameSource([OK_FRAME, FINAL_FRAME]), {
      requestId: 1,
      signal: new AbortController().signal,
      heartbeatMs: 0,
    })

    expect(fake.state.status).toBe(200)
    expect(fake.state.headers).toEqual({ ...SSE_HEADERS })
    expect(result).toEqual({ written: 2, ended: 'complete' })
    expect(fake.state.ended).toBe(true)
    expect(fake.chunks).toHaveLength(2)
    for (const chunk of fake.chunks) {
      // Format is owned by `sseFrame`: `data: {jsonrpc,id,result}\n\n`. No `id:`
      // line — the correlation id lives inside the envelope.
      expect(chunk.startsWith('data: ')).toBe(true)
      expect(chunk.endsWith('\n\n')).toBe(true)
    }
  })

  it('stops on abort, reports it, and still ends the response', async () => {
    const controller = new AbortController()
    const fake = makeSink()
    const frames = (async function* () {
      yield OK_FRAME
      controller.abort()
      yield FINAL_FRAME
    })()

    const result = await pipeSseStream(fake.sink, frames, {
      requestId: 7,
      signal: controller.signal,
      heartbeatMs: 0,
    })

    expect(result.ended).toBe('aborted')
    expect(result.written).toBe(1)
    expect(fake.state.ended).toBe(true)
  })

  it('reports a throwing frame source as an error and still ends', async () => {
    const fake = makeSink()
    const frames = (async function* () {
      yield OK_FRAME
      throw new Error('turn exploded')
    })()

    const result = await pipeSseStream(fake.sink, frames, {
      requestId: 1,
      signal: new AbortController().signal,
      heartbeatMs: 0,
    })

    expect(result.ended).toBe('error')
    expect(fake.state.ended).toBe(true)
  })

  it('emits a heartbeat only after the configured gap', async () => {
    let clock = 0
    const fake = makeSink()
    const result = await pipeSseStream(fake.sink, frameSource([OK_FRAME, FINAL_FRAME]), {
      requestId: 1,
      signal: new AbortController().signal,
      heartbeatMs: 1_000,
      // Each clock read advances by 2s, so every frame boundary crosses the 1s
      // gap. Stepping by less than the interval would (correctly) emit nothing.
      now: () => {
        clock += 2_000
        return clock
      },
    })

    expect(result.written).toBe(2)
    expect(fake.chunks.filter((chunk) => chunk === SSE_HEARTBEAT_FRAME).length).toBeGreaterThan(0)
  })

  it('waits for drain instead of piling frames into a full buffer', async () => {
    const fake = makeSink({ drain: false })
    let released = false
    let sawRelease = false
    const frames = (async function* () {
      yield OK_FRAME
      // Only reached if the pipe waited for 'drain' before pulling the next frame.
      sawRelease = released
      yield FINAL_FRAME
    })()

    const pending = pipeSseStream(fake.sink, frames, {
      requestId: 1,
      signal: new AbortController().signal,
      heartbeatMs: 0,
    })
    // Wait until the pipe has actually registered its drain listener, otherwise
    // this test would pass while a real socket hung.
    await fake.drainRequested
    released = true
    fake.release()

    const result = await pending
    expect(sawRelease).toBe(true)
    expect(result.written).toBe(2)
    expect(fake.state.ended).toBe(true)
  })
})

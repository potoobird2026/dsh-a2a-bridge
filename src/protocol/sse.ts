/**
 * SSE framing for A2A v1.0.
 *
 * Authoritative source: A2A spec + `specification/a2a.proto`.
 *
 * Two rules that are easy to get wrong:
 *   1. A2A streams **JSON-RPC responses**, not bare events. Each frame carries
 *      `id` so the peer can correlate it with its request.
 *   2. v1.0 **removed the `final` flag**. Closing the stream IS the terminal
 *      signal — so the close must immediately follow the terminal status.
 *
 * Layering rule: imports only `../constants.js` + `../types.js`.
 */

import { SSE_HEARTBEAT_FRAME } from '../constants.js'
import type { A2AStreamResponse } from './wire.js'

/** Render one SSE frame. Compact JSON has no embedded newlines, so the frame cannot break. */
export function sseFrame(id: string | number | null, payload: A2AStreamResponse): string {
  return `data: ${JSON.stringify({ jsonrpc: '2.0', id, result: payload })}\n\n`
}

/** The periodic comment frame that keeps idle proxies from killing a long stream. */
export function sseHeartbeat(): string {
  return SSE_HEARTBEAT_FRAME
}

// ── Chunk-safe frame decoding ──────────────────────────────────────────────

/**
 * Incremental SSE frame decoder.
 *
 * WHY THIS EXISTS: DSH's streaming model decoder is NOT chunk-safe. A reply
 * containing CJK or emoji can be split mid-codepoint, leaving a lone UTF-16
 * surrogate that is invisible on a terminal. `JSON.stringify` then emits
 * syntactically valid JSON that a Go/Rust/Python peer cannot re-encode.
 *
 * So: bytes are decoded with `TextDecoder(stream: true)` and held across
 * calls. `TextDecoder` buffers an incomplete trailing sequence instead of
 * emitting a replacement character — that is the whole point.
 */
export class SseFrameDecoder {
  private readonly decoder = new TextDecoder('utf-8', { fatal: false })
  private buffer = ''

  /**
   * Feed bytes and drain every complete frame.
   *
   * A frame is complete at a blank line (`\n\n`). A trailing `\r\n\r\n` is
   * tolerated. Comment frames (leading `:`) are skipped by the caller.
   */
  push(chunk: Uint8Array): string[] {
    this.buffer += this.decoder.decode(chunk, { stream: true })
    return this.drain()
  }

  /** Flush any decoder state held for an incomplete sequence. */
  flush(): string[] {
    const tail = this.decoder.decode()
    if (tail.length > 0) this.buffer += tail
    return this.drain()
  }

  private drain(): string[] {
    const frames: string[] = []
    let boundary: number
    // A blank line separates frames: `\n\n`, `\r\n\r\n`, or mixed.
    const matcher = /\r?\n\r?\n/
    while ((boundary = this.buffer.search(matcher)) >= 0) {
      const raw = this.buffer.slice(0, boundary)
      this.buffer = this.buffer.slice(boundary).replace(/^\r?\n\r?\n/, '')
      const data = extractData(raw)
      if (data !== undefined) frames.push(data)
    }
    return frames
  }
}

/** Pull the `data:` payload out of an SSE frame body. */
function extractData(rawFrame: string): string | undefined {
  const lines = rawFrame.split(/\r?\n/)
  const dataLines: string[] = []
  for (const line of lines) {
    if (line.startsWith(':')) continue // comment / heartbeat
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
  }
  if (dataLines.length === 0) return undefined
  return dataLines.join('\n')
}

/** Parse a decoded `data:` payload as JSON-RPC. */
export function parseFrameJson(data: string): unknown {
  try {
    return JSON.parse(data) as unknown
  } catch {
    return undefined
  }
}

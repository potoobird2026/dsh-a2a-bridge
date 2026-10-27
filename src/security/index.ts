/**
 * Security primitives shared by the inbound and outbound directions.
 *
 * Layering rule (ADR-008): this module depends on `node:crypto` and
 * `src/constants.ts` / `src/types.ts` only. It must never import Cordis, the
 * webserver, or any inbound/outbound module — that is what keeps the auth seam
 * unit-testable without booting a composition.
 *
 * ADR-005 (认证模型): per-peer tokens resolved through `ctx.credentials`.
 * Secrets never appear in config values, only reference names.
 */
import { timingSafeEqual } from 'node:crypto'

import { BEARER_PATTERN, MAX_DIAGNOSTIC_BYTES, RATE_LIMIT_WINDOW_MS } from '../constants.js'
import type { PeerIdentity } from '../types.js'

// ── Constant-time comparison ───────────────────────────────────────────────

/**
 * Compare two strings in constant time.
 *
 * `timingSafeEqual` requires equal lengths, so a length mismatch would
 * short-circuit and leak the difference. We burn a self-comparison first so a
 * wrong length is not measurably faster than a wrong byte.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) {
    timingSafeEqual(left, left)
    return false
  }
  return timingSafeEqual(left, right)
}

/**
 * Resolve a presented token to a peer identity.
 *
 * Every candidate is compared even after a match, so response time reveals
 * neither which peer matched nor how many peers are declared.
 */
export function identifyPeer(
  token: string | undefined,
  credentials: ReadonlyMap<PeerIdentity, string>,
): PeerIdentity | undefined {
  if (token === undefined || token.length === 0) return undefined
  let matched: PeerIdentity | undefined
  for (const [peer, secret] of credentials) {
    if (constantTimeEqual(token, secret) && matched === undefined) matched = peer
  }
  return matched
}

/** Extract the token from an `Authorization` header, if well-formed. */
export function bearerFrom(header: string | undefined): string | undefined {
  if (header === undefined) return undefined
  const match = BEARER_PATTERN.exec(header.trim())
  return match?.[1]
}

// ── Rate limiting ──────────────────────────────────────────────────────────

/**
 * Fixed-window rate limiter keyed by identity.
 *
 * `now` is injectable so tests can advance the clock without sleeping.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>()

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  allow(key: string): boolean {
    const cutoff = this.now() - RATE_LIMIT_WINDOW_MS
    const recent = (this.hits.get(key) ?? []).filter((at) => at > cutoff)
    if (recent.length >= this.perMinute) {
      this.hits.set(key, recent)
      return false
    }
    recent.push(this.now())
    this.hits.set(key, recent)
    return true
  }

  /** Drop state for identities that have been quiet for a full window. */
  sweep(): void {
    const cutoff = this.now() - RATE_LIMIT_WINDOW_MS
    for (const [key, times] of this.hits) {
      if (times.every((at) => at <= cutoff)) this.hits.delete(key)
    }
  }
}

// ── Outbound redaction ─────────────────────────────────────────────────────

/**
 * Patterns for credentials that must never cross the wire.
 *
 * Applied to every outbound text path — replies and artifacts alike — because
 * an inbound-only server still ships model-authored text to a peer. Keeping
 * the list in one function means a future second egress path cannot pick up
 * only half of it.
 */
const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/sk-[A-Za-z0-9_-]{16,}/g, '[redacted]'],
  [/sk-ant-[A-Za-z0-9_-]{16,}/g, '[redacted]'],
  [/gh[pousr]_[A-Za-z0-9]{16,}/g, '[redacted]'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, '[redacted]'],
  [/AKIA[0-9A-Z]{16}/g, '[redacted]'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[redacted]'],
  [/Bearer\s+[A-Za-z0-9._-]{16,}/gi, 'Bearer [redacted]'],
]

export function redactSecrets(text: string): string {
  let out = text
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement)
  return out
}

/**
 * Repair unpaired UTF-16 surrogates.
 *
 * DSH's streaming model decoder is not chunk-safe: a reply containing CJK or
 * emoji can be split mid-codepoint and leave a lone surrogate. The result is
 * invisible on a terminal but `JSON.stringify` emits syntactically valid JSON
 * that a Go/Rust/Python peer cannot re-encode. Every outbound string passes
 * through here so the defect cannot reach a peer.
 */
export function wellFormed(text: string): string {
  // `String.prototype.toWellFormed` is available on Node 20+; this wrapper
  // exists so there is exactly one place to change if we must polyfill.
  return text.toWellFormed()
}

/** Redact, then repair encoding. Always use this before egress. */
export function sanitizeOutbound(text: string): string {
  return wellFormed(redactSecrets(text))
}

/** Truncate a diagnostic string to the shared byte budget. */
export function clampDiagnostic(text: string): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= MAX_DIAGNOSTIC_BYTES) return text
  return buf.subarray(0, MAX_DIAGNOSTIC_BYTES).toString('utf8')
}

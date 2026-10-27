/**
 * Shared domain vocabulary for the DSH A2A bridge.
 *
 * This module is the contract between layers:
 *   protocol  (zero-dependency wire types)      -> src/protocol/*
 *   security  (identity, tokens, redaction)     -> src/security/*
 *   inbound   (server: remote peer -> our agent)-> src/inbound/*
 *   outbound  (client: our agent -> remote)     -> src/outbound/*
 *   session   (ADR-007 visible sessions)        -> src/session/*
 *
 * Layering rule (ADR-008 "避免上下游 bug 互相污染"):
 *   - `src/protocol/**` must never import from security/inbound/outbound/session.
 *   - `src/security/**` may import protocol + node builtins only.
 *   - inbound/outbound/session may import protocol + security + types.
 *   - Nothing may import `src/index.ts`.
 *
 * Wire-level types live in `src/protocol/` and are authoritative against
 * `specification/a2a.proto` (A2A spec §1.4). This file carries only the
 * DSH-side and cross-cutting types that no single layer owns.
 */

// ── Identity ───────────────────────────────────────────────────────────────

/** An authenticated remote peer name (inbound), produced by the auth seam. */
export type PeerIdentity = string

/** The reserved identity for the local deployment owner / console. */
export const OWNER_IDENTITY: PeerIdentity = 'owner'

/** A configured outbound remote. Direction is opposite to PeerIdentity. */
export interface ContactRef {
  readonly name: string
  readonly url: string
  readonly agentCardPath: string
  readonly tokenEnv?: string
  readonly timeoutMs: number
}

// ── Errors ─────────────────────────────────────────────────────────────────

/**
 * A failure the protocol layer may put on the wire.
 *
 * ADR-005 note: authentication / rate-limit / trust failures deliberately do
 * NOT get JSON-RPC codes — A2A puts transport security at the HTTP layer.
 * Those answer with an HTTP status whose body is still a valid JSON-RPC error
 * envelope. Only A2A-semantic failures use `code` from the reserved ranges.
 */
export interface ProtocolErrorShape {
  code: number
  message: string
  data?: unknown
}

// ── Task settlement (shared by inbound executor and outbound client) ───────

/**
 * Terminal A2A task states. `isTerminal` is the single authority — no layer
 * may restate this list, otherwise the two sides drift apart.
 */
export const TERMINAL_TASK_STATES = Object.freeze([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_FAILED',
  'TASK_STATE_REJECTED',
] as const)

export type TerminalTaskState = (typeof TERMINAL_TASK_STATES)[number]

export function isTerminalTaskState(state: string | undefined): state is TerminalTaskState {
  if (state === undefined) return false
  return (TERMINAL_TASK_STATES as readonly string[]).includes(state)
}

/**
 * How a DSH turn ending maps onto an A2A task state.
 *
 * Design decision carried over from huangjuhua-aigc/dsh-a2a and accepted here:
 * a token ceiling settles as COMPLETED, not FAILED — the agent produced real
 * work and FAILED would make the peer discard it. The true reason travels in
 * `Task.metadata.dsh.stopReason`.
 */
export function taskStateFromTurnEnding(endReason: string | undefined): string {
  if (endReason === undefined) return 'TASK_STATE_CANCELED'
  if (endReason === 'error') return 'TASK_STATE_FAILED'
  if (endReason === 'cancelled' || endReason === 'canceled') return 'TASK_STATE_CANCELED'
  return 'TASK_STATE_COMPLETED'
}

// ── Session / workspace (ADR-007) ──────────────────────────────────────────

/**
 * A2A conversations are first-class, visible DSH sessions. Each A2A context
 * maps deterministically onto one session id so a peer can resume a
 * conversation across process restarts.
 *
 * Determinism is deliberate: `contextId -> sessionId` must be reproducible,
 * otherwise a peer returning with the same contextId lands in a fresh session
 * and its history disappears.
 */
export interface SessionBinding {
  readonly sessionId: string
  readonly contextId: string
  readonly peer: PeerIdentity
  /**
   * The session header's `cwd` — the A2A WORKSPACE ROOT, not the per-session
   * working directory.
   *
   * The workspace entity attaches a session only when this value equals the
   * registered workspace path (strict equality, `dsh-workspace`
   * `lib/index.js:122`). The directory the agent actually works in is applied
   * afterwards with `workingDirectory.set()` and never appears here.
   */
  readonly cwd: string
  readonly title: string
}

// ── Cross-cutting result type ──────────────────────────────────────────────

export type Ok<T> = { ok: true; value: T }
export type Err<E> = { ok: false; error: E }
export type Result<T, E = Error> = Ok<T> | Err<E>

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value }
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error }
}

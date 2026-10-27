/**
 * Session binding — ADR-007: A2A conversations are first-class, visible DSH
 * sessions, not headless calls.
 *
 * User requirement (verbatim): A2A chats get their own workspace and a session
 * window like any user↔DSH conversation, so the user can always see what the
 * agent is running and doing — no black box.
 *
 * Layering rule: may import protocol + security + constants/types. Never
 * imports Cordis types directly — the workspace registry is probed through
 * `ctx.get('workspaceRegistry')` so this module stays testable and degrades
 * gracefully when the service is absent.
 */

import { createHash } from 'node:crypto'
import { join } from 'node:path'

import {
  MAX_PROJECT_KEY_LENGTH,
  SESSION_DIGEST_LENGTH,
} from '../constants.js'
import type { PeerIdentity, SessionBinding } from '../types.js'

/**
 * Derive a DSH session id from an A2A contextId.
 *
 * Determinism is deliberate: a peer returning with the same `contextId` must
 * land in the SAME session, otherwise its history silently disappears. The
 * sha256 slice is reproducible across process restarts, which is what makes
 * "resume a conversation" actually work.
 */
export function sessionIdFor(
  prefix: string,
  peer: PeerIdentity,
  contextId: string,
): string {
  const digest = createHash('sha256')
    .update(`${peer}\u0000${contextId}`)
    .digest('hex')
    .slice(0, SESSION_DIGEST_LENGTH)
  return `${prefix}-${slug(peer)}-${digest}`
}

// ── Stable default context (project dimension) ─────────────────────────────
//
// WHY THIS EXISTS (user requirement): a remote agent that does not send an A2A
// `contextId` used to get a RANDOM one per message, so every message opened a
// new session and a new chat window. The A2A spec says `contextId` groups the
// interactions of one conversation — but it also says the SERVER may group when
// the client omits it, and a client that never sends one still expects its
// requests to land in one place.
//
// So the default is now DERIVED, not random, from the only inputs that are
// stable on this machine for that peer:
//
//   1. the authenticated peer identity,
//   2. the PROJECT the conversation belongs to.
//
// "Project" is taken from the peer's own stable hint when it sends one, and
// otherwise from the project root this deployment configured for that peer
// (`inbound.isolation` -> `workspacePath()`). Both are reproducible across
// restarts, so "same peer + same project" always yields the same session id
// (and therefore the same chat window) with no client cooperation at all.
//
// DIFFERENT PROJECTS STAY APART: a different peer, a different configured
// project root, or a different `metadata.project` hint all change the hash.
// An EXPLICIT `contextId` still wins, because that is the protocol-level
// override and must keep its A2A meaning.

/**
 * Field the peer may put in A2A `Message.metadata` to name its project.
 *
 * A2A `Message.metadata` is a free-form map, so this needs no protocol change:
 * a client that serves several projects sends `metadata.project = "<stable
 * id>"` per project and gets one conversation per project. Clients that send
 * nothing are grouped per project root instead (see above). Documented here —
 * not guessed from a vendor API — because this is OUR side of the wire contract.
 */
export const PROJECT_HINT_FIELD = 'project'

/**
 * Upper bound on the normalised project key that feeds the hash.
 *
 * A project key is a short id or a path; a megabyte of it would only make logs
 * unreadable. The cap is applied to the HASH INPUT, so two pathological keys
 * that share their first `MAX_PROJECT_KEY_LENGTH` characters collapse into
 * one conversation — acceptable, because at that depth they name the same path.
 *
 * The constant lives in `src/constants.ts` (ADR-008: one place for tunables).
 */

/** Domain separator: a derived id can never equal a peer/context-only hash. */
const PROJECT_CONTEXT_DOMAIN = 'a2a-project'

/**
 * Normalise an explicit `contextId` from the wire.
 *
 * A2A's `contextId` is optional. An EMPTY string is not a context: treating
 * `''` as one would funnel every such request into a single anonymous
 * conversation. `undefined` therefore means "the client did not send one".
 */
export function normalizeContextId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** Read the project hint out of an A2A `Message.metadata` map. */
export function projectHintOf(metadata: unknown): string | undefined {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return undefined
  }
  const value = (metadata as Record<string, unknown>)[PROJECT_HINT_FIELD]
  return typeof value === 'string' ? value : undefined
}

/**
 * Canonical form of one project key.
 *
 * Backslashes become `/` and a trailing separator is dropped, so `D:\app\` and
 * `D:/app` name the SAME project instead of opening two conversations. Case is
 * preserved on purpose: two directories that differ only in case are distinct on
 * a case-sensitive filesystem, and silently merging them is worse than a
 * duplicate row.
 */
export function normalizeProjectKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const canonical = value.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (canonical.length === 0) return undefined
  return canonical.slice(0, MAX_PROJECT_KEY_LENGTH)
}

/**
 * The project key a conversation is grouped by.
 *
 * The peer's explicit hint wins; otherwise the configured project root for that
 * peer is used, which is what makes an UNCOOPERATIVE client still get one stable
 * conversation instead of one per message.
 */
export function projectKeyFor(input: {
  readonly projectHint?: unknown
  readonly projectRoot: string
}): string {
  return (
    normalizeProjectKey(input.projectHint) ??
    normalizeProjectKey(input.projectRoot) ??
    ''
  )
}

/**
 * Deterministic contextId used when the peer sends none.
 *
 * Same SHAPE as an explicit one (`<prefix>-<peer>-<digest>`) so the peer — and
 * our own tasks — keep receiving an opaque id, and so a client that echoes this
 * value back next time lands on exactly the same session.
 */
export function stableContextId(
  prefix: string,
  peer: PeerIdentity,
  projectKey: string,
): string {
  const digest = createHash('sha256')
    .update(`${PROJECT_CONTEXT_DOMAIN}\u0000${peer}\u0000${projectKey}`)
    .digest('hex')
    .slice(0, SESSION_DIGEST_LENGTH)
  return `${prefix}-${slug(peer)}-${digest}`
}

/**
 * Resolve the directory a peer's A2A session directories live under.
 *
 * This is now the PEER-destination half of the placement, not the workspace
 * path itself: `workspaceForPeer()` keeps ONE workspace named `<prefix>` and
 * makes each session's effective working directory a subdirectory of this
 * directory (applied through `workingDirectory.set`, not the header cwd).
 * `mode` therefore still means what it always meant — `per-peer` keeps two
 * peers' sessions in separate directories (a security boundary, not
 * cosmetics), `shared` does not.
 */
export function workspacePath(
  root: string,
  workspaceMode: 'per-peer' | 'shared',
  peer: PeerIdentity,
): string {
  if (workspaceMode === 'shared') return root
  return join(root, slug(peer))
}

/** Build the full binding record for one A2A conversation. */
export function bindSession(input: {
  readonly prefix: string
  readonly peer: PeerIdentity
  readonly contextId: string
  readonly cwd: string
}): SessionBinding {
  const sessionId = sessionIdFor(input.prefix, input.peer, input.contextId)
  return {
    sessionId,
    contextId: input.contextId,
    peer: input.peer,
    cwd: input.cwd,
    // The SESSION's own title. The workspace is named just `<prefix>` for every
    // peer now, so the peer has to stay visible on the session label — dropping
    // it here would make two different peers' sessions read identically.
    // No timestamp: the workspace no longer claims "this session's moment".
    title: `${input.prefix} · ${input.peer}`,
  }
}

/** Keeps a name safe as a single path segment / team segment. */
export function slug(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '') || 'peer'
}

// ── Registry probing ───────────────────────────────────────────────────────

/**
 * Structural contract for `ctx.get('workspaceRegistry')`.
 *
 * Probed, not injected: TtTRz/dsh-a2a verified this works, and a hard inject
 * would make the plugin never activate on profiles that lack the service.
 */
export interface WorkspaceRegistryLike {
  create(path: string, title?: string): Promise<unknown> | unknown
  attachSession?(sessionId: string, workspace: unknown): Promise<void> | void
}

export function asWorkspaceRegistry(value: unknown): WorkspaceRegistryLike | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Record<string, unknown>
  if (typeof candidate.create !== 'function') return undefined
  return candidate as unknown as WorkspaceRegistryLike
}

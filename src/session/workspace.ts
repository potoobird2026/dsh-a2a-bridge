/**
 * Workspace placement for A2A sessions — ADR-007 requirement ① (独立工作区).
 *
 * The user's requirement: A2A conversations live in ONE workspace named
 * `<prefix>` (by default literally `A2A`), the way a DSH client shows one
 * project space holding many conversations. Earlier this module produced one
 * workspace PER SESSION, titled `A2A · <peer> <MM-DD HH:MM>`, so every new
 * conversation added another sidebar row and the name the user asked for never
 * appeared on its own.
 *
 * So placement is split into three values that are easy to confuse, and the
 * runtime forces the split on us (evidence below):
 *
 *   workspace   `path`    = the resolved A2A root, the SAME directory for every
 *                           peer and every session.
 *   session     `workDir` = `<root>/<peer>/<session-id>`, always INSIDE `path`.
 *                           This is the directory the agent actually WORKS in.
 *   workspace   `title`   = `<prefix>` — no peer, no timestamp. Config owns it
 *                           (`session.workspaceTitlePrefix`), never a literal.
 *
 * WHY THE SESSION HEADER CWD MUST EQUAL `path` (not sit inside it):
 * `WorkspaceEntity.attachSession` validates the session header's cwd against the
 * workspace path with STRICT EQUALITY — `@deepseek-ai/dsh-workspace` 0.2.1-rc.2
 * `lib/index.js:122` throws `cannot attach session ...` unless
 * `realpathNormalize(header.cwd) === this.record.path`, and the membership
 * filters (`:103` `sessionIds`, `:367` `candidateMatches`) compare the exact same
 * way. Therefore `agents.create({ meta: { cwd } })` is given `path` (the root),
 * and only then does the registry agree the conversation belongs to this
 * workspace instead of landing in the UI's "未分组" bucket.
 *
 * WHY THE REAL WORKING DIRECTORY IS A SECOND VALUE (`workDir`):
 * Giving every peer the root as its WORKING directory would erase the isolation
 * boundary between peers' sessions — an agent's working directory is its
 * filesystem scope. The tools that matter (`dsh-tool-pwsh`, `dsh-tool-bash`,
 * the persistent variants, `dsh-tool-fs`, `dsh-tool-fs-search`) do NOT read
 * `header.cwd`; they call `ctx.workingDirectory.ensure(agent, signal)`, and that
 * service keeps a `workingDirectory` session projection initialised from
 * `header.cwd` and updated by a `working-directory/change` event. So the caller
 * moves the agent to `workDir` with `workingDirectory.set(agent, workDir)` right
 * after creation: the workspace membership stays valid (header cwd = root) and
 * the tools/sandbox follow `workDir` (per-peer isolation preserved).
 *
 * This module owns exactly three things:
 *   1. deriving that descriptor from a session binding,
 *   2. registering the workspace directory with `ctx.workspaceRegistry` once,
 *   3. creating the directories on disk (root and workDir).
 *
 * Why a structural registry and not a Cordis import: the service is absent on
 * headless / non-web profiles. Hard-injecting it would leave this plugin
 * permanently pending there, so absence MUST degrade to a no-op instead.
 *
 * Layering rule: may import constants/config + types + session-binding. No
 * Cordis import, no inbound/outbound import.
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { PeerIdentity } from '../types.js'
import {
  asWorkspaceRegistry,
  workspacePath,
  type WorkspaceRegistryLike,
} from './session-binding.js'

export type WorkspaceMode = 'per-peer' | 'shared'

/**
 * A workspace root that may still be changing.
 *
 * `inbound.isolation.workspaceRoot` is `.volatile()`: a write on the plugin page
 * reaches the running Loader WITHOUT remounting the plugin, so the value must be
 * read at USE time. Resolving it once in `apply()` pinned the string for the
 * whole process — a user who changed the path kept writing into the old root
 * until they restarted DSH, which is exactly the inconsistency with the model /
 * preset settings this change removes.
 *
 * A string is still accepted so tests and headless callers can pass a fixed
 * directory without wrapping it.
 */
export type WorkspaceRootOption = string | (() => string)

/**
 * Evaluate a {@link WorkspaceRootOption}.
 *
 * ONE implementation, used by every consumer (the session mirror and the inbound
 * executor). Two copies would drift, and the next person to touch placement
 * would have to find both.
 */
export function resolveRootOption(root: WorkspaceRootOption): string {
  return typeof root === 'function' ? root() : root
}

/**
 * The three values the caller needs to place one session:
 *
 *   - `title` is the sidebar label — the configured prefix, identical for every
 *     A2A session, which is what makes them ONE workspace instead of N;
 *   - `path` is the workspace directory handed to the registry AND the session
 *     header cwd (`agents.create({ meta: { cwd: path } })`), because
 *     `attachSession` accepts only exact equality (see the module comment);
 *   - `workDir` is where the AGENT actually runs. It is inside `path`, unique per
 *     session, and is applied with `workingDirectory.set()` — the tools and the
 *     sandbox follow THAT projection, not `header.cwd`.
 */
export interface WorkspaceDescriptor {
  readonly title: string
  readonly path: string
  /**
   * The session's effective working directory, always inside {@link path}.
   *
   * WHY IT IS SEPARATE FROM `path`: an agent's working directory is its
   * filesystem scope, so giving two peers one directory would let one peer's
   * session read what the other wrote. Isolation lives here — the shared
   * workspace (which must be `path` for the registry) must not erase it.
   *
   * WHY IT IS NOT THE HEADER CWD: the header cwd has a different job (workspace
   * membership, strict equality). `workingDirectory.set()` writes a
   * `working-directory/change` event and the tools read the resulting
   * projection, so the effective directory can differ from the header — that is
   * exactly the supported way to do this without breaking membership.
   *
   * WHY IT ENDS WITH THE SESSION ID: the id is derived from
   * (prefix, peer, contextId) and therefore reproducible, so a restarted
   * process reuses the same directory. The previous
   * `<prefix>-<peer>-<MMDD>-<HHMMSS>-<hash6>` name embedded the clock, which is
   * why a restart could produce a second directory for a conversation that
   * already had one.
   */
  readonly workDir: string
}

/** The structural subset of `ctx.workspaceRegistry.create()`'s return value. */
export interface WorkspaceLike {
  attachSession?(sessionId: string): Promise<void> | void
}

/**
 * Idempotency cache.
 *
 * Keyed by the REGISTRY OBJECT first: two plugin instances (or a test double and
 * the real service) must not share the "already created" answer for the same
 * path. The inner map is keyed by the workspace path — now the ONE shared A2A
 * root, so every session resolves to the same registry row instead of adding one
 * row per conversation.
 *
 * A WeakMap keeps the cache from extending a short-lived registry's lifetime.
 */
const createdByRegistry = new WeakMap<
  object,
  Map<string, Promise<WorkspaceLike | undefined>>
>()

/**
 * Create the directory if needed.
 *
 * `workspaceRegistry.create(path)` canonicalizes with realpath and rejects when
 * the directory is missing or is not a directory. Creating it first is what
 * makes "ensure" actually ensure something instead of failing the first turn.
 */
export async function ensureWorkspaceDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

/**
 * Derive the placement of one A2A session: the shared workspace + its own
 * working directory.
 *
 * `titlePrefix` is required (no literal fallback): the caller owns configuration
 * and passes `config.session.workspaceTitlePrefix`. Importing config.ts here
 * would drag in the schema library and make this pure module untestable in
 * environments where that optional peer dependency is not resolvable.
 *
 * `peer` and `sessionId` do not influence `path` or `title` — only `workDir`.
 * That is the whole point: two peers and two conversations must land on ONE row
 * named `<prefix>`, otherwise the sidebar grows a workspace per conversation,
 * which is what the user reported.
 *
 * `path` is returned VERBATIM as `root` (not a subdirectory) on purpose: it is
 * handed both to `workspaceRegistry.create()` and to
 * `agents.create({ meta: { cwd } })`, so any divergence between the two would
 * make `attachSession` throw (strict equality, `dsh-workspace` `lib/index.js:122`).
 */
export function workspaceForPeer(
  root: string,
  mode: WorkspaceMode,
  peer: PeerIdentity,
  sessionId: string,
  titlePrefix: string,
): WorkspaceDescriptor {
  return {
    title: titlePrefix,
    path: root,
    workDir: join(workspacePath(root, mode, peer), sessionId),
  }
}

/**
 * Register a workspace directory with the registry, at most once per path.
 *
 * Degradation contract: when the registry is absent (non-web profile) this is a
 * deliberate no-op returning `undefined` — throwing here would make the whole
 * plugin uninstallable on profiles that never provide the service. When the
 * registry IS present, a failure propagates to the caller so it can be logged;
 * visibility is important, but a workspace failure must not be silently
 * mistaken for success.
 */
export async function ensureWorkspace(
  registry: unknown,
  path: string,
  title: string,
): Promise<WorkspaceLike | undefined> {
  const resolved = asWorkspaceRegistry(registry)
  if (resolved === undefined) return undefined

  let byPath = createdByRegistry.get(resolved as object)
  if (byPath === undefined) {
    byPath = new Map()
    createdByRegistry.set(resolved as object, byPath)
  }

  const cached = byPath.get(path)
  if (cached !== undefined) return cached

  const creation = (async (): Promise<WorkspaceLike | undefined> => {
    await ensureWorkspaceDirectory(path)
    const workspace = await resolved.create(path, title)
    return isWorkspaceLike(workspace) ? workspace : undefined
  })()

  // Cache the promise, not the result: two concurrent first turns for the same
  // context must share one registry.create call.
  byPath.set(path, creation)
  try {
    return await creation
  } catch (error) {
    // A rejected promise must not pin the path as "done" forever; the next turn
    // may succeed (e.g. a transient permission problem) and retry.
    byPath.delete(path)
    throw error
  }
}

/**
 * Attach a session to a workspace entity.
 *
 * The registry validates the session's STORED HEADER cwd against the workspace
 * path before counting it as a member, with strict equality
 * (`dsh-workspace` `lib/index.js:122`), so this must run after the session
 * header is persisted. The agent is created with `descriptor.path` — the same
 * value the workspace was registered with — which is what makes the attach
 * succeed; the session's effective working directory is a different value
 * (`descriptor.workDir`, applied through `workingDirectory.set`) and does not
 * participate in this check. A refusal is the CALLER's to log and ignore, never
 * a reason to fail the A2A request. Attaching twice is idempotent inside the
 * entity.
 */
export async function attachSession(
  workspace: WorkspaceLike | undefined,
  sessionId: string,
): Promise<void> {
  if (workspace?.attachSession === undefined) return
  await workspace.attachSession(sessionId)
}

/** Narrow the registry's `unknown` create result without trusting a cast. */
function isWorkspaceLike(value: unknown): value is WorkspaceLike {
  return typeof value === 'object' && value !== null
}

/** Re-export so callers wiring the plugin do not need a second import path. */
export type { WorkspaceRegistryLike }

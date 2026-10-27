/**
 * Session mirroring — ADR-007 requirements ②/③/④ (会话窗口 / 实时可见 / 非黑箱).
 *
 * Inbound: the executor already runs a REAL DSH agent session
 * (`ctx.agents.create({ sessionId })`), so every assistant message, tool call and
 * turn boundary is rendered by the normal conversation UI. Nothing here needs to
 * re-publish those events — doing so would duplicate them. What this module adds
 * is the workspace placement (so the session sits in the A2A workspace) and its
 * teardown.
 *
 * PLACEMENT IS TWO STEPS, IN THIS ORDER (see `workspace.ts` for the evidence):
 *   1. `agents.create({ meta: { cwd: workspaceRoot } })` — the header cwd must
 *      EQUAL the registered workspace path, otherwise `attachSession` throws
 *      (`dsh-workspace` `lib/index.js:122`) and the conversation shows up
 *      ungrouped;
 *   2. `workingDirectory.set(agent, workDir)` — the tools and the sandbox follow
 *      the `workingDirectory` projection, not `header.cwd`, so this is what keeps
 *      two peers' sessions in separate directories.
 * Step 2 is best-effort but always logged: skipping it must not fail an A2A
 * request, and it must never fail silently either.
 *
 * OUTBOUND — a real two-sided conversation, not a status log.
 *
 *   delegate ──▶ session.append('user/message',      role:'user')      我方发出的消息
 *                session.append('assistant/message', role:'assistant') 远端回复
 *                session.append('developer/message', role:'developer') 中间进度
 *
 * This is DSH's own contract for what a conversation IS, verified in the shipped
 * runtime rather than invented here:
 *
 *   - `SURFACE_EVENT_TYPES = { user/message, developer/message, assistant/message,
 *     system/message, tool/result }` (`dsh-session/surface`) is exactly what the
 *     sidebar renders and what becomes model input when a session IS woken;
 *   - `deriveEventMessage` projects `user/message -> data` verbatim, and
 *     `assistant/message -> data.message` (dropping empty content);
 *   - `agent-loop` builds a turn exactly this way: `user/message` first, then a
 *     settled `assistant/message` carrying `{ turn, step, message, stream, usage }`.
 *
 * The mirror session is never woken (no followup), so those events never become
 * model input for any turn; rendering was always available — giving real user and
 * assistant messages is what makes it read like a chat transcript.
 *
 * Payload shapes follow from `deriveEventMessage`, and they are NOT symmetric:
 *
 *   - `user/message` → data IS the message itself (no envelope), which is why a
 *     `turn` cannot ride along here: adding one would corrupt the message object;
 *   - `assistant/message` → `{ turn, step, message, stream }`. `stream` is
 *     required; `[]` says honestly that no local token stream backs this text,
 *     which arrived as one settled HTTP reply rather than a decoded model stream;
 *   - `developer/message` → `{ turn, message }`, used for in-between progress.
 *
 * Because only the last two carry `turn`, ordering survives through them: each
 * reply takes the turn its question opened. If DSH later starts projecting
 * `user/message` through an envelope too, this is the one place to revisit.
 *
 * Layering rule: no Cordis import. Agents/registry are structural interfaces so
 * this module is unit-testable and safe on profiles that lack either service.
 */

import { randomUUID } from 'node:crypto'

import { OWNER_IDENTITY, type PeerIdentity, type SessionBinding } from '../types.js'
import { HOST_MESSAGES } from '../messages.js'
import { sessionIdFor } from './session-binding.js'
import {
  attachSession,
  ensureWorkspace,
  ensureWorkspaceDirectory,
  resolveRootOption,
  workspaceForPeer,
  type WorkspaceDescriptor,
  type WorkspaceLike,
  type WorkspaceMode,
  type WorkspaceRootOption,
} from './workspace.js'

// ── Structural contracts (no Cordis types) ─────────────────────────────────

/** The subset of a DSH `Session` the mirror writes through. */
export interface MirroredSessionLike {
  readonly events?: readonly unknown[]
  append?(type: string, data: unknown, options?: { readonly surfaceOp?: 'append' }): unknown
}

/**
 * The subset of a DSH `SessionHeader` the mirror reads.
 *
 * Verified field set (`SessionHeader` in every `@deepseek-ai/*` typert catalog):
 * `version / id / createdAt / cwd / parentSession / isSeeded / origin /
 * delegationDepth / agentPreset`.
 */
export interface MirroredHeaderLike {
  readonly id?: string
  readonly cwd?: string
  readonly agentPreset?: string
}

/** The subset of a DSH `Agent` the mirror needs. */
export interface MirrorAgentLike {
  readonly session?: MirroredSessionLike
  readonly header?: MirroredHeaderLike
}

/** The subset of `ctx.agents` the mirror needs. */
export interface MirrorAgentsLike {
  get(sessionId: string): MirrorAgentLike | undefined
  create(options: {
    sessionId: string
    parentAgent?: unknown
    meta?: {
      cwd?: string
      parentSession?: string
      isSeeded?: boolean
      origin?: 'subagent'
      agentPreset?: string
    }
  }): Promise<{ agent: MirrorAgentLike; dispose?: () => Promise<void> | void }>
}

/** One outbound delegation phase worth showing to the user. */
export type OutboundPhase = 'delegating' | 'waiting' | 'completed' | 'failed' | 'aborted'

export interface OutboundProgress {
  readonly contact: string
  readonly phase: OutboundPhase
  /** Optional extra context, e.g. a timeout or an error message. */
  readonly detail?: string
}

/**
 * One side of the outbound conversation worth showing to the user.
 *
 * Structurally identical to the outbound layer's own exchange type on purpose:
 * `src/outbound/**` must not import `src/session/**`, so the provider and the
 * tools declare their own copy and the seam stays dependency-free.
 */
export interface OutboundExchange {
  readonly contact: string
  /** `outgoing` = what we sent; `incoming` = what the remote answered. */
  readonly direction: 'outgoing' | 'incoming'
  readonly text: string
  /** Remote display name, used to attribute the assistant message. */
  readonly remote?: string
}

/** Human-facing copy, owned by the central table so phases cannot drift apart. */
const OUTBOUND_LABEL: Readonly<Record<OutboundPhase, string>> = Object.freeze({
  delegating: HOST_MESSAGES.progressDelegating,
  waiting: HOST_MESSAGES.progressWaiting,
  completed: HOST_MESSAGES.progressCompleted,
  failed: HOST_MESSAGES.progressFailed,
  aborted: HOST_MESSAGES.progressAborted,
})

/** `source.kind` on the mirrored developer messages; identifies their producer. */
const MIRROR_SOURCE_KIND = 'a2a-bridge'

/**
 * Step coordinate for mirrored events.
 *
 * `step` exists on the real event shapes; a mirror attaches them at different
 * times than the loop would, so a synthesized sequence would only mislead.
 */
const MIRRORED_STEP = 0

/** Input the executor hands to `cwdFor` before it creates the agent. */
export interface InboundPlacementInput {
  readonly peer: PeerIdentity
  readonly sessionId: string
}

/**
 * Hooks the inbound executor calls. Defined here (not in executor.ts) so the
 * executor only needs a tiny structural type, and the session layer stays the
 * owner of workspace policy.
 */
export interface InboundSessionHooks {
  /**
   * The value the agent's session header must carry as `cwd`.
   *
   * It is the WORKSPACE ROOT, not the per-peer directory: `attachSession` only
   * accepts a header cwd that equals the registered workspace path
   * (`dsh-workspace` `lib/index.js:122`). The effective working directory is
   * applied separately (see `onAgentCreated`).
   */
  cwdFor(input: InboundPlacementInput): Promise<string>
  /**
   * Runs after `agents.create` with the live agent; moves its working directory
   * to the per-session `workDir` and then attaches the now-persisted session.
   *
   * ORDER IS LOAD-BEARING: create (header cwd = workspace root) → set working
   * directory (`workDir`) → `attachSession`. Attaching before the header exists
   * cannot validate; moving the working directory before the agent exists has
   * no agent to move. Never throws.
   */
  onAgentCreated(binding: SessionBinding, agent: unknown): Promise<void>
}

export interface SessionMirrorOptions {
  /**
   * `ctx.get('workspaceRegistry')`, resolved LAZILY through a getter.
   *
   * A getter, not a value: the service is not active while `apply()` runs, so
   * capturing it once pinned it to `undefined` for the process lifetime and no
   * A2A workspace was ever registered.
   */
  readonly registry?: () => unknown
  /** `ctx.agents`; optional only so the mirror can degrade in isolation tests. */
  readonly agents?: MirrorAgentsLike
  /**
   * The A2A workspace root.
   *
   * A STRING OR A GETTER. The landing path comes from a `.volatile()` Config
   * field, so a plugin-page save reaches the running instance without a remount;
   * capturing the resolved string once would keep writing into the old root
   * until DSH restarts. `resolveRootOption()` is the single place that decides
   * how to read it.
   */
  readonly workspaceRoot: WorkspaceRootOption
  readonly workspaceMode: WorkspaceMode
  readonly contextIdPrefix: string
  readonly workspaceTitlePrefix: string
  readonly mirrorRemoteProgress: boolean
  readonly log?: (message: string) => void
  /**
   * Move a freshly created agent's effective working directory.
   *
   * Injected by `src/index.ts` from the `workingDirectory` service, resolved
   * LAZILY there because `ctx.get()` returns undefined while `apply()` runs.
   * `agent` is `unknown` on purpose: the mirror is Cordis-free and must not
   * import the service's types (nor the executor's `AgentLike`).
   *
   * OPTIONAL, and best-effort when present: a profile without the service, or a
   * rejected `set()`, must not fail an A2A request. It IS logged, though —
   * silently skipping it would leave every peer sharing the workspace root and
   * the operator would never learn why isolation disappeared.
   */
  readonly setWorkingDirectory?: (agent: unknown, path: string) => Promise<void>
  /**
   * The local agent currently delegating, read lazily at mirror-session creation.
   *
   * A GETTER, never a captured value: `ctx.agents.currentInitiator()` only
   * resolves inside a local agent's turn, and that is precisely when an outbound
   * delegation runs. Capturing it once at plugin startup would read `undefined`
   * forever and silently orphan every mirror session.
   */
  readonly currentParent?: () => MirrorAgentLike | undefined
}

interface InboundPlacement {
  readonly descriptor: WorkspaceDescriptor
  readonly workspace: WorkspaceLike | undefined
  readonly peer: PeerIdentity
}

interface OutboundHandle {
  readonly sessionId: string
  readonly handle: { dispose?: () => Promise<void> | void }
}

// ── Mirror ─────────────────────────────────────────────────────────────────

/**
 * Owns both directions of A2A session visibility and every resource the plugin
 * registers while doing so.
 */
export class SessionMirror {
  private readonly inbound = new Map<string, InboundPlacement>()
  private readonly outbound = new Map<string, OutboundHandle>()
  /**
   * In-flight session creations, keyed by session id.
   *
   * Progress phases can arrive back-to-back (delegating immediately followed by
   * waiting). Without this, every phase would observe "no agent yet" and create
   * its own agent for the same session id; only one can win.
   */
  private readonly outboundPending = new Map<string, Promise<MirrorAgentLike | undefined>>()
  /** Last resolved mirror agent per contact, so appends skip the lookup. */
  private readonly outboundLive = new Map<string, MirrorAgentLike>()
  /** Turn coordinate per contact conversation. */
  private readonly outboundTurns = new Map<string, number>()
  private readonly disposers: Array<() => void> = []
  private outboundDegraded = false

  constructor(private readonly options: SessionMirrorOptions) {}

  // ── Inbound ─────────────────────────────────────────────────────────────

  /** Stable hooks object for `InboundExecutor`. */
  inboundHooks(): InboundSessionHooks {
    return {
      cwdFor: (input) => this.cwdFor(input),
      onAgentCreated: (binding, agent) => this.attachInbound(binding, agent),
    }
  }

  /**
   * Resolve (and register) the placement for one A2A session.
   *
   * Returns the WORKSPACE ROOT (`descriptor.path`), not the session's working
   * directory: the executor passes this value straight into
   * `agents.create({ meta: { cwd } })`, and the workspace entity only counts a
   * session as a member when that header cwd equals the registered workspace
   * path (strict equality, `dsh-workspace` `lib/index.js:122`). Creating the
   * agent with `workDir` instead would leave the conversation in the UI's
   * "未分组" bucket.
   *
   * The descriptor is cached per sessionId for the lifetime of the plugin. The
   * session id is derived from the conversation, so the same conversation keeps
   * the same header cwd and the same workDir; re-deriving them per turn would buy
   * nothing. The workspace ROOT,
   * by contrast, is read per NEW session through `resolveRootOption()`, which is
   * what makes a plugin-page path change apply to the next session without a
   * restart. A conversation that already started keeps its directory on
   * purpose — its agent and stored header are bound to it.
   */
  private async cwdFor(input: InboundPlacementInput): Promise<string> {
    const cached = this.inbound.get(input.sessionId)
    if (cached !== undefined) return cached.descriptor.path

    const descriptor = workspaceForPeer(
      resolveRootOption(this.options.workspaceRoot),
      this.options.workspaceMode,
      input.peer,
      input.sessionId,
      this.options.workspaceTitlePrefix,
    )

    // The directory is created even without a registry: the tools run in
    // `workDir` (workingDirectory.set only accepts an EXISTING directory — its
    // `directory()` helper stats it and throws otherwise), and visibility is
    // best-effort while serving A2A is not. A recursive mkdir of the session
    // directory also creates the peer directory and the shared workspace root
    // above it, which `workspaceRegistry.create()` requires to exist.
    try {
      await ensureWorkspaceDirectory(descriptor.workDir)
    } catch (error) {
      this.warn(`a2a: could not create workspace directory ${descriptor.workDir}: ${String(error)}`)
    }

    let workspace: WorkspaceLike | undefined
    try {
      workspace = await ensureWorkspace(
        this.options.registry?.(),
        descriptor.path,
        descriptor.title,
      )
    } catch (error) {
      // Registry failures must not break the conversation. The session still
      // runs; it just is not grouped under the A2A row until a later turn works.
      this.warn(`a2a: could not register workspace ${descriptor.path}: ${String(error)}`)
    }

    this.inbound.set(input.sessionId, { descriptor, workspace, peer: input.peer })
    return descriptor.path
  }

  /**
   * Finish placing a freshly created live session.
   *
   * ORDER (load-bearing, and the reason this is one method):
   *   1. the agent already exists — `agents.create` persisted a header whose
   *      `cwd` is the workspace root, so the workspace attach can validate it;
   *   2. move the effective working directory to `workDir`, which is what the
   *      tools and the sandbox follow (`workingDirectory.set` appends a
   *      `working-directory/change` event);
   *   3. attach to the workspace, whose strict equality check reads the HEADER
   *      cwd only, so step 2 cannot invalidate it.
   *
   * A failure at either step is logged and ignored: it never fails the A2A
   * request.
   */
  private async attachInbound(binding: SessionBinding, agent: unknown): Promise<void> {
    const placement = this.inbound.get(binding.sessionId)
    if (placement === undefined) return
    await this.moveWorkingDirectory(agent, placement.descriptor.workDir, binding.sessionId)
    if (placement.workspace === undefined) return
    try {
      await attachSession(placement.workspace, binding.sessionId)
    } catch (error) {
      this.warn(`a2a: could not attach session ${binding.sessionId} to its workspace: ${String(error)}`)
    }
    // Deliberately NOT awaited: this is a visibility side effect on a different
    // service, and awaiting it here would insert an extra turn into the session
    // write pipeline (which the ordering-sensitive tests caught). Fire-and-forget
    // with an internal catch keeps the conversation path untouched.
    void this.unarchiveIfHidden(binding.sessionId)
  }

  /**
   * Make a session the plugin just took ownership of visible again.
   *
   * WHY THIS EXISTS: `archivedSessionIds` hides a session from the sidebar by
   * default. An A2A session can end up archived for mundane reasons — a user
   * tidying up after a corrupt-session error, an earlier cleanup — and neither
   * re-attaching nor resuming clears the flag. The conversation then exists,
   * runs, and is INVISIBLE, which silently defeats ADR-007: the whole point is
   * that A2A talk is watchable, not a black box.
   *
   * Scope: it runs when this process FIRST attaches a session, so a later
   * deliberate archive by the user is respected. The registry documents
   * `unarchiveSession` as a no-op for an id that is not archived, so calling it
   * unconditionally is safe. Best-effort: a failure is logged, never fatal.
   */
  private async unarchiveIfHidden(sessionId: string): Promise<void> {
    // EVERY step lives inside the try, including resolving the registry.
    //
    // This method is invoked fire-and-forget (`void this.unarchiveIfHidden(...)`),
    // so any throw becomes an UNHANDLED REJECTION: vitest fails the whole run
    // with exit 1 even though every test passed, and in production it surfaces as
    // a stray warning far from its cause. `registry?.()` only guards `undefined`;
    // a test double that passes a non-function threw straight through it.
    try {
      const provider = this.options.registry
      if (typeof provider !== 'function') return
      const registry = provider() as
        | { unarchiveSession?: (id: string) => Promise<void> | void }
        | undefined
      if (typeof registry?.unarchiveSession !== 'function') return
      await registry.unarchiveSession(sessionId)
    } catch (error) {
      this.warn(`a2a: could not unarchive session ${sessionId}: ${String(error)}`)
    }
  }

  /**
   * Best-effort `workingDirectory.set(agent, path)`.
   *
   * WHY IT MUST BE LOGGED EVEN THOUGH IT MUST NOT THROW: the A2A request works
   * either way, so a silent failure would only show up later, as one peer's
   * agent reading another peer's files. Both "no hook wired" and "the service
   * rejected the change" get an explicit warning naming the fallback directory.
   */
  private async moveWorkingDirectory(
    agent: unknown,
    path: string,
    sessionId: string,
  ): Promise<void> {
    const set = this.options.setWorkingDirectory
    if (set === undefined) {
      this.warn(
        `a2a: no workingDirectory hook is wired; session ${sessionId} will work in the ` +
          'A2A workspace root, so per-peer directory isolation is off',
      )
      return
    }
    try {
      await set(agent, path)
    } catch (error) {
      this.warn(
        `a2a: could not move session ${sessionId} to its own directory ${path}: ${String(error)}; ` +
          'it will work in the A2A workspace root, so per-peer directory isolation is off',
      )
    }
  }

  // ── Outbound ────────────────────────────────────────────────────────────

  /** Fire-and-forget progress mirror; never rejects, never blocks the remote call. */
  mirrorOutbound(progress: OutboundProgress): void {
    if (!this.options.mirrorRemoteProgress) return
    void this.writeOutbound(progress).catch((error: unknown) => {
      this.warn(`a2a: could not mirror outbound progress for "${progress.contact}": ${String(error)}`)
    })
  }

  /**
   * Fire-and-forget mirror of one SIDE of the conversation.
   *
   * `outgoing` is what WE sent, `incoming` is what the REMOTE answered. Together
   * they make the local session read like a chat transcript — the user's own
   * question next to the remote's reply — instead of a one-way status feed.
   */
  mirrorOutboundExchange(exchange: OutboundExchange): void {
    if (!this.options.mirrorRemoteProgress) return
    void this.writeExchange(exchange).catch((error: unknown) => {
      this.warn(
        `a2a: could not mirror outbound ${exchange.direction} for "${exchange.contact}": ${String(error)}`,
      )
    })
  }

  /**
   * Deterministic local session id for one outbound contact.
   *
   * The owner identity is correct here: this session is OUR view of a delegation,
   * not the remote peer's conversation. Determinism lets the same contact reuse
   * the same watchable session across delegations — which is what makes "the same
   * conversation" stay the same conversation instead of opening a new window per
   * message.
   */
  outboundSessionId(contact: string): string {
    return sessionIdFor(this.options.contextIdPrefix, OWNER_IDENTITY, `outbound:${contact}`)
  }

  /**
   * Resolve (creating on first use) the local viewing session for one contact.
   *
   * Phases and exchanges both funnel through here so a burst of updates can
   * never create two agents for one session id.
   */
  private async outboundAgent(contact: string): Promise<MirrorAgentLike | undefined> {
    const agents = this.options.agents
    if (agents === undefined) {
      this.degradeOutbound('the agents service is unavailable')
      return undefined
    }
    const sessionId = this.outboundSessionId(contact)
    const live = agents.get(sessionId)
    if (live !== undefined) return live
    const pending = this.outboundPending.get(sessionId)
    if (pending !== undefined) return pending
    const creation = this.createOutboundAgent(agents, sessionId)
    this.outboundPending.set(sessionId, creation)
    try {
      return await creation
    } finally {
      this.outboundPending.delete(sessionId)
    }
  }

  /** Append through the mirror session, or degrade honestly if it cannot. */
  private appendOutbound(
    contact: string,
    type: string,
    data: unknown,
    fallback: string,
  ): boolean {
    const agent = this.outboundLive.get(contact)
    const session = agent?.session
    if (session?.append === undefined) {
      this.degradeOutbound('this DSH session exposes no append()')
      this.log(fallback)
      return false
    }
    session.append(type, data, { surfaceOp: 'append' })
    return true
  }

  private async writeOutbound(progress: OutboundProgress): Promise<void> {
    const agent = await this.outboundAgent(progress.contact)
    if (agent === undefined) return
    this.outboundLive.set(progress.contact, agent)

    const line = this.formatOutbound(progress)
    this.appendOutbound(
      progress.contact,
      'developer/message',
      {
        turn: this.turnFor(progress.contact),
        message: {
          id: randomUUID(),
          role: 'developer',
          source: { kind: MIRROR_SOURCE_KIND },
          content: [{ type: 'text', text: line }],
        },
      },
      line,
    )
  }

  private async writeExchange(exchange: OutboundExchange): Promise<void> {
    const agent = await this.outboundAgent(exchange.contact)
    if (agent === undefined) return
    this.outboundLive.set(exchange.contact, agent)

    const turn = this.turnFor(exchange.contact, exchange.direction === 'outgoing')
    const text = exchange.text

    if (exchange.direction === 'outgoing') {
      // `deriveEventMessage` returns `data` verbatim for `user/message`, so the
      // payload IS the message — same as the agent loop writes for a real prompt.
      this.appendOutbound(
        exchange.contact,
        'user/message',
        {
          id: randomUUID(),
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text }],
        },
        `A2A → ${exchange.contact}: ${text}`,
      )
      return
    }

    // `assistant/message`: `{ turn, step, message, stream }`. The `stream` array
    // is required; `[]` states honestly that no local token stream backs this —
    // the text arrived as one settled HTTP reply, not as a decoded model stream.
    this.appendOutbound(
      exchange.contact,
      'assistant/message',
      {
        turn,
        step: MIRRORED_STEP,
        message: {
          id: randomUUID(),
          role: 'assistant',
          // Attributed to the REMOTE peer, never to a local vendor: the sidebar
          // must be able to tell which side of the wire produced this text.
          source: {
            kind: 'model',
            provider: exchange.contact,
            model: exchange.remote ?? exchange.contact,
          },
          content: [{ type: 'text', text }],
        },
        stream: [],
      },
      `A2A ← ${exchange.contact}: ${text}`,
    )
  }

  /**
   * Turn coordinate for the mirrored conversation.
   *
   * `turn` is the field the surface folds by, so a floating message with no turn
   * reads as detached from the exchange it belongs to. One outgoing message opens
   * a turn; the reply that answers it shares that turn, exactly as the real loop
   * pairs a prompt with its assistant settlement.
   */
  private turnFor(contact: string, open = false): number {
    const current = this.outboundTurns.get(contact) ?? 0
    if (!open) return current
    const next = current + 1
    this.outboundTurns.set(contact, next)
    return next
  }

  /** Create (once) the local viewing session for one outbound contact. */
  private async createOutboundAgent(
    agents: MirrorAgentsLike,
    sessionId: string,
  ): Promise<MirrorAgentLike | undefined> {
    // Same split as inbound: one shared `<prefix>` workspace (the agent's header
    // cwd, so `attachSession` accepts the session) and one per-session
    // `workDir` under it, applied through `workingDirectory.set`. The root is
    // read HERE (not at plugin startup) so a path change applies to the next
    // mirrored conversation without a restart.
    const descriptor = workspaceForPeer(
      resolveRootOption(this.options.workspaceRoot),
      this.options.workspaceMode,
      OWNER_IDENTITY,
      sessionId,
      this.options.workspaceTitlePrefix,
    )
    // `workingDirectory.set` requires an existing directory (it stats the path
    // and throws otherwise), so the real workDir is created first — recursively,
    // which also creates the registered root.
    try {
      await ensureWorkspaceDirectory(descriptor.workDir)
    } catch (error) {
      this.warn(`a2a: could not create outbound workspace directory ${descriptor.workDir}: ${String(error)}`)
    }
    let workspace: WorkspaceLike | undefined
    try {
      workspace = await ensureWorkspace(
        this.options.registry?.(),
        descriptor.path,
        descriptor.title,
      )
    } catch (error) {
      this.warn(`a2a: could not register outbound workspace ${descriptor.path}: ${String(error)}`)
    }

    /**
     * The delegating local agent, read at CREATION time.
     *
     * A getter, never a captured value: `currentInitiator()` only resolves inside
     * a local agent's turn, and the outbound call is exactly where that is true.
     * Both links are set because they are two different things —
     * `parentAgent` is runtime ownership (parent teardown releases the child)
     * while `meta.parentSession` is the durable lineage the sidebar nests by.
     */
    const parent = this.options.currentParent?.()
    const parentSession = parent?.header?.id

    // Deliberately no followup: the mirror session is a viewing surface, not a
    // model turn. Waking it would charge tokens for progress lines and let the
    // agent answer "正在委派给 X" as if it were a user request.
    const created = await agents.create({
      sessionId,
      ...(parent === undefined ? {} : { parentAgent: parent }),
      meta: {
        // The WORKSPACE ROOT, not the per-session directory: the workspace
        // entity validates the header cwd against its registered path with
        // strict equality (`dsh-workspace` `lib/index.js:122`), so any other
        // value would leave this mirror session ungrouped.
        cwd: descriptor.path,
        ...(parentSession === undefined
          ? {}
          : { parentSession, origin: 'subagent' as const }),
        ...(parent?.header?.agentPreset === undefined
          ? {}
          : { agentPreset: parent.header.agentPreset }),
      },
    })
    this.outbound.set(sessionId, { sessionId, handle: created })
    // Order matters exactly as it does inbound: the agent exists with the root
    // as its header cwd, THEN its effective working directory moves to
    // `workDir`, THEN the session is attached (the attach reads the header only,
    // so the move cannot invalidate it).
    await this.moveWorkingDirectory(created.agent, descriptor.workDir, sessionId)
    try {
      await attachSession(workspace, sessionId)
    } catch (error) {
      this.warn(`a2a: could not attach outbound session ${sessionId} to its workspace: ${String(error)}`)
    }
    // Not awaited, for the same reason as inbound: keep the write pipeline free of
    // an unrelated service round-trip.
    void this.unarchiveIfHidden(sessionId)
    return created.agent
  }

  private formatOutbound(progress: OutboundProgress): string {
    const base = `${OUTBOUND_LABEL[progress.phase]} ${progress.contact}`
    return progress.detail === undefined || progress.detail.length === 0
      ? `A2A · ${base}`
      : `A2A · ${base} — ${progress.detail}`
  }

  private degradeOutbound(reason: string): void {
    if (this.outboundDegraded) return
    this.outboundDegraded = true
    this.warn(
      `a2a: remote progress will not be visible in the conversation UI (${reason}). ` +
        'A2A serving continues; only the live mirroring is degraded.',
    )
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /**
   * Register a disposer owned by this mirror.
   *
   * Every subscription the plugin adds must come back here so a single
   * `ctx.effect` teardown releases all of them. (Inbound needs no event
   * subscription — the real agent session is itself the live view.)
   */
  track(disposer: () => void): () => void {
    this.disposers.push(disposer)
    return () => {
      const index = this.disposers.indexOf(disposer)
      if (index >= 0) this.disposers.splice(index, 1)
    }
  }

  /**
   * Release runtime resources. Called from `ctx.effect`.
   *
   * Deliberately does NOT delete workspace records or session history: those are
   * the user's durable conversation data, and unloading/reloading a plugin must
   * not erase it. Teardown only releases agent handles this mirror created and
   * clears in-process caches.
   */
  dispose(): void {
    for (const disposer of this.disposers.splice(0)) {
      try {
        disposer()
      } catch (error) {
        this.warn(`a2a: session mirror disposer failed: ${String(error)}`)
      }
    }
    for (const entry of this.outbound.values()) {
      void Promise.resolve(entry.handle.dispose?.()).catch((error: unknown) => {
        this.warn(`a2a: could not dispose mirror session ${entry.sessionId}: ${String(error)}`)
      })
    }
    this.outboundPending.clear()
    this.outboundLive.clear()
    this.outboundTurns.clear()
    this.outbound.clear()
    this.inbound.clear()
  }

  private log(message: string): void {
    this.options.log?.(message)
  }

  private warn(message: string): void {
    this.options.log?.(message)
  }
}

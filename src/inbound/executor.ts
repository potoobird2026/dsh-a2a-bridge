/**
 * Inbound executor — A2A SendMessage → a real DSH agent turn.
 *
 * Two ordering rules come straight from a working implementation and are easy
 * to get wrong:
 *
 *   1. Artifacts MUST be published BEFORE the terminal status update. The SDK
 *      ends the event stream at the first terminal event, so anything sent
 *      afterwards is lost.
 *   2. The reply text MUST ride ON the terminal status update's
 *      `status.message`. Sending it as a separate message event leaves the
 *      task stuck in WORKING forever.
 *
 * Layering rule: no Cordis import. Agents are addressed structurally so this
 * module is unit-testable without booting a composition.
 */

import { randomUUID } from 'node:crypto'

import {
  TURN_END_EVENT_TYPE,
  TURN_OUTCOME_ERROR,
  TURN_START_GRACE_MS,
  TURN_START_POLL_MS,
} from '../constants.js'
import {
  taskStateFromTurnEnding,
  type PeerIdentity,
  type SessionBinding,
} from '../types.js'
import {
  bindSession,
  normalizeContextId,
  projectHintOf,
  projectKeyFor,
  sessionIdFor,
  stableContextId,
  workspacePath,
} from '../session/session-binding.js'
import { resolveRootOption, type WorkspaceRootOption } from '../session/workspace.js'
import type { A2AArtifact, A2AMessage, A2APart, A2AStreamResponse, A2ATask, TaskState } from '../protocol/wire.js'
import { createCoalescer, createFrameFactory } from './stream-frames.js'
import { STREAM_PROGRESS_MIN_INTERVAL_MS } from '../constants.js'
import { buildAgentCard } from '../protocol/card.js'
import { isRecord, partsToText, parseMessage } from '../protocol/parse.js'
import { sanitizeOutbound } from '../security/index.js'
import { clampDiagnostic } from '../security/index.js'
import type { TaskStore } from './task-store.js'
import { HOST_MESSAGES } from '../messages.js'
import { A2A_DENIED_TOOLS } from '../constants.js'
import { applyToolPolicy } from './tool-policy.js'

// ── Structural contracts (no Cordis types) ─────────────────────────────────

/**
 * The session surface this executor reads.
 *
 * `session.events` does NOT exist on a real DSH session: it exposes
 * `snapshotEvents()` (and `ownEvents()`). Reading `.events` yields `undefined`,
 * so `collectReplyText` always returned '' and every task settled with the
 * "(no text reply on this turn)" sentinel even though the agent had answered.
 */
export interface SessionLike {
  snapshotEvents?(fromSeq?: number, toSeqExclusive?: number): readonly unknown[]
  ownEvents?(): readonly unknown[]
  readonly events?: readonly unknown[]
}

/** Read a session's events through whichever accessor this build exposes. */
export function readEvents(session: SessionLike | undefined): readonly unknown[] {
  if (session === undefined) return []
  if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
  if (typeof session.ownEvents === 'function') return session.ownEvents()
  return session.events ?? []
}

export interface AgentLike {
  followup(message: unknown): void
  whenIdle(): Promise<void>
  cancel(reason: unknown): void
  readonly session?: SessionLike
}

/**
 * Durable creation metadata: the subset of `CreateAgentOptions.meta` this
 * executor can supply.
 *
 * EXACT field names, verified with `cordis_inspect_query` host/Service `agents`
 * -> `CreateAgentOptions.meta`:
 *   cwd, parentSession, isSeeded, origin, delegationDepth, agentPreset
 *
 * Note `parentSession` (durable lineage, what nests a conversation in the
 * sidebar) is NOT `parentSessionId`, and it is independent of `parentAgent`
 * (live ownership). `@deepseek-ai/dsh-subagent` builds a child session from the
 * same set (see `childSessionMeta` in its `lib/index.js`).
 */
export interface AgentMeta {
  cwd?: string
  agentPreset?: string
  /** Durable parent session id; the sidebar renders the child under it. */
  parentSession?: string
  /** Coarse product origin; `'subagent'` is the only value DSH declares. */
  origin?: 'subagent'
  /** Recursion budget that must survive persistence. */
  delegationDepth?: number
  isSeeded?: boolean
}

export interface AgentsLike {
  get(sessionId: string): AgentLike | undefined
  /**
   * Load a persisted session instead of creating one.
   *
   * Verified contract: `ResumeAgentOptions` is
   * `{ resumeSessionId, parentAgent?, agentOptions?, signal?, setup? }` — it takes
   * NO `sessionId` and NO `meta`, because cwd/preset already live in the header.
   */
  resume?(options: Record<string, unknown>): Promise<{ agent: AgentLike }>
  create(options: {
    sessionId: string
    /**
     * Live local parent agent (runtime ownership: disposing the parent disposes
     * this child). The field name is the verified `CreateAgentOptions.parentAgent`.
     */
    parentAgent?: unknown
    /** Durable lineage/provenance; see {@link AgentMeta}. */
    meta?: AgentMeta
    /** REQUIRED in practice — see ExecutorOptions.agentOptions. */
    agentOptions?: { provider?: string; model?: string }
    setup?: (agentCtx: unknown) => Promise<void> | void
  }): Promise<{ agent: AgentLike; dispose?: () => Promise<void> }>
}

/**
 * The local delegation an A2A request belongs to, when there is one.
 *
 * INBOUND HTTP HAS NO PARENT: a remote peer's request arrives on its own async
 * chain, so there is no local initiating Agent and no local session to nest
 * under. An inbound A2A conversation is therefore a ROOT session — faking
 * `parentSession` would corrupt the sidebar lineage (and `agents` runtime
 * ownership) with an id that is not this conversation's parent.
 *
 * The seam exists for the directions where a local parent DOES exist: a local
 * agent that drives an A2A conversation in-process, and the outbound mirror
 * session (which should nest under the delegating Agent). Nothing wires it for
 * inbound today; when nothing provides it, the session stays a root.
 */
export interface AgentLineage {
  /** Live local parent agent (runtime ownership). */
  readonly parentAgent?: unknown
  /** Durable parent session id (sidebar nesting). */
  readonly parentSession: string
  /** Depth to persist when the caller knows it; omitted avoids inventing one. */
  readonly delegationDepth?: number
}

/** What `lineageFor` is told about the request it may attribute. */
export interface LineageInput {
  readonly peer: PeerIdentity
  readonly contextId: string
  readonly sessionId: string
}

/**
 * ADR-007 session seam.
 *
 * The executor stays transport-only; the session layer decides WHERE the turn
 * is shown. Both hooks are optional so the executor remains usable without any
 * session service (and unit-testable without a composition).
 */
export interface SessionHooks {
  /**
   * The value the agent's session header must carry as `cwd` — the A2A
   * WORKSPACE ROOT.
   *
   * Returning the root is what lets `workspaceRegistry` validate and attach the
   * session: the entity requires the stored header cwd to equal the registered
   * workspace path (strict equality, `dsh-workspace` `lib/index.js:122`). The
   * session's own working directory is NOT this value; the session layer moves
   * it afterwards through `workingDirectory.set` (see `onAgentCreated`).
   */
  cwdFor?(input: { readonly peer: PeerIdentity; readonly sessionId: string }): Promise<string>
  /**
   * Runs after `agents.create` with the live agent.
   *
   * The session layer uses this to move the agent's effective working directory
   * to its per-session `workDir` and then attach the now-persisted session.
   * Must not throw (visibility is best-effort).
   */
  onAgentCreated?(binding: SessionBinding, agent: AgentLike): Promise<void>
}

export interface ExecutorOptions {
  readonly agents: AgentsLike
  readonly prefix: string
  /**
   * The A2A workspace root — a string OR a getter.
   *
   * The value comes from a `.volatile()` Config field: a plugin-page save updates
   * the running Loader in place, so a string captured at plugin start would keep
   * this executor on the old root until a restart. `resolveRootOption()` (shared
   * with the session mirror) is the only place that decides how to read it.
   */
  readonly workspaceRoot: WorkspaceRootOption
  readonly workspaceMode: 'per-peer' | 'shared'
  readonly turnTimeoutMs: number
  /**
   * Clock seam for turn metadata (`metadata.dsh.startedAt`).
   *
   * Injected rather than read from `Date.now()` inline so a test can pin time;
   * the settled-status `timestamp` stays on the wall clock because it reports
   * when the reply actually landed, not when the caller wanted it to.
   */
  readonly now: () => Date
  readonly session?: SessionHooks
  /**
   * Persisted task records, so `GetTask` survives a process restart.
   *
   * Optional on purpose: without it the executor keeps its ORIGINAL behaviour —
   * a settled task is reachable only through the `SendMessage` response — which
   * is exactly what the turn-machinery tests exercise. Wiring is a separate,
   * reviewable change from the machinery itself.
   */
  readonly tasks?: TaskStore
  /**
   * The model every A2A session runs on.
   *
   * Without it the system prompt's `{{model}}` variable has no value and EVERY
   * turn fails before the first step with:
   *   prompt variable "{{model}}" has no value for this assembly
   *   (section "deployment:persona-prefix")
   * The A2A call still returns 200 with a settled task, so the failure looks
   * like "the agent produced no text" rather than "the model was never bound".
   */
  readonly agentOptions?: () => { provider?: string; model?: string } | undefined
  /**
   * The agent preset this session must mount.
   *
   * THE PRESET IS THE TOOLSET. `agents.create()` without a mounted preset
   * produces an agent with no execution tool at all (the Web bundle keeps
   * `tool-pwsh` / `tool-bash` / `tool-fs` / `tool-terminal` off the Host plane
   * and every preset supplies them in its own scope), so this option is what
   * separates "A2A can chat" from "A2A can work". See `src/inbound/preset.ts`
   * for the priority chain and the evidence.
   *
   * A PROMISE IS ACCEPTED because the second priority step
   * (`agentPresets.resolve()` with the id omitted) is an async service call.
   * The Host-side wiring resolves the whole chain and hands the answer over;
   * a plain synchronous `() => string | undefined` remains a valid
   * implementation, which keeps this module usable without a composition.
   *
   * `undefined` means "nothing was resolved": the session is still created
   * (chat keeps working) and the fact that it has no tools is logged.
   */
  readonly agentPreset?: () => string | undefined | Promise<string | undefined>
  /**
   * Mount `id` — or the registry's default when `undefined` — onto a freshly
   * created agent's `setup` context. Injected by `src/index.ts`, which owns the
   * Cordis `agentPresets` service, so this module keeps no Cordis import.
   *
   * It MUST run from `agents.create({ setup })`: the registry binds an agent
   * that is still UNPUBLISHED, and after publication the first turn has already
   * been assembled without the toolset.
   */
  readonly mountAgentPreset?: (agentCtx: unknown, id: string | undefined) => Promise<void>
  /**
   * The cross-session tools this session must not reach. Defaults to
   * {@link A2A_DENIED_TOOLS}; injectable so a test can assert the wiring without
   * depending on the shipped list.
   */
  readonly deniedTools?: readonly string[]
  /**
   * Attribute this conversation to a local delegation, when one exists.
   *
   * Returns `undefined` for genuine inbound traffic (the normal case): the peer
   * is a different process, so there is no local parent to nest under. Wiring
   * that DOES have a parent (see {@link AgentLineage}) gets the verified
   * `parentAgent` + `meta.parentSession` fields passed straight through to
   * `agents.create`, which is exactly how `@deepseek-ai/dsh-subagent` links a
   * child session to its delegating Agent.
   */
  readonly lineageFor?: (input: LineageInput) => AgentLineage | undefined
  /** Diagnostic sink; the plugin wires this to its Cordis logger. */
  readonly log?: (message: string) => void
}

export interface ExecuteInput {
  readonly peer: PeerIdentity
  readonly params: unknown
  readonly signal: AbortSignal
  /**
   * Pre-generated task id.
   *
   * The streaming path mints the id BEFORE the turn so the first frame can carry
   * the same id the settled task will have — otherwise a peer would see two ids for
   * one turn.
   */
  readonly taskId?: string
  /**
   * C1 progress milestones, called synchronously at named points of the turn.
   *
   * Deliberately a callback rather than a poll: the peer needs "what is happening",
   * and polling event snapshots would either miss milestones or emit far too many
   * frames. The streaming generator is the only caller.
   */
  readonly onProgress?: (label: string) => void
}

// ── Errors ─────────────────────────────────────────────────────────────────

/**
 * JSON-RPC code for "this deployment has no model bound yet".
 *
 * -32603 (internal error) is deliberate: the caller's request is well-formed,
 * the SERVER is misconfigured. Using -32602 would blame the peer and hide the
 * one action that fixes it (choosing a model in the plugin page).
 */
export const MODEL_NOT_SELECTED_CODE = -32603

/**
 * Raised when an A2A message arrives before a provider/model was chosen.
 *
 * The message is user-facing and actionable on purpose: the failure reaches a
 * remote peer as a JSON-RPC error, but the human who can fix it is sitting in
 * front of the DSH GUI.
 */
export class ModelNotSelectedError extends Error {
  readonly code = MODEL_NOT_SELECTED_CODE

  constructor() {
    super(HOST_MESSAGES.modelNotSelected)
    this.name = 'ModelNotSelectedError'
  }
}

export class TaskNotFoundError extends Error {
  constructor(readonly taskId: string) {
    super(`task not found: ${taskId}`)
  }
}

export class TurnTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`turn exceeded ${timeoutMs}ms and was cancelled`)
  }
}

// ── Executor ───────────────────────────────────────────────────────────────

/**
 * Turns an A2A SendMessage request into one DSH turn and returns a settled
 * A2A task.
 */
/**
 * Does this error mean the session is already persisted on disk?
 *
 * `agents.create` rejects an existing session id with
 * `session "<id>" already exists`. The match is deliberately narrow: any other
 * failure must NOT be retried through `resume`, which would hide a real creation
 * bug behind a second, unrelated failure.
 */
function alreadyExists(error: unknown): boolean {
  return error instanceof Error && /already exists/i.test(error.message)
}

export class InboundExecutor {
  constructor(private readonly options: ExecutorOptions) {}

  async sendMessage(input: ExecuteInput): Promise<{ task: A2ATask }> {
    const params = (input.params ?? {}) as Record<string, unknown>
    const message = parseMessage(params.message)
    if (message === undefined) {
      throw new Error('params.message is required and must carry a messageId')
    }

    // ── Conversation identity ───────────────────────────────────────────────
    //
    // SPEC: an explicit `contextId` wins — that is the A2A grouping primitive.
    //
    // DEFAULT: derived, never random. A peer that sends no contextId used to get
    // a fresh one per message, so every message opened a new session and a new
    // chat window. The derived id is stable for (peer, project): the peer's
    // `metadata.project` hint when it sends one, otherwise the project root this
    // deployment configured for that peer. See `session-binding.ts` for the
    // full reasoning and the cross-talk guarantees.
    //
    // The project root is computed BEFORE the cwd on purpose: the per-session
    // cwd depends on the session id, so it cannot be an input to it.
    const projectRoot = workspacePath(
      // Read per request: the root is a volatile Config field, so a saved path
      // change must reach the very next A2A turn without a restart.
      resolveRootOption(this.options.workspaceRoot),
      this.options.workspaceMode,
      input.peer,
    )
    const explicitContextId = normalizeContextId(message.contextId)
    const contextId =
      explicitContextId ??
      stableContextId(
        this.options.prefix,
        input.peer,
        projectKeyFor({
          // `parseMessage` intentionally keeps only protocol semantics; the
          // free-form metadata stays on the raw params, which is where a hint
          // contract like `metadata.project` belongs.
          projectHint: isRecord(params.message)
            ? projectHintOf(params.message.metadata)
            : undefined,
          projectRoot,
        }),
      )
    // Clock seam for the turn's metadata (see `ExecutorOptions.now`). The
    // session binding itself no longer carries a timestamp: placement is keyed
    // on the deterministic session id, so time cannot leak into the path.
    const now = this.options.now()
    // The session id is derived BEFORE the cwd because the session layer keys
    // its workspace placement on it (ADR-007).
    const sessionId = sessionIdFor(this.options.prefix, input.peer, contextId)
    // The session layer returns the A2A WORKSPACE ROOT, which becomes this
    // session's header cwd — the one value the workspace entity accepts as
    // proof of membership (strict equality). The agent's real working directory
    // is a different path, applied after creation by `onAgentCreated` via
    // `workingDirectory.set`. Without a session layer the per-peer root is the
    // best placement available, and it preserves the same isolation boundary.
    const cwd =
      (await this.options.session?.cwdFor?.({ peer: input.peer, sessionId })) ?? projectRoot
    const binding = bindSession({
      prefix: this.options.prefix,
      peer: input.peer,
      contextId,
      cwd,
    })
    this.options.log?.(
      `a2a: conversation context=${contextId} ` +
        `source=${explicitContextId === undefined ? 'project' : 'explicit'}`,
    )

    const taskId = input.taskId ?? randomUUID()
    const userText = partsToText(message.parts)

    // Refuse BEFORE creating an agent. A turn with no bound model dies at step 1
    // with `prompt variable "{{model}}" has no value`, and creating the session
    // first would leave an empty, misleading session behind.
    if (this.options.agentOptions?.() === undefined) {
      this.options.log?.('a2a: refused a message because no model is configured')
      throw new ModelNotSelectedError()
    }

    const lineage = this.options.lineageFor?.({
      peer: input.peer,
      contextId,
      sessionId: binding.sessionId,
    })
    if (lineage !== undefined) {
      this.options.log?.(
        `a2a: session ${binding.sessionId} nests under local session ${lineage.parentSession}`,
      )
    }

    const agent = await this.openAgent(binding.sessionId, cwd, lineage)
    this.options.log?.(`a2a: agent ready session=${binding.sessionId} headerCwd=${cwd}`)
    input.onProgress?.(HOST_MESSAGES.progressAgentReady)
    // After creation the session header exists, so the session layer can move
    // the agent's working directory and then attach it to the A2A workspace.
    // Best-effort: a failure must not turn a working A2A call into an error
    // response.
    await this.options.session?.onAgentCreated?.(binding, agent)
    const baseline = readEvents(agent.session).length

    const startedAt = now.toISOString()
    // Default to a normal completion. Leaving this undefined made a SUCCESSFUL
    // turn settle as TASK_STATE_CANCELED, because taskStateFromTurnEnding maps
    // `undefined` to CANCELED — a mapping that exists for the "admission dropped
    // the message" case, not for an ordinary finished turn.
    let endReason: string | undefined = 'stop'

    try {
      agent.followup(this.buildUserMessage(userText))
      this.options.log?.(
        `a2a: followup sent session=${binding.sessionId} baseline=${baseline} ` +
          `whenIdle=${typeof agent.whenIdle} snapshotEvents=${typeof agent.session?.snapshotEvents}`,
      )
      input.onProgress?.(HOST_MESSAGES.progressFollowupSent)
      await this.withTimeout(agent, this.options.turnTimeoutMs)
      this.options.log?.(`a2a: idle session=${binding.sessionId} events=${readEvents(agent.session).length}`)
      input.onProgress?.(HOST_MESSAGES.progressTurnIdle)

      // `whenIdle()` can resolve BEFORE the turn actually starts, in which case
      // the reply would be collected from an event stream that has not grown
      // yet. Give the session a short grace period to show activity, then wait
      // for it to settle again. Bounded so a genuinely empty turn still
      // completes instead of hanging.
      if (readEvents(agent.session).length <= baseline) {
        const graceUntil = Date.now() + TURN_START_GRACE_MS
        while (Date.now() < graceUntil && readEvents(agent.session).length <= baseline) {
          await new Promise((resolve) => setTimeout(resolve, TURN_START_POLL_MS))
        }
        if (readEvents(agent.session).length > baseline) {
          await this.withTimeout(agent, this.options.turnTimeoutMs)
        }
      }
    } catch (error) {
      if (error instanceof TurnTimeoutError) {
        endReason = 'cancelled'
      } else {
        endReason = 'error'
      }
    }

    const events = readEvents(agent.session)
    // A turn can FAIL INSIDE the agent while `whenIdle()` still resolves
    // normally and the ending reason stays 'stop' (observed as
    // `[TRANSPORT] DeepSeek Messages transport failed`). Without this check the
    // task was reported as TASK_STATE_COMPLETED with no reply text — a lie a
    // peer cannot detect. The turn/end event carries the real outcome.
    if (endedWithError(events, baseline)) {
      endReason = 'error'
    }

    const replyText = sanitizeOutbound(collectReplyText(events, baseline))
    const state = taskStateFromTurnEnding(endReason)

    // Rule 1: artifacts precede the terminal status update.
    const artifacts: A2AArtifact[] =
      replyText.length === 0
        ? []
        : [
            {
              artifactId: `${taskId}-result`,
              name: 'result',
              parts: [{ text: replyText, mediaType: 'text/plain' } as A2APart],
            },
          ]

    // Rule 2: the reply rides on the terminal status message.
    const statusMessage: A2AMessage = {
      messageId: randomUUID(),
      role: 'ROLE_AGENT',
      // ASCII fallback on purpose: a non-ASCII sentinel here made the wire
      // response unreadable for clients that ignore the charset, and it carries
      // no information a peer can act on.
      parts: [{ text: replyText.length === 0 ? '(no text reply on this turn)' : replyText }],
      taskId,
      contextId,
    }

    const task: A2ATask = {
      id: taskId,
      contextId,
      status: {
        state: state as A2ATask['status']['state'],
        message: statusMessage,
        timestamp: new Date().toISOString(),
      },
      artifacts,
      metadata: {
        dsh: {
          stopReason: endReason ?? 'stop',
          sessionId: binding.sessionId,
          startedAt,
        },
      },
    }

    // Persist BEFORE the response leaves: a peer holding this task id must be
    // able to `GetTask` it immediately, and after a restart. Best-effort — a disk
    // problem must not turn a turn the model already completed into an error.
    await this.persist(task)
    return { task }
  }

  /**
   * Look up a settled task.
   *
   * Returns the SAME projection `SendMessage` returned, read back from disk, so a
   * polling peer gets an identical answer instead of a second, drifting shape.
   *
   * Throws `TaskNotFoundError` for everything the store cannot produce — absent,
   * expired, or unreadable — because to a peer those are one condition, and the
   * protocol has exactly one code for it (-32001).
   */
  async getTask(taskId: string): Promise<A2ATask> {
    const task = await this.findTask(taskId)
    if (task === undefined) throw new TaskNotFoundError(taskId)
    return task
  }

  /**
   * `undefined` instead of throwing.
   *
   * `CancelTask` needs to tell three cases apart — unknown task, settled task,
   * running task — and a throwing lookup collapses the first two. Kept separate
   * rather than parsed out of an error message.
   */
  async findTask(taskId: string): Promise<A2ATask | undefined> {
    if (this.options.tasks === undefined) return undefined
    try {
      const stored = await this.options.tasks.get(taskId)
      return stored?.task
    } catch (error) {
      this.options.log?.(`a2a: task lookup failed for ${taskId}: ${String(error)}`)
      return undefined
    }
  }

  /** Best-effort persistence: a disk problem is logged, never fatal. */
  private async persist(task: A2ATask): Promise<void> {
    if (this.options.tasks === undefined) return
    try {
      await this.options.tasks.save(task)
    } catch (error) {
      this.options.log?.(`a2a: could not persist task ${task.id}: ${String(error)}`)
    }
  }

  /**
   * `SendStreamingMessage`: the SAME turn, reported as a frame sequence.
   *
   * Frame plan (C1 status-level, D1 coalesced):
   *   1. `task`          — SUBMITTED, carrying the id the settled task will reuse
   *   2+. `statusUpdate` — one per progress milestone, latest-wins inside the window
   *   …  `artifactUpdate` — the reply text
   *   last `statusUpdate` — terminal state; in v1.0 closing the stream ends the turn
   *
   * There is deliberately NO second implementation of turn semantics: this method
   * calls `sendMessage` and only observes it through `onProgress`. An independent
   * streaming turn would be the classic way for the two paths to disagree about
   * what "completed" means.
   */
  async *sendStreamingMessage(input: ExecuteInput): AsyncGenerator<A2AStreamResponse> {
    const taskId = input.taskId ?? randomUUID()
    const frames = createFrameFactory()
    const coalescer = createCoalescer<string>({ minIntervalMs: STREAM_PROGRESS_MIN_INTERVAL_MS })
    // Status frames reuse the seed task: the real one does not exist until the turn
    // settles, and a peer only needs the id + state to follow along.
    const seed: A2ATask = { id: taskId, status: { state: 'TASK_STATE_SUBMITTED' as TaskState } }
    yield frames.initial(seed)

    const labels: string[] = []
    let wake: (() => void) | undefined
    let finished = false
    const nudge = (): void => {
      wake?.()
      wake = undefined
    }

    const turn = this.sendMessage({
      ...input,
      taskId,
      onProgress: (label: string) => {
        labels.push(label)
        nudge()
      },
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    void turn.then(() => {
      finished = true
      nudge()
    })

    for (;;) {
      while (labels.length > 0) {
        const label = labels.shift() as string
        for (const text of coalescer.push(label)) {
          yield frames.status(seed, 'TASK_STATE_WORKING' as TaskState, text)
        }
      }
      if (finished) break
      // Wait for the next milestone OR completion. A rejected turn still resolves
      // `turn`, so this cannot hang on failure.
      await new Promise<void>((resolve) => {
        wake = resolve
      })
    }
    for (const text of coalescer.flush()) {
      yield frames.status(seed, 'TASK_STATE_WORKING' as TaskState, text)
    }

    const settled = await turn
    if (!settled.ok) {
      // A failed turn ends the stream with a FAILED terminal frame. Closing the
      // stream is the end-of-stream signal in v1.0 — there is no `final` flag.
      yield frames.status(seed, 'TASK_STATE_FAILED' as TaskState)
      return
    }
    const task = settled.value.task
    const artifact = task.artifacts?.[0]
    if (artifact !== undefined) yield frames.artifact(task, artifact, 0)
    yield frames.status(task, task.status.state)
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Create (or reuse) the agent for one A2A conversation.
   *
   * ── WHY THE `setup` CALLBACK IS THE WHOLE POINT ──────────────────────────
   * `agents.create()` on its own mounts NO preset, and a preset is what brings
   * the execution tools: the Web bundle disables `tool-pwsh` / `tool-bash` /
   * `tool-fs` / `tool-terminal` on the Host plane so that every agent supplies
   * them from the preset IT mounts. A session created without one could reach
   * the model and answer in text while being unable to run a single command.
   *
   * `setup` is the only hook that runs while the agent is still UNPUBLISHED,
   * which is what `agentPresets.mount()` requires — and it runs before the
   * first turn is assembled, so the tool schemas are part of that first request.
   *
   * A mount failure is CONTAINED here: the peer would otherwise receive a
   * transport error for a server-side composition problem it cannot act on. The
   * consequence (no execution tools) is logged explicitly, because nothing in
   * the A2A response reveals it.
   *
   * ALIGNMENT WITH THE SUBAGENT MODEL (`@deepseek-ai/dsh-subagent`): a child
   * session inherits the parent's cwd and composition and records its durable
   * lineage. Here `cwd` and `agentPreset` are always supplied the same way; the
   * lineage fields are added only when {@link ExecutorOptions.lineageFor} proves
   * a local parent exists.
   */
  private async openAgent(
    sessionId: string,
    cwd: string,
    lineage: AgentLineage | undefined,
  ): Promise<AgentLike> {
    const existing = this.options.agents.get(sessionId)
    if (existing !== undefined) return existing

    const preset = await this.options.agentPreset?.()
    const mountPreset = this.options.mountAgentPreset

    if (preset === undefined) {
      // The A2A answer will still look healthy; this line is the only signal a
      // human gets that the session behind it is tool-less.
      this.options.log?.(
        'a2a: no agent preset is bound to this session; it will have no execution tools ' +
          '(pwsh / bash / fs / terminal)',
      )
    } else if (mountPreset === undefined) {
      // A selected preset with no mount hook is a WIRING defect: it would be
      // silently ignored, which is the same symptom with a more confusing cause.
      this.options.log?.(
        `a2a: agent preset "${preset}" was selected but no mount hook is wired; ` +
          'this session will have no execution tools',
      )
    }

    const setup: (agentCtx: unknown) => Promise<void> = async (agentCtx: unknown) => {
      // The deny list is applied REGARDLESS of the preset: it narrows what a
      // remote peer may reach even in the "chat only" case, and a preset failure
      // must not leave the cross-session readers available.
      //
      // `applyToolPolicy` reads the tools service from `agentCtx` itself — the
      // restriction must land on THIS agent's scope, not the plugin's root scope.
      applyToolPolicy(
        agentCtx,
        this.options.deniedTools ?? A2A_DENIED_TOOLS,
        this.options.log,
      )
      if (preset === undefined || mountPreset === undefined) return
      try {
        await mountPreset(agentCtx, preset)
      } catch (error) {
        this.options.log?.(
          `${HOST_MESSAGES.presetMountFailed} (preset=${preset}): ${String(error)}`,
        )
      }
    }

    const createMeta: AgentMeta = { cwd }
    if (preset !== undefined) {
      // `meta.agentPreset` is the DURABLE provenance: the session header records
      // which composition the conversation ran under, and the registry's
      // `agentPreset` session projection initialises from that header.
      createMeta.agentPreset = preset
    }
    if (lineage !== undefined) {
      createMeta.parentSession = lineage.parentSession
      createMeta.origin = 'subagent'
      if (lineage.delegationDepth !== undefined) {
        createMeta.delegationDepth = lineage.delegationDepth
      }
    }

    const createOptions = {
      sessionId,
      // Live runtime ownership of a child session, distinct from durable lineage.
      ...(lineage?.parentAgent === undefined ? {} : { parentAgent: lineage.parentAgent }),
      meta: createMeta,
      // Bind the model explicitly; see ExecutorOptions.agentOptions.
      ...(this.options.agentOptions?.() !== undefined
        ? { agentOptions: this.options.agentOptions() }
        : {}),
      ...(setup === undefined ? {} : { setup }),
    }

    try {
      const handle = await this.options.agents.create(createOptions)
      return handle.agent
    } catch (error) {
      // A session persisted by an EARLIER process is not creatable again: the
      // store rejects it with `session "..." already exists`. Session ids are
      // stable by design (that stability is the whole point of requirement #3),
      // so without this branch every A2A conversation died on the first restart
      // after it started — the sessions sat on disk and were unusable.
      if (!alreadyExists(error) || this.options.agents.resume === undefined) throw error
      this.options.log?.(
        `a2a: session ${sessionId} already exists on disk; resuming it instead of creating a new one`,
      )
      const resumed = await this.options.agents.resume({
        // NOT `sessionId`: the verified field is `resumeSessionId`.
        resumeSessionId: sessionId,
        ...(lineage?.parentAgent === undefined ? {} : { parentAgent: lineage.parentAgent }),
        ...(this.options.agentOptions?.() !== undefined
          ? { agentOptions: this.options.agentOptions() }
          : {}),
        ...(setup === undefined ? {} : { setup }),
      })
      return resumed.agent
    }
  }

  private buildUserMessage(text: string): unknown {
    return {
      // A user message MUST carry an identity. The session-log validator rejects an
      // event whose message has no `id` ("lacks an identified message"), and that
      // surfaces as "stored session ... is corrupt" the next time it is loaded.
      // `@deepseek-ai/dsh-llm` stamps the id inside createMessage(); a hand-built
      // message has to stamp it here.
      id: randomUUID(),
      // The validator rejects `message must have role "user"` on reload, so the
      // role is as load-bearing as the id above. Both are what
      // `@deepseek-ai/dsh-llm`'s createUserMessage() stamps for us.
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }
  }

  private async withTimeout(agent: AgentLike, timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<{ timedOut: true }>((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs)
    })
    try {
      const outcome = await Promise.race([
        agent.whenIdle().then(() => ({ timedOut: false as const })),
        deadline,
      ])
      if (outcome.timedOut) {
        agent.cancel({ kind: 'user' })
        throw new TurnTimeoutError(timeoutMs)
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

// ── Event → text ───────────────────────────────────────────────────────────

/**
 * True when a `turn/end` event in the NEW events (from `baseline`) reports an
 * error outcome.
 *
 * Only the slice after `baseline` is inspected: an old failed turn in the same
 * conversation must not make every later success look failed.
 */
function endedWithError(events: readonly unknown[], baseline: number): boolean {
  for (let index = baseline; index < events.length; index += 1) {
    const event = events[index]
    if (typeof event !== 'object' || event === null) continue
    const record = event as Record<string, unknown>
    if (record.type !== TURN_END_EVENT_TYPE) continue
    const data = record.data as Record<string, unknown> | undefined
    // The VERIFIED `SessionEventMap` shape is `{ turn, reason: TurnEndReason }`
    // and a failed turn carries `reason.kind === 'error'`. The flat `outcome`
    // spelling never appears in a real log, so checking only that kept this
    // mapping dead in production while its unit test (which built the event by
    // hand) passed. Accept both spellings, detect the real one first.
    const reason = data?.reason as { kind?: string } | undefined
    if (reason?.kind === TURN_OUTCOME_ERROR) return true
    if (data?.outcome === TURN_OUTCOME_ERROR) return true
  }
  return false
}

/**
 * Collect committed assistant text from session events, starting at
 * `baseline`.
 *
 * The baseline matters: without it a multi-turn conversation re-collects the
 * whole history and the reply grows on every round.
 */
export function collectReplyText(events: readonly unknown[] | undefined, baseline = 0): string {
  if (events === undefined) return ''
  const chunks: string[] = []
  for (let index = baseline; index < events.length; index += 1) {
    const event = events[index]
    if (typeof event !== 'object' || event === null) continue
    const record = event as Record<string, unknown>
    if (record.type !== 'assistant/message') continue
    const data = record.data as Record<string, unknown> | undefined
    const message = data?.message as Record<string, unknown> | undefined
    const content = message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue
      const b = block as Record<string, unknown>
      if (b.type === 'text' && typeof b.text === 'string') chunks.push(b.text)
    }
  }
  return chunks.join('\n')
}

/** Build the card this deployment serves, from resolved config. */
export function cardForDeployment(
  config: {
    card: {
      name: string
      description: string
      public: boolean
      skills: ReadonlyArray<{ id: string; name: string; description: string; tags: string[] }>
      extendedSkills: ReadonlyArray<{
        id: string
        name: string
        description: string
        tags: string[]
      }>
    }
    basePath: string
  },
  version: string,
  origin: (hostHeader: string | undefined) => string,
) {
  return (hostHeader: string | undefined) =>
    buildAgentCard({
      name: config.card.name,
      description: config.card.description,
      version,
      url: origin(hostHeader),
      skills: config.card.skills,
      extendedSkills: config.card.extendedSkills,
      authRequired: true,
    })
}

export { clampDiagnostic }

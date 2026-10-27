/**
 * Unit tests for `src/inbound/executor.ts`.
 *
 * The executor is transport-only by design (no Cordis import), so these tests
 * drive it with structural fakes: a session whose event list a fake `followup`
 * appends to, and an `agents` table that records whether `create` was called.
 *
 * What is pinned here is the policy that is easy to regress:
 *   - an unconfigured model is refused BEFORE any agent exists,
 *   - a `turn/end` with `outcome: 'error'` settles as TASK_STATE_FAILED instead
 *     of lying to the peer with TASK_STATE_COMPLETED,
 *   - only events after the baseline decide the outcome (an old failure must not
 *     poison later successful turns).
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  InboundExecutor,
  MODEL_NOT_SELECTED_CODE,
  ModelNotSelectedError,
  type AgentLike,
  type AgentMeta,
  type AgentsLike,
  type SessionLike,
} from '../../src/inbound/executor.js'
import { sessionIdFor } from '../../src/session/session-binding.js'
import { mkdtemp } from 'node:fs/promises'
import { TaskStore } from '../../src/inbound/task-store.js'

// ── Fakes ──────────────────────────────────────────────────────────────────

const PEER = 'peer-a'

/** One SendMessage params object in the shape `parseMessage` accepts. */
const PARAMS = {
  message: {
    messageId: 'msg-1',
    role: 'ROLE_USER',
    parts: [{ text: 'hello from the peer' }],
  },
}

function makeExecutor(options: {
  agents: AgentsLike
  events: unknown[]
  agentOptions?: () => { provider?: string; model?: string } | undefined
  agentPreset?: () => string | undefined | Promise<string | undefined>
  mountAgentPreset?: (agentCtx: unknown, id: string | undefined) => Promise<void>
  /** Cross-session tools to deny; omitted = the shipped policy. */
  deniedTools?: readonly string[]
  lineageFor?: (input: { peer: string; contextId: string; sessionId: string }) =>
    | { parentAgent?: unknown; parentSession: string; delegationDepth?: number }
    | undefined
  log?: (message: string) => void
  /** Persisted task records; omitted by every test that only exercises a turn. */
  tasks?: TaskStore
}): InboundExecutor {
  return new InboundExecutor({
    agents: options.agents,
    prefix: 'a2a',
    workspaceRoot: join(tmpdir(), 'a2a-executor-tests'),
    workspaceMode: 'per-peer',
    turnTimeoutMs: 5_000,
    now: () => new Date('2026-01-02T03:04:05.000Z'),
    agentOptions: options.agentOptions,
    agentPreset: options.agentPreset,
    mountAgentPreset: options.mountAgentPreset,
    deniedTools: options.deniedTools,
    lineageFor: options.lineageFor,
    log: options.log,
    tasks: options.tasks,
  })
}

/** An `AgentsLike` whose `create` is observed and whose agent appends on demand. */
function makeAgents(options: {
  session: SessionLike
  onCreate?: () => void
  onFollowup: () => void
  /** Runs the `setup` callback the executor passed, as the factory would. */
  runSetup?: boolean
  /**
   * The object handed to `setup`. The real factory passes the agent's SCOPED
   * creation context, which is what `tools.restrict()` must be called on — so a
   * test that wants to observe the deny list supplies a context carrying `tools`.
   */
  agentContext?: unknown
}): {
  agents: AgentsLike
  createCalls: string[]
  setups: Array<(agentCtx: unknown) => Promise<void> | void>
  metas: Array<{ cwd?: string; agentPreset?: string } | undefined>
  specs: Array<{ sessionId: string; parentAgent?: unknown; meta?: AgentMeta }>
} {
  const createCalls: string[] = []
  const setups: Array<(agentCtx: unknown) => Promise<void> | void> = []
  const metas: Array<{ cwd?: string; agentPreset?: string } | undefined> = []
  const specs: Array<{ sessionId: string; parentAgent?: unknown; meta?: AgentMeta }> = []
  const agent: AgentLike = {
    followup: () => options.onFollowup(),
    whenIdle: async () => {},
    cancel: () => {},
    session: options.session,
  }
  const agents: AgentsLike = {
    get: () => undefined,
    create: async (spec) => {
      createCalls.push(spec.sessionId)
      metas.push(spec.meta)
      specs.push({ sessionId: spec.sessionId, parentAgent: spec.parentAgent, meta: spec.meta })
      if (spec.setup !== undefined) setups.push(spec.setup)
      // The real factory awaits `setup` BEFORE the agent is published; running
      // it here is what proves the mount happens before the first turn.
      if (options.runSetup === true && spec.setup !== undefined) {
        await spec.setup(options.agentContext ?? { scope: 'agent' })
      }
      options.onCreate?.()
      return { agent }
    },
  }
  return { agents, createCalls, setups, metas, specs }
}

/** A session whose snapshot is whatever the shared array currently holds. */
function makeSession(events: unknown[]): SessionLike {
  return { snapshotEvents: () => events }
}

function send(executor: InboundExecutor, signal = new AbortController().signal) {
  return executor.sendMessage({ peer: PEER, params: PARAMS, signal })
}

// ── Unconfigured model ─────────────────────────────────────────────────────

describe('unconfigured model', () => {
  it('refuses with ModelNotSelectedError and never creates an agent', async () => {
    const events: unknown[] = []
    const { agents, createCalls } = makeAgents({
      session: makeSession(events),
      onFollowup: () => {
        throw new Error('followup must not run without a model')
      },
    })
    const executor = makeExecutor({
      agents,
      events,
      agentOptions: () => undefined,
    })

    await expect(send(executor)).rejects.toBeInstanceOf(ModelNotSelectedError)
    // The refusal happens before `agents.create`, so no empty misleading
    // session is left behind.
    expect(createCalls).toEqual([])
  })

  it('carries the documented JSON-RPC code and an actionable message', async () => {
    const events: unknown[] = []
    const { agents } = makeAgents({
      session: makeSession(events),
      onFollowup: () => {},
    })
    const logs: string[] = []
    const executor = makeExecutor({
      agents,
      events,
      agentOptions: () => undefined,
      log: (message) => logs.push(message),
    })

    const error = await send(executor).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ModelNotSelectedError)
    expect((error as ModelNotSelectedError).code).toBe(MODEL_NOT_SELECTED_CODE)
    expect((error as ModelNotSelectedError).message).toMatch(/尚未选择模型/)
    expect(logs.some((line) => line.includes('no model is configured'))).toBe(true)
  })
})

// ── Turn outcome ───────────────────────────────────────────────────────────

describe('turn outcome', () => {
  it('maps a turn/end error outcome to TASK_STATE_FAILED (never a false COMPLETED)', async () => {
    const events: unknown[] = []
    const reply = 'The transport failed before the model answered.'
    const { agents } = makeAgents({
      session: makeSession(events),
      onFollowup: () => {
        events.push(
          {
            type: 'assistant/message',
            data: { message: { content: [{ type: 'text', text: reply }] } },
          },
          { type: 'turn/end', data: { outcome: 'error' } },
        )
      },
    })
    const executor = makeExecutor({
      agents,
      events,
      agentOptions: () => ({ provider: 'p', model: 'm' }),
    })

    const { task } = await send(executor)

    expect(task.status.state).toBe('TASK_STATE_FAILED')
    expect(task.metadata?.dsh).toMatchObject({ stopReason: 'error' })
    // The partial text still rides on the terminal status (Rule 2) and the
    // artifact precedes it (Rule 1).
    expect(task.status.message?.parts[0]?.text).toBe(reply)
    expect(task.artifacts).toHaveLength(1)
  })

  it('settles a normal turn as TASK_STATE_COMPLETED with the reply text', async () => {
    const events: unknown[] = []
    const { agents } = makeAgents({
      session: makeSession(events),
      onFollowup: () => {
        events.push(
          {
            type: 'assistant/message',
            data: { message: { content: [{ type: 'text', text: 'all good' }] } },
          },
          { type: 'turn/end', data: { outcome: 'stop' } },
        )
      },
    })
    const executor = makeExecutor({
      agents,
      events,
      agentOptions: () => ({ provider: 'p', model: 'm' }),
    })

    const { task } = await send(executor)

    expect(task.status.state).toBe('TASK_STATE_COMPLETED')
    expect(task.metadata?.dsh).toMatchObject({ stopReason: 'stop' })
    expect(task.status.message?.parts[0]?.text).toBe('all good')
  })

  it('applies the A2A tool deny list on the AGENT scope, even without a preset', async () => {
    // This is the security boundary: a remote peer must not reach this machine's
    // other sessions. The restriction has to land on the agent's OWN scoped
    // creation context — `tools.restrict()` narrows "the calling agent scope", so
    // calling it on the plugin's root context would change nothing for the peer.
    const denied: Array<{ deny?: readonly string[] }> = []
    const agentContext = {
      scope: 'agent',
      tools: {
        get: (name: string) => (name.startsWith('session_') ? { name } : undefined),
        restrict: (filter: { deny?: readonly string[] }) => {
          denied.push(filter)
        },
      },
    }
    const events: unknown[] = []
    const { agents } = makeAgents({
      session: makeSession(events),
      runSetup: true,
      agentContext,
      onFollowup: () => {
        events.push(
          { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'ok' }] } } },
          { type: 'turn/end', data: { outcome: 'stop' } },
        )
      },
    })
    const executor = makeExecutor({
      agents,
      events,
      agentOptions: () => ({ provider: 'p', model: 'm' }),
      // No preset resolved: the deny list must still be applied.
      deniedTools: ['session_search', 'session_event_read', 'read_file'],
    })

    await send(executor)

    expect(denied).toHaveLength(1)
    // Only names the deployment actually registers are handed to restrict — an
    // unknown name makes `restrict` throw and would leave the session unrestricted.
    expect(denied[0]?.deny).toEqual(['session_search', 'session_event_read'])
  })

  it('streams the same turn as a frame sequence (task → progress → artifact → terminal)', async () => {
    const events: unknown[] = []
    const { agents } = makeAgents({
      session: makeSession(events),
      onFollowup: () => {
        events.push(
          {
            type: 'assistant/message',
            data: { message: { content: [{ type: 'text', text: 'streamed reply' }] } },
          },
          { type: 'turn/end', data: { outcome: 'stop' } },
        )
      },
    })
    const executor = makeExecutor({
      agents,
      events,
      agentOptions: () => ({ provider: 'p', model: 'm' }),
    })

    const frames: any[] = []
    for await (const frame of executor.sendStreamingMessage({
      peer: PEER,
      params: PARAMS,
      signal: new AbortController().signal,
    })) {
      frames.push(frame)
    }

    // The first frame names the task, so a peer can follow before the turn ends.
    expect(frames[0]?.task?.id).toBeTruthy()
    // At least: initial + progress + terminal. Coalescing may merge progress frames,
    // so the assertion is a floor, not an exact count.
    expect(frames.length).toBeGreaterThanOrEqual(3)
    expect(frames.some((frame) => frame.statusUpdate !== undefined)).toBe(true)
    expect(frames.some((frame) => frame.artifactUpdate !== undefined)).toBe(true)

    const last = frames[frames.length - 1]
    expect(last.statusUpdate?.status.state).toBe('TASK_STATE_COMPLETED')

    // ONE task id across every frame — that is why the id is injectable.
    const ids = new Set(
      frames.map(
        (frame) => frame.task?.id ?? frame.statusUpdate?.taskId ?? frame.artifactUpdate?.taskId,
      ),
    )
    expect(ids.size).toBe(1)
  })

  it('persists the settled task, so GetTask returns it — including from a fresh instance', async () => {
    // Closes the one gap the earlier wiring commit left: `sendMessage` → `persist`
    // was only code-reviewed. A per-run directory keeps a record from a previous
    // run from making this pass for the wrong reason; the fresh-UUID id assertion
    // would catch that anyway, but the two together are unambiguous.
    const dir = await mkdtemp(join(tmpdir(), 'a2a-exec-persist-'))
    const events: unknown[] = []
    const { agents } = makeAgents({
      session: makeSession(events),
      onFollowup: () => {
        events.push(
          {
            type: 'assistant/message',
            data: { message: { content: [{ type: 'text', text: 'stored reply' }] } },
          },
          { type: 'turn/end', data: { outcome: 'stop' } },
        )
      },
    })
    const executor = makeExecutor({
      agents,
      events,
      agentOptions: () => ({ provider: 'p', model: 'm' }),
      tasks: new TaskStore({ dir, retentionMs: 60_000, maxRecords: 10 }),
    })

    const { task } = await send(executor)

    const fetched = await executor.getTask(task.id)
    expect(fetched.id).toBe(task.id)
    expect(fetched.status.state).toBe('TASK_STATE_COMPLETED')
    expect(fetched.status.message?.parts[0]?.text).toBe('stored reply')
    expect(fetched.artifacts?.[0]?.artifactId).toBe(task.artifacts?.[0]?.artifactId)

    // A different store object on the same directory stands in for a restart: the
    // reply must come off disk, not out of the first executor's memory.
    const restarted = makeExecutor({
      agents,
      events,
      tasks: new TaskStore({ dir, retentionMs: 60_000, maxRecords: 10 }),
    })
    expect((await restarted.getTask(task.id)).id).toBe(task.id)
  })

  it('ignores a failed turn/end that belongs to history BEFORE the baseline', async () => {
    // An earlier turn in the same conversation failed. It must not make this
    // successful turn look failed: the executor only reads events from
    // `baseline`.
    const events: unknown[] = [{ type: 'turn/end', data: { outcome: 'error' } }]
    const { agents } = makeAgents({
      session: makeSession(events),
      onFollowup: () => {
        events.push(
          {
            type: 'assistant/message',
            data: { message: { content: [{ type: 'text', text: 'recovered' }] } },
          },
          { type: 'turn/end', data: { outcome: 'stop' } },
        )
      },
    })
    const executor = makeExecutor({
      agents,
      events,
      agentOptions: () => ({ provider: 'p', model: 'm' }),
    })

    const { task } = await send(executor)

    expect(task.status.state).toBe('TASK_STATE_COMPLETED')
    expect(task.status.message?.parts[0]?.text).toBe('recovered')
  })
})

// ── Agent preset: the toolset a session gets ───────────────────────────────
//
// A session created without a mounted preset has NO execution tool, and nothing
// in the A2A response says so. These tests pin the three behaviours that keep
// that defect from coming back silently: the mount happens inside `create`'s
// setup callback (before the first turn), a failed mount never fails the
// request, and an unresolvable preset is logged.

describe('agent preset', () => {
  /** A turn that completes normally, so the task settles as COMPLETED. */
  function completingFollowup(events: unknown[], order: string[], label: string) {
    return () => {
      order.push(label)
      events.push(
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'ok' }] } } },
        { type: 'turn/end', data: { outcome: 'stop' } },
      )
    }
  }

  it('mounts the preset in the setup callback, BEFORE the first turn runs', async () => {
    const events: unknown[] = []
    const order: string[] = []
    const mounts: Array<{ ctx: unknown; id: string | undefined }> = []
    const { agents, metas } = makeAgents({
      session: makeSession(events),
      runSetup: true,
      onFollowup: completingFollowup(events, order, 'followup'),
    })
    const executor = makeExecutor({
      agents,
      events,
      agentOptions: () => ({ provider: 'p', model: 'm' }),
      agentPreset: () => 'picked',
      mountAgentPreset: async (ctx, id) => {
        order.push('mount')
        mounts.push({ ctx, id })
      },
    })

    const { task } = await send(executor)

    expect(task.status.state).toBe('TASK_STATE_COMPLETED')
    // `setup` is the only hook that runs while the agent is unpublished, so the
    // toolset exists before the turn's request is assembled.
    expect(order).toEqual(['mount', 'followup'])
    // The agent context handed to the mount is the one `create` supplied.
    expect(mounts).toEqual([{ ctx: { scope: 'agent' }, id: 'picked' }])
    // Durable provenance: the session header names the composition it ran under.
    expect(metas[0]).toMatchObject({ agentPreset: 'picked' })
  })

  it('keeps the request alive when the mount fails, and says the session has no tools', async () => {
    const events: unknown[] = []
    const logs: string[] = []
    const { agents } = makeAgents({
      session: makeSession(events),
      runSetup: true,
      onFollowup: () => {
        events.push(
          {
            type: 'assistant/message',
            data: { message: { content: [{ type: 'text', text: 'still answers' }] } },
          },
          { type: 'turn/end', data: { outcome: 'stop' } },
        )
      },
    })
    const executor = makeExecutor({
      agents,
      events,
      agentOptions: () => ({ provider: 'p', model: 'm' }),
      agentPreset: () => 'broken-preset',
      mountAgentPreset: async () => {
        throw new Error('agent-preset/invalid: the preset failed to activate')
      },
      log: (message) => logs.push(message),
    })

    const { task } = await send(executor)

    // A composition problem on THIS machine must not surface to the peer as a
    // failed request: the conversation still answers.
    expect(task.status.state).toBe('TASK_STATE_COMPLETED')
    expect(task.status.message?.parts[0]?.text).toBe('still answers')
    const mountFailure = logs.find((line) => line.includes('挂载失败'))
    expect(mountFailure).toBeDefined()
    expect(mountFailure).toContain('没有执行工具')
    expect(mountFailure).toContain('broken-preset')
    expect(mountFailure).toContain('the preset failed to activate')
  })

  it('logs "no execution tools" when no preset could be resolved, and does not mount', async () => {
    const events: unknown[] = []
    const logs: string[] = []
    let mountCalls = 0
    const { agents, setups } = makeAgents({
      session: makeSession(events),
      runSetup: true,
      onFollowup: completingFollowup(events, [], 'followup'),
    })
    const executor = makeExecutor({
      agents,
      events,
      agentOptions: () => ({ provider: 'p', model: 'm' }),
      agentPreset: () => undefined,
      mountAgentPreset: async () => {
        mountCalls += 1
      },
      log: (message) => logs.push(message),
    })

    const { task } = await send(executor)

    expect(task.status.state).toBe('TASK_STATE_COMPLETED')
    expect(mountCalls).toBe(0)
    // The preset is NOT mounted, but `setup` IS still wired: the cross-session
    // deny list must be applied even when the session has no preset, so a preset
    // failure can never leave the session-search readers available.
    expect(setups).toHaveLength(1)
    expect(logs.some((line) => line.includes('no agent preset is bound'))).toBe(true)
    expect(logs.some((line) => line.includes('no execution tools'))).toBe(true)
  })

  it('warns when a preset was selected but no mount hook is wired', async () => {
    const events: unknown[] = []
    const logs: string[] = []
    const { agents } = makeAgents({
      session: makeSession(events),
      runSetup: true,
      onFollowup: completingFollowup(events, [], 'followup'),
    })
    const executor = makeExecutor({
      agents,
      events,
      agentOptions: () => ({ provider: 'p', model: 'm' }),
      agentPreset: () => 'picked',
      // No mountAgentPreset: a wiring mistake that would otherwise be silent.
      log: (message) => logs.push(message),
    })

    const { task } = await send(executor)

    expect(task.status.state).toBe('TASK_STATE_COMPLETED')
    expect(logs.some((line) => line.includes('no mount hook is wired'))).toBe(true)
  })

  it('awaits an async preset getter (the Host resolves the runtime default that way)', async () => {
    const events: unknown[] = []
    const mounts: Array<string | undefined> = []
    const { agents } = makeAgents({
      session: makeSession(events),
      runSetup: true,
      onFollowup: completingFollowup(events, [], 'followup'),
    })
    const executor = makeExecutor({
      agents,
      events,
      agentOptions: () => ({ provider: 'p', model: 'm' }),
      agentPreset: async () => 'resolved-default',
      mountAgentPreset: async (_ctx, id) => {
        mounts.push(id)
      },
    })

    await send(executor)

    expect(mounts).toEqual(['resolved-default'])
  })
})

// ── Conversation identity: project dimension ───────────────────────────────
//
// User requirement: "A2A 聊天应按项目同步到同一个会话 ID，而不是每次新会话".
// The old default was `newContextId()` — random per message — so every message
// opened a new session. These tests pin the replacement contract:
//   (1) same peer + same project, no contextId -> SAME session id,
//   (2) different project or peer -> different session id,
//   (3) explicit contextId always wins.

/** Params with an optional project hint / explicit contextId. */
function paramsFor(options: { project?: string; contextId?: string } = {}): unknown {
  return {
    message: {
      messageId: 'msg-1',
      role: 'ROLE_USER',
      parts: [{ text: 'hello from the peer' }],
      ...(options.contextId === undefined ? {} : { contextId: options.contextId }),
      ...(options.project === undefined ? {} : { metadata: { project: options.project } }),
    },
  }
}

function sessionIdOf(task: { metadata?: Record<string, unknown> }): string {
  return (task.metadata?.dsh as { sessionId: string }).sessionId
}

/** An agents table that REUSES a live agent per session, like the real one. */
function makeReusingAgents(): {
  agents: AgentsLike
  specs: Array<{ sessionId: string; parentAgent?: unknown; meta?: AgentMeta }>
} {
  const specs: Array<{ sessionId: string; parentAgent?: unknown; meta?: AgentMeta }> = []
  const live = new Map<string, AgentLike>()
  const events: unknown[] = []
  const session: SessionLike = {
    snapshotEvents: () => events,
    ownEvents: () => events,
  }
  return {
    specs,
    agents: {
      get: (sessionId) => live.get(sessionId),
      async create(spec) {
        specs.push({ sessionId: spec.sessionId, parentAgent: spec.parentAgent, meta: spec.meta })
        const agent: AgentLike = {
          followup: () => {
            events.push(
              {
                type: 'assistant/message',
                data: { message: { content: [{ type: 'text', text: 'ok' }] } },
              },
              { type: 'turn/end', data: { outcome: 'stop' } },
            )
          },
          whenIdle: async () => {},
          cancel: () => {},
          session,
        }
        live.set(spec.sessionId, agent)
        return { agent }
      },
    },
  }
}

describe('conversation identity (project dimension)', () => {
  it('reuses ONE session for the same peer + project when no contextId is sent', async () => {
    const { agents, specs } = makeReusingAgents()
    const executor = new InboundExecutor({
      agents,
      prefix: 'a2a',
      workspaceRoot: join(tmpdir(), 'a2a-executor-tests'),
      workspaceMode: 'per-peer',
      turnTimeoutMs: 5_000,
      now: () => new Date('2026-01-02T03:04:05.000Z'),
      agentOptions: () => ({ provider: 'p', model: 'm' }),
    })

    const first = await executor.sendMessage({
      peer: PEER,
      params: paramsFor(),
      signal: new AbortController().signal,
    })
    const second = await executor.sendMessage({
      peer: PEER,
      params: paramsFor(),
      signal: new AbortController().signal,
    })

    expect(sessionIdOf(second.task)).toBe(sessionIdOf(first.task))
    // `agents.get` found the live agent, so the conversation was CONTINUED
    // rather than re-created.
    expect(specs).toHaveLength(1)
  })

  it('keeps one project hint form from forking the conversation', async () => {
    const { agents } = makeReusingAgents()
    const executor = makeExecutor({
      agents,
      events: [],
      agentOptions: () => ({ provider: 'p', model: 'm' }),
    })

    const first = await send(executor)
    const second = await executor.sendMessage({
      peer: PEER,
      // The same Windows project written with a backslash and a trailing slash
      // must resolve to the same conversation, not a second one.
      params: paramsFor({ project: 'D:\\work\\app\\' }),
      signal: new AbortController().signal,
    })
    const third = await executor.sendMessage({
      peer: PEER,
      params: paramsFor({ project: 'D:/work/app' }),
      signal: new AbortController().signal,
    })

    expect(sessionIdOf(second.task)).not.toBe(sessionIdOf(first.task))
    expect(sessionIdOf(third.task)).toBe(sessionIdOf(second.task))
  })

  it('separates different projects and different peers (no cross-talk)', async () => {
    const { agents } = makeReusingAgents()
    const executor = makeExecutor({
      agents,
      events: [],
      agentOptions: () => ({ provider: 'p', model: 'm' }),
    })

    const projectA = sessionIdOf((await executor.sendMessage({
      peer: PEER,
      params: paramsFor({ project: 'proj-a' }),
      signal: new AbortController().signal,
    })).task)
    const projectB = sessionIdOf((await executor.sendMessage({
      peer: PEER,
      params: paramsFor({ project: 'proj-b' }),
      signal: new AbortController().signal,
    })).task)
    const otherPeer = sessionIdOf((await executor.sendMessage({
      peer: 'peer-b',
      params: paramsFor({ project: 'proj-a' }),
      signal: new AbortController().signal,
    })).task)

    expect(projectA).not.toBe(projectB)
    expect(otherPeer).not.toBe(projectA)
  })

  it('lets an explicit contextId win over the derived project default', async () => {
    const { agents, specs } = makeReusingAgents()
    const executor = makeExecutor({
      agents,
      events: [],
      agentOptions: () => ({ provider: 'p', model: 'm' }),
    })

    const { task } = await executor.sendMessage({
      peer: PEER,
      // Both present: the protocol-level grouping primitive must win.
      params: paramsFor({ project: 'proj-a', contextId: 'ctx-explicit' }),
      signal: new AbortController().signal,
    })

    expect(sessionIdOf(task)).toBe(sessionIdFor('a2a', PEER, 'ctx-explicit'))
    expect(specs[0]?.sessionId).toBe(sessionIdFor('a2a', PEER, 'ctx-explicit'))
  })

  it('treats an EMPTY contextId as absent instead of funnelling peers together', async () => {
    const { agents } = makeReusingAgents()
    const executor = makeExecutor({
      agents,
      events: [],
      agentOptions: () => ({ provider: 'p', model: 'm' }),
    })

    const withEmpty = sessionIdOf((await executor.sendMessage({
      peer: PEER,
      params: paramsFor({ contextId: '', project: 'proj-a' }),
      signal: new AbortController().signal,
    })).task)
    const withoutContext = sessionIdOf((await executor.sendMessage({
      peer: PEER,
      params: paramsFor({ project: 'proj-a' }),
      signal: new AbortController().signal,
    })).task)

    expect(withEmpty).toBe(withoutContext)
  })

  it('reports which source decided the conversation', async () => {
    const { agents } = makeReusingAgents()
    const logs: string[] = []
    const executor = makeExecutor({
      agents,
      events: [],
      agentOptions: () => ({ provider: 'p', model: 'm' }),
      log: (message) => logs.push(message),
    })

    await send(executor)
    await executor.sendMessage({
      peer: PEER,
      params: paramsFor({ contextId: 'ctx-explicit' }),
      signal: new AbortController().signal,
    })

    expect(logs.some((line) => line.includes('source=project'))).toBe(true)
    expect(logs.some((line) => line.includes('source=explicit'))).toBe(true)
  })
})

// ── Lineage: alignment with the subagent model ─────────────────────────────
//
// Verified field names (`CreateAgentOptions` via cordis_inspect_query):
//   parentAgent            - live runtime ownership
//   meta.parentSession     - durable lineage (sidebar nesting)
//   meta.origin            - 'subagent'
//   meta.delegationDepth   - persisted recursion budget
// Inbound HTTP has no local parent, so the default must stay a ROOT session.

describe('lineage (subagent model alignment)', () => {
  it('creates a ROOT session by default: no parentAgent, no parentSession, no origin', async () => {
    const { agents, specs } = makeReusingAgents()
    const executor = makeExecutor({
      agents,
      events: [],
      agentOptions: () => ({ provider: 'p', model: 'm' }),
    })

    await send(executor)

    expect(specs).toHaveLength(1)
    expect(specs[0]?.parentAgent).toBeUndefined()
    expect(specs[0]?.meta).toMatchObject({ cwd: expect.any(String) })
    expect(specs[0]?.meta?.parentSession).toBeUndefined()
    expect(specs[0]?.meta?.origin).toBeUndefined()
    expect(specs[0]?.meta?.delegationDepth).toBeUndefined()
  })

  it('passes the verified lineage fields through when a local parent is proven', async () => {
    const { agents, specs } = makeReusingAgents()
    const parentAgent = { id: 'parent-session' }
    const seen: Array<{ peer: string; contextId: string; sessionId: string }> = []
    const executor = makeExecutor({
      agents,
      events: [],
      agentOptions: () => ({ provider: 'p', model: 'm' }),
      lineageFor: (input) => {
        seen.push(input)
        return { parentAgent, parentSession: 'parent-session', delegationDepth: 2 }
      },
    })

    await send(executor)

    expect(specs[0]?.parentAgent).toBe(parentAgent)
    expect(specs[0]?.meta).toMatchObject({
      parentSession: 'parent-session',
      origin: 'subagent',
      delegationDepth: 2,
      cwd: expect.any(String),
    })
    // The hook is told enough to attribute the request without guessing.
    expect(seen).toHaveLength(1)
    expect(seen[0]?.peer).toBe(PEER)
    expect(seen[0]?.contextId.length).toBeGreaterThan(0)
    expect(seen[0]?.sessionId).toBe(specs[0]?.sessionId)
  })

  it('does not invent a delegationDepth it was not given', async () => {
    const { agents, specs } = makeReusingAgents()
    const executor = makeExecutor({
      agents,
      events: [],
      agentOptions: () => ({ provider: 'p', model: 'm' }),
      lineageFor: () => ({ parentSession: 'parent-session' }),
    })

    await send(executor)

    expect(specs[0]?.meta?.parentSession).toBe('parent-session')
    expect(specs[0]?.parentAgent).toBeUndefined()
    expect(specs[0]?.meta?.delegationDepth).toBeUndefined()
  })
})

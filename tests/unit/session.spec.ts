/**
 * Unit tests for the ADR-007 session layer:
 *   src/session/session-binding.ts  (deterministic identity)
 *   src/session/workspace.ts        (workspace placement + idempotency)
 *   src/session/events.ts           (inbound placement + outbound mirroring)
 *
 * Scope: pure functions and structural seams only — no Cordis, no real agents,
 * no HTTP. That is deliberate: the whole point of the structural contracts in
 * these modules is that they can be proven here without booting a composition.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  bindSession,
  normalizeContextId,
  normalizeProjectKey,
  projectHintOf,
  projectKeyFor,
  sessionIdFor,
  stableContextId,
} from '../../src/session/session-binding.js'
import {
  attachSession,
  ensureWorkspace,
  resolveRootOption,
  workspaceForPeer,
  type WorkspaceLike,
} from '../../src/session/workspace.js'
import {
  SessionMirror,
  type MirrorAgentLike,
  type MirrorAgentsLike,
  type SessionMirrorOptions,
} from '../../src/session/events.js'
import {
  InboundExecutor,
  type AgentLike as ExecutorAgentLike,
  type AgentsLike as ExecutorAgentsLike,
} from '../../src/inbound/executor.js'
import { OWNER_IDENTITY, type SessionBinding } from '../../src/types.js'

// ── Fixtures ───────────────────────────────────────────────────────────────

const SESSION_ID = 'a2a-alice-0123456789abcdef01234567'

const createdDirs: string[] = []

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-a2a-session-'))
  createdDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

interface FakeRegistry {
  readonly create: (path: string, title?: string) => Promise<WorkspaceLike>
  readonly calls: Array<{ path: string; title?: string }>
}

function fakeRegistry(attached: string[] = []): FakeRegistry {
  const calls: Array<{ path: string; title?: string }> = []
  return {
    calls,
    async create(path, title) {
      calls.push({ path, title })
      return {
        attachSession(sessionId: string) {
          attached.push(sessionId)
        },
      }
    },
  }
}

// ── sessionIdFor ───────────────────────────────────────────────────────────

describe('sessionIdFor', () => {
  it('is deterministic: same peer + contextId always yields the same session', () => {
    const first = sessionIdFor('a2a', 'alice', 'ctx-1')
    const second = sessionIdFor('a2a', 'alice', 'ctx-1')
    expect(second).toBe(first)
  })

  it('derives a different session for a different peer', () => {
    const alice = sessionIdFor('a2a', 'alice', 'ctx-1')
    const bob = sessionIdFor('a2a', 'bob', 'ctx-1')
    expect(bob).not.toBe(alice)
  })

  it('derives a different session for a different contextId of the same peer', () => {
    expect(sessionIdFor('a2a', 'alice', 'ctx-1')).not.toBe(sessionIdFor('a2a', 'alice', 'ctx-2'))
  })

  it('keeps the configured prefix and a readable peer segment', () => {
    expect(sessionIdFor('a2a', 'alice', 'ctx-1')).toMatch(/^a2a-alice-[0-9a-f]{24}$/)
  })
})

// ── Stable default context (project dimension) ─────────────────────────────
//
// User requirement: "A2A 聊天应按项目同步到同一个会话 ID，而不是每次新会话".
// These pin the three guarantees that make the derived default safe:
//   same peer + same project -> same conversation,
//   different peer OR project -> different conversation,
//   an explicit contextId still wins (handled in the executor tests).

describe('stableContextId', () => {
  it('is deterministic for the same peer + project', () => {
    const first = stableContextId('a2a', 'alice', 'D:/work/app')
    const second = stableContextId('a2a', 'alice', 'D:/work/app')
    expect(second).toBe(first)
  })

  it('keeps the opaque <prefix>-<peer>-<digest> shape peers already receive', () => {
    expect(stableContextId('a2a', 'alice', 'D:/work/app')).toMatch(/^a2a-alice-[0-9a-f]{24}$/)
  })

  it('separates peers and projects (no cross-talk)', () => {
    const base = stableContextId('a2a', 'alice', 'D:/work/app')
    expect(stableContextId('a2a', 'bob', 'D:/work/app')).not.toBe(base)
    expect(stableContextId('a2a', 'alice', 'D:/work/other')).not.toBe(base)
  })

  it('drives a stable session id through sessionIdFor', () => {
    const contextId = stableContextId('a2a', 'alice', 'D:/work/app')
    expect(sessionIdFor('a2a', 'alice', contextId)).toBe(
      sessionIdFor('a2a', 'alice', contextId),
    )
    expect(sessionIdFor('a2a', 'alice', stableContextId('a2a', 'alice', 'D:/work/app'))).toBe(
      sessionIdFor('a2a', 'alice', contextId),
    )
  })
})

describe('normalizeContextId', () => {
  it('keeps a real explicit contextId (trimmed)', () => {
    expect(normalizeContextId('  ctx-1 ')).toBe('ctx-1')
  })

  it('treats empty / whitespace / non-string as ABSENT, not as one anonymous context', () => {
    for (const value of ['', '   ', undefined, null, 42, {}, ['ctx']]) {
      expect(normalizeContextId(value), String(value)).toBeUndefined()
    }
  })
})

describe('projectHintOf', () => {
  it('reads metadata.project', () => {
    expect(projectHintOf({ project: 'D:/work/app' })).toBe('D:/work/app')
  })

  it('ignores a hint of the wrong shape or a non-object metadata map', () => {
    for (const metadata of [undefined, null, [], 'project', { project: 42 }, {}]) {
      expect(projectHintOf(metadata), String(metadata)).toBeUndefined()
    }
  })
})

describe('normalizeProjectKey', () => {
  it('canonicalises separators and trailing slashes so one project cannot fork', () => {
    const canonical = normalizeProjectKey('D:\\work\\app\\')
    expect(canonical).toBe('D:/work/app')
    expect(normalizeProjectKey('  D:/work/app//')).toBe(canonical)
  })

  it('treats blank and non-string keys as absent', () => {
    for (const value of ['', '   ', '///', undefined, 7, null]) {
      expect(normalizeProjectKey(value), String(value)).toBeUndefined()
    }
  })

  it('bounds the hash input', () => {
    expect(normalizeProjectKey('p'.repeat(500))).toHaveLength(200)
  })

  it('preserves case (distinct directories on a case-sensitive filesystem)', () => {
    expect(normalizeProjectKey('D:/Work/App')).not.toBe(normalizeProjectKey('D:/work/app'))
  })
})

describe('projectKeyFor', () => {
  it('prefers the peer hint over the configured project root', () => {
    expect(projectKeyFor({ projectHint: 'proj-a', projectRoot: 'D:/root/alice' })).toBe('proj-a')
  })

  it('falls back to the configured project root so an uncooperative peer is still stable', () => {
    expect(projectKeyFor({ projectRoot: 'D:/root/alice' })).toBe('D:/root/alice')
    expect(projectKeyFor({ projectHint: '   ', projectRoot: 'D:/root/alice' })).toBe(
      'D:/root/alice',
    )
  })

  it('never throws on a degenerate root', () => {
    expect(projectKeyFor({ projectRoot: '' })).toBe('')
  })
})

// ── workspaceForPeer (single A2A workspace) ────────────────────────────────

describe('workspace placement', () => {
  it('names ONE workspace after the configured prefix — no peer, no timestamp', () => {
    const root = join('C:', 'a2a-root')
    const first = workspaceForPeer(root, 'per-peer', 'alice', SESSION_ID, 'A2A')
    const second = workspaceForPeer(root, 'per-peer', 'bob', 'a2a-bob-ffffffffffffffffffffffff', 'A2A')

    // The user requirement: a single workspace called `A2A`, whatever the peer.
    expect(first.title).toBe('A2A')
    expect(second.title).toBe(first.title)
    expect(first.path).toBe(root)
    expect(second.path).toBe(first.path)
  })

  it('keeps each session workDir INSIDE the workspace path and separated per peer', () => {
    const root = join('C:', 'a2a-root')
    const alice = workspaceForPeer(root, 'per-peer', 'alice', SESSION_ID, 'A2A')
    const bob = workspaceForPeer(root, 'per-peer', 'bob', SESSION_ID, 'A2A')

    // Per-peer directories are the isolation boundary; only the workspace is shared.
    expect(alice.workDir).toBe(join(root, 'alice', SESSION_ID))
    expect(bob.workDir).toBe(join(root, 'bob', SESSION_ID))
    expect(alice.workDir.startsWith(alice.path)).toBe(true)
    expect(alice.workDir).not.toBe(alice.path)
  })

  it('uses the session id as the directory name, so a restart reuses it', () => {
    const root = join('C:', 'a2a-root')
    const first = workspaceForPeer(root, 'per-peer', 'alice', SESSION_ID, 'A2A')
    const again = workspaceForPeer(root, 'per-peer', 'alice', SESSION_ID, 'A2A')
    expect(again.workDir).toBe(first.workDir)
  })

  it('gives two conversations of one peer different workDirs under one workspace', () => {
    const root = join('C:', 'a2a-root')
    const otherSession = 'a2a-alice-fedcba9876543210fedcba98'
    const first = workspaceForPeer(root, 'per-peer', 'alice', SESSION_ID, 'A2A')
    const second = workspaceForPeer(root, 'per-peer', 'alice', otherSession, 'A2A')

    expect(second.path).toBe(first.path)
    expect(second.workDir).not.toBe(first.workDir)
    expect(second.workDir.startsWith(second.path)).toBe(true)
  })

  it('drops the peer directory in shared mode but still lands inside the workspace', () => {
    const root = join('C:', 'a2a-root')
    const descriptor = workspaceForPeer(root, 'shared', 'alice', SESSION_ID, 'A2A')
    expect(descriptor.workDir).toBe(join(root, SESSION_ID))
    expect(descriptor.path).toBe(root)
  })
})

// ── resolveRootOption (lazy workspace root) ────────────────────────────────

describe('resolveRootOption', () => {
  it('evaluates a getter on every call instead of caching the first answer', () => {
    let root = join('C:', 'first-root')
    const option = () => root
    expect(resolveRootOption(option)).toBe(join('C:', 'first-root'))

    // A plugin-page save rewrites the volatile Config; the next read must see it.
    root = join('C:', 'second-root')
    expect(resolveRootOption(option)).toBe(join('C:', 'second-root'))
  })

  it('passes a plain string through unchanged', () => {
    expect(resolveRootOption(join('C:', 'fixed'))).toBe(join('C:', 'fixed'))
  })
})

// ── ensureWorkspace ────────────────────────────────────────────────────────

describe('ensureWorkspace', () => {
  it('creates the directory and registers it once for repeated calls', async () => {
    const root = await tempRoot()
    const path = join(root, 'alice', SESSION_ID)
    const registry = fakeRegistry()

    const first = await ensureWorkspace(registry, path, 'A2A · alice')
    const second = await ensureWorkspace(registry, path, 'A2A · alice')

    expect(registry.calls).toHaveLength(1)
    expect(registry.calls[0]?.path).toBe(path)
    expect(registry.calls[0]?.title).toBe('A2A · alice')
    // The same promise result is reused, not a fresh creation.
    expect(second).toBe(first)
  })

  it('treats a different path as a different workspace', async () => {
    const root = await tempRoot()
    const registry = fakeRegistry()
    await ensureWorkspace(registry, join(root, 'alice', 'one'), 'one')
    await ensureWorkspace(registry, join(root, 'alice', 'two'), 'two')
    expect(registry.calls).toHaveLength(2)
  })

  it('degrades to a no-op (undefined, no throw) when the registry is absent', async () => {
    const root = await tempRoot()
    const path = join(root, 'alice', 'ws')
    await expect(ensureWorkspace(undefined, path, 'A2A')).resolves.toBeUndefined()
  })

  it('degrades when a service exists but is not a workspace registry', async () => {
    const root = await tempRoot()
    // e.g. ctx.get() returned some unrelated service without create()
    await expect(ensureWorkspace({ list: () => [] }, join(root, 'ws'), 'A2A')).resolves.toBeUndefined()
  })

  it('retries a failed creation instead of caching the rejection', async () => {
    const root = await tempRoot()
    const path = join(root, 'alice', 'ws')
    let attempts = 0
    const flaky = {
      async create(): Promise<WorkspaceLike> {
        attempts += 1
        if (attempts === 1) throw new Error('transient')
        return {}
      },
    }

    await expect(ensureWorkspace(flaky, path, 'A2A')).rejects.toThrow('transient')
    await expect(ensureWorkspace(flaky, path, 'A2A')).resolves.toBeDefined()
    expect(attempts).toBe(2)
  })

  it('attaches a session through the entity returned by create()', async () => {
    const attached: string[] = []
    const registry = fakeRegistry(attached)
    const root = await tempRoot()
    const workspace = await ensureWorkspace(registry, join(root, 'ws'), 'A2A')

    await attachSession(workspace, SESSION_ID)
    expect(attached).toEqual([SESSION_ID])
  })

  it('does nothing when there is no workspace entity to attach to', async () => {
    await expect(attachSession(undefined, SESSION_ID)).resolves.toBeUndefined()
  })
})

// ── SessionMirror — inbound ────────────────────────────────────────────────

function mirrorOptions(overrides: Partial<SessionMirrorOptions> = {}): SessionMirrorOptions {
  return {
    workspaceRoot: join('C:', 'a2a-root'),
    workspaceMode: 'per-peer',
    contextIdPrefix: 'a2a',
    workspaceTitlePrefix: 'A2A',
    mirrorRemoteProgress: true,
    ...overrides,
  }
}

const bindingFor = (cwd: string): SessionBinding => ({
  sessionId: SESSION_ID,
  contextId: 'ctx-1',
  peer: 'alice',
  cwd,
  title: 'A2A · alice',
})

describe('SessionMirror inbound placement', () => {
  it('places a session in the single A2A workspace and reuses its header cwd', async () => {
    const root = await tempRoot()
    const registry = fakeRegistry()
    const mirror = new SessionMirror(mirrorOptions({ workspaceRoot: root, registry: () => registry }))
    const hooks = mirror.inboundHooks()

    const first = await hooks.cwdFor({ peer: 'alice', sessionId: SESSION_ID })
    const second = await hooks.cwdFor({ peer: 'alice', sessionId: SESSION_ID })

    expect(second).toBe(first)
    // `cwdFor` must return the WORKSPACE ROOT: the executor passes it straight
    // into `agents.create({ meta: { cwd } })`, and the registry only accepts a
    // header cwd that EQUALS the registered path (`dsh-workspace:122`).
    expect(first).toBe(root)
    expect(first).toBe(workspaceForPeer(root, 'per-peer', 'alice', SESSION_ID, 'A2A').path)
    // One registry row for the shared workspace, titled by the configured prefix.
    expect(registry.calls).toHaveLength(1)
    expect(registry.calls[0]?.path).toBe(root)
    expect(registry.calls[0]?.title).toBe('A2A')
    mirror.dispose()
  })

  it('re-reads a getter workspaceRoot for the NEXT session, without a new instance', async () => {
    const firstRoot = await tempRoot()
    const secondRoot = await tempRoot()
    let current = firstRoot
    const registry = fakeRegistry()
    const mirror = new SessionMirror(
      mirrorOptions({ workspaceRoot: () => current, registry: () => registry }),
    )
    const hooks = mirror.inboundHooks()

    const before = await hooks.cwdFor({ peer: 'alice', sessionId: SESSION_ID })
    expect(before).toBe(firstRoot)

    // What a plugin-page save does to the volatile Config: the getter's answer
    // changes while this already-constructed mirror keeps running.
    current = secondRoot
    const nextSession = 'a2a-alice-fedcba9876543210fedcba98'
    const after = await hooks.cwdFor({ peer: 'alice', sessionId: nextSession })

    expect(after).toBe(secondRoot)
    // Two DIFFERENT workspace rows (one per root): the root really was re-read.
    expect(registry.calls.map((call) => call.path)).toEqual([firstRoot, secondRoot])
    // The conversation that already started keeps its directory on purpose.
    expect(await hooks.cwdFor({ peer: 'alice', sessionId: SESSION_ID })).toBe(before)
    mirror.dispose()
  })

  it('attaches the created session to the workspace', async () => {
    const root = await tempRoot()
    const attached: string[] = []
    const registry = fakeRegistry(attached)
    const setPaths: string[] = []
    const mirror = new SessionMirror(
      mirrorOptions({
        workspaceRoot: root,
        registry: () => registry,
        setWorkingDirectory: async (_agent, path) => {
          setPaths.push(path)
        },
      }),
    )
    const hooks = mirror.inboundHooks()

    const cwd = await hooks.cwdFor({ peer: 'alice', sessionId: SESSION_ID })
    await hooks.onAgentCreated(bindingFor(cwd), { session: {} })

    expect(attached).toEqual([SESSION_ID])
    // The effective working directory is the per-session subdirectory, not the
    // header cwd (which stays the root so the attach stays valid).
    expect(setPaths).toEqual([join(root, 'alice', SESSION_ID)])
    mirror.dispose()
  })

  it('keeps serving when the working directory cannot be changed (with a warning)', async () => {
    const root = await tempRoot()
    const attached: string[] = []
    const logs: string[] = []
    const registry = fakeRegistry(attached)
    const mirror = new SessionMirror(
      mirrorOptions({
        workspaceRoot: root,
        registry: () => registry,
        setWorkingDirectory: async () => {
          throw new Error('service down')
        },
        log: (message) => logs.push(message),
      }),
    )
    const hooks = mirror.inboundHooks()

    const cwd = await hooks.cwdFor({ peer: 'alice', sessionId: SESSION_ID })
    // Must not throw: isolation is best-effort, an A2A request is not.
    await expect(hooks.onAgentCreated(bindingFor(cwd), { session: {} })).resolves.toBeUndefined()

    // The attach still happens (it reads the header cwd, which the failed move
    // did not touch), and the failure is NOT silent.
    expect(attached).toEqual([SESSION_ID])
    expect(logs.join('\n')).toContain('service down')
    expect(logs.join('\n')).toContain('isolation is off')
    mirror.dispose()
  })

  it('warns when no workingDirectory hook is wired at all', async () => {
    const root = await tempRoot()
    const logs: string[] = []
    const mirror = new SessionMirror(
      mirrorOptions({ workspaceRoot: root, registry: () => fakeRegistry(), log: (message) => logs.push(message) }),
    )
    const hooks = mirror.inboundHooks()

    const cwd = await hooks.cwdFor({ peer: 'alice', sessionId: SESSION_ID })
    await hooks.onAgentCreated(bindingFor(cwd), { session: {} })

    expect(logs.join('\n')).toContain('no workingDirectory hook is wired')
    expect(logs.join('\n')).toContain('isolation is off')
    mirror.dispose()
  })

  it('keeps running (no throw) when workspace registration fails', async () => {
    const root = await tempRoot()
    const logs: string[] = []
    const mirror = new SessionMirror(
      mirrorOptions({
        workspaceRoot: root,
        registry: () => ({
          async create(): Promise<WorkspaceLike> {
            throw new Error('registry down')
          },
        }),
        log: (message) => logs.push(message),
      }),
    )

    const cwd = await mirror.inboundHooks().cwdFor({ peer: 'alice', sessionId: SESSION_ID })
    expect(cwd).toBe(root)
    expect(logs.join('\n')).toContain('registry down')
    mirror.dispose()
  })
})

// ── Inbound: create → set working directory → attach ────────────────────────
//
// These drive the REAL `InboundExecutor`, because `meta.cwd` is the executor's
// decision: it passes `cwdFor()`'s answer through verbatim. Calling the hooks by
// hand would prove only what the mirror returns, not what the agent is created
// with.

/** One SendMessage params object in the shape `parseMessage` accepts. */
const INBOUND_PARAMS = {
  message: {
    messageId: 'msg-1',
    role: 'ROLE_USER',
    parts: [{ text: 'hello from the peer' }],
  },
}

interface InboundHarness {
  readonly executor: InboundExecutor
  /** Header cwd each created agent was assigned (what `attachSession` reads). */
  readonly headerCwds: Map<string, string | undefined>
  readonly creations: Array<{ sessionId: string; cwd?: string }>
  readonly order: string[]
  readonly attached: string[]
  readonly logs: string[]
}

/**
 * Wire an `InboundExecutor` to a `SessionMirror` with fakes that mirror the real
 * runtime's two relevant contracts:
 *   - `agents.create` records `meta.cwd` and treats it as the session header
 *     cwd (that is what the factory persists);
 *   - `attachSession` REFUSES unless that recorded cwd equals the registered
 *     workspace path — exactly the strict equality `dsh-workspace` enforces.
 */
function inboundHarness(options: {
  root: string
  setWorkingDirectory?: (agent: unknown, path: string) => Promise<void>
}): InboundHarness {
  const order: string[] = []
  const attached: string[] = []
  const logs: string[] = []
  const creations: Array<{ sessionId: string; cwd?: string }> = []
  const headerCwds = new Map<string, string | undefined>()
  const events: unknown[] = []

  const registry = {
    async create(path: string) {
      order.push('workspace')
      return {
        attachSession(sessionId: string) {
          if (headerCwds.get(sessionId) !== path) {
            throw new Error(
              `cannot attach session '${sessionId}': its cwd '${String(headerCwds.get(sessionId))}' does not resolve to '${path}'`,
            )
          }
          order.push('attach')
          attached.push(sessionId)
        },
      }
    },
  }

  const agents: ExecutorAgentsLike = {
    get: () => undefined,
    async create(spec) {
      order.push('create')
      headerCwds.set(spec.sessionId, spec.meta?.cwd)
      creations.push({ sessionId: spec.sessionId, cwd: spec.meta?.cwd })
      const agent: ExecutorAgentLike = {
        followup: () => {
          events.push({
            type: 'assistant/message',
            data: { message: { content: [{ type: 'text', text: 'ok' }] } },
          })
        },
        whenIdle: async () => {},
        cancel: () => {},
        session: { snapshotEvents: () => events },
      }
      return { agent }
    },
  }

  const setWorkingDirectory = options.setWorkingDirectory
  const mirrorOptions = {
    workspaceRoot: options.root,
    workspaceMode: 'per-peer' as const,
    contextIdPrefix: 'a2a',
    workspaceTitlePrefix: 'A2A',
    mirrorRemoteProgress: true,
    registry: () => registry,
    ...(setWorkingDirectory === undefined ? {} : { setWorkingDirectory }),
    log: (message: string) => logs.push(message),
  }
  const mirror = new SessionMirror(mirrorOptions)

  const executor = new InboundExecutor({
    agents,
    prefix: 'a2a',
    workspaceRoot: options.root,
    workspaceMode: 'per-peer',
    turnTimeoutMs: 5_000,
    // Deterministic clock: placement must not depend on wall time.
    now: () => new Date('2026-01-02T03:04:05.000Z'),
    session: mirror.inboundHooks(),
    agentOptions: () => ({ provider: 'provider-under-test', model: 'model-under-test' }),
    log: (message) => logs.push(message),
  })

  return { executor, headerCwds, creations, order, attached, logs }
}

async function sendInbound(harness: InboundHarness): Promise<{ task: { status: { state: string } } }> {
  return harness.executor.sendMessage({
    peer: 'alice',
    params: INBOUND_PARAMS,
    signal: new AbortController().signal,
  })
}

describe('SessionMirror inbound agent creation', () => {
  it('creates the agent with the workspace ROOT as meta.cwd, so attachSession accepts it', async () => {
    const root = await tempRoot()
    const setPaths: string[] = []
    const harness = inboundHarness({
      root,
      setWorkingDirectory: async (_agent, path) => {
        setPaths.push(path)
      },
    })

    const result = await sendInbound(harness)

    expect(result.task.status.state).toBe('TASK_STATE_COMPLETED')
    // Exactly one agent, created with the root — NOT the per-session directory.
    expect(harness.creations).toHaveLength(1)
    expect(harness.creations[0]?.cwd).toBe(root)
    expect(harness.creations[0]?.cwd).toBe(
      workspaceForPeer(root, 'per-peer', 'alice', harness.creations[0]!.sessionId, 'A2A').path,
    )
    // The attach ran (the fake entity validated the cwd with strict equality).
    expect(harness.attached).toEqual([harness.creations[0]?.sessionId])
    // The real working directory is the per-session subdirectory.
    expect(setPaths).toEqual([
      join(root, 'alice', harness.creations[0]!.sessionId),
    ])
  })

  it('orders the steps create → set working directory → attach', async () => {
    const root = await tempRoot()
    const harness = inboundHarness({
      root,
      setWorkingDirectory: async () => {
        harness.order.push('set')
      },
    })

    await sendInbound(harness)

    // `workspace` is the registry registration from `cwdFor` (before creation);
    // the three that matter are the last three and their order is load-bearing:
    // the header must exist before the move, and the move must not precede the
    // attach validation (which reads the header only, so it stays valid).
    expect(harness.order).toEqual(['workspace', 'create', 'set', 'attach'])
  })

  it('keeps the A2A request successful when the working directory move fails', async () => {
    const root = await tempRoot()
    const harness = inboundHarness({
      root,
      setWorkingDirectory: async () => {
        throw new Error('workingDirectory service exploded')
      },
    })

    const result = await sendInbound(harness)

    // Serving A2A wins over visibility/isolation hygiene.
    expect(result.task.status.state).toBe('TASK_STATE_COMPLETED')
    // ...but the loss of isolation is logged, never silent.
    expect(harness.logs.join('\n')).toContain('workingDirectory service exploded')
    expect(harness.logs.join('\n')).toContain('isolation is off')
    // The attach still happened: the failed move did not corrupt the header.
    expect(harness.attached).toEqual([harness.creations[0]?.sessionId])
  })
})

// ── SessionMirror — outbound ───────────────────────────────────────────────

interface AppendedEvent {
  readonly type: string
  readonly data: unknown
  readonly options?: unknown
}

function fakeAgents(appended: AppendedEvent[], disposed: string[]): {
  agents: {
    get(sessionId: string): MirrorAgentLike | undefined
    create(options: { sessionId: string; meta?: { cwd?: string } }): Promise<{
      agent: MirrorAgentLike
      dispose: () => Promise<void>
    }>
  }
  creations: Array<{ sessionId: string; meta?: { cwd?: string } }>
} {
  const creations: Array<{ sessionId: string; meta?: { cwd?: string } }> = []
  const live = new Map<string, MirrorAgentLike>()
  return {
    creations,
    agents: {
      get: (sessionId) => live.get(sessionId),
      async create(options) {
        creations.push(options)
        const agent: MirrorAgentLike = {
          session: {
            append(type: string, data: unknown, optionsArg?: { surfaceOp?: 'append' }) {
              appended.push({ type, data, options: optionsArg })
            },
          },
        }
        live.set(options.sessionId, agent)
        return {
          agent,
          async dispose() {
            disposed.push(options.sessionId)
          },
        }
      },
    },
  }
}

async function flush(): Promise<void> {
  // The mirror is fire-and-forget by contract; a macrotask drains every awaited
  // step of the write path (create -> append).
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('SessionMirror outbound progress', () => {
  it('writes delegating / waiting / completed into a dedicated local session', async () => {
    const root = await tempRoot()
    const appended: AppendedEvent[] = []
    const disposed: string[] = []
    const fake = fakeAgents(appended, disposed)
    const registry = fakeRegistry()
    const mirror = new SessionMirror(
      mirrorOptions({ workspaceRoot: root, registry: () => registry, agents: fake.agents }),
    )

    for (const phase of ['delegating', 'waiting', 'completed'] as const) {
      mirror.mirrorOutbound({ contact: 'bob', phase })
      await flush()
    }

    await vi.waitFor(() => expect(appended).toHaveLength(3))
    expect(fake.creations).toHaveLength(1)
    expect(fake.creations[0]?.sessionId).toBe(mirror.outboundSessionId('bob'))
    expect(appended).toHaveLength(3)
    expect(registry.calls).toHaveLength(1)
    for (const event of appended) {
      expect(event.type).toBe('developer/message')
      expect((event.options as { surfaceOp?: string }).surfaceOp).toBe('append')
    }

    const texts = appended.map(
      (event) =>
        (event.data as { message: { content: Array<{ text: string }> } }).message.content[0]?.text ?? '',
    )
    expect(texts[0]).toContain('正在委派给 bob')
    expect(texts[1]).toContain('等待任务结束')
    expect(texts[2]).toContain('收到回复')

    mirror.dispose()
    await flush()
    expect(disposed).toEqual([mirror.outboundSessionId('bob')])
  })

  it('does nothing when mirrorRemoteProgress is disabled', async () => {
    const root = await tempRoot()
    const appended: AppendedEvent[] = []
    const fake = fakeAgents(appended, [])
    const mirror = new SessionMirror(
      mirrorOptions({
        workspaceRoot: root,
        mirrorRemoteProgress: false,
        agents: fake.agents,
      }),
    )

    mirror.mirrorOutbound({ contact: 'bob', phase: 'delegating' })
    await flush()

    expect(fake.creations).toHaveLength(0)
    expect(appended).toHaveLength(0)
    mirror.dispose()
  })

  it('degrades to the log when the session exposes no append()', async () => {
    const root = await tempRoot()
    const logs: string[] = []
    const mirror = new SessionMirror(
      mirrorOptions({
        workspaceRoot: root,
        agents: {
          get: () => undefined,
          async create() {
            return { agent: { session: {} } }
          },
        },
        log: (message) => logs.push(message),
      }),
    )

    expect(() => mirror.mirrorOutbound({ contact: 'bob', phase: 'delegating' })).not.toThrow()
    await vi.waitFor(() => expect(logs.join('\n')).toContain('will not be visible'))
    mirror.dispose()
  })
})

// ── bindSession determinism (composition with workspace layer) ────────────

describe('bindSession', () => {
  it('returns the same session id that sessionIdFor derives', () => {
    const binding = bindSession({
      prefix: 'a2a',
      peer: 'alice',
      contextId: 'ctx-1',
      cwd: join('C:', 'root'),
    })
    expect(binding.sessionId).toBe(sessionIdFor('a2a', 'alice', 'ctx-1'))
  })

  it('keeps the peer on the session title so two peers do not read alike', () => {
    const alice = bindSession({ prefix: 'a2a', peer: 'alice', contextId: 'c', cwd: '/' })
    const bob = bindSession({ prefix: 'a2a', peer: 'bob', contextId: 'c', cwd: '/' })
    expect(alice.title).not.toBe(bob.title)
  })
})

// ── Outbound two-sided conversation (ADR-007: 本机也要有对话框) ───────────
//
// The user's requirement is that an A2A delegation reads like a chat between two
// people: OUR message and the REMOTE reply must both be in the local session,
// not just progress lines written by one side. These tests pin that the mirror
// emits real `user/message` + `assistant/message` surface events — the same two
// event types DSH's own agent loop writes for a genuine exchange
// (`dsh-agent-loop`: `user/message` then a settled `assistant/message`), and the
// ones `dsh-session/surface` projects into what the sidebar renders.

type MirrorCreateOptions = Parameters<MirrorAgentsLike['create']>[0]

/** A richer `agents` double that records every created option set verbatim. */
function conversationFixtures(): {
  appended: AppendedEvent[]
  creations: MirrorCreateOptions[]
  agents: MirrorAgentsLike
} {
  const appended: AppendedEvent[] = []
  const creations: MirrorCreateOptions[] = []
  const live = new Map<string, MirrorAgentLike>()
  const agents: MirrorAgentsLike = {
    get: (sessionId) => live.get(sessionId),
    async create(options) {
      creations.push(options)
      const agent: MirrorAgentLike = {
        session: {
          append(type: string, data: unknown, optionsArg?: { surfaceOp?: 'append' }) {
            appended.push({ type, data, options: optionsArg })
          },
        },
        header: { id: options.sessionId, cwd: options.meta?.cwd },
      }
      live.set(options.sessionId, agent)
      return { agent, async dispose() {} }
    },
  }
  return { appended, creations, agents }
}

/** Read the text out of an appended `user/message` event. */
function userTextOf(event: AppendedEvent | undefined): string {
  const message = event?.data as { content?: Array<{ text: string }> } | undefined
  return message?.content?.[0]?.text ?? ''
}

/** Read the text and attribution out of an appended `assistant/message` event. */
function assistantOf(event: AppendedEvent | undefined): {
  text: string
  provider?: string
  model?: string
} {
  const data = event?.data as
    | { message?: { content?: Array<{ text: string }>; source?: { provider?: string; model?: string } } }
    | undefined
  return {
    text: data?.message?.content?.[0]?.text ?? '',
    provider: data?.message?.source?.provider,
    model: data?.message?.source?.model,
  }
}

describe('SessionMirror outbound conversation', () => {
  it('records our message and the remote reply as a two-sided exchange', async () => {
    const root = await tempRoot()
    const fake = conversationFixtures()
    const mirror = new SessionMirror(
      mirrorOptions({ workspaceRoot: root, registry: () => fakeRegistry(), agents: fake.agents }),
    )

    mirror.mirrorOutboundExchange({ contact: 'bob', direction: 'outgoing', text: 'ping' })
    await flush()
    mirror.mirrorOutboundExchange({
      contact: 'bob',
      direction: 'incoming',
      text: 'pong',
      remote: 'bob-agent',
    })
    await flush()

    await vi.waitFor(() => expect(fake.appended).toHaveLength(2))

    // The two event types DSH renders as a conversation, in order.
    expect(fake.appended[0]?.type).toBe('user/message')
    expect(fake.appended[1]?.type).toBe('assistant/message')

    // OUR words, in the user role.
    expect(userTextOf(fake.appended[0])).toBe('ping')
    const sent = fake.appended[0]?.data as { role?: string; id?: string }
    expect(sent.role).toBe('user')
    expect(typeof sent.id).toBe('string')

    // The REMOTE's words, attributed to the remote and not to any local model.
    expect(assistantOf(fake.appended[1]).text).toBe('pong')
    expect(assistantOf(fake.appended[1]).provider).toBe('bob')
    expect(assistantOf(fake.appended[1]).model).toBe('bob-agent')

    const reply = fake.appended[1]?.data as { stream?: unknown[]; message?: { role?: string } }
    expect(reply.message?.role).toBe('assistant')
    // No local token stream backs a settled HTTP reply; say so rather than faking one.
    expect(reply.stream).toEqual([])

    // One shared session for the whole exchange, not one per side.
    expect(fake.creations).toHaveLength(1)
    mirror.dispose()
  })

  it('numbers each exchange so replies stay attached to their question', async () => {
    const root = await tempRoot()
    const fake = conversationFixtures()
    const mirror = new SessionMirror(mirrorOptions({ workspaceRoot: root, agents: fake.agents }))

    mirror.mirrorOutboundExchange({ contact: 'bob', direction: 'outgoing', text: 'first' })
    await flush()
    mirror.mirrorOutboundExchange({ contact: 'bob', direction: 'incoming', text: 'reply-1' })
    await flush()
    mirror.mirrorOutboundExchange({ contact: 'bob', direction: 'outgoing', text: 'second' })
    await flush()
    mirror.mirrorOutboundExchange({ contact: 'bob', direction: 'incoming', text: 'reply-2' })
    await flush()

    await vi.waitFor(() => expect(fake.appended).toHaveLength(4))

    // `user/message` data IS the message (the surface projects `data` verbatim),
    // so it carries no `turn` — adding one would corrupt the message object.
    const types = fake.appended.map((event) => event.type)
    expect(types).toEqual([
      'user/message',
      'assistant/message',
      'user/message',
      'assistant/message',
    ])

    const replyTurns = fake.appended
      .filter((event) => event.type === 'assistant/message')
      .map((event) => (event.data as { turn?: number }).turn)
    // Each reply carries the turn opened by the question it answers.
    expect(replyTurns).toEqual([1, 2])
    expect(assistantOf(fake.appended[1]).text).toBe('reply-1')
    expect(assistantOf(fake.appended[3]).text).toBe('reply-2')
    mirror.dispose()
  })

  it('links each exchange by contact so two peers do not share a transcript', async () => {
    const root = await tempRoot()
    const fake = conversationFixtures()
    const mirror = new SessionMirror(mirrorOptions({ workspaceRoot: root, agents: fake.agents }))

    // Ordering must not depend on how many microtask turns a write needs. A fixed
    // `flush()` assumed a single hop, but the write path awaits the workspace root,
    // directory creation and agents.create — so under CI load the second write
    // could overtake the first and land at index 0, which is exactly how this test
    // failed there while passing locally. Wait for each write to LAND instead.
    mirror.mirrorOutboundExchange({ contact: 'bob', direction: 'outgoing', text: 'to bob' })
    await vi.waitFor(() => expect(fake.appended).toHaveLength(1))
    mirror.mirrorOutboundExchange({ contact: 'carol', direction: 'outgoing', text: 'to carol' })
    await vi.waitFor(() => expect(fake.appended).toHaveLength(2))

    await vi.waitFor(() => expect(fake.creations).toHaveLength(2))
    expect(assistantOf(fake.appended[0]).text).toBe('')
    expect(userTextOf(fake.appended[0])).toBe('to bob')
    expect(userTextOf(fake.appended[1])).toBe('to carol')
    expect(fake.creations[0]?.sessionId).toBe(mirror.outboundSessionId('bob'))
    expect(fake.creations[1]?.sessionId).toBe(mirror.outboundSessionId('carol'))
    mirror.dispose()
  })

  it('links the mirror session to the delegating local agent as a child', async () => {
    const root = await tempRoot()
    const fake = conversationFixtures()
    const parent: MirrorAgentLike = {
      session: { append: () => undefined },
      header: { id: 'parent-session', agentPreset: 'standard' },
    }
    const mirror = new SessionMirror(
      mirrorOptions({ workspaceRoot: root, agents: fake.agents, currentParent: () => parent }),
    )

    mirror.mirrorOutboundExchange({ contact: 'bob', direction: 'outgoing', text: 'ping' })
    await flush()

    await vi.waitFor(() => expect(fake.creations).toHaveLength(1))
    const created = fake.creations[0]
    // `parentAgent` = runtime ownership (the parent releasing releases us too)...
    expect(created?.parentAgent).toBe(parent)
    // ...`meta.parentSession` = the durable lineage the sidebar nests by. Both are
    // real `CreateAgentOptions` fields; only one would leave a half-parented child.
    expect(created?.meta?.parentSession).toBe('parent-session')
    expect(created?.meta?.origin).toBe('subagent')
    expect(created?.meta?.agentPreset).toBe('standard')
    mirror.dispose()
  })

  it('creates a root session (no parent fields) when nothing is delegating', async () => {
    const root = await tempRoot()
    const fake = conversationFixtures()
    const mirror = new SessionMirror(
      // No initiator: an inbound-triggered or externally driven call has no local
      // parent to attach to, and inventing one would corrupt the sidebar lineage.
      mirrorOptions({ workspaceRoot: root, agents: fake.agents, currentParent: () => undefined }),
    )

    mirror.mirrorOutbound({ contact: 'bob', phase: 'delegating' })
    await flush()

    await vi.waitFor(() => expect(fake.creations).toHaveLength(1))
    expect(fake.creations[0]?.parentAgent).toBeUndefined()
    expect(fake.creations[0]?.meta?.parentSession).toBeUndefined()
    expect(fake.creations[0]?.meta?.origin).toBeUndefined()
    mirror.dispose()
  })

  it('does nothing when mirroring is disabled', async () => {
    const root = await tempRoot()
    const fake = conversationFixtures()
    const mirror = new SessionMirror(
      mirrorOptions({ workspaceRoot: root, mirrorRemoteProgress: false, agents: fake.agents }),
    )

    mirror.mirrorOutboundExchange({ contact: 'bob', direction: 'outgoing', text: 'ping' })
    await flush()

    expect(fake.creations).toHaveLength(0)
    expect(fake.appended).toHaveLength(0)
    mirror.dispose()
  })
})

// ── Outbound: create → set working directory → attach ──────────────────────
//
// Same placement rules as inbound, but the mirror itself calls `agents.create`,
// so the order is directly observable here.

interface OutboundPlacement {
  readonly agents: MirrorAgentsLike
  readonly creations: MirrorCreateOptions[]
  readonly appended: AppendedEvent[]
  readonly headerCwds: Map<string, string | undefined>
}

/** An `agents` double that records `meta.cwd` as the session header cwd. */
function placementAgents(order: string[]): OutboundPlacement {
  const creations: MirrorCreateOptions[] = []
  const appended: AppendedEvent[] = []
  const headerCwds = new Map<string, string | undefined>()
  const live = new Map<string, MirrorAgentLike>()
  const agents: MirrorAgentsLike = {
    get: (sessionId) => live.get(sessionId),
    async create(options) {
      order.push('create')
      creations.push(options)
      headerCwds.set(options.sessionId, options.meta?.cwd)
      const agent: MirrorAgentLike = {
        session: {
          append(type: string, data: unknown, optionsArg?: { surfaceOp?: 'append' }) {
            appended.push({ type, data, options: optionsArg })
          },
        },
        header: { id: options.sessionId, cwd: options.meta?.cwd },
      }
      live.set(options.sessionId, agent)
      return { agent, async dispose() {} }
    },
  }
  return { agents, creations, appended, headerCwds }
}

/** A registry whose `attachSession` enforces the real strict-equality check. */
function strictRegistry(
  order: string[],
  attached: string[],
  headerCwds: Map<string, string | undefined>,
): { create(path: string): Promise<WorkspaceLike> } {
  return {
    async create(path: string): Promise<WorkspaceLike> {
      order.push('workspace')
      return {
        attachSession(sessionId: string): void {
          if (headerCwds.get(sessionId) !== path) {
            throw new Error(
              `cannot attach session '${sessionId}': its cwd '${String(headerCwds.get(sessionId))}' does not resolve to '${path}'`,
            )
          }
          order.push('attach')
          attached.push(sessionId)
        },
      }
    },
  }
}

describe('SessionMirror outbound placement', () => {
  it('creates the mirror agent with the workspace ROOT and then moves it into its own workDir', async () => {
    const root = await tempRoot()
    const order: string[] = []
    const attached: string[] = []
    const setPaths: string[] = []
    const fake = placementAgents(order)
    const registry = strictRegistry(order, attached, fake.headerCwds)
    const mirror = new SessionMirror(
      mirrorOptions({
        workspaceRoot: root,
        registry: () => registry,
        agents: fake.agents,
        setWorkingDirectory: async (_agent, path) => {
          order.push('set')
          setPaths.push(path)
        },
      }),
    )

    mirror.mirrorOutboundExchange({ contact: 'bob', direction: 'outgoing', text: 'ping' })
    await vi.waitFor(() => expect(fake.appended).toHaveLength(1))

    const sessionId = mirror.outboundSessionId('bob')
    const descriptor = workspaceForPeer(root, 'per-peer', OWNER_IDENTITY, sessionId, 'A2A')
    // The header cwd is the root (exactly what attachSession compares)...
    expect(fake.creations).toHaveLength(1)
    expect(fake.creations[0]?.meta?.cwd).toBe(root)
    expect(fake.creations[0]?.meta?.cwd).toBe(descriptor.path)
    // ...while the effective working directory is the per-session subdirectory.
    expect(setPaths).toEqual([descriptor.workDir])
    expect(setPaths[0]).not.toBe(descriptor.path)
    // Order: workspace registration, agent creation, the move, then the attach.
    expect(order).toEqual(['workspace', 'create', 'set', 'attach'])
    expect(attached).toEqual([sessionId])
    mirror.dispose()
  })

  it('still mirrors the exchange when the working directory move fails, and warns', async () => {
    const root = await tempRoot()
    const order: string[] = []
    const attached: string[] = []
    const logs: string[] = []
    const fake = placementAgents(order)
    const registry = strictRegistry(order, attached, fake.headerCwds)
    const mirror = new SessionMirror(
      mirrorOptions({
        workspaceRoot: root,
        registry: () => registry,
        agents: fake.agents,
        setWorkingDirectory: async () => {
          order.push('set')
          throw new Error('workingDirectory service exploded')
        },
        log: (message) => logs.push(message),
      }),
    )

    mirror.mirrorOutboundExchange({ contact: 'bob', direction: 'outgoing', text: 'ping' })
    await vi.waitFor(() => expect(fake.appended).toHaveLength(1))

    // Mirroring is best-effort: the transcript still appears...
    expect(fake.appended[0]?.type).toBe('user/message')
    // ...the attach still runs (it reads the untouched header cwd)...
    expect(attached).toEqual([mirror.outboundSessionId('bob')])
    // ...and the loss of isolation is logged, never silent.
    expect(logs.join('\n')).toContain('workingDirectory service exploded')
    expect(logs.join('\n')).toContain('isolation is off')
    mirror.dispose()
  })
})

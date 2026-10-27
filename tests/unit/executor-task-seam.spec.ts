/**
 * `GetTask` / `CancelTask` back-end: the executor's task lookup seam.
 *
 * These tests deliberately do NOT drive a turn. What is pinned here is the shape
 * of the lookup itself, because that is where a "stub that always throws" turns
 * into a real state machine — and where an over-eager implementation starts
 * throwing where the protocol expects a code:
 *
 *   - a task written by one executor is readable by a NEW one (that is what
 *     "survives a restart" means at this seam);
 *   - an absent task is `TaskNotFoundError` (one condition, one code -32001);
 *   - a store that itself fails must degrade to "not found", not to a 500;
 *   - no store configured keeps the ORIGINAL behaviour, so wiring stayed opt-in.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { InboundExecutor, TaskNotFoundError, type AgentsLike } from '../../src/inbound/executor.js'
import { TaskStore, type StoredTask } from '../../src/inbound/task-store.js'
import type { A2ATask } from '../../src/protocol/wire.js'

const created: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'a2a-task-seam-'))
  created.push(dir)
  return dir
}

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
})

/** Only `create`/`get` are reachable from the lookup seam; neither is exercised. */
const NO_AGENTS: AgentsLike = {
  get: () => undefined,
  create: async () => {
    throw new Error('agents.create must not be called by a task lookup')
  },
}

function makeExecutor(tasks?: TaskStore): InboundExecutor {
  return new InboundExecutor({
    agents: NO_AGENTS,
    prefix: 'a2a',
    workspaceRoot: join(tmpdir(), 'a2a-task-seam'),
    workspaceMode: 'per-peer',
    turnTimeoutMs: 5_000,
    now: () => new Date('2026-01-02T03:04:05.000Z'),
    log: () => undefined,
    tasks,
  })
}

function makeTask(id: string): A2ATask {
  return {
    id,
    contextId: 'a2a-peer-ctx',
    status: { state: 'TASK_STATE_COMPLETED' as A2ATask['status']['state'] },
  }
}

describe('executor task lookup', () => {
  it('reads back a task a DIFFERENT executor wrote (restart at this seam)', async () => {
    const dir = await tempDir()
    const store = new TaskStore({ dir, retentionMs: 60_000, maxRecords: 10 })
    await store.save(makeTask('task-1'))

    // A second store + executor pair stands in for a restarted process: nothing is
    // shared in memory, only the directory.
    const restarted = new TaskStore({ dir, retentionMs: 60_000, maxRecords: 10 })
    const executor = makeExecutor(restarted)

    const task = await executor.getTask('task-1')
    expect(task.id).toBe('task-1')
    expect(task.status.state).toBe('TASK_STATE_COMPLETED')
  })

  it('throws TaskNotFoundError for an unknown id', async () => {
    const dir = await tempDir()
    const executor = makeExecutor(new TaskStore({ dir, retentionMs: 60_000, maxRecords: 10 }))
    await expect(executor.getTask('nope')).rejects.toBeInstanceOf(TaskNotFoundError)
  })

  it('findTask reports absence without throwing, so CancelTask can branch', async () => {
    const dir = await tempDir()
    const store = new TaskStore({ dir, retentionMs: 60_000, maxRecords: 10 })
    const executor = makeExecutor(store)

    expect(await executor.findTask('nope')).toBeUndefined()

    await store.save(makeTask('task-1'))
    const found = await executor.findTask('task-1')
    expect(found?.id).toBe('task-1')
  })

  it('a failing store degrades to "not found" instead of failing the request', async () => {
    const messages: string[] = []
    const broken = {
      get: async (): Promise<StoredTask | undefined> => {
        throw new Error('disk on fire')
      },
      save: async (): Promise<void> => undefined,
    } as unknown as TaskStore

    const executor = new InboundExecutor({
      agents: NO_AGENTS,
      prefix: 'a2a',
      workspaceRoot: join(tmpdir(), 'a2a-task-seam'),
      workspaceMode: 'per-peer',
      turnTimeoutMs: 5_000,
      now: () => new Date('2026-01-02T03:04:05.000Z'),
      log: (message) => messages.push(message),
      tasks: broken,
    })

    expect(await executor.findTask('task-1')).toBeUndefined()
    expect(messages.some((m) => m.includes('task lookup failed'))).toBe(true)
  })

  it('without a store the original behaviour is preserved (lookup never finds)', async () => {
    const executor = makeExecutor()
    await expect(executor.getTask('task-1')).rejects.toBeInstanceOf(TaskNotFoundError)
    expect(await executor.findTask('task-1')).toBeUndefined()
  })
})

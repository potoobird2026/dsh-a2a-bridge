/**
 * Disk-backed task store.
 *
 * The store sits on the request path of a protocol the peer cannot debug, so the
 * properties pinned here are failure modes, not conveniences:
 *   - a forged id from the wire must never become a filesystem path;
 *   - a corrupt record must read as "absent", never throw;
 *   - retention must bound the directory without a background timer.
 */

import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { TaskStore, isSafeTaskId, type StoredTask } from '../../src/inbound/task-store.js'
import type { A2ATask } from '../../src/protocol/wire.js'

const DAY = 24 * 60 * 60 * 1000

const created: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'a2a-tasks-'))
  created.push(dir)
  return dir
}

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
})

function makeTask(id: string, state = 'TASK_STATE_COMPLETED'): A2ATask {
  return {
    id,
    contextId: 'ctx-1',
    status: { state: state as A2ATask['status']['state'] },
  }
}

function store(dir: string, overrides: Partial<{ retentionMs: number, maxRecords: number, now: () => number }> = {}): TaskStore {
  return new TaskStore({
    dir,
    retentionMs: overrides.retentionMs ?? 7 * DAY,
    maxRecords: overrides.maxRecords ?? 1000,
    now: overrides.now,
  })
}

describe('TaskStore', () => {
  it('save → get round-trips the task and stamps both timestamps', async () => {
    const dir = await tempDir()
    const tasks = store(dir, { now: () => 1_000 })
    await tasks.save(makeTask('task-1'))

    const record = await tasks.get('task-1')
    expect(record).toBeDefined()
    expect(record?.task.id).toBe('task-1')
    expect(record?.task.status.state).toBe('TASK_STATE_COMPLETED')
    expect(record?.createdAt).toBe(1_000)
    expect(record?.updatedAt).toBe(1_000)
  })

  it('a second save keeps createdAt and moves updatedAt', async () => {
    const dir = await tempDir()
    let clock = 1_000
    const tasks = store(dir, { now: () => clock })
    await tasks.save(makeTask('task-1'))
    clock = 5_000
    await tasks.save(makeTask('task-1', 'TASK_STATE_CANCELED'))

    const record = await tasks.get('task-1')
    expect(record?.createdAt).toBe(1_000)
    expect(record?.updatedAt).toBe(5_000)
    expect(record?.task.status.state).toBe('TASK_STATE_CANCELED')
  })

  it('rejects a traversal-shaped id instead of turning it into a path', async () => {
    const dir = await tempDir()
    const tasks = store(dir)
    const warn: string[] = []
    const guarded = new TaskStore({ dir, retentionMs: DAY, maxRecords: 10, log: (m) => warn.push(m) })

    await guarded.save(makeTask('../../escape'))
    await guarded.save(makeTask('a/b'))
    await guarded.save(makeTask(''))

    expect(await guarded.get('../../escape')).toBeUndefined()
    expect(await guarded.get('a/b')).toBeUndefined()
    expect(warn.length).toBeGreaterThanOrEqual(3)
    // Nothing escaped the directory.
    expect((await readdir(dir)).filter((n) => n.endsWith('.json'))).toHaveLength(0)
    expect(await tasks.get('task-1')).toBeUndefined()
  })

  it('isSafeTaskId rejects the ids that matter', () => {
    expect(isSafeTaskId('0d6f2c1e-0000-4000-8000-000000000000')).toBe(true)
    expect(isSafeTaskId('../x')).toBe(false)
    expect(isSafeTaskId('a/b')).toBe(false)
    expect(isSafeTaskId('')).toBe(false)
    expect(isSafeTaskId('a'.repeat(129))).toBe(false)
  })

  it('a corrupt record reads as absent and is reported, not thrown', async () => {
    const dir = await tempDir()
    const warn: string[] = []
    const tasks = new TaskStore({ dir, retentionMs: DAY, maxRecords: 10, log: (m) => warn.push(m) })
    await tasks.save(makeTask('task-1'))
    await writeFile(join(dir, 'task-1.json'), '{ not json', 'utf8')

    expect(await tasks.get('task-1')).toBeUndefined()
    expect(warn.some((m) => m.includes('could not be parsed'))).toBe(true)
  })

  it('an expired record is invisible without being deleted, then pruned', async () => {
    const dir = await tempDir()
    let clock = 0
    const tasks = store(dir, { retentionMs: DAY, now: () => clock })
    await tasks.save(makeTask('task-1'))

    clock = DAY + 1
    expect(await tasks.get('task-1')).toBeUndefined()

    await tasks.prune()
    expect((await readdir(dir)).filter((n) => n.endsWith('.json'))).toHaveLength(0)
  })

  it('prune enforces the record cap by dropping the oldest first', async () => {
    const dir = await tempDir()
    let clock = 0
    const tasks = store(dir, { maxRecords: 2, now: () => clock })
    for (const id of ['a', 'b', 'c']) {
      clock += 1_000
      await tasks.save(makeTask(id))
    }
    await tasks.prune()

    const names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort()
    expect(names).toEqual(['b.json', 'c.json'])
  })

  it('save prunes automatically so the directory cannot grow unbounded', async () => {
    const dir = await tempDir()
    let clock = 0
    const tasks = store(dir, { maxRecords: 1, now: () => clock })
    clock = 1_000
    await tasks.save(makeTask('old'))
    clock = 2_000
    await tasks.save(makeTask('new'))

    expect((await readdir(dir)).filter((n) => n.endsWith('.json'))).toEqual(['new.json'])
  })

  it('a leftover temp file from an interrupted write is cleaned up', async () => {
    const dir = await tempDir()
    const tasks = store(dir)
    await writeFile(join(dir, 'ghost.json.tmp'), '{"partial":true}', 'utf8')
    await tasks.prune()
    expect((await readdir(dir)).filter((n) => n.endsWith('.tmp'))).toHaveLength(0)
  })

  it('remove is idempotent', async () => {
    const dir = await tempDir()
    const tasks = store(dir)
    await tasks.save(makeTask('task-1'))
    await tasks.remove('task-1')
    await tasks.remove('task-1')
    expect(await tasks.get('task-1')).toBeUndefined()
  })

  it('list returns newest first and honours the limit', async () => {
    const dir = await tempDir()
    let clock = 0
    const tasks = store(dir, { now: () => clock })
    for (const id of ['a', 'b', 'c']) {
      clock += 1_000
      await tasks.save(makeTask(id))
    }

    const all = await tasks.list()
    expect(all.map((record: StoredTask) => record.task.id)).toEqual(['c', 'b', 'a'])
    expect(await tasks.list(2)).toHaveLength(2)
  })

  it('a missing directory reads as empty rather than failing', async () => {
    const dir = join(await tempDir(), 'never-created')
    const tasks = store(dir)
    expect(await tasks.get('x')).toBeUndefined()
    expect(await tasks.list()).toEqual([])
    expect(await tasks.size()).toBe(0)
  })

  it('size sums the directory', async () => {
    const dir = await tempDir()
    const tasks = store(dir)
    await tasks.save(makeTask('task-1'))
    expect(await tasks.size()).toBeGreaterThan(0)
  })
})

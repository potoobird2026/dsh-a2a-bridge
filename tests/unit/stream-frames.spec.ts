/**
 * Streaming frame construction + coalescing.
 *
 * Both halves are pure (clock and ids injected), so the timing rules are pinned
 * without sleeping — and the coalescer's latest-wins rule is exactly the part that
 * would otherwise be discovered in production as "the peer never saw the last
 * update".
 */

import { describe, expect, it } from 'vitest'

import { createCoalescer, createFrameFactory } from '../../src/inbound/stream-frames.js'
import { streamKeyOf } from '../../src/protocol/wire.js'
import type { A2AArtifact, A2ATask } from '../../src/protocol/wire.js'

const TASK: A2ATask = {
  id: 'task-1',
  contextId: 'ctx-1',
  status: { state: 'TASK_STATE_SUBMITTED' as never },
}

describe('frame factory', () => {
  const factory = createFrameFactory({
    now: () => '2026-01-02T03:04:05.000Z',
    newMessageId: () => 'msg-fixed',
  })

  it('the initial frame carries the task and nothing else', () => {
    const frame = factory.initial(TASK)
    expect(streamKeyOf(frame)).toBe('task')
    expect(frame.task?.id).toBe('task-1')
  })

  it('a status frame carries one statusUpdate with the task identity', () => {
    const frame = factory.status(TASK, 'TASK_STATE_WORKING' as never)
    expect(streamKeyOf(frame)).toBe('statusUpdate')
    expect(frame.statusUpdate?.taskId).toBe('task-1')
    expect(frame.statusUpdate?.contextId).toBe('ctx-1')
    expect(frame.statusUpdate?.status.state).toBe('TASK_STATE_WORKING')
    expect(frame.statusUpdate?.status.timestamp).toBe('2026-01-02T03:04:05.000Z')
    // No progress text → no message, so the frame stays small.
    expect(frame.statusUpdate?.status.message).toBeUndefined()
  })

  it('progress text rides on status.message as an agent message', () => {
    const frame = factory.status(TASK, 'TASK_STATE_WORKING' as never, '正在调用工具')
    const message = frame.statusUpdate?.status.message
    expect(message?.role).toBe('ROLE_AGENT')
    expect(message?.messageId).toBe('msg-fixed')
    expect(message?.taskId).toBe('task-1')
    expect(message?.parts[0]?.text).toBe('正在调用工具')
  })

  it('an artifact frame carries the artifact with lastChunk set', () => {
    const artifact: A2AArtifact = {
      artifactId: 'task-1-result',
      parts: [{ text: 'done' }],
    }
    const frame = factory.artifact(TASK, artifact, 0)
    expect(streamKeyOf(frame)).toBe('artifactUpdate')
    // `artifactId` lives on the ARTIFACT, not on the update wrapper — asserting the
    // wrong one would silently pass via `??` (and it did, until tests were typechecked).
    expect(frame.artifactUpdate?.artifact.artifactId).toBe('task-1-result')
    expect(frame.artifactUpdate?.lastChunk).toBe(true)
    expect(frame.artifactUpdate?.index).toBe(0)
  })

  it('omits contextId when the task has none (the field is optional in v1.0)', () => {
    const frame = factory.status({ id: 'task-2', status: TASK.status }, 'TASK_STATE_WORKING' as never)
    expect(frame.statusUpdate === undefined ? undefined : 'contextId' in frame.statusUpdate).toBe(false)
  })
})

describe('coalescer (D1: latest wins, terminal survives)', () => {
  it('emits the first item immediately, then only at most one per window', () => {
    let clock = 0
    const coalescer = createCoalescer<string>({ minIntervalMs: 200, now: () => clock })

    expect(coalescer.push('a')).toEqual(['a'])
    clock = 50
    expect(coalescer.push('b')).toEqual([])
    clock = 100
    expect(coalescer.push('c')).toEqual([])
    // Latest wins: the intermediate 'b' is dropped, not queued.
    expect(coalescer.pending()).toBe('c')
  })

  it('emits again once the window has elapsed, discarding the superseded pending item', () => {
    let clock = 0
    const coalescer = createCoalescer<string>({ minIntervalMs: 200, now: () => clock })
    expect(coalescer.push('a')).toEqual(['a'])
    clock = 50
    coalescer.push('b')
    clock = 250
    expect(coalescer.push('c')).toEqual(['c'])
    expect(coalescer.pending()).toBeUndefined()
  })

  it('flush always yields the pending item, which is how the terminal frame survives', () => {
    let clock = 0
    const coalescer = createCoalescer<string>({ minIntervalMs: 200, now: () => clock })
    coalescer.push('working')
    clock = 10
    coalescer.push('completed')
    expect(coalescer.flush()).toEqual(['completed'])
    // Second flush has nothing left.
    expect(coalescer.flush()).toEqual([])
  })

  it('minIntervalMs 0 disables coalescing entirely', () => {
    const coalescer = createCoalescer<string>({ minIntervalMs: 0, now: () => 0 })
    expect(coalescer.push('a')).toEqual(['a'])
    expect(coalescer.push('b')).toEqual(['b'])
    expect(coalescer.pending()).toBeUndefined()
  })

  it('treats a nonsensical interval as 0 rather than throwing', () => {
    const coalescer = createCoalescer<string>({ minIntervalMs: Number.NaN })
    expect(coalescer.push('a')).toEqual(['a'])
    expect(coalescer.push('b')).toEqual(['b'])
  })
})

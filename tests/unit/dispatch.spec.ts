/**
 * Inbound JSON-RPC dispatch — every branch of the method switch.
 *
 * These branches previously lived inside the plugin entry's `apply()`, which needs
 * a full Cordis context, so NONE of them could be reached from a test. That is how
 * `GetTask` shipped as a stub answering -32001 while the Agent Card implied a real
 * task state machine. The switch now lives in `src/inbound/dispatch.ts` and is
 * driven here with a fake executor.
 *
 * What is pinned:
 *   - the A2A response SHAPES (`SendMessage` → `{ task }`, `GetTask` → the Task),
 *   - the three-way distinction `CancelTask` needs (unknown / settled / …),
 *   - that an unimplemented method answers -32004 rather than looking like success,
 *   - that a legacy v0.3 method name gets a replacement hint instead of a bare 404.
 */

import { describe, expect, it } from 'vitest'

import {
  createDispatcher,
  type DispatchInput,
} from '../../src/inbound/dispatch.js'
import {
  MODEL_NOT_SELECTED_CODE,
  ModelNotSelectedError,
  TaskNotFoundError,
  type InboundExecutor,
} from '../../src/inbound/executor.js'
import {
  ERR_INTERNAL,
  ERR_INVALID_PARAMS,
  ERR_METHOD_NOT_FOUND,
  ERR_TASK_NOT_CANCELABLE,
  ERR_TASK_NOT_FOUND,
  ERR_UNSUPPORTED_OPERATION,
} from '../../src/protocol/jsonrpc.js'
import type { A2ATask } from '../../src/protocol/wire.js'

function makeTask(id: string, state = 'TASK_STATE_COMPLETED'): A2ATask {
  return {
    id,
    contextId: 'ctx-1',
    status: { state: state as A2ATask['status']['state'] },
  }
}

function input(method: string, params: unknown = {}): DispatchInput {
  return {
    operation: '',
    method,
    params,
    peer: 'peer-a',
    stream: false,
    signal: new AbortController().signal,
  }
}

function fakeExecutor(overrides: Partial<Record<'sendMessage' | 'getTask' | 'findTask' | 'sendStreamingMessage', unknown>>): InboundExecutor {
  return {
    sendMessage: async () => ({ task: makeTask('task-1') }),
    getTask: async (id: string) => makeTask(id),
    findTask: async () => undefined,
    ...overrides,
  } as unknown as InboundExecutor
}

/** The dispatcher's responses are plain JSON-RPC envelopes; read them loosely. */
type Envelope = { result?: unknown, error?: { code: number, message: string } }

describe('inbound dispatch', () => {
  it('answers an unknown method with METHOD_NOT_FOUND', async () => {
    const dispatch = createDispatcher(fakeExecutor({}))
    const reply = (await dispatch(input('NoSuchMethod'))) as Envelope
    expect(reply.error?.code).toBe(ERR_METHOD_NOT_FOUND)
  })

  it('points a legacy v0.3 method name at its v1.0 replacement', async () => {
    const dispatch = createDispatcher(fakeExecutor({}))
    const reply = (await dispatch(input('message/send'))) as Envelope
    expect(reply.error?.code).toBe(ERR_METHOD_NOT_FOUND)
    // The hint is the whole point: a bare 404 sends the caller hunting.
    expect(reply.error?.message).toContain('SendMessage')
  })

  it('SendMessage results in `{ task }` — the executor payload passed through', async () => {
    const dispatch = createDispatcher(fakeExecutor({}))
    const reply = (await dispatch(input('SendMessage'))) as Envelope
    const result = reply.result as { task?: A2ATask }
    expect(result.task?.id).toBe('task-1')
  })

  it('SendMessage maps a missing model to its own code, not generic bad-params', async () => {
    const dispatch = createDispatcher(fakeExecutor({
      sendMessage: async () => {
        throw new ModelNotSelectedError()
      },
    }))
    const reply = (await dispatch(input('SendMessage'))) as Envelope
    expect(reply.error?.code).toBe(MODEL_NOT_SELECTED_CODE)
  })

  it('SendMessage maps any other failure to INVALID_PARAMS', async () => {
    const dispatch = createDispatcher(fakeExecutor({
      sendMessage: async () => {
        throw new Error('bad payload')
      },
    }))
    const reply = (await dispatch(input('SendMessage'))) as Envelope
    expect(reply.error?.code).toBe(ERR_INVALID_PARAMS)
    expect(reply.error?.message).toBe('bad payload')
  })

  it('GetTask results in the Task ITSELF, not `{ task }`', async () => {
    const dispatch = createDispatcher(fakeExecutor({}))
    const reply = (await dispatch(input('GetTask', { id: 'task-9' }))) as Envelope
    const task = reply.result as A2ATask
    expect(task.id).toBe('task-9')
    expect(task.status.state).toBe('TASK_STATE_COMPLETED')
  })

  it('GetTask maps a missing task to TASK_NOT_FOUND', async () => {
    const dispatch = createDispatcher(fakeExecutor({
      getTask: async (id: string) => {
        throw new TaskNotFoundError(id)
      },
    }))
    const reply = (await dispatch(input('GetTask', { id: 'ghost' }))) as Envelope
    expect(reply.error?.code).toBe(ERR_TASK_NOT_FOUND)
  })

  it('GetTask keeps an unexpected store failure distinguishable from "not found"', async () => {
    const dispatch = createDispatcher(fakeExecutor({
      getTask: async () => {
        throw new Error('disk on fire')
      },
    }))
    const reply = (await dispatch(input('GetTask', { id: 'task-1' }))) as Envelope
    expect(reply.error?.code).toBe(ERR_INTERNAL)
  })

  it('CancelTask on a settled task says -32002 AND reports the state it found', async () => {
    const dispatch = createDispatcher(fakeExecutor({
      findTask: async () => makeTask('task-1', 'TASK_STATE_COMPLETED'),
    }))
    const reply = (await dispatch(input('CancelTask', { id: 'task-1' }))) as Envelope
    expect(reply.error?.code).toBe(ERR_TASK_NOT_CANCELABLE)
    // -32001 would claim the task is unknown; the state in the message proves it
    // was found. Conflating the two is the regression this test exists for.
    expect(reply.error?.message).toContain('TASK_STATE_COMPLETED')
  })

  it('CancelTask on an unknown task says -32001', async () => {
    const dispatch = createDispatcher(fakeExecutor({}))
    const reply = (await dispatch(input('CancelTask', { id: 'ghost' }))) as Envelope
    expect(reply.error?.code).toBe(ERR_TASK_NOT_FOUND)
  })

  it('SendStreamingMessage returns the executor generator once streaming is enabled', async () => {
    const dispatch = createDispatcher(fakeExecutor({
      sendStreamingMessage: async function* () {
        yield { task: { id: 'task-1' } }
      },
    }))
    const outcome = await dispatch(input('SendStreamingMessage'))
    // An async iterable, NOT a JSON-RPC envelope: the route turns it into SSE.
    const iterable = outcome as unknown as { [Symbol.asyncIterator]?: () => unknown }
    expect(typeof iterable[Symbol.asyncIterator]).toBe('function')
  })

  it('refuses with UNSUPPORTED_OPERATION when the executor has no generator', async () => {
    // The "declared supported but no handler is wired" branch: a peer must never
    // receive a plain JSON body while believing it asked for a stream.
    const dispatch = createDispatcher(fakeExecutor({}))
    const reply = (await dispatch(input('SendStreamingMessage'))) as Envelope
    expect(reply.error?.code).toBe(ERR_UNSUPPORTED_OPERATION)
    expect(reply.error?.message).toContain('streaming')
  })

  it('ListTasks answers an empty list rather than pretending to support it fully', async () => {
    const dispatch = createDispatcher(fakeExecutor({}))
    const reply = (await dispatch(input('ListTasks'))) as Envelope
    expect(reply.result).toEqual({ tasks: [] })
  })

  it('every remaining method answers UNSUPPORTED_OPERATION naming itself', async () => {
    const dispatch = createDispatcher(fakeExecutor({}))
    for (const method of [
      'SubscribeToTask',
      'GetExtendedAgentCard',
      'CreateTaskPushNotificationConfig',
      'GetTaskPushNotificationConfig',
      'ListTaskPushNotificationConfigs',
      'DeleteTaskPushNotificationConfig',
    ]) {
      const reply = (await dispatch(input(method))) as Envelope
      expect(reply.error?.code).toBe(ERR_UNSUPPORTED_OPERATION)
      expect(reply.error?.message).toContain(method)
    }
  })

  it('a non-string task id is treated as absent, never passed to the executor', async () => {
    let asked: string | undefined
    const dispatch = createDispatcher(fakeExecutor({
      getTask: async (id: string) => {
        asked = id
        throw new TaskNotFoundError(id)
      },
    }))
    const reply = (await dispatch(input('GetTask', { id: 42 }))) as Envelope
    expect(asked).toBe('')
    expect(reply.error?.code).toBe(ERR_TASK_NOT_FOUND)
  })
})

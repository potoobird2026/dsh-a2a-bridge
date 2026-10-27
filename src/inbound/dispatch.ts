/**
 * JSON-RPC method dispatch for the inbound side.
 *
 * WHY THIS IS ITS OWN MODULE: the dispatcher used to live inside the plugin
 * entry's `apply()`, which needs a full Cordis context (agents, tools,
 * credentials, web server, workspace registry, settings…). Nothing in the switch
 * was therefore reachable from a unit test — and the switch is exactly where the
 * task state machine lives (`GetTask` / `CancelTask`). A protocol surface with no
 * coverage is how `GetTask` stayed a stub that always answered -32001 while the
 * Agent Card implied a real task state machine.
 *
 * Pulling it out makes every branch drivable with a fake executor, and it keeps
 * `src/index.ts` to wiring.
 *
 * Layering: imports `constants`, `protocol/*`, and the executor's types/errors —
 * it owns no transport and no Cordis type.
 */

import { INBOUND_STREAMING_IMPLEMENTED } from '../constants.js'
import {
  ERR_INTERNAL,
  ERR_INVALID_PARAMS,
  ERR_TASK_NOT_CANCELABLE,
  ERR_TASK_NOT_FOUND,
  ERR_UNSUPPORTED_OPERATION,
  jsonRpcError,
  jsonRpcResult,
  methodNotFound,
} from '../protocol/jsonrpc.js'
import { legacyMethodReplacement, resolveMethod } from '../protocol/parse.js'
import {
  MODEL_NOT_SELECTED_CODE,
  ModelNotSelectedError,
  TaskNotFoundError,
  type InboundExecutor,
} from './executor.js'
import type { PeerIdentity } from '../types.js'

/**
 * The input the inbound routes hand to the dispatcher.
 *
 * Structurally identical to `InboundDeps['dispatch']`'s parameter in
 * `routes.ts`; kept as a named type so the two cannot drift without a compile
 * error at the assignment site.
 */
export interface DispatchInput {
  readonly operation: string
  readonly method: string
  readonly params: unknown
  readonly peer: PeerIdentity
  readonly stream: boolean
  readonly signal: AbortSignal
}

/**
 * Build the dispatcher for one executor.
 *
 * The executor is the only collaborator, so a test can pass a fake with three
 * methods and drive every branch below.
 */
export function createDispatcher(
  executor: InboundExecutor,
): (input: DispatchInput) => Promise<unknown> {
  return async function dispatch(input: DispatchInput): Promise<unknown> {
    const operation = resolveMethod(input.method)
    if (operation === undefined) {
      const replacement = legacyMethodReplacement(input.method)
      const error = methodNotFound(input.method, replacement)
      return jsonRpcError(null, error.code, error.message)
    }

    const params = (input.params ?? {}) as Record<string, unknown>

    switch (operation) {
      case 'send':
        try {
          return jsonRpcResult(null, await executor.sendMessage(input))
        } catch (error) {
          // A misconfigured model is a server-side fault, not bad params:
          // -32603 keeps it distinguishable from a caller's malformed request.
          if (error instanceof ModelNotSelectedError) {
            return jsonRpcError(null, MODEL_NOT_SELECTED_CODE, error.message)
          }
          return jsonRpcError(
            null,
            ERR_INVALID_PARAMS,
            error instanceof Error ? error.message : String(error),
          )
        }
      case 'get': {
        const taskId = typeof params.id === 'string' ? params.id : ''
        try {
          // A2A shape: GetTask's `result` IS the Task, not `{ task }`. Our own
          // outbound client reads `payload.result` as a task, so both halves of
          // this plugin agree on one shape.
          return jsonRpcResult(null, await executor.getTask(taskId))
        } catch (error) {
          if (error instanceof TaskNotFoundError) {
            return jsonRpcError(null, ERR_TASK_NOT_FOUND, `task not found: ${taskId}`)
          }
          return jsonRpcError(
            null,
            ERR_INTERNAL,
            error instanceof Error ? error.message : String(error),
          )
        }
      }
      case 'stream':
        // Driven by the SAME constant the card uses for capabilities.streaming, so the
        // advertisement and this branch cannot drift apart. When the constant is true
        // but the executor has no generator, the peer gets an explicit error rather
        // than a silent downgrade to a non-streaming reply.
        if (INBOUND_STREAMING_IMPLEMENTED && typeof executor.sendStreamingMessage === 'function') {
          return executor.sendStreamingMessage(input)
        }
        return jsonRpcError(
          null,
          ERR_UNSUPPORTED_OPERATION,
          INBOUND_STREAMING_IMPLEMENTED
            ? 'streaming is declared supported but no handler is wired'
            : 'streaming is not implemented yet',
        )
      case 'cancel': {
        const taskId = typeof params.id === 'string' ? params.id : ''
        const task = await executor.findTask(taskId)
        if (task === undefined) {
          return jsonRpcError(null, ERR_TASK_NOT_FOUND, `task not found: ${taskId}`)
        }
        // Every task this deployment keeps is already settled: SendMessage blocks
        // until the turn ends, so a stored task is terminal by definition. -32002
        // says exactly that instead of pretending the cancel worked.
        return jsonRpcError(
          null,
          ERR_TASK_NOT_CANCELABLE,
          `task ${taskId} has already settled (${task.status.state}); CancelTask only applies to a running task`,
        )
      }
      case 'list':
        return jsonRpcResult(null, { tasks: [] })
      case 'subscribe':
      case 'extended_card':
      case 'push_create':
      case 'push_get':
      case 'push_list':
      case 'push_delete':
        return jsonRpcError(null, ERR_UNSUPPORTED_OPERATION, `${input.method} is not implemented`)
      default:
        return jsonRpcError(null, ERR_UNSUPPORTED_OPERATION, 'unsupported operation')
    }
  }
}

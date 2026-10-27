/**
 * JSON-RPC 2.0 envelope construction and the A2A error vocabulary.
 *
 * Authoritative source: `specification/a2a.proto` + A2A spec §Error codes.
 *
 * Two ranges, and they are NOT interchangeable:
 *   - JSON-RPC reserved: -32700..-32603 (parse / invalid request / method /
 *     params / internal)
 *   - A2A reserved:      -32001..-32009
 *
 * `-32609` does NOT exist in A2A — the handoff document's mention of it is a
 * typo, disproved three independent ways (huangjuhua grep, openclaw PR #179380,
 * official spec error-code table).
 *
 * Layering rule: imports only `../constants.js` + `../types.js`.
 */

import { A2A_ERROR_DOMAIN, ERROR_INFO_TYPE } from '../constants.js'

// ── JSON-RPC 2.0 ───────────────────────────────────────────────────────────

export const ERR_PARSE = -32700
export const ERR_INVALID_REQUEST = -32600
export const ERR_METHOD_NOT_FOUND = -32601
export const ERR_INVALID_PARAMS = -32602
export const ERR_INTERNAL = -32603

// ── A2A reserved ───────────────────────────────────────────────────────────

export const ERR_TASK_NOT_FOUND = -32001
export const ERR_TASK_NOT_CANCELABLE = -32002
export const ERR_PUSH_NOT_SUPPORTED = -32003
export const ERR_UNSUPPORTED_OPERATION = -32004
export const ERR_CONTENT_TYPE_NOT_SUPPORTED = -32005
export const ERR_INVALID_AGENT_RESPONSE = -32006
export const ERR_EXTENDED_CARD_NOT_CONFIGURED = -32007
export const ERR_EXTENSION_SUPPORT_REQUIRED = -32008
/** VersionNotSupportedError — v1.0 only (v0.3 had no version negotiation). */
export const ERR_VERSION_NOT_SUPPORTED = -32009

export interface A2ARpcErrorShape {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

export interface A2AJsonRpcRequest {
  readonly jsonrpc: '2.0'
  readonly id?: string | number | null
  readonly method?: string
  readonly params?: unknown
}

export interface A2AJsonRpcResponse {
  readonly jsonrpc: '2.0'
  readonly id: string | number | null
  readonly result?: unknown
  readonly error?: A2ARpcErrorShape
}

/** Success envelope. */
export function jsonRpcResult(id: string | number | null, result: unknown): A2AJsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}

/** Error envelope. */
export function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): A2AJsonRpcResponse {
  const error: A2ARpcErrorShape = data === undefined ? { code, message } : { code, message, data }
  return { jsonrpc: '2.0', id, error }
}

// ── ErrorInfo details (google.rpc.ErrorInfo) ───────────────────────────────

/**
 * Build `error.data[]` details.
 *
 * A2A v1.0 attaches `google.rpc.ErrorInfo` to errors so a peer can react to a
 * machine-readable `reason` + `domain` rather than parsing prose.
 */
export function errorDetails(
  reason: string,
  metadata?: Readonly<Record<string, string>>,
): unknown[] {
  const detail: Record<string, unknown> = {
    '@type': ERROR_INFO_TYPE,
    reason,
    domain: A2A_ERROR_DOMAIN,
  }
  if (metadata !== undefined) detail.metadata = metadata
  return [detail]
}

/** VersionNotSupportedError with ErrorInfo details. */
export function versionNotSupported(requested: string, supported: string): A2ARpcErrorShape {
  return {
    code: ERR_VERSION_NOT_SUPPORTED,
    message: `unsupported A2A-Version: ${requested}; this interface serves ${supported}`,
    data: errorDetails('VERSION_NOT_SUPPORTED', { requested, supported }),
  }
}

export function taskNotFound(taskId: string): A2ARpcErrorShape {
  return {
    code: ERR_TASK_NOT_FOUND,
    message: `task not found: ${taskId}`,
    data: errorDetails('TASK_NOT_FOUND', { taskId }),
  }
}

// ── Envelope parsing ───────────────────────────────────────────────────────

export type JsonRpcParseResult =
  | { readonly ok: true; readonly request: A2AJsonRpcRequest }
  | {
      readonly ok: false
      readonly error: A2ARpcErrorShape
      readonly id: string | number | null
    }

/**
 * Parse a raw JSON-RPC body.
 *
 * Failures return an error SHAPE rather than throwing, so the caller can
 * decide the HTTP status while the body stays a valid JSON-RPC envelope.
 */
export function parseJsonRpc(raw: unknown): JsonRpcParseResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      id: null,
      error: { code: ERR_PARSE, message: 'invalid JSON-RPC request' },
    }
  }
  const candidate = raw as Record<string, unknown>
  if (candidate.jsonrpc !== '2.0') {
    return {
      ok: false,
      id: (candidate.id as string | number | null | undefined) ?? null,
      error: { code: ERR_INVALID_REQUEST, message: 'jsonrpc must be "2.0"' },
    }
  }
  const request: A2AJsonRpcRequest = {
    jsonrpc: '2.0',
    id: (candidate.id as string | number | null | undefined) ?? null,
    method: typeof candidate.method === 'string' ? candidate.method : undefined,
    params: candidate.params,
  }
  return { ok: true, request }
}

/** Reject a v0.3 method name, naming its v1.0 replacement in the message. */
export function methodNotFound(method: string, replacement?: string): A2ARpcErrorShape {
  return {
    code: ERR_METHOD_NOT_FOUND,
    message:
      replacement === undefined
        ? `method not found: ${method}`
        : `method not found: ${method}; this interface speaks A2A 1.0, which renamed it to ${replacement}`,
  }
}

export function invalidParams(message: string): A2ARpcErrorShape {
  return { code: ERR_INVALID_PARAMS, message }
}

/** Never leak internal detail (it can carry filesystem paths). */
export const INTERNAL_ERROR: A2ARpcErrorShape = { code: ERR_INTERNAL, message: 'internal error' }

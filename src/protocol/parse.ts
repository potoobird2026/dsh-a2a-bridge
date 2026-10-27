/**
 * Inbound parsing and validation for A2A v1.0.
 *
 * Authoritative source: `specification/a2a.proto` + A2A spec §3 (operations).
 *
 * The strictness here is deliberate. A v0.3 peer must be told, in a
 * machine-readable way, exactly what changed — never answered with a v1.0
 * payload it cannot parse, because that only moves the failure further from
 * its cause.
 *
 * Layering rule: imports only `node:内置` + `../constants.js` + `../types.js` +
 * `./wire.js`, plus the error VOCABULARY from `./jsonrpc.js` (error codes only —
 * that module imports constants and nothing else, so this adds no cycle and
 * keeps `-32602` spelled once in the codebase).
 */

import { A2A_PROTOCOL_VERSION } from '../constants.js'
import { ERR_INVALID_PARAMS } from './jsonrpc.js'
import type { A2AMessage, A2APart, MessageRole } from './wire.js'
import { isTaskState } from './wire.js'

// ── Method table ───────────────────────────────────────────────────────────

export type A2AOperation =
  | 'send'
  | 'stream'
  | 'get'
  | 'list'
  | 'cancel'
  | 'subscribe'
  | 'push_create'
  | 'push_get'
  | 'push_list'
  | 'push_delete'
  | 'extended_card'

/** v1.0 method names (PascalCase), as required by the spec. */
const METHODS: ReadonlyMap<string, A2AOperation> = new Map<string, A2AOperation>([
  ['SendMessage', 'send'],
  ['SendStreamingMessage', 'stream'],
  ['GetTask', 'get'],
  ['ListTasks', 'list'],
  ['CancelTask', 'cancel'],
  ['SubscribeToTask', 'subscribe'],
  ['CreateTaskPushNotificationConfig', 'push_create'],
  ['GetTaskPushNotificationConfig', 'push_get'],
  ['ListTaskPushNotificationConfigs', 'push_list'],
  ['DeleteTaskPushNotificationConfig', 'push_delete'],
  ['GetExtendedAgentCard', 'extended_card'],
])

/**
 * The v0.3 names, kept ONLY to explain their absence.
 *
 * A peer sending `message/send` gets `-32601` with the v1.0 replacement named
 * in the message. Answering the call would be worse: the reply would be v1.0
 * JSON a v0.3 client cannot read.
 */
const LEGACY_METHODS: ReadonlyMap<string, string> = new Map<string, string>([
  ['message/send', 'SendMessage'],
  ['message/stream', 'SendStreamingMessage'],
  ['tasks/get', 'GetTask'],
  ['tasks/cancel', 'CancelTask'],
  ['tasks/resubscribe', 'SubscribeToTask'],
  ['tasks/pushNotificationConfig/set', 'CreateTaskPushNotificationConfig'],
  ['tasks/pushNotificationConfig/get', 'GetTaskPushNotificationConfig'],
  ['tasks/pushNotificationConfig/list', 'ListTaskPushNotificationConfigs'],
  ['tasks/pushNotificationConfig/delete', 'DeleteTaskPushNotificationConfig'],
  ['tasks/pushNotification/set', 'CreateTaskPushNotificationConfig'],
  ['agent/getAuthenticatedExtendedCard', 'GetExtendedAgentCard'],
])

export function resolveMethod(method: string | undefined): A2AOperation | undefined {
  if (method === undefined) return undefined
  return METHODS.get(method)
}

export function legacyMethodReplacement(method: string | undefined): string | undefined {
  if (method === undefined) return undefined
  return LEGACY_METHODS.get(method)
}

export function isLegacyMethod(method: string | undefined): boolean {
  return method !== undefined && LEGACY_METHODS.has(method)
}

// ── Parameter validation ───────────────────────────────────────────────────

/**
 * Validate the task-reference parameter.
 *
 * v1.0 spells every task reference `id`. The v0.3 `taskId` is NOT accepted: a
 * peer still sending it would also be sending a v0.3 message body and
 * expecting a v0.3 reply, and a half-understood request is worse than a
 * refused one.
 */
export function requireTaskId(raw: unknown, paramName = 'id'): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new InvalidParamsError(`${paramName} is required`)
  }
  return raw
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class InvalidParamsError extends Error {
  readonly code = ERR_INVALID_PARAMS
}

// ── Part parsing ───────────────────────────────────────────────────────────

/**
 * Parse one Part.
 *
 * Returns `undefined` for shapes v1.0 does not define. Notably this drops a
 * v0.3 nested `file` part entirely — and a v0.3 `{kind:'text', text:'…'}`
 * part still parses, but only because v1.0 spells the `text` member the same
 * way. `kind` is ignored, not honored.
 */
export function parsePart(raw: unknown): A2APart | undefined {
  if (!isRecord(raw)) return undefined
  const part: A2APart = {
    metadata: isRecord(raw.metadata) ? raw.metadata : undefined,
  }

  if (typeof raw.text === 'string') return { ...part, text: raw.text }
  if (raw.data !== undefined) return { ...part, data: raw.data }
  if (typeof raw.url === 'string') {
    return {
      ...part,
      url: raw.url,
      filename: typeof raw.filename === 'string' ? raw.filename : undefined,
      mediaType: typeof raw.mediaType === 'string' ? raw.mediaType : undefined,
    }
  }
  if (raw.raw instanceof Uint8Array) {
    return {
      ...part,
      raw: raw.raw,
      filename: typeof raw.filename === 'string' ? raw.filename : undefined,
      mediaType: typeof raw.mediaType === 'string' ? raw.mediaType : undefined,
    }
  }
  return undefined
}

export function parseParts(raw: unknown): readonly A2APart[] {
  if (!Array.isArray(raw)) return []
  const out: A2APart[] = []
  for (const item of raw) {
    const part = parsePart(item)
    if (part !== undefined) out.push(part)
  }
  return out
}

/** Flatten parts into text, dropping structured/binary parts. */
export function partsToText(parts: readonly A2APart[]): string {
  const chunks: string[] = []
  for (const part of parts) {
    if (part.text !== undefined) chunks.push(part.text)
    else if (part.data !== undefined) chunks.push(JSON.stringify(part.data))
  }
  return chunks.join('\n')
}

// ── Message parsing ────────────────────────────────────────────────────────

const ROLE_BY_NAME: Readonly<Record<string, MessageRole>> = {
  ROLE_UNSPECIFIED: 'ROLE_UNSPECIFIED',
  ROLE_USER: 'ROLE_USER',
  ROLE_AGENT: 'ROLE_AGENT',
}

export function parseRole(raw: unknown): MessageRole {
  if (typeof raw === 'string') {
    const role = ROLE_BY_NAME[raw]
    if (role !== undefined) return role
  }
  // ProtoJSON also permits the numeric enum. Unknown -> unspecified.
  return 'ROLE_UNSPECIFIED'
}

export interface ParsedMessage {
  readonly messageId: string
  readonly role: MessageRole
  readonly parts: readonly A2APart[]
  readonly contextId?: string
  readonly taskId?: string
}

export function parseMessage(raw: unknown): ParsedMessage | undefined {
  if (!isRecord(raw)) return undefined
  if (typeof raw.messageId !== 'string' || raw.messageId.length === 0) return undefined
  return {
    messageId: raw.messageId,
    role: parseRole(raw.role),
    parts: parseParts(raw.parts),
    contextId: typeof raw.contextId === 'string' ? raw.contextId : undefined,
    taskId: typeof raw.taskId === 'string' ? raw.taskId : undefined,
  }
}

// ── Task / status parsing ──────────────────────────────────────────────────

export function parseTaskStatus(raw: unknown): { state: string; message?: A2AMessage } | undefined {
  if (!isRecord(raw)) return undefined
  const state = typeof raw.state === 'string' ? raw.state : undefined
  if (state === undefined || !isTaskState(state)) return undefined
  return {
    state,
    message: parseMessage(raw.message),
  }
}

// ── Version negotiation ────────────────────────────────────────────────────

/**
 * Validate the `A2A-Version` request header.
 *
 * Spec §3.6.2 says an EMPTY header means 0.3 — a MUST-level rule. The spec is
 * explicit, so an absent header is rejected with `-32009` rather than silently
 * served as 1.0.
 *
 * `strict: false` opts into the deployment-policy reading (treat absent as
 * 1.0), which huangjuhua-aigc/dsh-a2a chooses. It exists because a peer that
 * has just discovered this interface by its card has already committed to 1.0,
 * and answering a v0.3 request only moves the failure further from its cause.
 */
export function versionIsAcceptable(
  header: string | undefined,
  strict: boolean,
): { ok: true; requested?: string } | { ok: false; requested: string } {
  const trimmed = header?.trim()
  if (trimmed === undefined || trimmed.length === 0) {
    return strict ? { ok: false, requested: '' } : { ok: true }
  }
  if (trimmed === A2A_PROTOCOL_VERSION || trimmed === '1.0.0') {
    return { ok: true, requested: trimmed }
  }
  return { ok: false, requested: trimmed }
}

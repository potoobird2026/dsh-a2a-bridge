/**
 * A2A v1.0 wire types.
 *
 * Authoritative source: `specification/a2a.proto` (A2A spec §1.4 — the single
 * normative definition). JSON Schema is a build artifact, NOT normative, and
 * neither are any SDK's TS types.
 *
 * Layering rule: this file imports nothing but `../constants.js` and
 * `../types.js`. It is the vocabulary every other layer speaks.
 *
 * v0.3 vs v1.0 — the changes that matter here:
 *   - `kind` discriminators are GONE. Enums became ProtoJSON spellings
 *     (`working` → `TASK_STATE_WORKING`, `user` → `ROLE_USER`).
 *   - `Part` collapsed into one unified message (no `{kind:'text', text}`).
 *   - `SendMessage` returns `{ task: … }`, not a bare Task.
 *   - Task references are `id`, never `taskId`.
 *   - Card discovery moved from `url`+`preferredTransport` to
 *     `supportedInterfaces[]`; security schemes moved inside
 *     `httpAuthSecurityScheme`; `security` became `securityRequirements`.
 */

import { A2A_PROTOCOL_VERSION, JSONRPC_BINDING } from '../constants.js'

// ── Task state ─────────────────────────────────────────────────────────────

/**
 * The nine A2A v1.0 task states, in ProtoJSON spelling.
 *
 * Do not restate this list elsewhere — `src/types.ts` owns the terminal
 * subset so the two sides cannot drift.
 */
export const TASK_STATES = Object.freeze([
  'TASK_STATE_UNSPECIFIED',
  'TASK_STATE_SUBMITTED',
  'TASK_STATE_WORKING',
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_AUTH_REQUIRED',
  'TASK_STATE_COMPLETED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_FAILED',
  'TASK_STATE_REJECTED',
] as const)

export type TaskState = (typeof TASK_STATES)[number]

export function isTaskState(value: unknown): value is TaskState {
  return typeof value === 'string' && (TASK_STATES as readonly string[]).includes(value)
}

// ── Message role ───────────────────────────────────────────────────────────

export const MESSAGE_ROLES = Object.freeze(['ROLE_UNSPECIFIED', 'ROLE_USER', 'ROLE_AGENT'] as const)

export type MessageRole = (typeof MESSAGE_ROLES)[number]

// ── Part ───────────────────────────────────────────────────────────────────

/**
 * A2A v1.0 Part — a single unified message, NOT a `kind`-tagged union.
 *
 * The members that can appear:
 *   `text`        — text content
 *   `data`        — structured content
 *   `url`         — a file reference (flattened from v0.3's nested `file`)
 *   `raw`         — inline binary
 *   `filename` / `mediaType` — file metadata
 *
 * A v0.3 `{kind:'file', file:{...}}` part is NOT recognizable and must be
 * dropped. A v0.3 `{kind:'text', text:'…'}` part still parses, but only
 * because v1.0 spells the `text` member the same way — `kind` is ignored,
 * not honored.
 */
export interface A2APart {
  readonly text?: string
  readonly data?: unknown
  readonly url?: string
  readonly raw?: Uint8Array
  readonly filename?: string
  readonly mediaType?: string
  readonly metadata?: Record<string, unknown>
}

// ── Message ────────────────────────────────────────────────────────────────

export interface A2AMessage {
  readonly messageId: string
  readonly role: MessageRole
  readonly parts: readonly A2APart[]
  readonly taskId?: string
  readonly contextId?: string
  readonly extensions?: readonly unknown[]
  readonly referenceTaskIds?: readonly string[]
  readonly metadata?: Record<string, unknown>
}

// ── Task status / artifacts / task ─────────────────────────────────────────

export interface A2ATaskStatus {
  readonly state: TaskState
  readonly message?: A2AMessage
  readonly timestamp?: string
}

export interface A2AArtifact {
  readonly artifactId: string
  readonly name?: string
  readonly description?: string
  readonly parts: readonly A2APart[]
  readonly metadata?: Record<string, unknown>
}

export interface A2ATask {
  readonly id: string
  readonly contextId?: string
  readonly status: A2ATaskStatus
  readonly artifacts?: readonly A2AArtifact[]
  readonly history?: readonly A2AMessage[]
  readonly metadata?: Record<string, unknown>
}

// ── Streaming events ───────────────────────────────────────────────────────

/**
 * Stream payloads. Each frame carries exactly ONE of these under `result`.
 *
 * v1.0 dropped the `final` flag: **closing the stream IS the terminal signal**.
 * Every frame's `result` object has exactly one key, drawn from this list.
 */
export const STREAM_KEYS = Object.freeze(['task', 'message', 'statusUpdate', 'artifactUpdate'] as const)

export type StreamKey = (typeof STREAM_KEYS)[number]

export interface A2AArtifactUpdate {
  readonly taskId: string
  readonly contextId?: string
  readonly artifact: A2AArtifact
  readonly index: number
  readonly lastChunk: boolean
  readonly append?: boolean
}

export interface A2AStatusUpdate {
  readonly taskId: string
  readonly contextId?: string
  readonly status: A2ATaskStatus
}

export interface A2AStreamResponse {
  readonly task?: A2ATask
  readonly message?: A2AMessage
  readonly statusUpdate?: A2AStatusUpdate
  readonly artifactUpdate?: A2AArtifactUpdate
}

export function streamKeyOf(response: A2AStreamResponse): StreamKey | undefined {
  for (const key of STREAM_KEYS) {
    if (response[key] !== undefined) return key
  }
  return undefined
}

// ── Agent Card ─────────────────────────────────────────────────────────────

export interface A2AAgentSkill {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly tags: readonly string[]
}

/**
 * v1.0 interface entry. Replaces v0.3's `url` + `preferredTransport` on the
 * card itself — each interface carries its own `protocolVersion` and `tenant`.
 */
export interface A2AAgentInterface {
  readonly url: string
  readonly protocolBinding: string
  readonly protocolVersion: string
  readonly tenant?: string
}

export interface A2AAgentCapabilities {
  readonly streaming: boolean
  readonly pushNotifications: boolean
  readonly extendedAgentCard: boolean
}

export interface A2AAgentProvider {
  readonly organization: string
  readonly url: string
}

/**
 * v1.0 security scheme: the type-named member (`httpAuthSecurityScheme`)
 * wraps the scheme object. v0.3's bare `securitySchemes.bearer` is gone.
 */
export interface A2ASecuritySchemeEntry {
  readonly httpAuthSecurityScheme?: {
    readonly scheme: string
    readonly description?: string
    readonly bearerFormat?: string
  }
}

export interface A2ASecurityRequirements {
  readonly schemes: Readonly<Record<string, { readonly list?: readonly string[] }>>
}

export interface A2AAgentCard {
  readonly name: string
  readonly description: string
  readonly version: string
  readonly supportedInterfaces: readonly A2AAgentInterface[]
  readonly capabilities: A2AAgentCapabilities
  readonly defaultInputModes: readonly string[]
  readonly defaultOutputModes: readonly string[]
  readonly skills: readonly A2AAgentSkill[]
  readonly provider?: A2AAgentProvider
  readonly securitySchemes?: Readonly<Record<string, A2ASecuritySchemeEntry>>
  readonly securityRequirements?: readonly A2ASecurityRequirements[]
  readonly documentationUrl?: string
  readonly signatures?: readonly unknown[]
}

/** The interface this bridge advertises by default. */
export function defaultInterface(url: string): A2AAgentInterface {
  return { url, protocolBinding: JSONRPC_BINDING, protocolVersion: A2A_PROTOCOL_VERSION }
}

// ── Request / response envelopes ───────────────────────────────────────────

export interface A2ASendMessageConfiguration {
  readonly returnImmediately?: boolean
  readonly acceptedOutputModes?: readonly string[]
  readonly historyLength?: number
  readonly taskPushNotificationConfig?: unknown
}

export interface A2ASendMessageRequest {
  readonly message: A2AMessage
  readonly configuration?: A2ASendMessageConfiguration
  readonly metadata?: Record<string, unknown>
}

export interface A2ASendMessageResponse {
  readonly task?: A2ATask
  readonly message?: A2AMessage
}

export interface A2AGetTaskRequest {
  readonly id: string
  readonly historyLength?: number
}

export interface A2AListTasksRequest {
  readonly contextId?: string
  readonly status?: TaskState
  readonly pageSize?: number
  readonly pageToken?: string
  readonly historyLength?: number
  readonly statusTimestampAfter?: string
  readonly includeArtifacts?: boolean
}

export interface A2AListTasksResponse {
  readonly tasks: readonly A2ATask[]
  readonly nextPageToken?: string
  readonly pageSize?: number
  readonly totalSize?: number
}

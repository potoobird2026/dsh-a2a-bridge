/**
 * Outbound client — our agent → remote peers.
 *
 * Two non-obvious requirements, both from real implementations:
 *
 * 1. Requests MUST carry `a2a-version: 1.0`. Without it the server applies
 *    its own default (some treat absent as 1.0, some as 0.3), and the failure
 *    then surfaces far from its cause.
 * 2. The SSE reader MUST be chunk-safe. DSH's streaming decoder is not, so a
 *    reply containing CJK or emoji can be split mid-codepoint and leave a lone
 *    surrogate — invisible on a terminal, but it produces syntactically valid
 *    JSON that a Go/Rust/Python peer cannot re-encode.
 *
 * Layering rule: may import protocol + security + constants/types.
 */

import {
  A2A_PROTOCOL_VERSION,
  A2A_VERSION_HEADER,
  BEARER_PREFIX,
  CONTENT_TYPE_JSON,
  DEFAULT_CALL_TIMEOUT_MS,
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  REMOTE_POLL_INTERVAL_MS,
} from '../constants.js'
import { sanitizeOutbound } from '../security/index.js'
import { SseFrameDecoder, parseFrameJson } from '../protocol/sse.js'
import { partsToText } from '../protocol/parse.js'
import { parseAgentCard, AgentCardError } from '../protocol/card.js'
import type { A2AAgentCard, A2APart, A2AStreamResponse, A2ATask, TaskState } from '../protocol/wire.js'
import { isTerminalTaskState } from '../types.js'
import { randomUUID } from 'node:crypto'

// ── Card discovery ──────────────────────────────────────────────────────────

export interface DiscoveredContact {
  readonly card: A2AAgentCard
  readonly url: string
  readonly agentCardPath: string
  readonly warnings: readonly string[]
}

/**
 * Fetch and parse a remote Agent Card.
 *
 * The card path is stripped if the caller supplied a full well-known URL,
 * because we append it ourselves — otherwise we would request
 * `…/.well-known/agent-card.json/.well-known/agent-card.json`.
 */
export async function discoverCard(
  baseUrl: string,
  agentCardPath: string,
  headers: Readonly<Record<string, string>> = {},
  timeoutMs: number = DEFAULT_DISCOVERY_TIMEOUT_MS,
): Promise<DiscoveredContact> {
  const root = stripCardPath(baseUrl)
  const cardUrl = joinUrl(root, agentCardPath)

  const response = await fetchWithTimeout(cardUrl, {
    headers: { accept: CONTENT_TYPE_JSON, ...headers },
    redirect: 'follow',
  }, timeoutMs)

  if (!response.ok) {
    throw new AgentCardError(`agent card request failed: HTTP ${response.status}`)
  }

  let raw: unknown
  try {
    raw = await response.json()
  } catch (error) {
    throw new AgentCardError(`agent card is not valid JSON: ${String(error)}`)
  }

  const parsed = parseAgentCard(raw, agentCardPath)
  // The card's own interface URL is the authoritative RPC endpoint: it may
  // carry a path prefix (e.g. `/a2a`) that the base URL we dialed does not.
  // Falling back to the stripped root would post to the wrong path and get a
  // 404 — which looks like "the server is up but broken" rather than
  // "the client used the wrong URL".
  const endpoint = parsed.selectedInterface.url.length > 0 ? parsed.selectedInterface.url : root
  return { ...parsed, url: endpoint, agentCardPath }
}

export function stripCardPath(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  const cardPath = '/.well-known/agent-card.json'
  if (trimmed.endsWith(cardPath)) return trimmed.slice(0, -cardPath.length)
  const legacy = '/.well-known/agent.json'
  if (trimmed.endsWith(legacy)) return trimmed.slice(0, -legacy.length)
  const wellKnown = trimmed.indexOf('/.well-known/')
  if (wellKnown >= 0) return trimmed.slice(0, wellKnown)
  return trimmed
}

export function joinUrl(root: string, path: string): string {
  if (!path.startsWith('/')) return `${root}/${path}`
  return `${root}${path}`
}

// ── SendMessage ─────────────────────────────────────────────────────────────

export interface SendMessageInput {
  readonly text: string
  readonly contextId?: string
  readonly messageId?: string
}

export interface SendOptions {
  readonly token?: string
  readonly timeoutMs?: number
  readonly onStreamFrame?: (frame: unknown) => void
}

export interface SendResult {
  readonly task?: A2ATask
  readonly text: string
  readonly terminatedEarly: boolean
}

function authHeaders(token: string | undefined): Record<string, string> {
  return token === undefined || token.length === 0 ? {} : { authorization: `${BEARER_PREFIX}${token}` }
}

/**
 * Send a message and wait for the task to settle.
 *
 * `returnImmediately: false` asks the server to block. A server may still
 * return a non-terminal task, so we poll `GetTask` until a terminal state.
 */
export async function sendMessage(
  contact: DiscoveredContact,
  input: SendMessageInput,
  options: SendOptions = {},
): Promise<SendResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
  const headers: Record<string, string> = {
    'content-type': CONTENT_TYPE_JSON,
    [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION,
    ...authHeaders(options.token),
  }

  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'SendMessage',
    params: {
      message: {
        messageId: input.messageId ?? randomUUID(),
        role: 'ROLE_USER',
        parts: [{ text: input.text } satisfies A2APart],
        ...(input.contextId !== undefined ? { contextId: input.contextId } : {}),
      },
      configuration: { returnImmediately: false, acceptedOutputModes: ['text/plain'] },
    },
  }

  const response = await fetchWithTimeout(contact.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }, timeoutMs)

  if (!response.ok) {
    throw new Error(`SendMessage failed: HTTP ${response.status}`)
  }

  const payload = (await response.json()) as Record<string, unknown>
  const result = payload.result as Record<string, unknown> | undefined
  const error = payload.error as Record<string, unknown> | undefined
  if (error !== undefined) {
    throw new Error(`SendMessage error ${String(error.code)}: ${String(error.message)}`)
  }

  const task = result?.task as A2ATask | undefined
  const message = result?.message as { parts?: readonly A2APart[] } | undefined
  if (task === undefined && message !== undefined) {
    return { text: sanitizeOutbound(partsToText(message.parts ?? [])), terminatedEarly: false }
  }
  if (task === undefined) {
    throw new Error('SendMessage response carried neither task nor message')
  }

  if (isTerminalTaskState(task.status?.state)) {
    return { task, text: sanitizeOutbound(partsToText(task.artifacts?.[0]?.parts ?? [])), terminatedEarly: false }
  }

  return pollUntilTerminal(contact, task.id, options, timeoutMs)
}

async function pollUntilTerminal(
  contact: DiscoveredContact,
  taskId: string,
  options: SendOptions,
  timeoutMs: number,
): Promise<SendResult> {
  const deadline = Date.now() + timeoutMs
  const headers: Record<string, string> = {
    'content-type': CONTENT_TYPE_JSON,
    [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION,
    ...authHeaders(options.token),
  }

  let current: A2ATask | undefined
  while (Date.now() < deadline) {
    await sleep(REMOTE_POLL_INTERVAL_MS)
    const response = await fetchWithTimeout(contact.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: taskId } }),
    }, timeoutMs)
    if (!response.ok) throw new Error(`GetTask failed: HTTP ${response.status}`)
    const payload = (await response.json()) as Record<string, unknown>
    current = payload.result as A2ATask | undefined
    if (current === undefined) throw new Error(`GetTask returned no task for ${taskId}`)
    if (isTerminalTaskState(current.status?.state)) {
      return {
        task: current,
        text: sanitizeOutbound(partsToText(current.artifacts?.[0]?.parts ?? [])),
        terminatedEarly: false,
      }
    }
  }
  return { task: current, text: '', terminatedEarly: true }
}

// ── Streaming ──────────────────────────────────────────────────────────────

/**
 * Open a streaming request and surface every frame.
 *
 * Frames are decoded by `SseFrameDecoder`, which holds incomplete UTF-8
 * sequences across chunks via `TextDecoder(stream: true)`.
 */
export interface StreamMessageResult {
  /** Final reply text: the artifact if one arrived, else the terminal status text. */
  readonly text: string
  /** Last state seen, so a caller can tell "completed" from "failed". */
  readonly state?: TaskState
}

export async function streamMessage(
  contact: DiscoveredContact,
  input: SendMessageInput,
  options: SendOptions = {},
): Promise<StreamMessageResult> {
  const headers: Record<string, string> = {
    'content-type': CONTENT_TYPE_JSON,
    [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION,
    ...authHeaders(options.token),
  }
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'SendStreamingMessage',
    params: {
      message: {
        messageId: input.messageId ?? randomUUID(),
        role: 'ROLE_USER',
        parts: [{ text: input.text }],
        ...(input.contextId !== undefined ? { contextId: input.contextId } : {}),
      },
    },
  }

  // `timeoutMs` must cover the WHOLE stream, not just the handshake: a peer that
  // opens a stream and then stalls would otherwise hang the delegation forever.
  const timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
  const response = await fetchWithTimeout(contact.url, { method: 'POST', headers, body: JSON.stringify(body) }, timeoutMs)
  if (!response.ok) throw new Error(`SendStreamingMessage failed: HTTP ${response.status}`)
  if (response.body === null) throw new Error('streaming response had no body')

  const decoder = new SseFrameDecoder()
  const reader = response.body.getReader()
  let text = ''
  let state: TaskState | undefined

  /**
   * Progress frames carry human labels, so their text must NOT be mistaken for the
   * reply: only an artifact, or the message on a TERMINAL status, becomes `text`.
   */
  const handle = (frame: A2AStreamResponse): void => {
    options.onStreamFrame?.(frame)
    const update = frame.statusUpdate
    if (update?.status?.state !== undefined) {
      state = update.status.state
      const messageText = update.status.message === undefined ? '' : partsToText(update.status.message.parts)
      if (messageText.length > 0 && isTerminalTaskState(update.status.state)) text = messageText
    }
    const artifact = frame.artifactUpdate?.artifact
    if (artifact !== undefined) {
      const artifactText = partsToText(artifact.parts)
      if (artifactText.length > 0) text = artifactText
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      for (const data of decoder.push(value)) {
        const frame = parseFrameJson(data)
        if (frame !== undefined) handle(frame as A2AStreamResponse)
      }
    }
    for (const data of decoder.flush()) {
      const frame = parseFrameJson(data)
      if (frame !== undefined) handle(frame as A2AStreamResponse)
    }
  } finally {
    reader.releaseLock()
  }

  return { text, state }
}

// ── Plumbing ───────────────────────────────────────────────────────────────

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export { AgentCardError }

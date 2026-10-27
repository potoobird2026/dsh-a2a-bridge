/**
 * Inbound routing — remote peers → our agent.
 *
 * TRANSPORT DECISION (ADR-011): the A2A endpoint is served by a listener this
 * plugin creates, NOT by `ctx.webServer`.
 *
 * Why: the Desktop shell pins webServer to 127.0.0.1 —
 *   `function desktopWebServerHost(_exposure) { return "127.0.0.1" }`
 * with a hard assertion that throws if the bound host differs, and
 * `networkExposure: 'lan'` only opens an HTTPS edge for the browser GUI while
 * the upstream HTTP origin stays loopback. Serving on webServer would make the
 * endpoint unreachable from the other machine, and the symptom ("connection
 * refused") looks like a firewall problem.
 *
 * So this module knows nothing about webServer or Cordis. It talks to a tiny
 * `RouteHost` interface, which both our own listener (src/inbound/server.ts)
 * and tests can implement.
 *
 * Layering rule: may import protocol + security + constants/types.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  AGENT_CARD_PATH,
  CARD_ALLOWED_METHOD,
  CONTENT_TYPE_JSON,
  HTTP_BAD_REQUEST,
  HTTP_FORBIDDEN,
  HTTP_METHOD_NOT_ALLOWED,
  HTTP_OK,
  HTTP_PAYLOAD_TOO_LARGE,
  HTTP_TOO_MANY_REQUESTS,
  HTTP_UNAUTHORIZED,
  LEGACY_AGENT_CARD_PATH,
  RPC_ALLOWED_METHOD,
  TRANSPORT_ERROR_CODE,
  WWW_AUTHENTICATE,
} from '../constants.js'
import { bearerFrom, identifyPeer, type RateLimiter } from '../security/index.js'
import { pipeSseStream } from './sse-response.js'
import type { A2AAgentCard, A2AStreamResponse } from '../protocol/wire.js'
import {
  ERR_INTERNAL,
  ERR_INVALID_PARAMS,
  ERR_PARSE,
  jsonRpcError,
  parseJsonRpc,
  versionNotSupported,
} from '../protocol/jsonrpc.js'
import { resolveMethod, versionIsAcceptable } from '../protocol/parse.js'
import type { PeerIdentity } from '../types.js'

// ── Transport-neutral route contract ──────────────────────────────────────

export interface WebRouteLike {
  readonly kind: 'exact' | 'prefix'
  readonly path: string
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** Anything that can accept named routes and hand back a disposer. */
export interface RouteHost {
  register(route: WebRouteLike): () => void
}

export interface InboundDeps {
  readonly cardFor: (hostHeader: string | undefined) => A2AAgentCard
  readonly dispatch: (input: {
    /** The method exactly as received; `dispatch` re-normalizes it via `resolveMethod`. */
    readonly operation: string
    readonly method: string
    readonly params: unknown
    readonly peer: PeerIdentity
    /** True when the received method is `SendStreamingMessage`. */
    readonly stream: boolean
    readonly signal: AbortSignal
  }) => Promise<unknown> | AsyncGenerator<unknown, void, unknown> | undefined
  /** Resolve every peer's secret. Called per request — never cached. */
  readonly resolvePeerSecrets: () => Promise<ReadonlyMap<string, string>>
  /** Empty means "every authenticated peer is trusted". */
  readonly trustedPeers: readonly string[]
  readonly maxBodyBytes: number
  readonly strictVersionHeader: boolean
  readonly rateLimiter: RateLimiter
  /** The reserved identity that bypasses rate limits (the local owner). */
  readonly ownerIdentity?: string
}

export interface RouteRegistration {
  readonly dispose: () => void
}

// ── HTTP helpers ───────────────────────────────────────────────────────────

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': CONTENT_TYPE_JSON,
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

export class PayloadTooLargeError extends Error {}
export class InvalidTaskIdError extends Error {}

/** An AbortSignal that fires when the client disconnects. */
function abortSignalFor(req: IncomingMessage): AbortSignal {
  const controller = new AbortController()
  req.once('close', () => controller.abort())
  return controller.signal
}

/** Read a request body, enforcing the configured byte ceiling. */
export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buf.length
    if (total > limit) throw new PayloadTooLargeError()
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

/** 401 that advertises the scheme the peer should have used. */
export function sendUnauthorized(res: ServerResponse): void {
  res.setHeader(WWW_AUTHENTICATE, 'Bearer')
  sendJson(res, HTTP_UNAUTHORIZED, jsonRpcError(null, TRANSPORT_ERROR_CODE, 'unauthorized'))
}

/**
 * Transport-security failures answer with an HTTP status whose body is STILL a
 * valid JSON-RPC envelope (ADR-005), so a client that parses only the body and
 * one that reads only the status are both served.
 */
function sendTransportFailure(res: ServerResponse, status: number, message: string): void {
  if (status === HTTP_UNAUTHORIZED) {
    sendUnauthorized(res)
    return
  }
  sendJson(res, status, jsonRpcError(null, TRANSPORT_ERROR_CODE, message))
}

/** Never leak internal detail: it can carry filesystem paths. */
export function sendInternalError(res: ServerResponse, id: string | number | null): void {
  sendJson(res, HTTP_OK, jsonRpcError(id, ERR_INTERNAL, 'internal error'))
}

// ── Handlers ───────────────────────────────────────────────────────────────

/**
 * Serve the Agent Card.
 *
 * Public by design: discovery requires an anonymous read. A deployment that
 * serves only known internal peers closes it with `card.public = false`.
 */
export function makeCardHandler(deps: InboundDeps): WebRouteLike['handler'] {
  return (req, res) => {
    if (req.method !== CARD_ALLOWED_METHOD) {
      res.setHeader('allow', CARD_ALLOWED_METHOD)
      sendJson(res, HTTP_METHOD_NOT_ALLOWED, { error: 'method not allowed' })
      return
    }
    sendJson(res, HTTP_OK, deps.cardFor(req.headers.host))
  }
}

/**
 * Serve the JSON-RPC endpoint.
 *
 * The order is deliberate (mirrors a working implementation): method → auth →
 * rate limit → trust gate → version → body → parse → params → dispatch.
 * Reordering changes what an unauthenticated caller can learn.
 */
export function makeRpcHandler(deps: InboundDeps): WebRouteLike['handler'] {
  return async (req, res) => {
    if (req.method !== RPC_ALLOWED_METHOD) {
      res.setHeader('allow', RPC_ALLOWED_METHOD)
      sendJson(res, HTTP_METHOD_NOT_ALLOWED, { error: 'method not allowed' })
      return
    }

    // 1. Authentication. Every candidate is compared (constant time, no early
    //    exit) by identifyPeer, so timing reveals neither which peer matched
    //    nor how many are declared.
    const token = bearerFrom(req.headers.authorization)
    const secrets = await deps.resolvePeerSecrets()
    const peer = identifyPeer(token, secrets)
    if (peer === undefined) {
      sendTransportFailure(res, HTTP_UNAUTHORIZED, 'unauthorized')
      return
    }

    const isOwner = deps.ownerIdentity !== undefined && peer === deps.ownerIdentity

    // 2. Rate limit — per identity, fixed window. The owner is exempt so a
    //    local console can never lock itself out.
    if (!isOwner && !deps.rateLimiter.allow(peer)) {
      sendTransportFailure(res, HTTP_TOO_MANY_REQUESTS, 'rate limit exceeded')
      return
    }

    // 3. Trust gate: an authenticated peer may still not be allowed in.
    if (deps.trustedPeers.length > 0 && !isOwner && !deps.trustedPeers.includes(peer)) {
      sendTransportFailure(res, HTTP_FORBIDDEN, 'peer is not trusted')
      return
    }

    // 4. Version negotiation. An explicit non-1.0 version is refused with the
    //    spec's own VersionNotSupportedError rather than a reply in a spelling
    //    the caller cannot parse.
    const versionHeader = req.headers['a2a-version']
    const version = versionIsAcceptable(
      typeof versionHeader === 'string' ? versionHeader : undefined,
      deps.strictVersionHeader,
    )
    if (!version.ok) {
      const shape = versionNotSupported(version.requested, '1.0')
      sendJson(res, HTTP_OK, jsonRpcError(null, shape.code, shape.message, shape.data))
      return
    }

    // 5. Body, with a hard byte ceiling.
    let raw: Buffer
    try {
      raw = await readBody(req, deps.maxBodyBytes)
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        sendJson(res, HTTP_PAYLOAD_TOO_LARGE, jsonRpcError(null, ERR_PARSE, 'payload too large'))
        return
      }
      sendInternalError(res, null)
      return
    }

    // CRITICAL: `readBody` yields a Buffer. A naive `body.params ?? {}` on a
    // Buffer silently yields `{}` because Buffer has no `.params` property, and
    // every request then fails with a baffling "messageId is required".
    // Decode to text and parse explicitly.
    const text = raw.toString('utf8')
    let parsed: unknown
    try {
      parsed = text.length === 0 ? undefined : JSON.parse(text)
    } catch {
      sendJson(res, HTTP_BAD_REQUEST, jsonRpcError(null, ERR_PARSE, 'parse error'))
      return
    }

    // 6. Envelope.
    const envelope = parseJsonRpc(parsed)
    if (!envelope.ok) {
      sendJson(res, HTTP_BAD_REQUEST, jsonRpcError(envelope.id, envelope.error.code, envelope.error.message))
      return
    }

    const { request } = envelope
    const requestId = request.id ?? null
    const params = request.params

    if (params !== undefined && (typeof params !== 'object' || Array.isArray(params))) {
      sendJson(res, HTTP_OK, jsonRpcError(requestId, ERR_INVALID_PARAMS, 'params must be an object'))
      return
    }

    // 7. Dispatch.
    const signal = abortSignalFor(req)
    // `stream` must be truthful: claiming "not streaming" on a streaming request is
    // the kind of small lie that invites a wrong assumption later. `operation` keeps
    // its existing value — the method exactly as received — because `dispatch`
    // re-normalizes it and callers already rely on that shape.
    const resolvedOperation = resolveMethod(request.method ?? '')
    let outcome: unknown
    try {
      outcome = await deps.dispatch({
        operation: request.method ?? '',
        method: request.method ?? '',
        params: params ?? {},
        peer,
        stream: resolvedOperation === 'stream',
        signal,
      })
    } catch (error) {
      if (error instanceof InvalidTaskIdError) {
        sendJson(res, HTTP_OK, jsonRpcError(requestId, ERR_INVALID_PARAMS, error.message))
        return
      }
      sendInternalError(res, requestId)
      return
    }

    // A streaming method answers with SSE instead of a JSON envelope. The
    // dispatcher signals it by RETURNING an async iterable — no plain object can
    // be mistaken for one, so the non-streaming path below is unchanged.
    if (isAsyncIterable(outcome)) {
      await pipeSseStream(res, outcome, { requestId, signal })
      return
    }

    // JSON-RPC requires the response `id` to equal the request `id`.
    // `dispatch` produces the envelope BODY; correlation belongs to the
    // transport, so a handler never has to know the request id (and cannot get
    // it wrong). Overwriting here is deliberate, not defensive.
    const envelopeOut =
      typeof outcome === 'object' && outcome !== null && !Array.isArray(outcome)
        ? { ...(outcome as Record<string, unknown>), id: requestId }
        : outcome

    sendJson(res, HTTP_OK, envelopeOut)
  }
}

// ── Registration ───────────────────────────────────────────────────────────

/**
 * Whether a dispatcher outcome is a stream of A2A frames rather than a JSON body.
 *
 * Deliberately narrow: only an object with `Symbol.asyncIterator` qualifies. A
 * JSON-RPC envelope never has one, so a non-streaming response cannot accidentally
 * take the SSE path and lose its `id` correlation.
 */
function isAsyncIterable(value: unknown): value is AsyncIterable<A2AStreamResponse> {
  if (value === null || typeof value !== 'object') return false
  return typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
}

/** Mount the three inbound routes on any route host. */
export function registerInboundRoutes(
  host: RouteHost,
  deps: InboundDeps,
  basePath: string,
): RouteRegistration {
  const routes: Array<{ kind: 'exact' | 'prefix'; path: string; handler: WebRouteLike['handler'] }> = [
    { kind: 'exact', path: AGENT_CARD_PATH, handler: makeCardHandler(deps) },
    { kind: 'exact', path: LEGACY_AGENT_CARD_PATH, handler: makeCardHandler(deps) },
    { kind: 'exact', path: basePath, handler: makeRpcHandler(deps) },
  ]

  const disposers = routes.map((route) => host.register(route))
  return {
    dispose: () => {
      for (const dispose of disposers) dispose()
    },
  }
}

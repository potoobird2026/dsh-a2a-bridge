/**
 * Wire-level integration tests — real listener, real HTTP, no mocks of the
 * transport.
 *
 * This is the layer where ADR-011 is actually proven: if `InboundServer` did
 * not bind, or the route table did not match, or the auth/version/body pipeline
 * were in the wrong order, nothing here would pass. Unit tests cannot catch any
 * of that.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { InboundServer } from '../../src/inbound/server.js'
import { registerInboundRoutes, type InboundDeps } from '../../src/inbound/routes.js'
import { RateLimiter } from '../../src/security/index.js'
import { buildAgentCard } from '../../src/protocol/card.js'
import { AGENT_CARD_PATH, A2A_VERSION_HEADER } from '../../src/constants.js'
import type { A2AAgentCard } from '../../src/protocol/wire.js'

const ALICE_TOKEN = 'test-token-alice-0123456789'
const BASE_PATH = '/a2a'

interface Harness {
  readonly origin: string
  readonly close: () => Promise<void>
}

const open: Harness[] = []

afterEach(async () => {
  while (open.length > 0) {
    const harness = open.pop()
    await harness?.close()
  }
})

function card(): A2AAgentCard {
  return buildAgentCard({
    name: 'wire-test-agent',
    description: 'test',
    version: '0.1.0',
    url: `http://127.0.0.1${BASE_PATH}`,
    authRequired: true,
  })
}

async function startServer(overrides: Partial<InboundDeps> = {}): Promise<Harness> {
  const server = new InboundServer({ host: '127.0.0.1', port: 0 })
  const deps: InboundDeps = {
    cardFor: () => card(),
    dispatch: async (input) => ({
      jsonrpc: '2.0',
      id: 1,
      result: { handled: input.method, peer: input.peer },
    }),
    resolvePeerSecrets: async () => new Map([['alice', ALICE_TOKEN]]),
    trustedPeers: [],
    maxBodyBytes: 64 * 1024,
    strictVersionHeader: true,
    rateLimiter: new RateLimiter(1000),
    ...overrides,
  }

  const registration = registerInboundRoutes(server, deps, BASE_PATH)
  const port = await server.start()

  const harness: Harness = {
    origin: `http://127.0.0.1:${port}`,
    close: async () => {
      registration.dispose()
      await server.stop()
    },
  }
  open.push(harness)
  return harness
}

function rpc(
  origin: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${origin}${BASE_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [A2A_VERSION_HEADER]: '1.0',
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

function auth(token: string = ALICE_TOKEN): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

describe('inbound wire: streaming response', () => {
  it('pipes an async iterable from dispatch as text/event-stream', async () => {
    const harness = await startServer({
      // The dispatcher signals streaming by RETURNING an async iterable. This is
      // the only contract the route needs; it knows nothing about A2A semantics.
      dispatch: async function* () {
        yield { task: { id: 'task-1' } } as never
        yield {
          statusUpdate: { taskId: 'task-1', status: { state: 'TASK_STATE_COMPLETED' } },
        } as never
      },
    })

    const response = await rpc(
      harness.origin,
      { jsonrpc: '2.0', id: 7, method: 'SendStreamingMessage', params: {} },
      auth(),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    // Proxies buffer unless told otherwise; the header is part of the contract.
    expect(response.headers.get('x-accel-buffering')).toBe('no')

    const body = await response.text()
    const frames = body.split('\n\n').filter((part) => part.trim().length > 0)
    expect(frames).toHaveLength(2)
    for (const frame of frames) {
      // `sseFrame` owns the format: `data: {jsonrpc,id,result}`. The correlation id
      // rides INSIDE the envelope, so it must appear in every frame.
      expect(frame.startsWith('data: ')).toBe(true)
      expect(frame).toContain('"id":7')
    }
    expect(body).toContain('TASK_STATE_COMPLETED')
  })

  it('keeps the JSON envelope path for a non-iterable outcome', async () => {
    const harness = await startServer()
    const response = await rpc(
      harness.origin,
      { jsonrpc: '2.0', id: 3, method: 'SendMessage', params: {} },
      auth(),
    )

    expect(response.headers.get('content-type')).toContain('application/json')
    const payload = (await response.json()) as { id?: number }
    expect(payload.id).toBe(3)
  })
})

describe('inbound wire: agent card', () => {
  it('serves the card anonymously at the well-known path', async () => {
    const { origin } = await startServer()
    const response = await fetch(`${origin}${AGENT_CARD_PATH}`)
    expect(response.status).toBe(200)

    const body = (await response.json()) as Record<string, unknown>
    expect(body.name).toBe('wire-test-agent')
    // v1.0 shape: no v0.3 members.
    expect(body.protocolVersion).toBeUndefined()
    expect(body.url).toBeUndefined()
    expect(Array.isArray(body.supportedInterfaces)).toBe(true)
  })

  it('serves the legacy well-known path too', async () => {
    const { origin } = await startServer()
    const response = await fetch(`${origin}/.well-known/agent.json`)
    expect(response.status).toBe(200)
  })

  it('rejects a non-GET card request', async () => {
    const { origin } = await startServer()
    const response = await fetch(`${origin}${AGENT_CARD_PATH}`, { method: 'POST' })
    expect(response.status).toBe(405)
  })
})

describe('inbound wire: authentication', () => {
  it('answers 401 with www-authenticate and a valid JSON-RPC body when no token is sent', async () => {
    const { origin } = await startServer()
    const response = await rpc(origin, { jsonrpc: '2.0', id: 1, method: 'SendMessage', params: {} })

    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe('Bearer')

    const body = (await response.json()) as Record<string, unknown>
    expect(body.jsonrpc).toBe('2.0')
    expect((body.error as Record<string, unknown>).code).toBe(-32600)
  })

  it('answers 401 for an unknown token', async () => {
    const { origin } = await startServer()
    const response = await rpc(
      origin,
      { jsonrpc: '2.0', id: 1, method: 'SendMessage', params: {} },
      auth('wrong-token'),
    )
    expect(response.status).toBe(401)
  })

  it('answers 403 for an authenticated but untrusted peer', async () => {
    const { origin } = await startServer({ trustedPeers: ['bob'] })
    const response = await rpc(
      origin,
      { jsonrpc: '2.0', id: 1, method: 'SendMessage', params: {} },
      auth(),
    )
    expect(response.status).toBe(403)
  })

  it('answers 429 once the rate limiter is exhausted', async () => {
    const { origin } = await startServer({ rateLimiter: new RateLimiter(1) })
    const first = await rpc(origin, { jsonrpc: '2.0', id: 1, method: 'SendMessage', params: {} }, auth())
    const second = await rpc(origin, { jsonrpc: '2.0', id: 2, method: 'SendMessage', params: {} }, auth())

    expect(first.status).toBe(200)
    expect(second.status).toBe(429)
  })
})

describe('inbound wire: version negotiation', () => {
  it('rejects an explicit v0.3 version with -32009 and ErrorInfo details', async () => {
    const { origin } = await startServer()
    const response = await rpc(
      origin,
      { jsonrpc: '2.0', id: 1, method: 'SendMessage', params: {} },
      { ...auth(), [A2A_VERSION_HEADER]: '0.3' },
    )
    expect(response.status).toBe(200)

    const body = (await response.json()) as Record<string, unknown>
    const error = body.error as Record<string, unknown>
    expect(error.code).toBe(-32009)
    expect(Array.isArray(error.data)).toBe(true)
  })

  it('rejects a missing version header in strict mode', async () => {
    const { origin } = await startServer({ strictVersionHeader: true })
    const response = await fetch(`${origin}${BASE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth() },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: {} }),
    })
    const body = (await response.json()) as Record<string, unknown>
    expect((body.error as Record<string, unknown>).code).toBe(-32009)
  })

  it('accepts a missing version header in permissive mode', async () => {
    const { origin } = await startServer({ strictVersionHeader: false })
    const response = await fetch(`${origin}${BASE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth() },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: {} }),
    })
    const body = (await response.json()) as Record<string, unknown>
    expect(body.result).toBeDefined()
  })
})

describe('inbound wire: dispatch', () => {
  it('forwards an authenticated SendMessage and echoes the peer identity', async () => {
    const { origin } = await startServer()
    const response = await rpc(
      origin,
      { jsonrpc: '2.0', id: 7, method: 'SendMessage', params: { message: { messageId: 'm1' } } },
      auth(),
    )
    expect(response.status).toBe(200)

    const body = (await response.json()) as Record<string, unknown>
    const result = body.result as Record<string, unknown>
    expect(result.handled).toBe('SendMessage')
    expect(result.peer).toBe('alice')
  })

  it('keeps the request id in the response envelope', async () => {
    const { origin } = await startServer()
    const response = await rpc(
      origin,
      { jsonrpc: '2.0', id: 'abc-123', method: 'SendMessage', params: {} },
      auth(),
    )
    const body = (await response.json()) as Record<string, unknown>
    expect(body.id).toBe('abc-123')
  })

  it('answers 400 on malformed JSON', async () => {
    const { origin } = await startServer()
    const response = await fetch(`${origin}${BASE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'a2a-version': '1.0', ...auth() },
      body: '{not json',
    })
    expect(response.status).toBe(400)
  })

  it('rejects a non-object params', async () => {
    const { origin } = await startServer()
    const response = await rpc(
      origin,
      { jsonrpc: '2.0', id: 1, method: 'SendMessage', params: [1, 2, 3] },
      auth(),
    )
    const body = (await response.json()) as Record<string, unknown>
    expect((body.error as Record<string, unknown>).code).toBe(-32602)
  })
})

describe('inbound wire: routing', () => {
  it('answers 404 for an unknown path', async () => {
    const { origin } = await startServer()
    const response = await fetch(`${origin}/nope`)
    expect(response.status).toBe(404)
  })

  it('answers 405 for a non-POST on the RPC path', async () => {
    const { origin } = await startServer()
    const response = await fetch(`${origin}${BASE_PATH}`, { method: 'GET' })
    expect(response.status).toBe(405)
  })
})

describe('inbound listener: wildcard refusal', () => {
  it('refuses a wildcard bind', () => {
    expect(() => new InboundServer({ host: '0.0.0.0', port: 0 })).toThrow(/wildcard/i)
    expect(() => new InboundServer({ host: '::', port: 0 })).toThrow(/wildcard/i)
  })
})

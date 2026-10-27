/**
 * Round-trip wire test — our OUTBOUND client against our INBOUND server.
 *
 * This is the closest thing to the M1 acceptance criterion that can run in one
 * process: if the two halves disagree about the card shape, the version header,
 * the auth scheme, the envelope, or the task shape, this test fails. A unit
 * test cannot catch a disagreement between two hand-written halves, because
 * both halves would share the same wrong assumption.
 *
 * What it does NOT prove: real network hops, firewall rules, or two separate
 * DSH processes. That is `tests/live/`.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { InboundServer } from '../../src/inbound/server.js'
import { registerInboundRoutes, type InboundDeps } from '../../src/inbound/routes.js'
import { RateLimiter } from '../../src/security/index.js'
import { buildAgentCard } from '../../src/protocol/card.js'
import { discoverCard, sendMessage } from '../../src/outbound/client.js'
import { AGENT_CARD_PATH } from '../../src/constants.js'
import { jsonRpcResult } from '../../src/protocol/jsonrpc.js'
import type { A2AAgentCard, A2ATask } from '../../src/protocol/wire.js'

const TOKEN = 'roundtrip-token-abcdef0123456789'
const BASE_PATH = '/a2a'

const open: Array<() => Promise<void>> = []

afterEach(async () => {
  while (open.length > 0) {
    const close = open.pop()
    await close?.()
  }
})

function buildCardForOrigin(origin: string): A2AAgentCard {
  return buildAgentCard({
    name: 'roundtrip-server',
    description: 'A server used to exercise the client',
    version: '0.1.0',
    url: `${origin}${BASE_PATH}`,
    authRequired: true,
  })
}

function completedTask(id: string, text: string): A2ATask {
  return {
    id,
    contextId: 'ctx-roundtrip',
    status: { state: 'TASK_STATE_COMPLETED', timestamp: new Date().toISOString() },
    artifacts: [{ artifactId: `${id}-a`, name: 'result', parts: [{ text, mediaType: 'text/plain' }] }],
  }
}

async function startStack(reply = 'hello from the server'): Promise<{ origin: string }> {
  const server = new InboundServer({ host: '127.0.0.1', port: 0 })

  // The card must advertise the port we actually got, so the client's
  // post-discovery endpoint matches the listener.
  let origin = ''

  const deps: InboundDeps = {
    cardFor: () => buildCardForOrigin(origin),
    dispatch: async (input) => {
      const params = (input.params ?? {}) as Record<string, unknown>
      if (input.operation === 'SendMessage') {
        const message = params.message as Record<string, unknown> | undefined
        const messageId = typeof message?.messageId === 'string' ? message.messageId : 'unknown'
        return jsonRpcResult(null, { task: completedTask(`task-${messageId}`, reply) })
      }
      if (input.operation === 'GetTask') {
        return jsonRpcResult(null, completedTask('task-1', reply))
      }
      return jsonRpcResult(null, { tasks: [] })
    },
    resolvePeerSecrets: async () => new Map([['alice', TOKEN]]),
    trustedPeers: [],
    maxBodyBytes: 256 * 1024,
    strictVersionHeader: true,
    rateLimiter: new RateLimiter(1000),
  }

  const registration = registerInboundRoutes(server, deps, BASE_PATH)
  const port = await server.start()
  origin = `http://127.0.0.1:${port}`

  open.push(async () => {
    registration.dispose()
    await server.stop()
  })

  return { origin }
}

describe('round trip: outbound client -> inbound server', () => {
  it('discovers the card through the client and selects the JSONRPC interface', async () => {
    const { origin } = await startStack()

    const discovered = await discoverCard(origin, AGENT_CARD_PATH)

    expect(discovered.card.name).toBe('roundtrip-server')
    // The discovery result exposes the CARD; interface selection happens inside the
    // client. This assertion used to read `discovered.selectedInterface` — a property
    // that does not exist, so it compared `undefined` and could never fail.
    // Typechecking the tests is what surfaced it.
    expect(discovered.card.supportedInterfaces[0]?.protocolBinding).toBe('JSONRPC')
    expect(discovered.warnings).toHaveLength(0)
  })

  it('sends a message and receives the settled task text', async () => {
    const { origin } = await startStack('the reply text')
    const discovered = await discoverCard(origin, AGENT_CARD_PATH)

    const result = await sendMessage(discovered, { text: 'ping' }, { token: TOKEN, timeoutMs: 10_000 })

    expect(result.terminatedEarly).toBe(false)
    expect(result.text).toBe('the reply text')
    expect(result.task?.status.state).toBe('TASK_STATE_COMPLETED')
  })

  it('fails the send when the token is wrong', async () => {
    const { origin } = await startStack()
    const discovered = await discoverCard(origin, AGENT_CARD_PATH)

    await expect(
      sendMessage(discovered, { text: 'ping' }, { token: 'wrong-token', timeoutMs: 10_000 }),
    ).rejects.toThrow(/401|SendMessage/i)
  })

  it('rejects a v0.3-shaped card with an actionable error', async () => {
    const server = new InboundServer({ host: '127.0.0.1', port: 0 })
    const legacy = {
      name: 'legacy',
      description: 'v0.3 shape',
      url: 'http://127.0.0.1/a2a',
      preferredTransport: 'JSONRPC',
      version: '0.3.0',
    }
    server.register({
      kind: 'exact',
      path: AGENT_CARD_PATH,
      handler: (_req, res) => {
        const payload = JSON.stringify(legacy)
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
        res.end(payload)
      },
    })
    const port = await server.start()
    open.push(async () => {
      await server.stop()
    })

    await expect(discoverCard(`http://127.0.0.1:${port}`, AGENT_CARD_PATH)).rejects.toThrow(/v0\.3|preferredTransport/)
  })
})

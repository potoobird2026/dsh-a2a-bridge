/**
 * Inbound HTTP listener — owned by this plugin, not by `ctx.webServer`.
 *
 * ADR-011: the Desktop shell pins `ctx.webServer` to 127.0.0.1 (verified:
 * `desktopWebServerHost()` returns the constant, with a throwing assertion if
 * the bound host differs). `networkExposure: 'lan'` only opens an HTTPS edge
 * for the browser GUI — the upstream HTTP origin is never exposed. Serving the
 * A2A endpoint there would make it unreachable from the peer machine.
 *
 * So we run our own `node:http` server bound to ONE concrete local address.
 *
 * Hard rules encoded here:
 *   - A wildcard bind (`0.0.0.0` / `::`) is refused. Binding every interface
 *     would expose this agent's tool surface to whatever network the machine is
 *     attached to; the webserver refuses it for the same reason.
 *   - `stop()` destroys every tracked socket. `server.close()` alone waits for
 *     keep-alive connections and never resolves.
 *   - Long-lived response objects (SSE) are tracked separately because
 *     `closeAllConnections()` does not reap them either.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'

import {
  CONTENT_TYPE_JSON,
  HTTP_BAD_REQUEST,
  HTTP_INTERNAL_SERVER_ERROR,
  HTTP_NOT_FOUND,
  WILDCARD_HOST_PATTERN,
} from '../constants.js'
import type { RouteHost, WebRouteLike } from './routes.js'

export class WildcardBindError extends Error {}

export interface InboundServerOptions {
  /** A concrete local address. Wildcards are refused — see the class comment. */
  readonly host: string
  /** 0 asks the OS for a free port (the only sane choice in tests). */
  readonly port: number
}

interface PrefixRoute {
  readonly path: string
  readonly route: WebRouteLike
}

export class InboundServer implements RouteHost {
  private readonly exact = new Map<string, WebRouteLike>()
  private readonly prefixes: PrefixRoute[] = []
  private readonly sockets = new Set<Socket>()
  /** Long-lived responses (SSE) that must be ended explicitly on stop. */
  private readonly streaming = new Set<ServerResponse>()
  private server: Server | undefined
  private boundPort: number | undefined

  constructor(private readonly options: InboundServerOptions) {
    assertConcreteHost(options.host)
  }

  /** The port actually bound (useful when the caller asked for 0). */
  get port(): number | undefined {
    return this.boundPort
  }

  get host(): string {
    return this.options.host
  }

  get origin(): string {
    return `http://${this.options.host}:${this.boundPort ?? this.options.port}`
  }

  // ── Route registration ───────────────────────────────────────────────────

  register(route: WebRouteLike): () => void {
    if (route.kind === 'exact') {
      if (this.exact.has(route.path)) {
        throw new Error(`inbound route already registered: exact ${route.path}`)
      }
      this.exact.set(route.path, route)
      return () => {
        this.exact.delete(route.path)
      }
    }

    if (this.prefixes.some((entry) => entry.path === route.path)) {
      throw new Error(`inbound route already registered: prefix ${route.path}`)
    }
    this.prefixes.push({ path: route.path, route })
    this.prefixes.sort((a, b) => b.path.length - a.path.length)
    return () => {
      const index = this.prefixes.findIndex((entry) => entry.path === route.path)
      if (index >= 0) this.prefixes.splice(index, 1)
    }
  }

  /** Track a response that stays open (SSE) so `stop()` can end it. */
  trackStreaming(res: ServerResponse): () => void {
    this.streaming.add(res)
    return () => {
      this.streaming.delete(res)
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async start(): Promise<number> {
    if (this.server !== undefined) throw new Error('inbound server already started')

    const server = createServer((req, res) => {
      void this.route(req, res)
    })

    server.on('connection', (socket: Socket) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
    })

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.removeListener('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        server.removeListener('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.options.port, this.options.host)
    })

    this.server = server
    const address = server.address()
    this.boundPort = typeof address === 'object' && address !== null ? address.port : this.options.port
    return this.boundPort
  }

  async stop(): Promise<void> {
    const server = this.server
    if (server === undefined) return
    this.server = undefined

    // Close open streams FIRST so their handlers see a normal end rather than
    // a socket reset (a reset is indistinguishable from a network fault).
    for (const res of this.streaming) {
      try {
        res.end()
      } catch {
        // already gone
      }
    }
    this.streaming.clear()

    // `close()` waits for keep-alive sockets; destroy them.
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()

    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
    this.boundPort = undefined
  }

  // ── Dispatch ─────────────────────────────────────────────────────────────

  private match(pathname: string): WebRouteLike | undefined {
    const exact = this.exact.get(pathname)
    if (exact !== undefined) return exact

    for (const entry of this.prefixes) {
      if (pathname === entry.path || pathname.startsWith(`${entry.path}/`)) {
        return entry.route
      }
    }
    return undefined
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', this.origin).pathname
    } catch {
      sendPlain(res, HTTP_BAD_REQUEST, 'bad request')
      return
    }

    const route = this.match(pathname)
    if (route === undefined) {
      sendPlain(res, HTTP_NOT_FOUND, 'not found')
      return
    }

    try {
      await route.handler(req, res)
    } catch {
      if (!res.headersSent) {
        sendPlain(res, HTTP_INTERNAL_SERVER_ERROR, 'internal error')
        return
      }
      try {
        res.end()
      } catch {
        // already gone
      }
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function sendPlain(res: ServerResponse, status: number, message: string): void {
  const payload = JSON.stringify({ error: message })
  res.writeHead(status, {
    'content-type': CONTENT_TYPE_JSON,
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * Refuse a wildcard bind.
 *
 * A wildcard address would expose this agent's tools to every network the
 * machine is attached to (including guest Wi-Fi). The operator must name the
 * one interface the peers can reach.
 */
export function assertConcreteHost(host: string): void {
  if (host.length === 0) throw new WildcardBindError('inbound.listen.host must not be empty')
  if (isWildcard(host)) {
    throw new WildcardBindError(
      `inbound.listen.host ${JSON.stringify(host)} is a wildcard address; bind one concrete ` +
        `IPv4/IPv6 address of a local interface instead`,
    )
  }
}

export function isWildcard(host: string): boolean {
  return WILDCARD_HOST_PATTERN.test(host.trim().toLowerCase())
}

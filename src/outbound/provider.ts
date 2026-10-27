/**
 * Outbound subagent provider — our agent delegates to a remote A2A peer.
 *
 * ADR-006: this is the primary outbound shape. A remote DSH should look like a
 * normal agent you can hand work to, not a passive tool.
 *
 * Six contracts, each learned the hard way (see MicroWearld reference):
 *   1. `capabilities = NO_START_CAPABILITIES` — a remote agent owns its own
 *      tools/schema/depth; claiming otherwise makes the harness pass options
 *      that are silently ignored.
 *   2. `inheritsParentContext = false` — no parent conversation crosses HTTP.
 *   3. The `result` promise MUST NOT reject. Every failure becomes
 *      `stopReason: 'error'` (or 'aborted'). This is the opposite of normal
 *      async intuition and the easiest thing to get wrong.
 *   4. Double cancellation: outer `request.signal` → inner `controller.signal`.
 *   5. A `timedOut` flag distinguishes a local timeout from a peer cancellation.
 *   6. Clean up the timer and the listener in BOTH the normal path and dispose.
 */

import { randomUUID } from 'node:crypto'

import { discoverCard, sendMessage, streamMessage, type DiscoveredContact } from './client.js'
import { isTerminalTaskState, type ContactRef } from '../types.js'
import type { A2AStreamResponse } from '../protocol/wire.js'

// ── Structural provider types (mirrors @deepseek-ai/dsh-subagent) ──────────

export interface SubagentCapabilities {
  readonly agentOptions: boolean
  readonly agentPreset: boolean
  readonly outputSchema: boolean
  readonly depthLimit: boolean
}

/** Capability advertisement of an out-of-process backend: NONE. */
export const NO_START_CAPABILITIES: SubagentCapabilities = Object.freeze({
  agentOptions: false,
  agentPreset: false,
  outputSchema: false,
  depthLimit: false,
})

export type SubagentStopReason = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'

export interface SubagentResult {
  readonly output: readonly unknown[]
  readonly structured?: unknown
  readonly diagnostic?: string
  readonly stopReason: SubagentStopReason
}

export interface SubagentRun {
  readonly id: string
  readonly result: Promise<SubagentResult>
  dispose(): Promise<void>
}

export interface ResolvedSubagentStartRequest {
  readonly cwd?: string
  readonly prompt: readonly unknown[]
  readonly signal: AbortSignal
  readonly label?: string
}

export interface SubagentProviderLike {
  readonly name: string
  readonly capabilities: SubagentCapabilities
  readonly inheritsParentContext: boolean
  start(request: ResolvedSubagentStartRequest): Promise<SubagentRun>
}

// ── Prompt flattening ──────────────────────────────────────────────────────

/** Flatten prompt blocks into plain text. Non-text blocks are dropped. */
export function promptToText(prompt: readonly unknown[]): string {
  const chunks: string[] = []
  for (const block of prompt) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') chunks.push(record.text)
  }
  return chunks.join('\n')
}

// ── Provider ───────────────────────────────────────────────────────────────

/**
 * ADR-007 outbound visibility event. Structurally identical to the session
 * layer's progress type on purpose: this module must not import `session/`, so
 * the outbound layer stays usable without any session service.
 */
export interface ProviderProgress {
  readonly contact: string
  readonly phase: 'delegating' | 'waiting' | 'completed' | 'failed' | 'aborted'
  readonly detail?: string
}

/**
 * One side of the outbound conversation, mirrored so the LOCAL user sees a chat.
 *
 * Structurally identical to the session layer's `OutboundExchange` on purpose:
 * this layer must not import `src/session/**`, so it declares its own copy and
 * the seam stays dependency-free (same discipline as `ProviderProgress`).
 *
 * This is the part the user asked for by name: the progress lines alone are a
 * one-way status feed; these two events are what turn the local mirror into a
 * conversation with the remote — our question beside its answer.
 */
export interface ProviderExchange {
  readonly contact: string
  /** `outgoing` = our prompt; `incoming` = the remote's settled reply. */
  readonly direction: 'outgoing' | 'incoming'
  readonly text: string
  /** Remote card name, so the reply is attributed to the peer that produced it. */
  readonly remote?: string
}

export interface ProviderOptions {
  readonly providerName: string
  readonly contacts: readonly ContactRef[]
  readonly resolveToken: (tokenEnv: string | undefined) => Promise<string | undefined>
  readonly log?: (message: string) => void
  /** Best-effort mirror into a local session; must never affect the A2A call. */
  readonly onProgress?: (progress: ProviderProgress) => void
  /** Best-effort mirror of each conversation side; must never affect the call. */
  readonly onExchange?: (exchange: ProviderExchange) => void
  /**
   * Test seams. The real implementations are the defaults, so production code
   * never passes them; a test supplies them instead of standing up an HTTP server.
   * Without these the provider had NO unit coverage at all, which is how its
   * streaming path could stay dead code without anyone noticing.
   */
  readonly discoverCard?: (contact: ContactRef, token: string | undefined) => Promise<DiscoveredContact>
  readonly send?: typeof sendMessage
  readonly stream?: typeof streamMessage
}

export class A2aSubagentProvider implements SubagentProviderLike {
  readonly capabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false
  readonly name: string

  /** Card cache: discovery is one HTTP GET, but not one per turn. */
  private readonly cards = new Map<string, DiscoveredContact>()

  constructor(private readonly options: ProviderOptions) {
    this.name = options.providerName
  }

  /** Which remote this provider targets. Exactly one for MVP. */
  private primaryContact(): ContactRef | undefined {
    return this.options.contacts[0]
  }

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    if (request.signal.aborted) {
      throw new Error('a2a: request was aborted before the remote agent started')
    }

    const contact = this.primaryContact()
    if (contact === undefined) {
      throw new Error(`a2a: provider "${this.name}" has no configured contact`)
    }

    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    request.signal.addEventListener('abort', onAbort, { once: true })

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, contact.timeoutMs)

    const cleanup = (): void => {
      clearTimeout(timer)
      request.signal.removeEventListener('abort', onAbort)
    }

    const report = (phase: ProviderProgress['phase'], detail?: string): void => {
      try {
        this.options.onProgress?.({ contact: contact.name, phase, detail })
      } catch (error) {
        // A broken listener must not break delegation (ADR-007 visibility is
        // secondary to actually delivering the task).
        this.log(`progress mirror failed: ${String(error)}`)
      }
    }

    /** Mirror one side of the conversation; same best-effort discipline. */
    const say = (direction: ProviderExchange['direction'], text: string, remote?: string): void => {
      try {
        this.options.onExchange?.({ contact: contact.name, direction, text, remote })
      } catch (error) {
        this.log(`exchange mirror failed: ${String(error)}`)
      }
    }

    const prompt = promptToText(request.prompt)

    // Contract 3: never reject.
    const result: Promise<SubagentResult> = (async () => {
      try {
        report('delegating')
        // Our own words go first, so the local transcript reads as a dialogue:
        // what we asked, then what came back.
        say('outgoing', prompt)
        const token = await this.options.resolveToken(contact.tokenEnv)
        const discovered = await this.card(contact, token)
        report('waiting')
        // Prefer the peer's OWN stream when it advertises one: that is what makes the
        // local transcript update WHILE the remote turn runs, instead of showing
        // nothing until it settles. A peer that does not stream keeps the polling
        // path unchanged.
        const send = this.options.send ?? sendMessage
        const stream = this.options.stream ?? streamMessage
        let outcome: { text: string, terminatedEarly: boolean }
        if (discovered.card.capabilities?.streaming === true) {
          const streamed = await stream(
            discovered,
            { text: prompt },
            {
              token,
              timeoutMs: contact.timeoutMs,
              onStreamFrame: (frame) => {
                // `onStreamFrame` is typed `unknown` (the decoder cannot know the
                // schema), so narrow at the boundary instead of trusting it.
                const update = (frame as A2AStreamResponse | undefined)?.statusUpdate
                const label = update?.status?.message?.parts?.[0]?.text
                report('waiting', typeof label === 'string' && label.length > 0 ? label : undefined)
              },
            },
          )
          outcome = {
            text: streamed.text,
            // No terminal state means the stream closed early: treat it exactly like
            // a poll that never settled, rather than reporting a bogus success.
            terminatedEarly: streamed.state === undefined || !isTerminalTaskState(streamed.state),
          }
        } else {
          outcome = await send(discovered, { text: prompt }, { token, timeoutMs: contact.timeoutMs })
        }
        if (outcome.terminatedEarly) {
          report('failed', 'remote task did not settle before the timeout')
          return { output: [], diagnostic: 'remote task did not settle before the timeout', stopReason: 'error' }
        }
        report('completed')
        say('incoming', outcome.text, discovered.card.name)
        return { output: [{ type: 'text', text: outcome.text }], stopReason: 'completed' }
      } catch (error) {
        if (timedOut) {
          report('failed', `timed out after ${contact.timeoutMs}ms`)
          return { output: [], diagnostic: `timed out after ${contact.timeoutMs}ms`, stopReason: 'error' }
        }
        if (controller.signal.aborted || request.signal.aborted) {
          report('aborted')
          return { output: [], stopReason: 'aborted' }
        }
        this.log(`remote run failed: ${String(error)}`)
        report('failed', String(error))
        return { output: [], diagnostic: String(error), stopReason: 'error' }
      } finally {
        cleanup()
      }
    })()

    return {
      id: randomUUID(),
      result,
      dispose: async (): Promise<void> => {
        cleanup()
        controller.abort()
      },
    }
  }

  private async card(contact: ContactRef, token: string | undefined): Promise<DiscoveredContact> {
    const cached = this.cards.get(contact.name)
    if (cached !== undefined) return cached
    const discover = this.options.discoverCard
    const discovered = discover !== undefined
      ? await discover(contact, token)
      : await discoverCard(
          contact.url,
          contact.agentCardPath,
          token === undefined ? {} : { authorization: `Bearer ${token}` },
          contact.timeoutMs,
        )
    this.cards.set(contact.name, discovered)
    return discovered
  }

  private log(message: string): void {
    if (this.options.log !== undefined) this.options.log(`a2a "${this.name}": ${message}`)
  }
}

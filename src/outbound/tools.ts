/**
 * Outbound tools — explicit `a2a_call` / `a2a_list` entry points.
 *
 * ADR-006: the subagent provider is the primary shape; these tools are the
 * explicit fallback so a caller can address a specific remote by name.
 *
 * CRITICAL: tools MUST be built with `defineTool` from `@deepseek-ai/dsh-tools`.
 * That helper is where the DSH parameter DSL (`{ prop: { type, required } }`)
 * is converted into a real JSON Schema (`{ type:'object', properties, required }`).
 * Registering a hand-built object instead leaves `parameters` as the raw DSL,
 * so the model provider receives a schema with `type: null` and rejects EVERY
 * request with:
 *   Invalid schema for function 'a2a_call': schema must be a JSON Schema of
 *   'type: "object"', got 'type: null'.
 * That failure is not limited to the tool — it breaks the whole conversation.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { discoverCard, sendMessage, type DiscoveredContact } from './client.js'
import { HOST_MESSAGES, probeFailedLine } from '../messages.js'
import type { ContactRef } from '../types.js'

export interface ToolsOptions {
  readonly contacts: readonly ContactRef[]
  readonly resolveToken: (tokenEnv: string | undefined) => Promise<string | undefined>
  /**
   * Enumerate the models this DEPLOYMENT already has configured.
   *
   * The plugin must never assume a provider: every desktop has its own set
   * (DeepSeek account, LongCat, Ollama, a WorkBuddy catalog, ...). This feeds
   * `a2a_models` so the user picks a pair that exists on THEIR machine instead
   * of guessing provider ids in YAML.
   */
  readonly listModels?: () => Promise<Array<{ provider: string; models: string[] }>>
  /** The pair currently in effect, so the user can see what is active. */
  readonly currentSelection?: () => { provider?: string; model?: string } | undefined
  /**
   * Best-effort mirror of each conversation side into a local session.
   *
   * Deliberately the SAME seam the subagent provider uses: the user asked for a
   * local conversation window for A2A, and a tool call is still an A2A
   * delegation — routing only the provider would leave `a2a_call` invisible,
   * which is exactly the black box the requirement rejects.
   *
   * Structural copy of `src/session/events.ts` `OutboundExchange` (no import:
   * `src/outbound/**` must not depend on `src/session/**`).
   */
  readonly onExchange?: (exchange: {
    readonly contact: string
    readonly direction: 'outgoing' | 'incoming'
    readonly text: string
    readonly remote?: string
  }) => void
}

/** One-line label for a remote, used by `a2a_list` output. */
export function describeContact(name: string, url: string, card: DiscoveredContact): string {
  const skill = card.card.skills[0]
  const suffix = skill !== undefined ? ` / ${skill.name}` : ''
  return `- ${name}: ${card.card.name}${suffix} — ${url}`
}

/**
 * Build the two tool definitions.
 *
 * Tool descriptions are model-facing text, so they say when NOT to use them —
 * a delegation tool that looks like the cheapest option gets used by mistake.
 */
export function buildOutboundTools(options: ToolsOptions): unknown[] {
  const byName = new Map(options.contacts.map((contact) => [contact.name, contact]))

  /**
   * `a2a_models` — show which provider/model pairs this machine can actually
   * run, plus which one A2A is currently using.
   *
   * This exists so the model choice is a SELECTION from the user's real
   * configuration, never a hardcoded provider baked into the plugin.
   */
  const modelsTool = defineTool({
    name: 'a2a_models',
    description:
      'List the provider/model pairs configured on this machine and show which one A2A sessions currently use. ' +
      'Use it before setting `inbound.agent` so the values come from this deployment, not from a guess.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(): Promise<string> {
      const current = options.currentSelection?.()
      const header =
        current?.provider !== undefined && current?.model !== undefined
          ? `current A2A model: ${current.provider} / ${current.model}`
          : 'current A2A model: (none selected — A2A calls are refused)'

      if (options.listModels === undefined) {
        return `${header}\n(model catalog is unavailable in this profile)`
      }
      let catalog: Array<{ provider: string; models: string[] }>
      try {
        catalog = await options.listModels()
      } catch (error) {
        return `${header}\n(could not read the model catalog: ${String(error)})`
      }
      if (catalog.length === 0) return `${header}\n(no providers configured)`

      const lines = [header, 'available providers:']
      for (const entry of catalog) {
        lines.push(`- ${entry.provider}: ${entry.models.length > 0 ? entry.models.join(', ') : '(no models listed)'}`)
      }
      lines.push('', 'To pin A2A to one of these, set inbound.agent.provider / inbound.agent.model.')
      return lines.join('\n')
    },
  })

  /**
   * Mirror one side of the conversation, best-effort.
   *
   * A tool call must not fail because visibility failed: the requirement is that
   * the request succeeds even when the mirror does not (ADR-007 visibility is
   * secondary to delivering the delegation).
   */
  const say = (
    contact: string,
    direction: 'outgoing' | 'incoming',
    text: string,
    remote?: string,
  ): void => {
    try {
      options.onExchange?.({ contact, direction, text, remote })
    } catch {
      // Intentionally swallowed: see above.
    }
  }

  async function discover(contact: ContactRef): Promise<DiscoveredContact> {
    const token = await options.resolveToken(contact.tokenEnv)
    const headers: Record<string, string> =
      token === undefined ? {} : { authorization: `Bearer ${token}` }
    return discoverCard(contact.url, contact.agentCardPath, headers, contact.timeoutMs)
  }

  const listTool = defineTool({
    name: 'a2a_list',
    description:
      'List the remote A2A agents this machine can delegate to (name, URL, description). ' +
      'Use it before a2a_call when unsure which remote exists.',
    // An empty DSL map converts to `{ type: 'object', properties: {} }`.
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(): Promise<string> {
      if (options.contacts.length === 0) return HOST_MESSAGES.noContacts
      const lines: string[] = []
      for (const contact of options.contacts) {
        try {
          const card = await discover(contact)
          lines.push(describeContact(contact.name, contact.url, card))
        } catch (error) {
          lines.push(probeFailedLine(contact.name, contact.url, error))
        }
      }
      return lines.join('\n')
    },
  })

  const callTool = defineTool({
    name: 'a2a_call',
    description:
      'Send a prompt to a configured remote A2A agent and wait for its settled text reply. ' +
      'Use it only for work that belongs on the remote machine; prefer local tools for local work.',
    parameters: {
      agent: {
        type: 'string',
        required: true,
        description: 'Contact name of the remote agent (see a2a_list).',
      },
      message: {
        type: 'string',
        required: true,
        description: 'Prompt text to send.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const name = typeof args.agent === 'string' ? args.agent : ''
      const text = typeof args.message === 'string' ? args.message : ''
      const contact = byName.get(name)
      if (contact === undefined) {
        throw new Error(`a2a: no such contact ${JSON.stringify(name)}; see a2a_list`)
      }
      if (text.length === 0) throw new Error('a2a: message must not be empty')

      say(name, 'outgoing', text)
      const token = await options.resolveToken(contact.tokenEnv)
      const discovered = await discover(contact)
      const outcome = await sendMessage(discovered, { text }, { token, timeoutMs: contact.timeoutMs })
      if (outcome.terminatedEarly) {
        throw new Error('a2a: remote task did not settle before the timeout')
      }
      say(name, 'incoming', outcome.text, discovered.card.name)
      return outcome.text
    },
  })

  return [modelsTool, listTool, callTool]
}

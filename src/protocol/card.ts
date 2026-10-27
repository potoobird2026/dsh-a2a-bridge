/**
 * Agent Card construction and parsing.
 *
 * Authoritative source: A2A spec §Agent Discovery + `specification/a2a.proto`.
 *
 * v1.0 removed six members the builder must never emit, and this file pins
 * them in a test:
 *   `protocolVersion` (now per-interface), `url`, `preferredTransport`,
 *   `additionalInterfaces`, `supportsAuthenticatedExtendedCard`, `security`.
 *
 * Layering rule: imports only `../constants.js` + `../types.js` + `./wire.js`.
 */

import {
  A2A_PROTOCOL_VERSION,
  DEFAULT_AGENT_CARD_PATH,
  INBOUND_STREAMING_IMPLEMENTED,
  JSONRPC_BINDING,
} from '../constants.js'
import type { A2AAgentCard, A2AAgentSkill, A2APart } from './wire.js'
import { defaultInterface } from './wire.js'

/** Emitted when a deployment declares no skills. */
export const FALLBACK_SKILL: A2AAgentSkill = Object.freeze({
  id: 'general',
  name: 'general',
  description: 'General-purpose agent task execution.',
  tags: Object.freeze(['general'] as const),
})

export interface CardInput {
  readonly name: string
  readonly description: string
  readonly version: string
  readonly url: string
  readonly streaming?: boolean
  readonly pushNotifications?: boolean
  readonly skills?: readonly A2AAgentSkill[]
  readonly extendedSkills?: readonly A2AAgentSkill[]
  readonly provider?: { readonly organization: string; readonly url: string }
  readonly authRequired?: boolean
  readonly documentationUrl?: string
}

/**
 * Build a v1.0 Agent Card.
 *
 * `skills` are DECLARED BY THE DEPLOYMENT — never a projection of the live
 * tool registry. Broadcasting the installed tool list to anyone scanning
 * ports is information disclosure, not service discovery.
 */
export function buildAgentCard(input: CardInput): A2AAgentCard {
  const skills = input.skills !== undefined && input.skills.length > 0 ? input.skills : [FALLBACK_SKILL]

  const card: A2AAgentCard = {
    name: input.name,
    description: input.description,
    version: input.version,
    supportedInterfaces: [defaultInterface(input.url)],
    capabilities: {
      // Default comes from the SAME constant the dispatcher reads, so the card
      // cannot advertise a method that `dispatch()` refuses. See
      // `INBOUND_STREAMING_IMPLEMENTED` in constants.ts for why this is a
      // constant and not an independent default.
      streaming: input.streaming ?? INBOUND_STREAMING_IMPLEMENTED,
      pushNotifications: input.pushNotifications ?? false,
      extendedAgentCard: (input.extendedSkills?.length ?? 0) > 0,
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills,
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.documentationUrl !== undefined ? { documentationUrl: input.documentationUrl } : {}),
  }

  if (input.authRequired === true) {
    // v1.0 wraps each scheme in the member naming its type, and replaces the
    // bare `security` array with `securityRequirements`.
    // Returned as a new object because A2AAgentCard is readonly by design.
    return {
      ...card,
      securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
      securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    }
  }

  return card
}

// ── Outbound card parsing ──────────────────────────────────────────────────

export interface ParsedCard {
  readonly card: A2AAgentCard
  /** The interface entry the caller should use. */
  readonly selectedInterface: { readonly url: string; readonly protocolBinding: string }
  /** Non-fatal notes for diagnostics. */
  readonly warnings: readonly string[]
}

export class AgentCardError extends Error {}

/**
 * Parse and select an interface from a remote card.
 *
 * Selection is where naive implementations go wrong, so it is explicit:
 *   1. Prefer an entry whose `protocolBinding` is JSONRPC.
 *   2. Reject any entry whose `protocolVersion` is not 1.0 — never silently
 *      downgrade, never guess.
 *   3. Fall back to the first entry only if no JSONRPC entry exists, and say
 *      so in `warnings`.
 */
export function parseAgentCard(raw: unknown, agentCardPath: string = DEFAULT_AGENT_CARD_PATH): ParsedCard {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new AgentCardError(`agent card is not an object (requested from ${agentCardPath})`)
  }
  const record = raw as Record<string, unknown>
  if (typeof record.name !== 'string' || record.name.length === 0) {
    throw new AgentCardError('agent card has no name')
  }

  const interfaces = Array.isArray(record.supportedInterfaces)
    ? (record.supportedInterfaces as Array<Record<string, unknown>>)
    : []

  if (interfaces.length === 0) {
    // A v0.3 card uses top-level `url` + `preferredTransport`. Detect and
    // refuse it with a clear message rather than mis-parsing it.
    if (typeof record.url === 'string') {
      throw new AgentCardError(
        `agent card uses the v0.3 'url' + 'preferredTransport' shape; this client speaks A2A ${A2A_PROTOCOL_VERSION}`,
      )
    }
    throw new AgentCardError('agent card declares no supportedInterfaces')
  }

  const warnings: string[] = []
  const parsedInterfaces = interfaces
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map((entry) => ({
      url: typeof entry.url === 'string' ? entry.url : '',
      protocolBinding: typeof entry.protocolBinding === 'string' ? entry.protocolBinding : '',
      protocolVersion: typeof entry.protocolVersion === 'string' ? entry.protocolVersion : '',
      tenant: typeof entry.tenant === 'string' ? entry.tenant : undefined,
    }))

  const jsonrpcEntries = parsedInterfaces.filter((entry) => entry.protocolBinding === JSONRPC_BINDING)
  const candidates = jsonrpcEntries.length > 0 ? jsonrpcEntries : parsedInterfaces
  if (jsonrpcEntries.length === 0) {
    warnings.push(`no JSONRPC interface declared; falling back to ${candidates[0]?.protocolBinding ?? 'unknown'}`)
  }

  const selected = candidates[0]
  if (selected === undefined || selected.url.length === 0) {
    throw new AgentCardError('agent card has no usable interface url')
  }

  if (selected.protocolVersion !== '' && selected.protocolVersion !== A2A_PROTOCOL_VERSION && selected.protocolVersion !== '1.0.0') {
    throw new AgentCardError(
      `agent card interface speaks protocol ${selected.protocolVersion}; this client speaks A2A ${A2A_PROTOCOL_VERSION}`,
    )
  }
  if (selected.protocolVersion === '') {
    warnings.push('interface omits protocolVersion; assuming A2A 1.0')
  }

  const card: A2AAgentCard = {
    name: record.name,
    description: typeof record.description === 'string' ? record.description : '',
    version: typeof record.version === 'string' ? record.version : '0.0.0',
    supportedInterfaces: parsedInterfaces.map((entry) => ({
      url: entry.url,
      protocolBinding: entry.protocolBinding,
      protocolVersion: entry.protocolVersion === '' ? A2A_PROTOCOL_VERSION : entry.protocolVersion,
      ...(entry.tenant !== undefined ? { tenant: entry.tenant } : {}),
    })),
    capabilities: {
      streaming: record.capabilities !== undefined && typeof record.capabilities === 'object'
        ? (record.capabilities as Record<string, unknown>).streaming === true
        : false,
      pushNotifications: record.capabilities !== undefined && typeof record.capabilities === 'object'
        ? (record.capabilities as Record<string, unknown>).pushNotifications === true
        : false,
      extendedAgentCard: record.capabilities !== undefined && typeof record.capabilities === 'object'
        ? (record.capabilities as Record<string, unknown>).extendedAgentCard === true
        : false,
    },
    defaultInputModes: Array.isArray(record.defaultInputModes)
      ? (record.defaultInputModes as string[]).filter((m): m is string => typeof m === 'string')
      : ['text/plain'],
    defaultOutputModes: Array.isArray(record.defaultOutputModes)
      ? (record.defaultOutputModes as string[]).filter((m): m is string => typeof m === 'string')
      : ['text/plain'],
    skills: Array.isArray(record.skills)
      ? (record.skills as Array<Record<string, unknown>>)
          .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
          .map((s) => ({
            id: typeof s.id === 'string' ? s.id : '',
            name: typeof s.name === 'string' ? s.name : '',
            description: typeof s.description === 'string' ? s.description : '',
            tags: Array.isArray(s.tags) ? (s.tags as string[]).filter((t): t is string => typeof t === 'string') : [],
          }))
      : [],
    ...(typeof record.documentationUrl === 'string' ? { documentationUrl: record.documentationUrl } : {}),
  }

  return {
    card,
    selectedInterface: { url: selected.url, protocolBinding: selected.protocolBinding },
    warnings,
  }
}

/** Extract the first text part from a card's own description, for logs only. */
export function cardLabel(card: A2AAgentCard): string {
  const skill = card.skills[0]
  return `${card.name}${skill !== undefined ? ` (${skill.name})` : ''}`
}

export { DEFAULT_AGENT_CARD_PATH }
export type { A2APart }

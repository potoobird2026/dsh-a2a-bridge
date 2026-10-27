/**
 * Host half of the A2A model picker: the same-origin configuration API the
 * browser card calls.
 *
 * TRANSPORT: this route lives on `ctx.webServer`
 * (`register(route: WebRoute): () => void`; `WebRoute = { kind: 'exact', path,
 * handler }` — verified with `cordis_inspect_query` host/Service `webServer`),
 * unlike the peer-facing A2A endpoint (ADR-011, which must listen on a concrete
 * LAN address). The GUI is served by that same web server, so a relative
 * `fetch` is same-origin — no CORS, no token, no second listener. The two
 * surfaces are kept apart by path: peers speak JSON-RPC under
 * `config.basePath` (`/a2a`), while this route is `/a2a-bridge/config`.
 *
 * STORAGE: the write goes through the `SelectionGateway` seam. The supported
 * backend is `createSettingsSelection()` (the plugin's own volatile
 * `inbound.agent` Config, written through `ctx.settings.update`); see
 * `src/selection.ts` for the verified evidence. This module never touches a
 * file and never assumes which backend it got.
 *
 * CSRF / SAME-ORIGIN TRADE-OFF (deliberate, documented — the long-form analysis
 * belongs in docs/threat-model.md, which another owner maintains):
 *
 *  - This route can only change WHICH model A2A sessions run on. It cannot move
 *    a port, add a peer, add a contact, or read a credential. A successful
 *    cross-site attack would therefore be a preference tamper, not a takeover.
 *  - Mutations require `content-type: application/json`. A cross-origin
 *    `fetch` with that header triggers a CORS preflight (OPTIONS); this route
 *    answers every non-GET/POST method with 405 and sets no CORS headers, so
 *    the browser never sends the POST. A classic HTML form cannot set the
 *    header at all. Responses carry no CORS headers, so even a state-changing
 *    GET (there is none) could not be read cross-origin.
 *  - Additionally rejected: `Sec-Fetch-Site: cross-site`, and an `Origin` whose
 *    authority differs from `Host`. That comparison mirrors the Harness's own
 *    `/api` fence (`isSameAuthorityOrigin` in `@deepseek-ai/dsh-client-connection`),
 *    including its scheme-aware default-port handling.
 *  - RESIDUAL RISK, stated honestly: the `/api` fence also requires `Host` to be
 *    loopback / the bind address / a trusted host, which is what closes DNS
 *    rebinding. This route does not have that list (`trustedHosts` is not
 *    plumbed here), so a rebinding attacker whose `Origin` and `Host` agree on
 *    its own hostname is not stopped by the checks above. That is acceptable
 *    only because of the low blast radius above; if this route ever gains a
 *    higher-impact write, it must adopt the full fence.
 *  - The route is deliberately NOT under `config.basePath`: the peer-facing
 *    listener is a different control plane and must never reach a config write.
 *
 * Layering: node:http structural types + selection + constants. No Cordis
 * import, so the whole handler is testable with a fake request/response.
 */

import type { IncomingMessage } from 'node:http'

import {
  CONFIG_ROUTE_ALLOW,
  CONFIG_ROUTE_PATH,
  HTTP_BAD_REQUEST,
  HTTP_CONFLICT,
  HTTP_FORBIDDEN,
  HTTP_INTERNAL_SERVER_ERROR,
  HTTP_METHOD_NOT_ALLOWED,
  HTTP_OK,
  HTTP_PAYLOAD_TOO_LARGE,
  HTTP_SERVICE_UNAVAILABLE,
  HTTP_UNSUPPORTED_MEDIA_TYPE,
  MAX_CONFIG_BODY_BYTES,
  MAX_SELECTION_FIELD_LENGTH,
} from './constants.js'
import {
  PayloadTooLargeError,
  readBody,
  sendJson,
  type WebRouteLike,
} from './inbound/routes.js'
import {
  SelectionConflictError,
  SelectionSettingsUnavailableError,
  completeSelection,
  type AgentSelection,
  type SelectionGateway,
} from './selection.js'
import { listAgentPresetIds, type AgentPresetDirectoryLike } from './inbound/preset.js'

// ── LLM catalog ────────────────────────────────────────────────────────────

/**
 * The slice of `ctx.llm` this module uses, with the VERIFIED return shapes.
 *
 * `cordis_inspect_query` host/Service `llm` returns:
 *   listProviders(): LlmProviderInfo[]                     // @Remote, synchronous
 *   async listModels(provider: string): Promise<LlmModelInfo[]>
 * with
 *   interface LlmProviderInfo { id: string; name: string }
 *   interface LlmModelInfo {
 *     provider: string; id: string; name: string
 *     description?: string; inputModalities?: readonly ModelModality[]
 *   }
 *
 * So BOTH answers are METADATA OBJECTS, never bare strings, and the model id is
 * `.id` (`.name` is a display label, `.provider` is the route). The readers
 * below accept an object with a string `id` as the contract, and tolerate a
 * plain string only as a documented compatibility branch for a Host line (or a
 * remote carrier) that flattens ids — never as the basis of the aggregation.
 */
export interface LlmLike {
  listProviders?: () => unknown
  listModels?: (provider: string) => unknown
}

/** One provider and the models it advertises, as the GUI renders it. */
export interface ProviderCatalogEntry {
  readonly provider: string
  readonly models: readonly string[]
}

/** Why the catalog could not be read, so the UI can say "unavailable", not "none". */
export type CatalogFailure = 'service-missing' | 'unreadable'

export interface ModelCatalog {
  readonly providers: readonly ProviderCatalogEntry[]
  /** False when the `llm` service is absent or its provider list is unreadable. */
  readonly available: boolean
  readonly failure?: CatalogFailure
}

/** Model id from one `LlmModelInfo`, or undefined when the entry is malformed. */
function modelIdOf(entry: unknown, route: string): string | undefined {
  if (typeof entry === 'string') return entry.length > 0 ? entry : undefined
  if (entry === null || typeof entry !== 'object') return undefined
  const record = entry as Record<string, unknown>
  const id = record.id
  if (typeof id !== 'string' || id.length === 0) return undefined
  // `LlmModelInfo.provider` names the route the model came from. When an adapter
  // reports a DIFFERENT route, this entry does not belong under the requested
  // provider: skipping it keeps the GUI from offering a model that would be
  // dispatched to a route the user did not pick.
  if (typeof record.provider === 'string' && record.provider.length > 0 && record.provider !== route) {
    return undefined
  }
  return id
}

/** Provider id from one `LlmProviderInfo`, or undefined when malformed. */
function providerIdOf(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry.length > 0 ? entry : undefined
  if (entry === null || typeof entry !== 'object') return undefined
  const id = (entry as Record<string, unknown>).id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/** Dedupe ids while preserving the adapter's order. */
function unique(ids: Iterable<string | undefined>): string[] {
  const seen = new Set<string>()
  for (const id of ids) {
    if (id !== undefined && id.length > 0) seen.add(id)
  }
  return [...seen]
}

/**
 * Aggregate what THIS deployment actually has configured.
 *
 * Never throws. The distinction the UI needs is
 * `available: false` (the `llm` service is absent, or `listProviders()` is not
 * an array) vs `available: true` with zero providers (the service is present and
 * really has nothing configured). A non-array answer is a contract violation,
 * i.e. "unreadable", NOT "no models".
 *
 * A provider whose `listModels()` throws keeps its row with an empty model list:
 * one broken adapter must not hide the rest of the catalog.
 */
export async function readModelCatalog(llm: LlmLike | undefined): Promise<ModelCatalog> {
  if (llm === undefined || typeof llm.listProviders !== 'function') {
    return { providers: [], available: false, failure: 'service-missing' }
  }

  let answer: unknown
  try {
    answer = await llm.listProviders()
  } catch {
    return { providers: [], available: false, failure: 'unreadable' }
  }
  if (!Array.isArray(answer)) {
    return { providers: [], available: false, failure: 'unreadable' }
  }

  const providers: ProviderCatalogEntry[] = []
  for (const provider of unique(answer.map(providerIdOf))) {
    let models: string[] = []
    if (typeof llm.listModels === 'function') {
      try {
        const modelsAnswer = await llm.listModels(provider)
        if (Array.isArray(modelsAnswer)) {
          models = unique(modelsAnswer.map((entry) => modelIdOf(entry, provider)))
        }
      } catch {
        // One broken provider must not hide the others.
        models = []
      }
    }
    providers.push({ provider, models })
  }
  return { providers, available: true }
}

// ── Payload + handler ──────────────────────────────────────────────────────

/** Stable machine codes in the response body; the client may branch on them. */
export const CONFIG_ERROR = Object.freeze({
  methodNotAllowed: 'method_not_allowed',
  unsupportedMediaType: 'unsupported_media_type',
  crossSite: 'cross_site_request',
  payloadTooLarge: 'payload_too_large',
  invalidBody: 'invalid_body',
  invalidField: 'invalid_field',
  incompleteSelection: 'incomplete_selection',
  unknownProvider: 'unknown_provider',
  catalogUnavailable: 'catalog_unavailable',
  settingsUnavailable: 'settings_unavailable',
  selectionConflict: 'selection_conflict',
  internal: 'internal_error',
} as const)

/** The GET/POST response body. `source` says whether a human pinned the model. */
export interface ConfigPayload {
  readonly provider: string
  readonly model: string
  readonly source: 'pinned' | 'none'
  /**
   * False means A2A is UNCONFIGURED and will refuse every request until the
   * user picks a model on this plugin page. There is deliberately no deployment
   * fallback, so `provider`/`model` alone cannot express "nothing chosen"—both
   * are empty in that state, and this flag distinguishes it from a read that
   * merely failed to find a catalog.
   */
  readonly configured: boolean
  readonly providers: readonly ProviderCatalogEntry[]
  /**
   * Whether the provider catalog could be read at all. False means "unavailable"
   * (no `llm` service, or it answered with something unusable), which the page
   * must not render as "this machine has no providers".
   */
  readonly catalogAvailable: boolean
  /**
   * Agent preset ids this deployment declares, for the preset picker.
   *
   * An EMPTY array with `presetsAvailable: true` means "this deployment really
   * declares no preset" — which is a defect for A2A (such a session gets no
   * execution tools), NOT the same thing as a registry that could not be read.
   * The two are kept apart so the page never reports a broken service as an
   * empty roster.
   */
  readonly presets: readonly string[]
  /** False means the `agentPresets` service is absent or unreadable. */
  readonly presetsAvailable: boolean
  /**
   * Revision of the backing Settings document, when the backend exposes one.
   * Echoing it back on POST gives the write compare-and-set semantics; a null
   * means the legacy file backend, which has no revision.
   */
  readonly revision: number | null
}

export interface ConfigApiDeps {
  /** Resolved lazily: `ctx.get('llm')` is undefined while `apply()` runs. */
  readonly llm: () => LlmLike | undefined
  /** Where the pin lives. `createSettingsSelection()` is the supported backend. */
  readonly selection: SelectionGateway
  /**
   * The YAML `inbound.agent` pin, read directly rather than through the
   * gateway. With the settings backend this is the SAME field as
   * `selection.read()`, so the chain below normally stops at step 1; keeping the
   * second probe is what lets a host without a usable settings service still
   * report the pin instead of "unconfigured".
   */
  readonly configSelection?: () => unknown
  /** Kept for wire compatibility; derived from the effective pair when absent. */
  readonly hasSelection?: () => boolean
  /**
   * Write arbitrary config path ops (used by the tasks/workspace settings form).
   * Calls `ctx.settings.mutate(ns, ops, undefined)` — the unconditional write path.
   */
  readonly writeOps?: (ops: ReadonlyArray<Record<string, unknown>>) => Promise<void>
  /**
   * The agent-preset registry, resolved lazily (`ctx.get('agentPresets')` is
   * undefined while `apply()` runs). Absent means the picker reports
   * "unavailable" instead of failing the whole configuration read.
   */
  readonly presets?: () => AgentPresetDirectoryLike | undefined
  /** Diagnostics sink. Errors are logged in full, answers stay path-free. */
  readonly log?: (message: string) => void
}

/**
 * The selection that will govern the NEXT A2A session.
 *
 * Priority is exactly the one `defaultAgentOptions()` uses, so the GUI can
 * never show one model while the executor runs another:
 *   1. the gateway (Settings-backed `inbound.agent`)
 *   2. the `inbound.agent` YAML pin, read directly
 *
 * There is NO deployment fallback (`ctx.agentDefaultModel` exists and is
 * deliberately NOT consulted): an empty result means A2A is unconfigured and the
 * executor refuses every request (`ModelNotSelectedError`).
 */
function resolveEffective(deps: ConfigApiDeps): {
  provider: string
  model: string
  source: 'pinned' | 'none'
} {
  const stored = completeSelection(deps.selection.read())
  if (stored !== undefined) return { ...stored, source: 'pinned' }

  const pinned = completeSelection(deps.configSelection?.())
  if (pinned !== undefined) return { ...pinned, source: 'pinned' }

  return { provider: '', model: '', source: 'none' }
}

async function readPayload(deps: ConfigApiDeps): Promise<ConfigPayload> {
  const catalog = await readModelCatalog(deps.llm())
  const effective = resolveEffective(deps)
  // Never throws: a registry that is absent or unreadable degrades to
  // "unavailable" (see `listAgentPresetIds`), so one missing service cannot
  // break the model picker this page already provides.
  const presets = await listAgentPresetIds(deps.presets?.())
  return {
    provider: effective.provider,
    model: effective.model,
    source: effective.source,
    configured: deps.hasSelection?.() ?? effective.source !== 'none',
    providers: catalog.providers,
    catalogAvailable: catalog.available,
    presets: presets.ids,
    presetsAvailable: presets.available,
    revision: deps.selection.revision?.() ?? null,
  }
}

/** One header value as a string, or undefined (node may hand back arrays). */
function headerOf(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name]
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' ? value : undefined
}

/**
 * Whether this mutation may have come from a cross-site page.
 *
 * See the module header for the full trade-off. Missing `Host` cannot be a
 * browser request (HTTP/1.1 requires it), so only the browser markers are
 * enforced there — which keeps non-browser local clients (tests, curl) working.
 */
function isSameAuthorityMutation(req: IncomingMessage): boolean {
  if (headerOf(req, 'sec-fetch-site') === 'cross-site') return false
  const origin = headerOf(req, 'origin')
  const host = headerOf(req, 'host')
  if (origin === undefined || host === undefined) return true
  return sameAuthority(origin, host)
}

/**
 * Compare an `Origin` with a `Host` under the Origin's scheme.
 *
 * The scheme comes from the Origin so default ports normalise consistently
 * (the transport may still be HTTP behind an HTTPS proxy). Mirrors
 * `isSameAuthorityOrigin` in `@deepseek-ai/dsh-client-connection`.
 */
function sameAuthority(origin: string, host: string): boolean {
  let originUrl: URL
  try {
    originUrl = new URL(origin)
  } catch {
    return false
  }
  const scheme =
    originUrl.protocol === 'https:' ? 'https:' : originUrl.protocol === 'http:' ? 'http:' : undefined
  if (scheme === undefined) return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`${scheme}//${host.trim()}`)
  } catch {
    return false
  }
  return originUrl.host === hostUrl.host
}

/** A mutation must be a JSON POST: `application/json` also forces a CORS preflight. */
function isJsonRequest(req: IncomingMessage): boolean {
  const value = headerOf(req, 'content-type')
  if (value === undefined) return false
  return value.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
}

function sendError(
  res: Parameters<WebRouteLike['handler']>[1],
  status: number,
  code: string,
  message: string,
): void {
  sendJson(res, status, { error: message, code })
}

/**
 * Parse and validate one POST body; returns the accepted pair plus revision.
 *
 * Takes the already-read body text: the handler reads the stream ONCE so it can
 * dispatch between the generic `ops` path and this model-selection path.
 */
type ParsedMutation =
  | { readonly ok: true; readonly provider: string; readonly model: string; readonly revision?: number }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly message: string }

function parseMutationText(text: string): ParsedMutation {
  let parsed: unknown
  try {
    parsed = text.length === 0 ? undefined : JSON.parse(text)
  } catch {
    return {
      ok: false,
      status: HTTP_BAD_REQUEST,
      code: CONFIG_ERROR.invalidBody,
      message: 'body must be valid JSON',
    }
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      status: HTTP_BAD_REQUEST,
      code: CONFIG_ERROR.invalidBody,
      message: 'body must be a JSON object with string fields "provider" and "model"',
    }
  }

  const body = parsed as Record<string, unknown>
  const provider = body.provider
  const model = body.model
  if (typeof provider !== 'string' || typeof model !== 'string') {
    return {
      ok: false,
      status: HTTP_BAD_REQUEST,
      code: CONFIG_ERROR.invalidField,
      message: 'provider and model must both be strings',
    }
  }

  const nextProvider = provider.trim()
  const nextModel = model.trim()
  if (
    nextProvider.length > MAX_SELECTION_FIELD_LENGTH ||
    nextModel.length > MAX_SELECTION_FIELD_LENGTH
  ) {
    return {
      ok: false,
      status: HTTP_BAD_REQUEST,
      code: CONFIG_ERROR.invalidField,
      message: `provider and model must each be at most ${MAX_SELECTION_FIELD_LENGTH} characters`,
    }
  }

  if ((nextProvider.length === 0) !== (nextModel.length === 0)) {
    return {
      ok: false,
      status: HTTP_BAD_REQUEST,
      code: CONFIG_ERROR.incompleteSelection,
      message: 'provider and model must be set together, or both left empty',
    }
  }

  const revision = body.revision
  if (
    revision !== undefined &&
    (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0)
  ) {
    return {
      ok: false,
      status: HTTP_BAD_REQUEST,
      code: CONFIG_ERROR.invalidField,
      message: 'revision must be a non-negative integer when present',
    }
  }

  return {
    ok: true,
    provider: nextProvider,
    model: nextModel,
    ...(revision === undefined ? {} : { revision: revision as number }),
  }
}

/**
 * Build the route handler.
 *
 * Kept as a factory over structural deps so tests can drive it with a fake
 * request/response pair, a fake `llm`, and a fake settings service — no
 * listening socket, no Cordis composition.
 */
export function makeConfigHandler(deps: ConfigApiDeps): WebRouteLike['handler'] {
  const log = deps.log ?? (() => {})

  const fail = (
    res: Parameters<WebRouteLike['handler']>[1],
    status: number,
    code: string,
    message: string,
  ): void => {
    sendError(res, status, code, message)
  }

  return async (req, res) => {
    const method = req.method ?? 'GET'

    if (method !== 'GET' && method !== 'POST') {
      res.setHeader('allow', CONFIG_ROUTE_ALLOW)
      fail(res, HTTP_METHOD_NOT_ALLOWED, CONFIG_ERROR.methodNotAllowed, 'method not allowed')
      return
    }

    if (method === 'GET') {
      try {
        sendJson(res, HTTP_OK, await readPayload(deps))
      } catch (error) {
        // Never leak a stack trace or a filesystem path.
        log(`a2a: config GET failed: ${String(error)}`)
        fail(res, HTTP_INTERNAL_SERVER_ERROR, CONFIG_ERROR.internal, 'could not read the configuration')
      }
      return
    }

    // ── POST: every mutation passes the same four gates ────────────────────
    if (!isSameAuthorityMutation(req)) {
      fail(
        res,
        HTTP_FORBIDDEN,
        CONFIG_ERROR.crossSite,
        'cross-site configuration writes are refused; open the plugin page on this Harness',
      )
      return
    }

    if (!isJsonRequest(req)) {
      fail(
        res,
        HTTP_UNSUPPORTED_MEDIA_TYPE,
        CONFIG_ERROR.unsupportedMediaType,
        'content-type must be application/json',
      )
      return
    }

    // Read the body ONCE: the stream can only be consumed one time, so the generic
    // `ops` path and the model-selection path share this read.
    let raw: Buffer
    try {
      raw = await readBody(req, MAX_CONFIG_BODY_BYTES)
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        fail(res, HTTP_PAYLOAD_TOO_LARGE, CONFIG_ERROR.payloadTooLarge, `request body must not exceed ${MAX_CONFIG_BODY_BYTES} bytes`)
        return
      }
      fail(res, HTTP_BAD_REQUEST, CONFIG_ERROR.invalidBody, 'could not read request body')
      return
    }
    const text = raw.toString('utf8')

    // Generic ops path: the config page writes task/workspace settings here because
    // `form.mutate` cannot reach the unconditional-write path (its wrapper fills in
    // the form's own revision). `ctx.settings.mutate(ns, ops, undefined)` is the
    // documented unconditional write.
    let bodyObj: unknown
    try {
      bodyObj = text.length === 0 ? undefined : JSON.parse(text)
    } catch {
      bodyObj = undefined
    }
    if (
      bodyObj !== null &&
      typeof bodyObj === 'object' &&
      !Array.isArray(bodyObj) &&
      Array.isArray((bodyObj as Record<string, unknown>).ops)
    ) {
      const ops = (bodyObj as Record<string, unknown>).ops as Array<Record<string, unknown>>
      // `writeOps` is OPTIONAL only because the route is constructible in tests
      // without a settings backend. A missing writer is NOT a success: answering
      // `200 {ok:true}` here would tell the page "saved" while nothing was written —
      // a silent data loss the operator can only notice by re-reading the profile.
      const writeOps = deps.writeOps
      if (typeof writeOps !== 'function') {
        log('a2a: config ops write refused — no settings writer is wired in this profile')
        fail(
          res,
          HTTP_SERVICE_UNAVAILABLE,
          CONFIG_ERROR.settingsUnavailable,
          'this Host cannot persist configuration edits (no settings writer)',
        )
        return
      }
      try {
        await writeOps(ops)
        sendJson(res, HTTP_OK, { ok: true })
      } catch (error) {
        // The Host's message is the ONLY thing that distinguishes "path is not
        // volatile" from "revision conflict" from "schema rejected". Burying it in a
        // generic 500 is what made the save bug take several rounds to find.
        const detail = error instanceof Error ? error.message : String(error)
        log(`a2a: config ops write failed: ${detail}`)
        fail(res, HTTP_INTERNAL_SERVER_ERROR, CONFIG_ERROR.internal, detail)
      }
      return
    }

    const parsed = parseMutationText(text)
    if (!parsed.ok) {
      fail(res, parsed.status, parsed.code, parsed.message)
      return
    }

    const next: AgentSelection = { provider: parsed.provider, model: parsed.model }

    if (next.provider.length > 0) {
      // Validate against THIS deployment's providers. An unknown provider would
      // create sessions that fail at transport time with no useful diagnostic,
      // so it is refused at the write instead of blamed on the model later.
      const catalog = await readModelCatalog(deps.llm())
      if (!catalog.available) {
        fail(
          res,
          HTTP_SERVICE_UNAVAILABLE,
          CONFIG_ERROR.catalogUnavailable,
          'the model catalog is unavailable, so this provider cannot be verified; try again once the llm service is ready',
        )
        return
      }
      if (!catalog.providers.some((entry) => entry.provider === next.provider)) {
        fail(
          res,
          HTTP_BAD_REQUEST,
          CONFIG_ERROR.unknownProvider,
          `unknown provider: ${next.provider} (this machine advertises ${catalog.providers.length})`,
        )
        return
      }
    }

    try {
      await deps.selection.write(next, { expectedRevision: parsed.revision })
    } catch (error) {
      if (error instanceof SelectionSettingsUnavailableError) {
        log(`a2a: the model pin cannot be persisted through Settings: ${error.message}`)
        fail(res, HTTP_SERVICE_UNAVAILABLE, CONFIG_ERROR.settingsUnavailable, error.message)
        return
      }
      if (error instanceof SelectionConflictError) {
        fail(res, HTTP_CONFLICT, CONFIG_ERROR.selectionConflict, error.message)
        return
      }
      log(`a2a: could not persist the model selection: ${String(error)}`)
      fail(
        res,
        HTTP_INTERNAL_SERVER_ERROR,
        CONFIG_ERROR.internal,
        'could not persist the model selection',
      )
      return
    }

    // Return the FRESH payload, computed from what was just persisted, so the
    // browser can adopt the server's answer instead of keeping its own guess.
    try {
      sendJson(res, HTTP_OK, await readPayload(deps))
    } catch (error) {
      log(`a2a: config POST succeeded but the fresh payload failed: ${String(error)}`)
      fail(
        res,
        HTTP_INTERNAL_SERVER_ERROR,
        CONFIG_ERROR.internal,
        'the selection was saved but could not be re-read',
      )
    }
  }
}

/** Anything that accepts a named route and hands back a disposer. */
export interface ConfigRouteHost {
  register(route: WebRouteLike): () => void
}

/** Mount the configuration route; returns its disposer. */
export function registerConfigRoute(host: ConfigRouteHost, deps: ConfigApiDeps): () => void {
  return host.register({
    kind: 'exact',
    path: CONFIG_ROUTE_PATH,
    handler: makeConfigHandler(deps),
  })
}

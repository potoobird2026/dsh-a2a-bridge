/**
 * Unit tests for `src/config-api.ts` — the same-origin configuration API the
 * browser card calls.
 *
 * The handler takes node `(req, res)` objects, so these tests drive it with a
 * Readable-backed fake request and a capturing fake response. No listening
 * socket, no Cordis composition: what matters is the validation matrix, the
 * catalog degradation, the same-origin gate, and the selection precedence the
 * GUI mirrors.
 *
 * The settings-backed write path is exercised through
 * `createSettingsSelection()` with a fake `settings` service shaped like the
 * real contract (`describe(): SettingsDescriptor[]`,
 * `update(ns, patch, expectedRevision): Promise<void>`, conflicts carry
 * `code: 'SETTINGS_CONFLICT'`).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'

import {
  CONFIG_ERROR,
  makeConfigHandler,
  readModelCatalog,
  type ConfigApiDeps,
} from '../../src/config-api.js'
import {
  createSettingsSelection,
  type AgentSelection,
  type SelectionGateway,
} from '../../src/selection.js'

// ── Fakes ──────────────────────────────────────────────────────────────────

interface CapturedResponse {
  readonly statusCode: number
  readonly headers: Record<string, unknown>
  readonly payload: unknown
}

function makeRequest(options: {
  method: string
  body?: string
  contentType?: string | undefined
  headers?: Record<string, string>
}): IncomingMessage {
  const chunks = options.body === undefined ? [] : [Buffer.from(options.body, 'utf8')]
  const stream = Readable.from(chunks) as unknown as IncomingMessage
  const target = stream as unknown as {
    method: string
    headers: Record<string, string>
  }
  target.method = options.method
  target.headers = { ...(options.headers ?? {}) }
  if (options.contentType !== undefined) target.headers['content-type'] = options.contentType
  return stream
}

function makeResponse(): ServerResponse {
  const headers: Record<string, unknown> = {}
  let statusCode = 0
  let payload: unknown

  const response = {
    get statusCode(): number {
      return statusCode
    },
    headers,
    payload,
    setHeader(name: string, value: unknown): void {
      headers[name.toLowerCase()] = value
    },
    writeHead(status: number, values?: Record<string, unknown>): void {
      statusCode = status
      if (values !== undefined) Object.assign(headers, values)
    },
    end(body?: string): void {
      payload = body === undefined ? undefined : JSON.parse(body)
      ;(response as { payload?: unknown }).payload = payload
    },
  }

  return response as unknown as ServerResponse
}

/**
 * In-memory gateway for the HTTP layer.
 *
 * The handler is backend-agnostic on purpose (`SelectionGateway`), so the
 * fixture does not need the deleted `selection.json` store: a closure-backed
 * object exercises the same contract with no temporary directory. The old
 * file-backed fixture only ever proved "rename() works", which the store's own
 * tests did — and that store is gone.
 */
function makeMemorySelection(): SelectionGateway {
  let current: AgentSelection | undefined
  return {
    read: () => current,
    write: (selection) => {
      // Same contract as the real store: a half-set pair is not a pin, and two
      // empty strings clear it.
      current =
        selection.provider.length > 0 && selection.model.length > 0
          ? { provider: selection.provider, model: selection.model }
          : undefined
    },
  }
}

// ── Fake `settings` service (contract-shaped) ──────────────────────────────

const ENTRY_ID = 'a2a-bridge'

interface ModuleConfig {
  provider: string
  model: string
}

/** Read `inbound.agent` out of a raw config document. */
function agentOf(value: Record<string, unknown>): ModuleConfig | undefined {
  const inbound = value.inbound
  if (inbound === null || typeof inbound !== 'object') return undefined
  const agent = (inbound as Record<string, unknown>).agent
  if (agent === null || typeof agent !== 'object') return undefined
  const pair = agent as Record<string, unknown>
  return {
    provider: typeof pair.provider === 'string' ? pair.provider : '',
    model: typeof pair.model === 'string' ? pair.model : '',
  }
}

interface SettingsState {
  value: Record<string, unknown>
  revision: number
  updates: Array<{ ns: string; patch: Record<string, unknown>; expected: number | undefined }>
}

function makeSettingsState(): SettingsState {
  return { value: {}, revision: 0, updates: [] }
}

/** Deep-assign the patch shape `settings.update` receives. */
function applyPatch(value: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, next] of Object.entries(patch)) {
    if (next !== null && typeof next === 'object' && !Array.isArray(next)) {
      const current = value[key]
      const base = current !== null && typeof current === 'object' && !Array.isArray(current)
        ? (current as Record<string, unknown>)
        : {}
      applyPatch(base, next as Record<string, unknown>)
      value[key] = base
    } else {
      value[key] = next
    }
  }
}

const CONFLICT = Object.assign(new Error('settings changed'), { code: 'SETTINGS_CONFLICT' })

/**
 * A fake `settings` service.
 *
 * `delayMs` makes `update` genuinely asynchronous so a concurrency test can
 * have two writes in flight at once (both read the same revision).
 */
function makeSettings(
  state: SettingsState,
  options: { delayMs?: number; conflictsBeforeSuccess?: number } = {},
): {
  describe: () => unknown[]
  update: (ns: string, patch: object, expectedRevision?: number) => Promise<void>
} {
  let remainingConflicts = options.conflictsBeforeSuccess ?? 0
  return {
    describe: () => [
      { ns: ENTRY_ID, revision: state.revision, schema: {}, value: state.value, applies: 'live' },
    ],
    async update(ns: string, patch: object, expectedRevision?: number): Promise<void> {
      if (options.delayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs))
      }
      if (remainingConflicts > 0) {
        remainingConflicts -= 1
        throw CONFLICT
      }
      if (expectedRevision !== undefined && expectedRevision !== state.revision) throw CONFLICT
      state.updates.push({ ns, patch: patch as Record<string, unknown>, expected: expectedRevision })
      applyPatch(state.value, patch as Record<string, unknown>)
      state.revision += 1
    },
  }
}

function makeSettingsDeps(
  state: SettingsState,
  settings: ReturnType<typeof makeSettings> | undefined,
  options: { llm?: unknown; log?: (message: string) => void } = {},
): ConfigApiDeps {
  return {
    llm: () => options.llm as never, // test double: option is intentionally loose
    selection: createSettingsSelection({
      settings: () => settings,
      entryId: () => ENTRY_ID,
      configSelection: () => agentOf(state.value),
    }),
    configSelection: () => agentOf(state.value),
    ...(options.log === undefined ? {} : { log: options.log }),
  }
}

function makeDeps(options: {
  selection: SelectionGateway
  llm?: unknown
  configSelection?: () => unknown
  hasSelection?: () => boolean
  log?: (message: string) => void
  writeOps?: (ops: ReadonlyArray<Record<string, unknown>>) => Promise<void>
}): ConfigApiDeps {
  return {
    llm: () => options.llm as never, // test double: option is intentionally loose
    selection: options.selection,
    configSelection: options.configSelection ?? (() => undefined),
    // Mirrors the Host wiring: "configured" means a persisted selection or the
    // YAML pin exists. Tests may override it when they are exercising the two
    // sources independently.
    hasSelection: options.hasSelection ?? (() => options.selection.read() !== undefined),
    ...(options.writeOps === undefined ? {} : { writeOps: options.writeOps }),
    ...(options.log === undefined ? {} : { log: options.log }),
  }
}

/**
 * A two-provider catalog shaped EXACTLY like the verified `ctx.llm` contract:
 * `listProviders(): [{ id, name }]`, `listModels(): [{ provider, id, name }]`.
 */
const LLM = {
  listProviders: () => [
    { id: 'deepseek-account', name: 'DeepSeek (account)' },
    { id: 'longcat', name: 'LongCat' },
  ],
  listModels: (provider: string) =>
    provider === 'deepseek-account'
      ? [
          { provider, id: 'deepseek-flash', name: 'DeepSeek Flash' },
          { provider, id: 'deepseek-pro', name: 'DeepSeek Pro' },
        ]
      : [{ provider, id: 'LongCat-2.5-Preview', name: 'LongCat 2.5 Preview' }],
}

const JSON_HEADERS = { 'content-type': 'application/json' }

async function call(
  deps: ConfigApiDeps,
  options: {
    method: string
    body?: string
    contentType?: string | undefined
    headers?: Record<string, string>
  },
): Promise<CapturedResponse> {
  const request = makeRequest(options)
  const response = makeResponse()
  await makeConfigHandler(deps)(request, response)
  return response as unknown as CapturedResponse
}

function bodyOf(response: CapturedResponse): Record<string, unknown> {
  return response.payload as Record<string, unknown>
}

// ── GET ────────────────────────────────────────────────────────────────────

describe('GET /a2a-bridge/config', () => {
  it('reports an UNCONFIGURED deployment with no fallback model', async () => {
    const deps = makeDeps({ selection: makeMemorySelection(), llm: LLM })

    const response = await call(deps, { method: 'GET' })

    expect(response.statusCode).toBe(200)
    expect(response.payload).toEqual({
      provider: '',
      model: '',
      source: 'none',
      configured: false,
      providers: [
        { provider: 'deepseek-account', models: ['deepseek-flash', 'deepseek-pro'] },
        { provider: 'longcat', models: ['LongCat-2.5-Preview'] },
      ],
      catalogAvailable: true,
      // No `agentPresets` service was wired into this fake, so the picker must
      // say "unavailable" — never "this deployment declares no preset".
      presets: [],
      presetsAvailable: false,
      revision: null,
    })
  })

  it('accepts a plain string[] catalog (documented compatibility branch)', async () => {
    const deps = makeDeps({
      selection: makeMemorySelection(),
      llm: {
        listProviders: () => ['alpha', 'beta'],
        listModels: (provider: string) => (provider === 'alpha' ? ['one'] : []),
      },
    })

    const response = await call(deps, { method: 'GET' })

    expect(bodyOf(response).providers).toEqual([
      { provider: 'alpha', models: ['one'] },
      { provider: 'beta', models: [] },
    ])
  })

  it('reports "unavailable" (not "no models") when listProviders is not an array', async () => {
    const deps = makeDeps({
      selection: makeMemorySelection(),
      llm: { listProviders: () => ({ ids: ['a'] }) },
    })

    const response = await call(deps, { method: 'GET' })

    expect(response.statusCode).toBe(200)
    expect(bodyOf(response)).toMatchObject({ providers: [], catalogAvailable: false })
  })

  it('degrades to an empty, unavailable catalog when listProviders throws', async () => {
    const deps = makeDeps({
      selection: makeMemorySelection(),
      llm: {
        listProviders: () => {
          throw new Error('provider registry is still loading')
        },
      },
      configSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }),
      hasSelection: () => true,
    })

    const response = await call(deps, { method: 'GET' })

    expect(response.statusCode).toBe(200)
    expect(bodyOf(response)).toMatchObject({ providers: [], catalogAvailable: false })
    // The effective model is still reported: the page must not look "unset"
    // just because the catalog could not be read.
    expect(bodyOf(response).provider).toBe('deepseek-account')
  })

  it('degrades ONE provider whose listModels throws, keeping the others', async () => {
    const deps = makeDeps({
      selection: makeMemorySelection(),
      llm: {
        listProviders: () => [{ id: 'broken' }, { id: 'healthy' }],
        listModels: (provider: string) => {
          if (provider === 'broken') throw new Error('adapter offline')
          return [{ provider, id: 'ok-model' }]
        },
      },
    })

    const response = await call(deps, { method: 'GET' })

    expect(bodyOf(response).providers).toEqual([
      { provider: 'broken', models: [] },
      { provider: 'healthy', models: ['ok-model'] },
    ])
    expect(bodyOf(response).catalogAvailable).toBe(true)
  })

  it('handles a missing llm service without failing the request', async () => {
    const deps = makeDeps({ selection: makeMemorySelection() })

    const response = await call(deps, { method: 'GET' })

    expect(response.statusCode).toBe(200)
    expect(response.payload).toMatchObject({
      providers: [],
      provider: '',
      model: '',
      catalogAvailable: false,
    })
  })

  it('reports a saved selection as pinned and lets it beat the YAML pin', async () => {
    const selection = makeMemorySelection()
    selection.write({ provider: 'longcat', model: 'LongCat-2.5-Preview' })

    const deps = makeDeps({
      selection,
      llm: LLM,
      configSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-pro' }),
      hasSelection: () => true,
    })

    const response = await call(deps, { method: 'GET' })

    expect(response.payload).toMatchObject({
      provider: 'longcat',
      model: 'LongCat-2.5-Preview',
      source: 'pinned',
      configured: true,
    })
  })

  it('reports the YAML pin as pinned when no GUI selection exists', async () => {
    const deps = makeDeps({
      selection: makeMemorySelection(),
      llm: LLM,
      configSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-pro' }),
      hasSelection: () => true,
    })

    const response = await call(deps, { method: 'GET' })

    expect(response.payload).toMatchObject({
      provider: 'deepseek-account',
      model: 'deepseek-pro',
      source: 'pinned',
      configured: true,
    })
  })

  it('reads a VOLATILE config pin (`.get()` accessors), not a phantom string', async () => {
    // `inbound.agent` is `.volatile()` in src/config.ts, so at runtime each
    // field is `{ get(): string }`. A plain `typeof === 'string'` check made the
    // YAML pin unreachable; this pins the fix.
    const deps = makeDeps({
      selection: makeMemorySelection(),
      llm: LLM,
      configSelection: () => ({
        provider: { get: () => 'longcat' },
        model: { get: () => 'LongCat-2.5-Preview' },
      }),
      hasSelection: () => true,
    })

    const response = await call(deps, { method: 'GET' })

    expect(response.payload).toMatchObject({
      provider: 'longcat',
      model: 'LongCat-2.5-Preview',
      configured: true,
    })
  })

  it('treats a half-set YAML pin (string + volatile half) as unset', async () => {
    const deps = makeDeps({
      selection: makeMemorySelection(),
      llm: LLM,
      configSelection: () => ({ provider: { get: () => 'deepseek-account' } }),
      hasSelection: () => false,
    })

    const response = await call(deps, { method: 'GET' })

    expect(response.payload).toMatchObject({
      provider: '',
      model: '',
      source: 'none',
      configured: false,
    })
  })

  it('reports the settings revision and the volatile selection', async () => {
    const state = makeSettingsState()
    state.value = { inbound: { agent: { provider: 'longcat', model: 'LongCat-2.5-Preview' } } }
    state.revision = 4
    const settings = makeSettings(state)
    const deps = makeSettingsDeps(state, settings, { llm: LLM })

    const response = await call(deps, { method: 'GET' })

    expect(response.payload).toMatchObject({
      provider: 'longcat',
      model: 'LongCat-2.5-Preview',
      source: 'pinned',
      configured: true,
      revision: 4,
    })
  })

  it('does not leak internals when the backing store itself throws', async () => {
    const messages: string[] = []
    const deps = makeDeps({
      selection: {
        read: () => {
          throw new Error('C:\\Users\\someone\\secret\\selection.json is unreadable')
        },
        write: () => {},
      },
      llm: LLM,
      log: (message) => messages.push(message),
    })

    const response = await call(deps, { method: 'GET' })

    expect(response.statusCode).toBe(500)
    expect(bodyOf(response).code).toBe(CONFIG_ERROR.internal)
    expect(JSON.stringify(response.payload)).not.toContain('C:\\\\Users')
    // …but it IS logged, so the failure is never silently swallowed.
    expect(messages.join('\n')).toContain('unreadable')
  })
})

// ── POST ───────────────────────────────────────────────────────────────────

describe('POST /a2a-bridge/config', () => {
  it('persists a valid selection and answers with the fresh payload', async () => {
    const selection = makeMemorySelection()
    const deps = makeDeps({ selection, llm: LLM })

    const response = await call(deps, {
      method: 'POST',
      contentType: JSON_HEADERS['content-type'],
      body: JSON.stringify({ provider: 'deepseek-account', model: 'deepseek-pro' }),
    })

    expect(response.statusCode).toBe(200)
    expect(response.payload).toMatchObject({
      provider: 'deepseek-account',
      model: 'deepseek-pro',
      source: 'pinned',
    })
    expect(selection.read()).toEqual({ provider: 'deepseek-account', model: 'deepseek-pro' })
  })

  it('trims the submitted pair', async () => {
    const selection = makeMemorySelection()
    const deps = makeDeps({ selection, llm: LLM })

    await call(deps, {
      method: 'POST',
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ provider: '  deepseek-account  ', model: ' deepseek-flash ' }),
    })

    expect(selection.read()).toEqual({ provider: 'deepseek-account', model: 'deepseek-flash' })
  })

  it('clears the selection with two empty strings and reports the unconfigured state', async () => {
    const selection = makeMemorySelection()
    selection.write({ provider: 'longcat', model: 'LongCat-2.5-Preview' })
    const deps = makeDeps({ selection, llm: LLM })

    const response = await call(deps, {
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({ provider: '', model: '' }),
    })

    expect(response.statusCode).toBe(200)
    expect(response.payload).toMatchObject({
      provider: '',
      model: '',
      source: 'none',
      configured: false,
    })
    expect(selection.read()).toBeUndefined()
  })

  it('rejects an unknown provider with 400 and leaves the file untouched', async () => {
    const selection = makeMemorySelection()
    selection.write({ provider: 'longcat', model: 'LongCat-2.5-Preview' })
    const deps = makeDeps({ selection, llm: LLM })

    const response = await call(deps, {
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({ provider: 'not-installed', model: 'some-model' }),
    })

    expect(response.statusCode).toBe(400)
    expect(bodyOf(response).code).toBe(CONFIG_ERROR.unknownProvider)
    expect(String(bodyOf(response).error)).toContain('unknown provider')
    expect(selection.read()).toEqual({ provider: 'longcat', model: 'LongCat-2.5-Preview' })
  })

  it('answers 503 (not 400) when the catalog is unavailable, so "unverifiable" ≠ "invalid"', async () => {
    const deps = makeDeps({ selection: makeMemorySelection() })

    const response = await call(deps, {
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({ provider: 'deepseek-account', model: 'deepseek-flash' }),
    })

    expect(response.statusCode).toBe(503)
    expect(bodyOf(response).code).toBe(CONFIG_ERROR.catalogUnavailable)
  })

  it('rejects non-string fields with 400', async () => {
    const deps = makeDeps({ selection: makeMemorySelection(), llm: LLM })

    for (const body of [
      '{"provider":1,"model":"m"}',
      '{"provider":"deepseek-account"}',
      '{"provider":"deepseek-account","model":null}',
    ]) {
      const response = await call(deps, {
        method: 'POST',
        contentType: 'application/json',
        body,
      })
      expect(response.statusCode, body).toBe(400)
      expect(bodyOf(response).code).toBe(CONFIG_ERROR.invalidField)
    }
  })

  it('rejects a field longer than the ceiling and names the limit', async () => {
    const deps = makeDeps({ selection: makeMemorySelection(), llm: LLM })

    const response = await call(deps, {
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({ provider: 'p'.repeat(201), model: 'm' }),
    })

    expect(response.statusCode).toBe(400)
    expect(bodyOf(response).code).toBe(CONFIG_ERROR.invalidField)
    expect(String(bodyOf(response).error)).toContain('200')
  })

  it('accepts a field exactly at the ceiling', async () => {
    const state = makeSettingsState()
    const settings = makeSettings(state)
    // The catalog must contain the 200-char provider for the write to pass
    // membership; a fake catalog keeps this test about the length boundary.
    const provider = 'p'.repeat(200)
    const deps = makeSettingsDeps(state, settings, {
      llm: { listProviders: () => [{ id: provider, name: provider }], listModels: () => [] },
    })

    const response = await call(deps, {
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({ provider, model: 'm' }),
    })

    expect(response.statusCode).toBe(200)
  })

  it('rejects a half-set pair, which would create an unusable agent', async () => {
    const deps = makeDeps({ selection: makeMemorySelection(), llm: LLM })

    for (const body of [
      '{"provider":"deepseek-account","model":""}',
      '{"provider":"","model":"deepseek-flash"}',
    ]) {
      const response = await call(deps, {
        method: 'POST',
        contentType: 'application/json',
        body,
      })
      expect(response.statusCode, body).toBe(400)
      expect(bodyOf(response).code).toBe(CONFIG_ERROR.incompleteSelection)
    }
  })

  it('rejects an empty body and malformed JSON with 400', async () => {
    const deps = makeDeps({ selection: makeMemorySelection(), llm: LLM })

    for (const body of ['', '{oops']) {
      const response = await call(deps, {
        method: 'POST',
        contentType: 'application/json',
        body,
      })
      expect(response.statusCode, body).toBe(400)
      expect(bodyOf(response).code).toBe(CONFIG_ERROR.invalidBody)
    }
  })

  it('rejects a JSON array body with 400', async () => {
    const deps = makeDeps({ selection: makeMemorySelection(), llm: LLM })

    const response = await call(deps, {
      method: 'POST',
      contentType: 'application/json',
      body: '[]',
    })

    expect(response.statusCode).toBe(400)
  })

  it('rejects an invalid revision with 400', async () => {
    const deps = makeDeps({ selection: makeMemorySelection(), llm: LLM })

    for (const revision of [-1, 1.5, '3', null]) {
      const response = await call(deps, {
        method: 'POST',
        contentType: 'application/json',
        body: JSON.stringify({ provider: 'deepseek-account', model: 'deepseek-flash', revision }),
      })
      expect(response.statusCode, String(revision)).toBe(400)
    }
  })

  it('refuses a non-JSON content type (which also blocks a form CSRF post)', async () => {
    const deps = makeDeps({ selection: makeMemorySelection(), llm: LLM })

    const response = await call(deps, {
      method: 'POST',
      contentType: 'text/plain',
      body: JSON.stringify({ provider: 'deepseek-account', model: 'deepseek-flash' }),
    })

    expect(response.statusCode).toBe(415)
    expect(bodyOf(response).code).toBe(CONFIG_ERROR.unsupportedMediaType)
  })

  it('refuses an oversized body with 413', async () => {
    const deps = makeDeps({ selection: makeMemorySelection(), llm: LLM })

    const response = await call(deps, {
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({ provider: 'p'.repeat(5_000), model: 'm' }),
    })

    expect(response.statusCode).toBe(413)
  })
})

// ── POST through the settings channel (the supported backend) ──────────────

describe('POST /a2a-bridge/config via settings', () => {
  it('writes inbound.agent into the plugin Config at the current revision', async () => {
    const state = makeSettingsState()
    state.revision = 3
    const settings = makeSettings(state)
    const deps = makeSettingsDeps(state, settings, { llm: LLM })

    const response = await call(deps, {
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({ provider: 'longcat', model: 'LongCat-2.5-Preview' }),
    })

    expect(response.statusCode).toBe(200)
    expect(state.updates).toHaveLength(1)
    expect(state.updates[0]).toEqual({
      ns: ENTRY_ID,
      patch: { inbound: { agent: { provider: 'longcat', model: 'LongCat-2.5-Preview' } } },
      expected: 3,
    })
    // The response reflects the just-committed value, not the pre-write state.
    expect(response.payload).toMatchObject({
      provider: 'longcat',
      model: 'LongCat-2.5-Preview',
      revision: 4,
      configured: true,
    })
  })

  it('clears the pin by writing two empty strings (A2A stays unconfigured)', async () => {
    const state = makeSettingsState()
    state.value = { inbound: { agent: { provider: 'longcat', model: 'LongCat-2.5-Preview' } } }
    const settings = makeSettings(state)
    const deps = makeSettingsDeps(state, settings, { llm: LLM })

    const response = await call(deps, {
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({ provider: '', model: '' }),
    })

    expect(response.statusCode).toBe(200)
    expect(response.payload).toMatchObject({ provider: '', configured: false, source: 'none' })
    expect(agentOf(state.value)).toEqual({ provider: '', model: '' })
  })

  it('answers 503 with an actionable message when the settings service is absent', async () => {
    const state = makeSettingsState()
    const deps = makeSettingsDeps(state, undefined, { llm: LLM })

    const response = await call(deps, {
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({ provider: 'longcat', model: 'LongCat-2.5-Preview' }),
    })

    expect(response.statusCode).toBe(503)
    expect(bodyOf(response).code).toBe(CONFIG_ERROR.settingsUnavailable)
    expect(String(bodyOf(response).error)).toContain('Settings')
  })

  it('answers 503 when the plugin is not a profile entry (no addressable namespace)', async () => {
    const state = makeSettingsState()
    const settings = makeSettings(state)
    const deps: ConfigApiDeps = {
      llm: () => LLM,
      selection: createSettingsSelection({
        settings: () => settings,
        entryId: () => undefined,
        configSelection: () => agentOf(state.value),
      }),
    }

    const response = await call(deps, {
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({ provider: 'longcat', model: 'LongCat-2.5-Preview' }),
    })

    expect(response.statusCode).toBe(503)
    expect(String(bodyOf(response).error)).toContain('profile entry')
  })

  it('retries ONE revision conflict (the browser cannot send a revision)', async () => {
    const state = makeSettingsState()
    const settings = makeSettings(state, { conflictsBeforeSuccess: 1 })
    // One shared state object, so the retry sees the new revision.
    const deps: ConfigApiDeps = {
      llm: () => LLM,
      selection: createSettingsSelection({
        settings: () => settings,
        entryId: () => ENTRY_ID,
        configSelection: () => agentOf(state.value),
      }),
      configSelection: () => agentOf(state.value),
    }

    const response = await call(deps, {
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({ provider: 'longcat', model: 'LongCat-2.5-Preview' }),
    })

    expect(response.statusCode).toBe(200)
    expect(state.revision).toBe(1)
  })

  it('answers 409 when the caller pinned a stale revision (CAS is honoured)', async () => {
    const state = makeSettingsState()
    state.revision = 5
    const settings = makeSettings(state)
    const deps = makeSettingsDeps(state, settings, { llm: LLM })

    const response = await call(deps, {
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({
        provider: 'longcat',
        model: 'LongCat-2.5-Preview',
        revision: 4,
      }),
    })

    expect(response.statusCode).toBe(409)
    expect(bodyOf(response).code).toBe(CONFIG_ERROR.selectionConflict)
    expect(state.updates).toHaveLength(0)
  })

  it('keeps overlapping writes consistent: both settle, last commit wins', async () => {
    const state = makeSettingsState()
    const settings = makeSettings(state, { delayMs: 5 })
    const deps = makeSettingsDeps(state, settings, { llm: LLM })

    const [first, second] = await Promise.all([
      call(deps, {
        method: 'POST',
        contentType: 'application/json',
        body: JSON.stringify({ provider: 'longcat', model: 'LongCat-2.5-Preview' }),
      }),
      call(deps, {
        method: 'POST',
        contentType: 'application/json',
        body: JSON.stringify({ provider: 'deepseek-account', model: 'deepseek-pro' }),
      }),
    ])

    expect([first.statusCode, second.statusCode]).toEqual([200, 200])
    expect(state.revision).toBe(2)
    // Whichever finished last is what the document holds; both pairs are valid.
    expect([
      { provider: 'longcat', model: 'LongCat-2.5-Preview' },
      { provider: 'deepseek-account', model: 'deepseek-pro' },
    ]).toContainEqual(agentOf(state.value))
  })
})

// ── Same-origin / CSRF gate ────────────────────────────────────────────────

describe('same-origin gate', () => {
  const VALID = JSON.stringify({ provider: 'longcat', model: 'LongCat-2.5-Preview' })

  it('refuses a browser request marked cross-site', async () => {
    const deps = makeDeps({ selection: makeMemorySelection(), llm: LLM })

    const response = await call(deps, {
      method: 'POST',
      contentType: 'application/json',
      body: VALID,
      headers: { 'sec-fetch-site': 'cross-site', host: '127.0.0.1:43120' },
    })

    expect(response.statusCode).toBe(403)
    expect(bodyOf(response).code).toBe(CONFIG_ERROR.crossSite)
  })

  it('refuses an Origin whose authority differs from Host', async () => {
    const deps = makeDeps({ selection: makeMemorySelection(), llm: LLM })

    const response = await call(deps, {
      method: 'POST',
      contentType: 'application/json',
      body: VALID,
      headers: { origin: 'http://evil.example', host: '127.0.0.1:43120' },
    })

    expect(response.statusCode).toBe(403)
  })

  it('accepts a same-authority Origin (the real GUI case)', async () => {
    const state = makeSettingsState()
    const settings = makeSettings(state)
    const deps = makeSettingsDeps(state, settings, { llm: LLM })

    const response = await call(deps, {
      method: 'POST',
      contentType: 'application/json',
      body: VALID,
      headers: { origin: 'http://127.0.0.1:43120', host: '127.0.0.1:43120' },
    })

    expect(response.statusCode).toBe(200)
  })

  it('normalises default ports (http :80 on both sides)', async () => {
    const state = makeSettingsState()
    const settings = makeSettings(state)
    const deps = makeSettingsDeps(state, settings, { llm: LLM })

    const response = await call(deps, {
      method: 'POST',
      contentType: 'application/json',
      body: VALID,
      headers: { origin: 'http://127.0.0.1', host: '127.0.0.1:80' },
    })

    expect(response.statusCode).toBe(200)
  })

  it('still accepts a non-browser client with no Origin/Host (tests, curl)', async () => {
    const state = makeSettingsState()
    const settings = makeSettings(state)
    const deps = makeSettingsDeps(state, settings, { llm: LLM })

    const response = await call(deps, {
      method: 'POST',
      contentType: 'application/json',
      body: VALID,
    })

    expect(response.statusCode).toBe(200)
  })
})

// ── Other methods + catalog helper ─────────────────────────────────────────

describe('method handling', () => {
  it('answers 405 with an Allow header for anything but GET/POST', async () => {
    const deps = makeDeps({ selection: makeMemorySelection(), llm: LLM })

    const response = await call(deps, { method: 'PUT' })

    expect(response.statusCode).toBe(405)
    expect(response.headers.allow).toBe('GET, POST')
    expect(bodyOf(response).code).toBe(CONFIG_ERROR.methodNotAllowed)
  })
})

describe('readModelCatalog', () => {
  it('reports availability so the UI can distinguish "none" from "unavailable"', async () => {
    await expect(readModelCatalog(undefined)).resolves.toEqual({
      providers: [],
      available: false,
      failure: 'service-missing',
    })
    await expect(readModelCatalog({ listProviders: () => [] })).resolves.toEqual({
      providers: [],
      available: true,
    })
  })

  it('treats a non-array provider answer as unreadable, not empty', async () => {
    for (const answer of [undefined, null, 'deepseek', { id: 'a' }]) {
      const catalog = await readModelCatalog({ listProviders: () => answer })
      expect(catalog.available, String(answer)).toBe(false)
      expect(catalog.failure).toBe('unreadable')
    }
  })

  it('accepts only the verified shapes: {id} metadata and (compat) bare ids', async () => {
    const catalog = await readModelCatalog({
      // `{ provider: 'c' }` and `{ model: 'd' }` are NOT LlmProviderInfo: the
      // verified contract carries `id`, so guessing another key is forbidden.
      listProviders: () => ['a', 'a', 42, null, { id: 'b' }, { provider: 'c' }, { id: '' }],
      listModels: () => ['m', 'm', { id: 'n' }, {}, { model: 'd' }, { id: '' }],
    })

    expect(catalog.providers).toEqual([
      { provider: 'a', models: ['m', 'n'] },
      { provider: 'b', models: ['m', 'n'] },
    ])
  })

  it('skips a model entry that reports a foreign provider route', async () => {
    const catalog = await readModelCatalog({
      listProviders: () => [{ id: 'wanted' }],
      listModels: () => [
        { provider: 'wanted', id: 'ok' },
        { provider: 'other', id: 'foreign' },
      ],
    })

    expect(catalog.providers).toEqual([{ provider: 'wanted', models: ['ok'] }])
  })
})
// ── POST /a2a-bridge/config : the {ops} branch ──────────────────────────────
//
// This branch had ZERO coverage, which is how a silent data-loss bug survived:
// `await deps.writeOps?.(ops)` with an absent writer short-circuits, then the route
// answered 200 {ok:true} — the page said "saved" while nothing was written.
describe('POST /a2a-bridge/config {ops}', () => {
  const OPS = [{ op: 'set', path: ['inbound', 'tasks', 'retentionMs'], value: 86400000 }]

  it('REFUSES when no settings writer is wired (never answers ok:true)', async () => {
    const deps = makeDeps({ selection: makeMemorySelection() })
    const response = await call(deps, {
      method: 'POST',
      contentType: JSON_HEADERS['content-type'],
      body: JSON.stringify({ ops: OPS }),
    })
    // 503 + settings_unavailable: the operator must never see a false success.
    expect(response.statusCode).toBe(503)
    const payload = bodyOf(response)
    expect(payload.code).toBe('settings_unavailable')
    // And critically: nothing in the response may look like success.
    expect(payload.ok).toBeUndefined()
    expect(payload.ok === true).toBe(false)
  })

  it('writes the ops through the injected writer and reports success', async () => {
    const seen: Array<ReadonlyArray<Record<string, unknown>>> = []
    const deps = makeDeps({
      selection: makeMemorySelection(),
      writeOps: async (ops) => {
        seen.push(ops)
      },
    })
    const response = await call(deps, {
      method: 'POST',
      contentType: JSON_HEADERS['content-type'],
      body: JSON.stringify({ ops: OPS }),
    })
    expect(response.statusCode).toBe(200)
    expect(bodyOf(response)).toMatchObject({ ok: true })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual(OPS)
  })

  it('surfaces the Host message when the writer rejects', async () => {
    // The Host message is the only thing that distinguishes "not volatile" from
    // "revision conflict"; swallowing it is what made the save bug hard to find.
    const deps = makeDeps({
      selection: makeMemorySelection(),
      writeOps: async () => {
        throw new Error('Config field "inbound.tasks.retentionMs" is not volatile')
      },
    })
    const response = await call(deps, {
      method: 'POST',
      contentType: JSON_HEADERS['content-type'],
      body: JSON.stringify({ ops: OPS }),
    })
    expect(response.statusCode).toBe(500)
    expect(JSON.stringify(bodyOf(response))).toContain('is not volatile')
  })
})
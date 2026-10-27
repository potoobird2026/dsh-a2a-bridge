/**
 * dsh-a2a-bridge — Cordis plugin entry.
 *
 * Assembles three layers:
 *   inbound  — we serve an A2A v1.0 endpoint to remote peers
 *   outbound — we delegate to remote peers as a subagent provider + tools
 *   session  — ADR-007: every A2A conversation is a visible DSH session
 *
 * `inject` deliberately lists ONLY `agents`. `webServer` is probed with
 * `ctx.get()`: a hard inject on a profile that never provides it leaves the
 * plugin permanently pending (verified against obsidian-bridge on this
 * machine). `subagents` / `tools` / `credentials` are probed for the same
 * reason — a composition without them still boots with the rest serving.
 */

import {
  Config,
  assertConfigCoherent,
  configuredAgentPreset,
  resolveTaskDir,
  resolveWorkspaceRoot,
  type A2ABridgeConfig,
} from './config.js'
import { TaskStore, volatileNumberOr } from './inbound/task-store.js'
import { registerInboundRoutes, type InboundDeps } from './inbound/routes.js'
import { InboundServer } from './inbound/server.js'
import { createDispatcher } from './inbound/dispatch.js'
import { describeSeams, probeSeams } from './diagnostics.js'
import { HOST_MESSAGES } from './messages.js'
import {
  InboundExecutor,
  cardForDeployment,
  type AgentsLike,
} from './inbound/executor.js'
import {
  listAgentPresetIds,
  mountAgentPresetOn,
  resolveAgentPreset,
  type AgentPresetDirectoryLike,
} from './inbound/preset.js'
import { A2aSubagentProvider } from './outbound/provider.js'
import { buildOutboundTools } from './outbound/tools.js'
import { SessionMirror } from './session/events.js'
import { asWorkspaceRegistry } from './session/session-binding.js'
import { RateLimiter, identifyPeer } from './security/index.js'
import type { PeerIdentity } from './types.js'
import {
  type ConfigRouteHost,
  type LlmLike,
  readModelCatalog,
  registerConfigRoute,
} from './config-api.js'
import {
  completeSelection,
  createSettingsSelection,
  resolveProfileEntryId,
  type SettingsLike,
} from './selection.js'
import { versionNotSupported } from './protocol/jsonrpc.js'
import {
  DEFAULT_TASK_MAX_RECORDS,
  DEFAULT_TASK_RETENTION_MS,
  SEAM_PROBE_DELAY_MS,
  SETTINGS_WRITE_ATTEMPTS,
} from './constants.js'
import { unwrapVolatile } from './selection.js'


export const name = 'dsh-a2a-bridge'

/** Hard dependency only. Everything else is probed. */
export const inject = ['agents']

export { Config }

/** Mirrors package.json; asserted by scripts/verify-version.mjs. */
export const PLUGIN_VERSION = '0.1.0'

// ── Minimal structural typings (no Cordis import) ──────────────────────────

interface CredentialsLike {
  resolve(ref: string): Promise<{ value: string } | undefined>
}

interface SubagentsLike {
  registerProvider(provider: unknown): () => void
}

interface ToolsLike {
  register(tool: unknown): () => void
}

interface LoggerLike {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

interface EffectContext {
  readonly agents: AgentsLike
  readonly logger: LoggerLike
  get(name: string): unknown
  effect(callback: () => (() => void) | void, label?: string): () => void
  /**
   * `ctx.plugin({ inject, apply: callback })` shorthand. The callback runs in a
   * scoped child fiber once EVERY listed service is active — that is the only
   * correct way to use a service that is not in this plugin's static `inject`.
   */
  inject(deps: string[], callback: () => void): unknown
}

// ── Entry ──────────────────────────────────────────────────────────────────

export function apply(ctx: EffectContext, config: A2ABridgeConfig): void {
  assertConfigCoherent(config)

  const logger = ctx.logger

  /**
   * Resolve the credential seam LAZILY, per call.
   *
   * `ctx.get('credentials')` inside `apply()` returns undefined: Cordis only
   * activates the services named in the plugin's `inject` array, and every
   * other service appears later in the composition. Capturing it once here
   * pinned it to undefined forever, so every inbound request answered 401 with
   * no diagnostic beyond "unauthorized".
   */
  const credentialsNow = (): CredentialsLike | undefined =>
    ctx.get('credentials') as CredentialsLike | undefined

  if (credentialsNow() === undefined) {
    logger.info(
      'a2a: the "credentials" service is not active yet; peer tokens will be resolved lazily per request',
    )
  }

  /**
   * Resolve every peer secret. Called PER REQUEST and never cached: that read
   * is what makes a rotated credential reach the very next request.
   */
  const resolvePeerSecrets = async (): Promise<Map<PeerIdentity, string>> => {
    const resolved = new Map<PeerIdentity, string>()
    const credentials = credentialsNow()
    if (credentials === undefined) {
      logger.warn(
        'a2a: the "credentials" service is still unavailable; every inbound request will be rejected as unauthorized',
      )
      return resolved
    }
    for (const [peer, entry] of Object.entries(config.inbound.peers)) {
      try {
        const hit = await credentials.resolve(entry.tokenEnv)
        if (hit !== undefined && hit.value.length > 0) {
          resolved.set(peer, hit.value)
        } else {
          logger.warn(
            `a2a: credential ref "${entry.tokenEnv}" for peer "${peer}" resolved to nothing; ` +
              'that peer will be rejected as unauthorized',
          )
        }
      } catch (error) {
        logger.warn(`a2a: could not resolve credential for peer "${peer}": ${String(error)}`)
      }
    }
    return resolved
  }

  const resolveToken = async (tokenEnv: string | undefined): Promise<string | undefined> => {
    const credentials = credentialsNow()
    if (tokenEnv === undefined || credentials === undefined) return undefined
    const hit = await credentials.resolve(tokenEnv)
    return hit?.value
  }

  // ── Session visibility (ADR-007) ─────────────────────────────────────────
  /**
   * The workspace registry, resolved LAZILY on every use.
   *
   * WHY LAZY: `ctx.get()` only answers for services this plugin's static
   * `inject` list has activated, and Cordis activates those over time. Reading it
   * once during `apply()` therefore pinned it to `undefined` FOREVER, and
   * `ensureWorkspace()` then returned nothing — so the A2A workspace row was
   * never created at all and every A2A session stayed ungrouped. That is the same
   * trap `credentialsNow()` and `agentPresetsNow()` exist to avoid.
   *
   * A profile without the service still loads this plugin; it just cannot group
   * sessions under the A2A row, and says so on first use.
   */
  let warnedMissingRegistry = false
  const workspaceRegistry = (): ReturnType<typeof asWorkspaceRegistry> => {
    const resolved = asWorkspaceRegistry(ctx.get('workspaceRegistry'))
    if (resolved === undefined && !warnedMissingRegistry) {
      warnedMissingRegistry = true
      logger.warn(
        'a2a: workspaceRegistry is unavailable — A2A sessions stay visible but will not be grouped into the A2A workspace',
      )
    }
    return resolved
  }
  /**
   * The workspace root, resolved LAZILY on every use.
   *
   * `isolation.workspaceRoot` defaults to the empty string in the shipped
   * Config; empty means "derive `<DSH_HOME>/a2a-workspaces` from the running
   * Harness" (see `resolveWorkspaceRoot`). It is `.volatile()`, so a plugin-page
   * save updates the running Config in place — resolving it once here pinned the
   * string for the whole process, and a user who changed the path kept writing
   * into the old root until DSH restarted. A getter keeps the model/preset
   * promise ("the next turn uses it") true for this field as well.
   *
   * The closure is also why both consumers agree: they call the same function
   * instead of each receiving a (possibly stale) copy.
   */
  const workspaceRoot = (): string => resolveWorkspaceRoot(config, ctx)
  // One startup SAMPLE, clearly labelled as such: it tells the operator where
  // the first session will land without pretending the value is fixed.
  logger.info(
    `a2a: peer workspaces are created under ${workspaceRoot()} (current value; re-read for every new session)`,
  )

  const mirror = new SessionMirror({
    registry: workspaceRegistry,
    agents: ctx.agents,
    workspaceRoot,
    workspaceMode: config.inbound.isolation.workspaceMode,
    contextIdPrefix: config.session.contextIdPrefix,
    workspaceTitlePrefix: config.session.workspaceTitlePrefix,
    mirrorRemoteProgress: config.session.mirrorRemoteProgress,
    /**
     * Move an A2A session's EFFECTIVE working directory to its own subdirectory.
     *
     * Why this is not simply the header cwd: `workspaceRegistry.attachSession`
     * requires the stored header cwd to EQUAL the workspace path
     * (`@deepseek-ai/dsh-workspace` `lib/index.js:122`), so the header keeps the
     * shared root (that is what puts the conversation in the A2A workspace) and
     * the per-peer directory is applied HERE — the tools (`dsh-tool-pwsh`,
     * `dsh-tool-bash`, `dsh-tool-fs`, ...) read `ctx.workingDirectory`, not
     * `header.cwd`, so peer isolation survives.
     *
     * `ctx.get()` is called INSIDE the closure on every use, never captured:
     * like every other probed service in this file, `workingDirectory` is not
     * active while `apply()` runs, so hoisting the lookup would pin it to
     * undefined and silently disable isolation for the whole process.
     */
    setWorkingDirectory: async (agent, path) => {
      const wd = ctx.get('workingDirectory') as
        | { set?: (a: unknown, p: string) => Promise<string> }
        | undefined
      if (wd?.set === undefined) {
        logger.warn(
          HOST_MESSAGES.workingDirectoryUnavailable,
        )
        return
      }
      // Called as `wd.set(...)` (not through a detached reference) so the
      // service method keeps its receiver.
      await wd.set(agent, path)
    },
    log: (message) => logger.warn(message),
  })
  // One teardown for every subscription/agent handle the mirror owns.
  ctx.effect(() => () => mirror.dispose(), 'a2a:session-mirror')

  // ── Model selection (the plugin's own volatile Config, via `settings`) ────
  /**
   * THE ONE SUPPORTED CHANNEL (see `src/selection.ts` for the verified
   * evidence): the pin is this plugin's `inbound.agent` Config field, and the
   * plugin page writes it through the Harness `settings` service. There is no
   * `selection.json` any more — a private file next to the authoritative
   * `cordis.patch.yml` was a second source of truth for one decision.
   *
   * Every dependency is a closure, not a captured value:
   *  - `settings` is `ctx.get(...)` per call, because the service is not active
   *    while `apply()` runs;
   *  - `entryId` is resolved at PLUGIN scope. Inside `ctx.inject([...], ...)`
   *    the context is a child fiber with no entry of its own, so the id would
   *    read as `undefined` and Settings could not address this plugin;
   *  - `configSelection` is the live `Volatile` reference the Loader updates in
   *    place, so a Settings write is visible to the very next A2A turn.
   */
  const selection = createSettingsSelection({
    settings: () => ctx.get('settings') as SettingsLike | undefined,
    entryId: () => resolveProfileEntryId(ctx),
    configSelection: () => config.inbound.agent,
  })
  logger.info('a2a: the A2A model pin lives in this plugin\'s inbound.agent Config (written via Settings)')

  /**
   * The model A2A sessions run on.
   *
   * Re-evaluated on EVERY call — never cached — so a choice made on the plugin
   * page reaches the very next request with no restart. `selection.read()`
   * reads the live volatile reference, which is why the Settings write applies
   * without remounting the plugin.
   *
   * There is deliberately NO deployment-default fallback and no second source:
   * every machine ships a different provider set, so silently borrowing the
   * desktop default would run A2A on a model the operator never chose and could
   * not discover afterwards. An empty result means A2A is UNCONFIGURED and the
   * executor refuses each request with an actionable message
   * (`ModelNotSelectedError`) instead.
   */
  const defaultAgentOptions = (): { provider?: string; model?: string } | undefined => {
    // A half-set pin is not a pin: `completeSelection` returns undefined for it,
    // so an empty field fails loudly rather than creating an unusable agent.
    const selected = completeSelection(selection.read())
    if (selected === undefined) return undefined
    return { provider: selected.provider, model: selected.model }
  }

  /** Whether a model is configured; the GUI renders a warning when it is not. */
  const hasAgentSelection = (): boolean => defaultAgentOptions() !== undefined

  // ── Agent preset (the toolset a session gets) ────────────────────────────
  /**
   * Resolve the preset registry LAZILY, per call.
   *
   * Exactly the trap `credentialsNow()` documents: `ctx.get('agentPresets')`
   * inside `apply()` returns undefined because the registry activates later in
   * the composition, so capturing it once pinned it to undefined forever. For
   * THIS service the consequence is not a 401 — it is that every A2A session
   * would silently be created without a preset and therefore without a single
   * execution tool, which is the defect being fixed.
   */
  const agentPresetsNow = (): AgentPresetDirectoryLike | undefined =>
    ctx.get('agentPresets') as AgentPresetDirectoryLike | undefined

  /**
   * One activation-time diagnostic: which presets does this deployment declare?
   *
   * A MISSING preset is a packaging problem (the `@deepseek-ai/dsh-agent-preset`
   * rows absent from the profile), not a code problem, and it is otherwise
   * invisible until an operator notices that A2A sessions answer but cannot run
   * anything. Listing the roster here turns that into one grep-able line.
   */
  ctx.inject(['agentPresets'], () => {
    void (async () => {
      const roster = await listAgentPresetIds(agentPresetsNow())
      if (!roster.available) {
        logger.warn('a2a: the agentPresets service is active but its preset roster is unreadable')
        return
      }
      logger.info(
        `a2a: this deployment declares agent presets: ${roster.ids.length === 0 ? '(none)' : roster.ids.join(', ')}`,
      )
    })()
  })

  /**
   * The preset every inbound A2A session mounts, resolved with the documented
   * priority (implemented in `src/inbound/preset.ts`, tested there):
   *
   *   1. `config.inbound.agentPreset` — the operator's explicit choice,
   *   2. `agentPresets.resolve()` with the id OMITTED — the deployment default,
   *   3. nothing — logged as a WARNING, because such a session can chat but has
   *      no execution tool and nothing in the A2A response says so.
   */
  const agentPresetFor = async (): Promise<string | undefined> => {
    const resolution = await resolveAgentPreset(configuredAgentPreset(config), agentPresetsNow())
    if (resolution.id === undefined) {
      logger.warn(
        `${HOST_MESSAGES.presetNotConfigured} (${resolution.reason ?? 'no preset configured'}); ${HOST_MESSAGES.presetNotConfiguredHint}`,
      )
      return undefined
    }
    if (resolution.source === 'default') {
      logger.info(
        `a2a: no inbound.agentPreset is pinned; A2A sessions use the deployment default preset "${resolution.id}"`,
      )
    }
    return resolution.id
  }

  /**
   * Mount that preset onto a freshly created agent.
   *
   * `composedPreset()` is the only honest confirmation that the bind took
   * effect, so the effective id is logged next to the requested one: a
   * successful `mount()` that bound nothing would leave the very tool-less
   * session this change exists to prevent, and "mount returned" alone would not
   * reveal it.
   */
  const mountAgentPreset = async (agentCtx: unknown, id: string | undefined): Promise<void> => {
    const effective = await mountAgentPresetOn(agentPresetsNow(), agentCtx, id)
    logger.info(
      `a2a: agent preset mounted requested=${id ?? '(default)'} effective=${effective ?? '(unknown)'}`,
    )
  }

  /**
   * Same-origin configuration API for the browser card.
   *
   * Registered through `ctx.inject` because `webServer` is probed, not injected:
   * a hard requirement would keep this plugin pending on a profile without it.
   * A duplicate-route throw (a second copy of this plugin in one composition)
   * is logged rather than allowed to break the rest of the bridge.
   */
  ctx.inject(['webServer'], () => {
    const webServer = ctx.get('webServer') as ConfigRouteHost | undefined
    if (webServer === undefined) return
    try {
      ctx.effect(
        () =>
          registerConfigRoute(webServer, {
            llm: () => ctx.get('llm') as LlmLike | undefined,
            // The settings-backed gateway: reads the live `inbound.agent`
            // reference and writes it back through `settings.update`. The
            // HTTP layer never learns which backend it got (see `SelectionGateway`).
            selection,
            configSelection: () => config.inbound.agent,
            hasSelection: hasAgentSelection,
            // Generic ops write for the configuration page.
            //
            // Mirrors `createSettingsSelection().write()` exactly, because that path
            // is the one PROVEN to work against this Host: read the revision from
            // `describe()`, call `settings.mutate(ns, ops, revision)`, and on a
            // conflict re-read and retry. The page's `form.mutate` cannot do this
            // (its wrapper substitutes the form's own revision, which is always 0
            // here), which is why every save was refused.
            writeOps: async (ops) => {
              const settings = ctx.get('settings') as
                | {
                    mutate?: (ns: string, ops: unknown, rev?: number) => Promise<void>
                    describe?: (options?: { redactSecrets?: boolean }) => unknown
                  }
                | undefined
              if (settings === undefined || typeof settings.mutate !== 'function') {
                throw new Error('settings.mutate is unavailable in this profile')
              }
              const ns = resolveProfileEntryId(ctx)
              if (ns === undefined) {
                throw new Error('this plugin is not a profile entry, so Settings cannot address it')
              }

              // Read the live revision the same way the working selection path does.
              const readRevision = (): number | undefined => {
                try {
                  const described = settings.describe?.()
                  if (!Array.isArray(described)) return undefined
                  for (const row of described) {
                    const record = row as { ns?: unknown; revision?: unknown }
                    if (record.ns === ns && typeof record.revision === 'number') return record.revision
                  }
                  return undefined
                } catch {
                  return undefined
                }
              }

              for (let attempt = 1; attempt <= SETTINGS_WRITE_ATTEMPTS; attempt++) {
                const revision = readRevision()
                try {
                  await settings.mutate(ns, ops, revision)
                  return
                } catch (error) {
                  // Only a conflict is worth retrying; anything else is a real
                  // rejection (schema, permission) and must reach the caller.
                  const message = error instanceof Error ? error.message : String(error)
                  if (!/revision|conflict/i.test(message)) throw error
                }
              }
              throw new Error('the configuration kept changing while this write was retrying')
            },
            // The preset picker's option source. Lazy like every other service
            // read here, and absent-safe: the route reports "unavailable".
            presets: agentPresetsNow,
            // Errors are logged in full; answers stay path-free.
            log: (message) => logger.error(message),
          }),
        'a2a:config-api',
      )
    } catch (error) {
      logger.error(`a2a: could not register the configuration API: ${String(error)}`)
    }
  })

  // ── Inbound ──────────────────────────────────────────────────────────────
  // Task records live OUTSIDE the workspace root on purpose: the workspace is a
  // directory a peer can list, and the protocol's own bookkeeping must not show up
  // there. Both policy numbers and the directory are getters so a settings-page
  // save reaches the running fiber without a remount.
  const taskStore = new TaskStore({
    dir: () => resolveTaskDir(config, ctx),
    // `.volatile()` makes the LIVE value an ACCESSOR, not a number. Reading the
    // accessor directly would hand `sourceOf()` an object, which fails
    // `Number.isFinite` and silently becomes 0 — i.e. "no retention, no cap".
    // Unwrap first, and fall back to the documented defaults when unreadable.
    retentionMs: () =>
      volatileNumberOr(config.inbound.tasks.retentionMs, DEFAULT_TASK_RETENTION_MS, unwrapVolatile),
    maxRecords: () =>
      volatileNumberOr(config.inbound.tasks.maxRecords, DEFAULT_TASK_MAX_RECORDS, unwrapVolatile),
    log: (message) => logger.info(message),
  })
  const executor = new InboundExecutor({
    agents: ctx.agents,
    prefix: config.session.contextIdPrefix,
    workspaceRoot,
    workspaceMode: config.inbound.isolation.workspaceMode,
    turnTimeoutMs: config.inbound.blockTimeoutMs,
    now: () => new Date(),
    session: mirror.inboundHooks(),
    agentOptions: defaultAgentOptions,
    // The preset is what gives the session its execution tools; without these
    // two closures every A2A agent is created tool-less (see the block above).
    agentPreset: agentPresetFor,
    mountAgentPreset,
    tasks: taskStore,
    log: (message) => logger.info(message),
  })

  let actualPort = config.inbound.listen.port

  const origin = (_hostHeader: string | undefined): string => {
    if (config.publicUrl !== undefined && config.publicUrl.length > 0) {
      return `${config.publicUrl.replace(/\/$/, '')}${config.basePath}`
    }
    // The card must advertise an address the PEER can reach, never the
    // loopback bind (ADR-011).
    return `http://${config.inbound.listen.host}:${actualPort}${config.basePath}`
  }

  const cardFor = cardForDeployment(config, PLUGIN_VERSION, origin)

  // One greppable line reporting which optional seams this RUNTIME actually has.
  // Two machines on different DSH builds can then be compared by log line instead
  // of by guesswork: a seam that changed between builds otherwise disappears
  // silently (the `if (x !== undefined)` guard is simply skipped). See
  // docs/rc-seam-audit.md for why the usual `.d.ts` diff is unavailable remotely.
  // Deferred by one turn: during `apply()` most services are still undefined, so
  // probing here printed `settings=0 … missing=<everything>` — a line that says the
  // opposite of the truth and misleads anyone reading the log. The timer is owned by
  // an effect so it cannot outlive the fiber.
  //
  // `SEAM_PROBE_DELAY_MS` is referenced rather than a literal so the gate does not
  // have to distinguish "a scheduling tick" from "a tunable timeout"; the constant
  // carries that distinction in one documented place.
  ctx.effect(() => {
    const timer = setTimeout(
      () => logger.info(describeSeams(probeSeams(ctx))),
      SEAM_PROBE_DELAY_MS,
    )
    return () => clearTimeout(timer)
  }, 'a2a:seam-probe')

  const deps: InboundDeps = {
    cardFor,
    maxBodyBytes: config.inbound.maxBodyBytes,
    strictVersionHeader: config.inbound.strictVersionHeader,
    trustedPeers: config.inbound.trustedPeers,
    rateLimiter: new RateLimiter(config.inbound.rateLimitPerMinute),
    resolvePeerSecrets,
    dispatch: createDispatcher(executor),
  }

  if (config.inbound.enabled) {
    // ADR-011: our own listener on a concrete LAN address. Desktop pins
    // ctx.webServer to 127.0.0.1, so serving there is unreachable from a peer.
    const server = new InboundServer({
      host: config.inbound.listen.host,
      port: config.inbound.listen.port,
    })
    ctx.effect(() => {
      const registration = registerInboundRoutes(server, deps, config.basePath)
      const running = server.start().then(
        (port) => {
          actualPort = port
          logger.info(
            `a2a: serving at http://${config.inbound.listen.host}:${port}${config.basePath}`,
          )
        },
        (error: unknown) => {
          logger.error(`a2a: inbound listener failed to start: ${String(error)}`)
        },
      )
      return () => {
        registration.dispose()
        void running.then(() => server.stop())
      }
    }, 'a2a:inbound-listener')

    const peers = Object.keys(config.inbound.peers)
    if (peers.length === 0) {
      logger.warn('a2a: no inbound peers configured — every request will be rejected as unauthorized')
    }
  }

  // ── Outbound ─────────────────────────────────────────────────────────────
  if (config.outbound.enabled) {
    const contacts = config.outbound.contacts.map((contact) => ({
      name: contact.name,
      url: contact.url,
      agentCardPath: contact.agentCardPath,
      tokenEnv: contact.tokenEnv,
      timeoutMs: contact.timeoutMs,
    }))

    // `subagents` is not available while apply() runs, so register from a
    // scoped child that activates once the service exists.
    ctx.inject(['subagents'], () => {
      const subagents = ctx.get('subagents') as SubagentsLike | undefined
      if (subagents === undefined) return
      ctx.effect(() => {
        const provider = new A2aSubagentProvider({
          providerName: config.outbound.providerName,
          contacts,
          resolveToken,
          log: (message) => logger.warn(message),
          // ADR-007 outbound: surface "delegating / remote / replied" in a
          // watchable local session instead of leaving the call a black box.
          onProgress: (progress) => mirror.mirrorOutbound(progress),
        })
        return subagents.registerProvider(provider as unknown)
      }, 'a2a:outbound-provider')
    })

    ctx.inject(['tools'], () => {
      const tools = ctx.get('tools') as ToolsLike | undefined
      if (tools === undefined) return

      /**
       * Enumerate what THIS deployment actually has, for `a2a_models`.
       *
       * `readModelCatalog()` owns the wire-shape normalization, and that is the
       * point: `ctx.llm.listProviders()` returns METADATA objects
       * (`{ id, name }`), NOT provider-route strings, while
       * `listModels(route)` expects that route string and returns model
       * metadata objects (`{ id, name, provider }`). The previous local
       * aggregation passed each provider METADATA OBJECT straight into
       * `listModels()`, so the catalog was built from the wrong shapes and the
       * tool reported a nonsense list. Reusing the shared reader keeps one
       * definition of the contract and matches what the GUI route serves.
       */
      const listModels = async (): Promise<Array<{ provider: string; models: string[] }>> => {
        // Resolved per call: `llm` is not active while `apply()` runs, and the
        // catalog is read from the deployment, never assumed.
        const catalog = await readModelCatalog(ctx.get('llm') as LlmLike | undefined)
        return catalog.providers.map((entry) => ({
          provider: entry.provider,
          models: [...entry.models],
        }))
      }

      ctx.effect(() => {
        const disposers = buildOutboundTools({
          contacts,
          resolveToken,
          listModels,
          currentSelection: defaultAgentOptions,
          // The SAME seam the subagent provider uses. Without it `a2a_call`
          // mirrored nothing: tools.ts already emitted the exchange, but no hook
          // was wired, so the local conversation window the requirement asks for
          // never appeared for tool-driven delegations.
          onExchange: (exchange) => mirror.mirrorOutboundExchange(exchange),
        }).map((tool) => tools.register(tool))
        return () => {
          for (const dispose of disposers) dispose()
        }
      }, 'a2a:outbound-tools')
    })
  }
}

/** Exposed for tests: resolve a presented token to a peer without booting. */
export function resolvePeerForTest(
  token: string | undefined,
  secrets: ReadonlyMap<string, string>,
): PeerIdentity | undefined {
  return identifyPeer(token, secrets)
}

void versionNotSupported

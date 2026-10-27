/**
 * Model selection for A2A sessions — READ + WRITE of the one place it lives.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DECISION (design debt resolved): the selection is this plugin's own
 * `inbound.agent` Config field, and the browser page writes it through the
 * Harness `settings` service — NOT through a file this plugin invents.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * WHY (verified against the installed Host, not assumed):
 *
 *  1. `cordis_inspect_query` host/Service `settings` returns:
 *       update(ns: string, patch: object, expectedRevision?: number): Promise<void>
 *       describe(options?): SettingsDescriptor[]   // { ns, schema, value, revision, applies: 'live' }
 *       mutate(ns, ops: readonly SettingsPathOp[], expectedRevision?): Promise<void>
 *     `describe()` reports `applies: 'live'`: a write lands in the running
 *     plugin, not after a restart.
 *
 *  2. `settings` is itself built on `configEditor` (`static inject =
 *     ['configEditor', 'profileContext']`). `cordis_inspect_query` host/Service
 *     `configEditor` returns:
 *       entries(): Entry[]
 *       configuration(): Array<{ entry, inherited, override }>
 *       async edit(entry, change): Promise<void>
 *     and `@deepseek-ai/dsh-config-editor/lib/index.js` persists with
 *     `writeFileAtomic(profilePatch, ...)` under `withFileLock`, then
 *     `reconcileProfilePatches(...)`, and RESTORES the previous document if the
 *     reload fails. That is `@deepseek-ai/dsh-config-editor`'s documented job:
 *     write the plugin config into the current profile's patch and apply it
 *     immediately.
 *
 *  3. A write does NOT remount this plugin. The Loader special-cases
 *     schema-declared volatile config: `equalExceptVolatile()` plus
 *     `_commitVolatile()` in `@deepseek-ai/cordis-plugin-loader` commit the new
 *     values into the running fiber's `Volatile` references and emit
 *     `loader/volatile-update` instead of reloading the entry. `inbound.agent`
 *     is declared `.volatile()` in `src/config.ts` for exactly this reason, so
 *     the model switch reaches the next A2A turn with no restart and no
 *     dropped in-flight route.
 *
 *  4. Precedent, same feature shape: `@deepseek-ai/dsh-tool-subagent`'s
 *     `model-selection-settings` owns a runtime-discovered model preference as
 *     volatile Config (`z.array(routeSchema).default([]).volatile()`), reads it
 *     with `.get()`, and its UI saves with
 *     `ctx.remote.settings.mutate(ns, [{op:'set', path:['allowedModels'], ...}], revision)`.
 *     "The catalog is discovered at runtime" is therefore NO argument against
 *     config storage: DSH stores the chosen routes as config and discovers the
 *     candidates in the UI, exactly like this plugin's GET handler does.
 *
 * WHY THE OLD `selection.json` WAS WRONG (the debt being paid off):
 *  - two sources for one decision (`selection.json` winning over the YAML pin),
 *    so the GUI could show a model the operator never wrote anywhere visible;
 *  - invisible to the user: not in `cordis.patch.yml`, not in the Settings page,
 *    not version-controlled — the exact opposite of practices.md's "put tunable
 *    values in the plugin's Config so users change them in cordis.patch.yml";
 *  - a hand-rolled write with no CAS, no lock and no rollback, re-implementing
 *    (worse) what `configEditor.edit` already does;
 *  - a second "where is my config" answer for support to explain.
 *
 * WHAT SURVIVES FROM IT: the pure helpers only. `completeSelection()` is the
 * single definition of "a complete pin"; `resolveDshHome()` is still the honest
 * answer to "where is the Harness home" — `src/config.ts` derives
 * `<DSH_HOME>/a2a-workspaces` from it. The legacy file store, `selection.json`
 * and its path helper are GONE: once the settings channel shipped there was a
 * single write path, and a second store kept alive by its own tests is the very
 * debt this module exists to pay off.
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  DSH_HOME_DIR_NAME,
  DSH_HOME_ENV,
  MAX_VOLATILE_UNWRAP_DEPTH,
  SELECTION_CONFIG_FIELD,
  SELECTION_CONFIG_NAMESPACE,
  SETTINGS_CONFLICT_CODE,
  SETTINGS_WRITE_ATTEMPTS,
} from './constants.js'

/** The provider/model pair that decides which model an A2A session runs on. */
export interface AgentSelection {
  readonly provider: string
  readonly model: string
}

/**
 * Anything that may carry a provider/model pair.
 *
 * The fields are `unknown` ON PURPOSE: the `inbound.agent` YAML pin is declared
 * with `.volatile()` in `src/config.ts`, so at runtime each field is a
 * `Volatile<string>` accessor (`{ get(): string }`) rather than a string, even
 * though the emitted TypeScript interface says `string`. Widening here is what
 * lets `completeSelection` accept the real object without a cast and without
 * silently treating a volatile pin as "unset" (which is what a plain
 * `typeof value.provider === 'string'` check used to do — the YAML pin could
 * never win).
 */
export interface PartialSelection {
  readonly provider?: unknown
  readonly model?: unknown
}

/**
 * Unwrap a `Volatile<T>` reference into its current snapshot.
 *
 * `Volatile<T>` is the Harness's stable-reference protocol for live-editable
 * config (verified in `@deepseek-ai/cosmokit`: `createVolatile()`/`isVolatile()`
 * expose a frozen `{ get() }`). This module duck-types it instead of importing
 * the package, because `@deepseek-ai/cosmokit` is not a declared dependency of
 * this plugin and a hard runtime import would break profiles that ship a
 * different copy. The depth cap makes a pathological `get()` bounded.
 *
 * EXPORTED because the protocol has more than one reader: `src/config.ts` uses
 * it for `inbound.agentPreset` (also `.volatile()`). One implementation of the
 * unwrap rule is the point — a second copy is how a field silently starts
 * reading as "unset".
 */
export function unwrapVolatile(value: unknown): unknown {
  let current = value
  for (let depth = 0; depth < MAX_VOLATILE_UNWRAP_DEPTH; depth++) {
    if (current === null || typeof current !== 'object') return current
    const accessor = (current as { get?: unknown }).get
    if (typeof accessor !== 'function') return current
    try {
      current = (accessor as () => unknown).call(current)
    } catch {
      // A reference that throws is unreadable, which is "unset", not a crash.
      return undefined
    }
  }
  return current
}

/** Trimmed string content of one possibly-volatile field; anything else is empty. */
function stringField(value: unknown): string {
  const unwrapped = unwrapVolatile(value)
  return typeof unwrapped === 'string' ? unwrapped.trim() : ''
}

/**
 * Collapse a partial pair into a usable selection.
 *
 * A HALF-SET pin is not a pin: `{ provider: 'x' }` with no model cannot create a
 * session, and treating it as one produces a turn that dies before its first
 * step. Returning `undefined` lets every caller fall through instead of building
 * an unusable agent.
 */
export function completeSelection(value: unknown): AgentSelection | undefined {
  // Unwrap the PAIR first (a `.volatile()` object), then each field (the current
  // `src/config.ts` shape). Both are the same protocol, one hop apart.
  const pair = unwrapVolatile(value)
  if (pair === null || typeof pair !== 'object') return undefined
  const record = pair as PartialSelection
  const provider = stringField(record.provider)
  const model = stringField(record.model)
  if (provider.length === 0 || model.length === 0) return undefined
  return { provider, model }
}

// ── Gateway contract ───────────────────────────────────────────────────────

/** Options a caller may attach to one write. */
export interface SelectionWriteOptions {
  /**
   * Revision the caller observed when it read the selection. A settings-backed
   * store refuses a stale one (HTTP 409) instead of clobbering another writer.
   */
  readonly expectedRevision?: number | undefined
}

/**
 * The two operations the config API needs, over the backing store.
 *
 * Deliberately tiny (and an interface rather than a class): the HTTP layer must
 * never learn where the value lives, and tests can drive it with a plain
 * in-memory object instead of the real settings service.
 */
export interface SelectionGateway {
  /** The persisted selection, or `undefined` when nothing usable is stored. */
  read(): AgentSelection | undefined
  /** Persist the pair; both fields empty clears the pin. May be async. */
  write(selection: AgentSelection, options?: SelectionWriteOptions): void | Promise<void>
  /** Revision of the backing document, when the backend has one. */
  revision?(): number | undefined
}

// ── Settings-backed selection (the supported channel) ──────────────────────

/** The slice of the `settings` service this module uses. */
export interface SettingsLike {
  /** Returns `SettingsDescriptor[]`; typed as unknown so a promise also works. */
  describe(options?: { readonly redactSecrets?: boolean }): unknown
  update(namespace: string, patch: object, expectedRevision?: number): Promise<void>
}

/** Raised when the settings channel cannot be used in this composition. */
export class SelectionSettingsUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SelectionSettingsUnavailableError'
  }
}

/** Raised when a write lost a revision race that the caller asked us to win. */
export class SelectionConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SelectionConflictError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Whether an error is `settings`' own revision conflict, matched structurally. */
function isSettingsConflict(error: unknown): boolean {
  return isRecord(error) && error.code === SETTINGS_CONFLICT_CODE
}

/**
 * Resolve the Loader entry id this plugin instance was mounted as.
 *
 * `settings.describe()`/`update(ns, …)` address a PROFILE ENTRY id, not a
 * package name. A plugin can learn its own id without importing Loader types:
 * shipped code does it as `ctx.fiber.entry?.options.id`
 * (`@deepseek-ai/dsh-plugin-market`, `@deepseek-ai/dsh-experimental-speech-to-text`).
 * Read with `ctx.get('settings')`, never imported.
 *
 * Call this at PLUGIN scope. Inside `ctx.inject([...], () => …)` the context is
 * a child fiber with no entry of its own, and the id would read as undefined.
 */
export function resolveProfileEntryId(ctx: unknown): string | undefined {
  const fiber = (ctx as { fiber?: unknown } | undefined)?.fiber
  const entry = (fiber as { entry?: unknown } | undefined)?.entry
  const options = (entry as { options?: unknown } | undefined)?.options
  const id = (options as { id?: unknown } | undefined)?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/** Dependencies of the settings-backed gateway; every one resolved per call. */
export interface SettingsSelectionDeps {
  /** `ctx.get('settings')` — undefined while the plugin activates. */
  readonly settings: () => SettingsLike | undefined
  /** `resolveProfileEntryId(ctx)` at plugin scope. */
  readonly entryId: () => string | undefined
  /** `config.inbound.agent` — the live volatile reference the Loader updates. */
  readonly configSelection: () => unknown
}

/** The settings-backed gateway, plus a readiness probe for the HTTP layer. */
export interface SettingsSelection extends SelectionGateway {
  /** Whether a settings write is possible right now. */
  available(): boolean
  revision(): number | undefined
}

/** Revision of one namespace, from a `describe()` answer. */
function revisionOf(descriptors: unknown, namespace: string): number | undefined {
  if (!Array.isArray(descriptors)) return undefined
  for (const row of descriptors) {
    if (!isRecord(row) || row.ns !== namespace) continue
    return typeof row.revision === 'number' && Number.isFinite(row.revision)
      ? row.revision
      : undefined
  }
  return undefined
}

/**
 * Build the selection gateway backed by the plugin's own Config.
 *
 * `write()` mirrors the official UI writers (`settings.mutate`) with the one
 * difference the protocol forces on us: the browser POST body carries no
 * revision, so this gateway reads the freshest revision and retries ONCE. When
 * the caller DOES pin a revision (a future client that echoes the GET value),
 * a conflict is final and surfaces as `SelectionConflictError` → HTTP 409.
 */
export function createSettingsSelection(deps: SettingsSelectionDeps): SettingsSelection {
  const available = (): boolean => deps.settings() !== undefined && deps.entryId() !== undefined

  /** Read the namespace revision, mapping absence to a typed "unavailable". */
  const readRevision = async (settings: SettingsLike, namespace: string): Promise<number> => {
    let descriptors: unknown
    try {
      descriptors = await settings.describe()
    } catch (error) {
      throw new SelectionSettingsUnavailableError(
        'the Settings service could not describe this plugin entry',
        { cause: error },
      )
    }
    const revision = revisionOf(descriptors, namespace)
    if (revision === undefined) {
      throw new SelectionSettingsUnavailableError(
        `this plugin entry ("${namespace}") is not exposed as live-editable Settings; ` +
          'set inbound.agent in the plugin configuration instead',
      )
    }
    return revision
  }

  return {
    available,
    read(): AgentSelection | undefined {
      return completeSelection(deps.configSelection())
    },
    revision(): number | undefined {
      const settings = deps.settings()
      const namespace = deps.entryId()
      if (settings === undefined || namespace === undefined) return undefined
      try {
        const described = settings.describe()
        // A promise-shaped describe() cannot be awaited from a synchronous
        // accessor; the route simply reports "no revision" then.
        return Array.isArray(described) ? revisionOf(described, namespace) : undefined
      } catch {
        return undefined
      }
    },
    async write(selection: AgentSelection, options?: SelectionWriteOptions): Promise<void> {
      const settings = deps.settings()
      const namespace = deps.entryId()
      if (settings === undefined) {
        throw new SelectionSettingsUnavailableError(
          'the Settings service is not active in this profile; the model pin cannot be persisted',
        )
      }
      if (namespace === undefined) {
        throw new SelectionSettingsUnavailableError(
          'this plugin is not a profile entry, so Settings cannot address it; ' +
            'install it as a bundle in the active profile',
        )
      }

      const callerPinned = options?.expectedRevision !== undefined
      const patch = {
        [SELECTION_CONFIG_NAMESPACE]: {
          [SELECTION_CONFIG_FIELD]: { provider: selection.provider, model: selection.model },
        },
      }

      let expected = options?.expectedRevision
      for (let attempt = 1; attempt <= SETTINGS_WRITE_ATTEMPTS; attempt++) {
        const revision = expected ?? (await readRevision(settings, namespace))
        try {
          await settings.update(namespace, patch, revision)
          return
        } catch (error) {
          if (!isSettingsConflict(error)) throw error
          // A revision we did NOT observe came from the caller: retrying would
          // defeat the compare-and-set it asked for.
          if (callerPinned) {
            throw new SelectionConflictError(
              `the model selection changed since it was read (expected revision ${String(revision)}); reload and retry`,
            )
          }
          expected = undefined
        }
      }

      throw new SelectionConflictError(
        'the model selection kept changing while this write was retrying; reload and retry',
      )
    },
  }
}

/**
 * Pick the Harness home.
 *
 * Order (highest first): the `homePaths` service's value, `$DSH_HOME`, `~/.dsh`.
 *
 * Still needed after the file store was removed: `src/config.ts` derives the
 * default workspace root (`<DSH_HOME>/a2a-workspaces`) from this, which is what
 * lets the shipped patch leave `isolation.workspaceRoot` empty instead of
 * hard-coding one machine's absolute path.
 *
 * `ctx.get('homePaths')` is probed defensively because (a) that service is not
 * part of this plugin's `inject` list and may simply be absent from a profile,
 * and (b) a service is free to expose the root as a plain property, a getter
 * method, or a `{ home }` record — all three shapes are accepted here rather
 * than guessed once at authoring time.
 *
 * NOTE: this is called once during `apply()`. Unlike `ctx.get('credentials')`,
 * the answer does not change while the process runs (`DSH_HOME` is fixed at
 * boot), so caching it cannot pin a "not active yet" undefined.
 */
export function resolveDshHome(
  ctx: { get(name: string): unknown } | undefined,
  env: Record<string, string | undefined> = process.env,
  home: () => string = homedir,
): string {
  const fromService = homeFromValue(ctx?.get('homePaths'))
  if (fromService !== undefined) return resolve(fromService)

  const fromEnv = env[DSH_HOME_ENV]
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return resolve(fromEnv.trim())

  return resolve(join(home(), DSH_HOME_DIR_NAME))
}

/**
 * Extract a string root from whatever shape the `homePaths` slot exposes.
 *
 * Recursion is bounded by the known key list instead of "walk the object":
 * a service object with cycles must not hang boot.
 */
function homeFromValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }
  if (typeof value === 'function') {
    try {
      return homeFromValue((value as () => unknown)())
    } catch {
      return undefined
    }
  }
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  for (const key of ['home', 'dshHome', 'root', 'path']) {
    const hit = homeFromValue(record[key])
    if (hit !== undefined) return hit
  }
  return undefined
}

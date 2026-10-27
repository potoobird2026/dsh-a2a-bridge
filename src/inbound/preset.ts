/**
 * Agent-preset resolution for inbound A2A sessions.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS MODULE EXISTS — the defect it fixes
 * ══════════════════════════════════════════════════════════════════════════
 *
 * An A2A session that is created with
 *
 *     agents.create({ sessionId, meta: { cwd } })
 *
 * and nothing else mounts NO preset. That is not a cosmetic gap:
 * `@deepseek-ai/dsh-web-app` deliberately keeps every execution tool
 * (`tool-pwsh`, `tool-bash`, `tool-fs`, `tool-terminal`, …) OFF the Host plane
 * (`disabled: true` rows in its bundle patch) so that each agent gets its tool
 * set from the preset IT mounts. A session without a preset can therefore call
 * the model and answer in text while having no execution tool at all — which is
 * exactly the reported symptom ("I cannot run that command: there is no tool on
 * this machine").
 *
 * The supported order below is not invented here; it is copied from the
 * Harness's own child-agent path (`@deepseek-ai/dsh-subagent`,
 * `applyChildComposition()`), which calls `agentPresets.mount(childCtx, id)`
 * from the child's `setup` callback and lets the registry resolve "no id" to
 * the deployment default:
 *
 *   1. the operator's explicit choice (`inbound.agentPreset` in Config),
 *   2. the deployment default — `agentPresets.resolve()` with the id OMITTED,
 *   3. nothing — which for an A2A session is a DEFECT, so callers must say so
 *      out loud instead of degrading silently to "chat only".
 *
 * No preset NAME is ever written here: rosters differ per machine (a profile
 * may declare `standard`/`ptc`/`minimal`/`cordis`, or none at all), so a
 * baked-in id would be a value that exists on one deployment and not the next.
 *
 * Layering: no Cordis import. The registry is addressed structurally, which is
 * what makes the whole chain unit-testable with plain fakes.
 */

/**
 * The slice of the `agentPresets` service this plugin uses.
 *
 * Verified with `cordis_inspect_query` host/Service `agentPresets`:
 *   async resolve(id?: string): Promise<AgentPreset>   // id omitted => default
 *   async mount(ctx: Context, id?: string): Promise<AgentPreset>
 *   composedPreset(ctx: Context): string | undefined
 *   async list(): Promise<AgentPreset[]>
 *
 * `composedPreset` is marked optional because an older registry line may not
 * serve it; without it the effective id simply stays unknown instead of
 * failing the mount.
 */
export interface AgentPresetDirectoryLike {
  /** Resolve an identity WITHOUT starting an agent; an omitted id means the default. */
  resolve(id?: string): Promise<unknown>
  /** Bind an UNPUBLISHED agent (its `setup` context) to the current revision. */
  mount(ctx: unknown, id?: string): Promise<unknown>
  /** The preset a live agent actually uses. */
  composedPreset?(ctx: unknown): string | undefined
  /** Every declared preset, including activation failures. */
  list?(): Promise<unknown>
}

/** Where a resolved preset id came from — the priority step that won. */
export type AgentPresetSource = 'configured' | 'default' | 'none'

export interface AgentPresetResolution {
  /** The id to mount, or `undefined` when NOTHING could be resolved. */
  readonly id: string | undefined
  readonly source: AgentPresetSource
  /**
   * Why step 2 could not produce an id, so the caller can log the real cause
   * (service absent vs. `resolve()` throwing vs. a malformed answer) instead of
   * one generic "no preset".
   */
  readonly reason: string | undefined
}

/**
 * Read the id out of one `AgentPreset` answer.
 *
 * Both shapes are tolerated on purpose: the registry returns `{ id }`
 * (`AgentPreset`), while a remote carrier or a future line may flatten it to a
 * bare string. An answer that carries neither is "no id", never a guess.
 */
export function presetIdOf(answer: unknown): string | undefined {
  if (typeof answer === 'string') {
    const trimmed = answer.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }
  if (answer === null || typeof answer !== 'object') return undefined
  const id = (answer as { id?: unknown }).id
  if (typeof id !== 'string') return undefined
  const trimmed = id.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Resolve the preset id to mount, in the documented priority order.
 *
 * Never throws: a caller in the middle of an A2A request must be able to log a
 * precise reason and continue (the conversation still answers, it just has no
 * tools), instead of turning a composition problem into a JSON-RPC error the
 * peer cannot act on.
 *
 * `resolve()` is called with NO argument when the operator pinned nothing —
 * that is the documented "give me the deployment default" form. Calling it with
 * an invented id would defeat the point of not hard-coding one.
 */
export async function resolveAgentPreset(
  configured: string | undefined,
  directory: AgentPresetDirectoryLike | undefined,
): Promise<AgentPresetResolution> {
  // Step 1: the operator's explicit choice wins outright, and the registry is
  // not even consulted — a pinned id must not be overridden by a default that
  // happens to be set elsewhere.
  const explicit = configured?.trim() ?? ''
  if (explicit.length > 0) return { id: explicit, source: 'configured', reason: undefined }

  // Step 2 needs the registry; without it there is nothing to ask.
  if (directory === undefined) {
    return {
      id: undefined,
      source: 'none',
      reason: 'the agentPresets service is not active in this composition',
    }
  }

  try {
    const id = presetIdOf(await directory.resolve())
    if (id === undefined) {
      return {
        id: undefined,
        source: 'none',
        reason: 'agentPresets.resolve() reported no default preset',
      }
    }
    return { id, source: 'default', reason: undefined }
  } catch (error) {
    return {
      id: undefined,
      source: 'none',
      reason: `agentPresets.resolve() failed: ${String(error)}`,
    }
  }
}

/**
 * Mount `id` onto a freshly created agent and report what is ACTUALLY live.
 *
 * MUST be awaited inside `agents.create({ setup })`: the registry binds an
 * agent that is still UNPUBLISHED, and it rejects a context that is not the
 * agent's scoped creation context. Calling it after publication is too late —
 * the first turn would already have been assembled without the toolset.
 *
 * Throws when the service is missing or `mount()` rejects. That is deliberate:
 * containment belongs one level up (the executor logs it and keeps the session
 * usable), while this function must not report a success it did not observe.
 *
 * The return value is `composedPreset(ctx)` — the only honest confirmation that
 * the bind took effect. `undefined` means "bound, but this registry line cannot
 * tell us the id", not "failed".
 */
export async function mountAgentPresetOn(
  directory: AgentPresetDirectoryLike | undefined,
  agentCtx: unknown,
  id: string | undefined,
): Promise<string | undefined> {
  if (directory === undefined) {
    throw new Error('the agentPresets service is not active in this composition')
  }
  await directory.mount(agentCtx, id)
  return directory.composedPreset?.(agentCtx)
}

/** What the plugin page can offer in its preset picker. */
export interface AgentPresetRoster {
  readonly ids: readonly string[]
  /**
   * False means "cannot tell" (no service, or an unreadable answer), which the
   * UI must render as "unavailable" rather than "this deployment has none".
   */
  readonly available: boolean
}

/**
 * List the preset ids THIS deployment declares.
 *
 * Never throws: the picker is a convenience, and a registry that is absent or
 * mid-activation must not turn the configuration page into an error screen. The
 * `available` flag is what keeps the two "nothing" states distinguishable.
 */
export async function listAgentPresetIds(
  directory: AgentPresetDirectoryLike | undefined,
): Promise<AgentPresetRoster> {
  if (directory === undefined || typeof directory.list !== 'function') {
    return { ids: [], available: false }
  }
  let answer: unknown
  try {
    answer = await directory.list()
  } catch {
    return { ids: [], available: false }
  }
  if (!Array.isArray(answer)) return { ids: [], available: false }

  const ids: string[] = []
  for (const entry of answer) {
    const id = presetIdOf(entry)
    if (id !== undefined) ids.push(id)
  }
  return { ids, available: true }
}

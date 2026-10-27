/**
 * Tool policy for A2A sessions: which HOST tools an inbound peer may reach.
 *
 * WHY THIS EXISTS
 * ---------------
 * An A2A session runs a real Harness agent, and a Harness agent sees every tool
 * the host registers — including the ones that read OTHER sessions. Verified on
 * this deployment via `cordis_inspect_query host/Tool listTools`:
 *
 *   session_search            search prior sessions in the caller
 *   session_event_search      search events across sessions
 *   session_trace             read the lineage of another session
 *   session_event_trace       trace one event of another session
 *   session_event_read        "Read one full unabridged event ... from an
 *                             authorized session"
 *   list_agents               enumerate every durable teammate
 *   team_task_*               the shared team board
 *
 * A2A is a cross-machine delegation surface. Granting a remote peer the ability
 * to enumerate and read this machine's other conversations would make the peer
 * able to harvest the operator's history, so those verbs are removed from the
 * A2A scope.
 *
 * WHY `restrict` AND NOT A DEDICATED PRESET
 * -----------------------------------------
 * The Harness exposes an official, scope-aware mechanism:
 *
 *     tools.restrict(filter): () => void
 *       "Restrict global tools for the calling agent scope. ... Restrictions
 *        intersect; scoped registrations remain visible."
 *
 * Called inside `agents.create({ setup })` — i.e. on the agent's SCOPED creation
 * context — it removes exactly the named globals for that agent and nothing else.
 * A dedicated "safe preset" would instead depend on a preset existing on every
 * deployment (the registry's roster differs per machine) and would silently
 * degrade to "no tools" when it does not.
 *
 * Layering: no Cordis import; the tools service is addressed structurally, which
 * is what keeps this unit-testable with a plain fake.
 */

/** The slice of the `tools` service this policy uses. */
export interface ToolsScopeLike {
  /** `undefined` when the tool is not visible to the caller — the existence probe. */
  readonly get?: (name: string) => unknown
  /**
   * Remove named GLOBAL tools from the calling agent's scope.
   *
   * The service fails on empty filters, unknown names, scope-local names, and
   * reserved transport names — so callers must pass only names that actually
   * resolve, which is what the existence probe below is for.
   */
  readonly restrict?: (filter: { deny?: readonly string[]; allow?: readonly string[] }) => unknown
}

export interface ToolPolicyOutcome {
  /** Names that were present on this deployment and are now denied. */
  readonly applied: readonly string[]
  /** Names from the policy that this deployment does not register (harmless). */
  readonly absent: readonly string[]
  /** Set when the service refused the restriction; the session is NOT restricted. */
  readonly error?: string
}

/**
 * Apply the A2A deny list to one agent scope.
 *
 * `tools` is read from `agentCtx` on purpose. `tools.restrict()` narrows "the
 * CALLING agent scope", so resolving the service from the plugin's root context
 * would restrict the wrong scope entirely — and then the restriction would look
 * applied while changing nothing for the peer's session. The agent's scoped
 * creation context (the object `agents.create({ setup })` hands to `setup`) is
 * the only correct receiver.
 *
 * Best-effort by design: a policy failure must never fail the A2A request. A peer
 * whose turn succeeds but whose toolset was not narrowed is a security gap, so the
 * failure is logged loudly — it is not swallowed silently.
 */
export function applyToolPolicy(
  agentCtx: unknown,
  denied: readonly string[],
  log?: (message: string) => void,
): ToolPolicyOutcome {
  const tools = (agentCtx as { tools?: ToolsScopeLike } | null | undefined)?.tools
  if (tools === undefined || typeof tools.restrict !== 'function') {
    const message = 'the tools service is not active, so the A2A deny list cannot be applied'
    log?.(`a2a: tool policy NOT applied — ${message}`)
    return { applied: [], absent: [...denied], error: message }
  }

  // `get` MUST be invoked as a method of `tools`. Detaching it
  // (`const probe = tools.get; probe(name)`) leaves `this` undefined, and the
  // service reads `this.view(scope)` — which fails with exactly
  // "Cannot read properties of undefined (reading 'view')" and, because this runs
  // inside `agents.create({ setup })`, takes the whole A2A request down with it.
  // The arrow wrapper keeps the receiver while still allowing an absent method.
  const probe: (name: string) => unknown =
    typeof tools.get === 'function' ? (name) => tools.get?.(name) : () => undefined
  const applied: string[] = []
  const absent: string[] = []
  for (const name of denied) {
    if (probe(name) === undefined) absent.push(name)
    else applied.push(name)
  }

  if (applied.length === 0) {
    // Nothing on this deployment matches the policy: nothing to do, and worth
    // saying so rather than pretending a restriction landed.
    log?.(`a2a: tool policy applied to nothing (${absent.length} policy names are not registered here)`)
    return { applied: [], absent }
  }

  try {
    tools.restrict({ deny: applied })
    // The absent names are reported on the SAME line on purpose: a reader who
    // only sees "denied 5 of them" cannot tell that 5 were silently not denied.
    // `tools.restrict()` only reaches GLOBAL tools — a name that is scope-local or
    // not registered here is reported rather than assumed harmless.
    log?.(
      `a2a: A2A session denied ${applied.length} cross-session tool(s): ${applied.join(', ')}` +
        (absent.length > 0 ? ` (not denyable on this deployment: ${absent.join(', ')})` : ''),
    )
    return { applied, absent }
  } catch (error) {
    // `restrict` throws on empty filters, unknown names, and reserved names. All
    // of those would mean the caller handed it something wrong — report it.
    const message = `tools.restrict refused the deny list: ${String(error)}`
    log?.(`a2a: tool policy FAILED — ${message}`)
    return { applied: [], absent, error: message }
  }
}

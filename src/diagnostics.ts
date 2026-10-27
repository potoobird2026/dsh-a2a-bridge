/**
 * Startup seam probe.
 *
 * WHY THIS EXISTS: this plugin runs against a DSH whose packages ship INSIDE the
 * desktop app. The local machine and the remote machine are on different runtime
 * builds (rc.2 vs rc.3), and the remote ships a packed `app.asar`, so the usual
 * control — diff the published `lib/*.d.ts` — is not available there.
 *
 * Without a probe, a seam that changed between builds disappears SILENTLY: a
 * `ctx.get('x')` returns undefined, an `if (x !== undefined)` guard is skipped,
 * and the feature quietly does not happen. That is precisely how a whole class of
 * earlier bugs looked (credentials, subagents, tools, workspaceRegistry all read
 * during `apply()` and therefore always undefined).
 *
 * So: report once, at startup, exactly which optional seams exist. An operator can
 * then compare two machines by reading one log line instead of guessing. Nothing
 * here changes behaviour — it only makes the difference observable.
 *
 * Layering: imports only `session-binding` (for the registry shape check).
 */

import { asWorkspaceRegistry } from './session/session-binding.js'

/** What the plugin found when it looked for each seam it can use. */
export interface SeamFacts {
  /** `ctx.agents.resume` — required to REOPEN a persisted session; without it a
   * restart makes every A2A conversation permanently unreachable. */
  readonly agentsResume: boolean
  /** `workspaceRegistry` — required to group sessions under the A2A workspace. */
  readonly workspaceRegistry: boolean
  /** `workspaceRegistry.unarchiveSession` — required to un-hide an archived A2A
   * session, which otherwise runs invisibly (defeats ADR-007). */
  readonly workspaceUnarchive: boolean
  /** `workingDirectory.set` — required to keep per-session cwd isolation. */
  readonly workingDirectory: boolean
  readonly agentPresets: boolean
  readonly credentials: boolean
  readonly settings: boolean
  readonly llm: boolean
  readonly subagents: boolean
  readonly tools: boolean
  readonly homePaths: boolean
}

/**
 * Seams whose ABSENCE breaks a user-visible promise.
 *
 * Kept separate from the rest so `describeSeams` can call them out by name rather
 * than burying them in a list of eleven flags.
 */
const CRITICAL: ReadonlyArray<keyof SeamFacts> = [
  'agentsResume',
  'workspaceRegistry',
  'workspaceUnarchive',
  'workingDirectory',
]

/** Probe a Cordis-like context. Never throws; a missing service is just `false`. */
export function probeSeams(ctx: {
  readonly agents?: unknown
  get(name: string): unknown
}): SeamFacts {
  const has = (name: string): boolean => {
    try {
      return ctx.get(name) !== undefined
    } catch {
      return false
    }
  }
  const agents = ctx.agents as { resume?: unknown } | undefined
  const registry = asWorkspaceRegistry((() => {
    try {
      return ctx.get('workspaceRegistry')
    } catch {
      return undefined
    }
  })()) as { unarchiveSession?: unknown } | undefined
  const workingDirectory = (() => {
    try {
      return ctx.get('workingDirectory')
    } catch {
      return undefined
    }
  })() as { set?: unknown } | undefined

  return {
    agentsResume: typeof agents?.resume === 'function',
    workspaceRegistry: registry !== undefined,
    workspaceUnarchive: typeof registry?.unarchiveSession === 'function',
    workingDirectory: typeof workingDirectory?.set === 'function',
    agentPresets: has('agentPresets'),
    credentials: has('credentials'),
    settings: has('settings'),
    llm: has('llm'),
    subagents: has('subagents'),
    tools: has('tools'),
    homePaths: has('homePaths'),
  }
}

/**
 * One greppable log line.
 *
 * Shape: `a2a: seams agents.resume=1 workspace=1 ... missing=<none>|a,b`.
 * `missing=` is the part an operator (or a bug report) can act on, so it is always
 * present — including `missing=none` — instead of only appearing on failure.
 */
export function describeSeams(facts: SeamFacts): string {
  const entries = Object.entries(facts) as Array<[keyof SeamFacts, boolean]>
  const flags = entries.map(([name, ok]) => `${name}=${ok ? 1 : 0}`).join(' ')
  const missing = entries.filter(([, ok]) => !ok).map(([name]) => name)
  const criticalMissing = missing.filter((name) => CRITICAL.includes(name))
  const suffix = missing.length === 0 ? 'none' : missing.join(',')
  const warn = criticalMissing.length === 0 ? '' : ` critical-missing=${criticalMissing.join(',')}`
  return `a2a: seams ${flags} missing=${suffix}${warn}`
}

/**
 * Central configuration schema for the DSH A2A bridge.
 *
 * ADR-008 (正规化 / 标准化开发): every tunable lives here. Module code must
 * never carry a literal port, path, timeout, or credential value — modules
 * receive a resolved config object and read only from it.
 *
 * ADR-005 (认证模型): peer/contact entries store a `ctx.credentials`
 * REFERENCE NAME (`tokenEnv`), never a secret value. Pasting a raw token is
 * rejected at load time by `assertConfigCoherent`.
 *
 * ADR-007 (会话可见性): the `session` block governs how A2A conversations are
 * surfaced as first-class, visible DSH sessions rather than headless calls.
 */
// `@deepseek-ai/schemastery` ships NO type declarations and exposes the schema
// builder as its DEFAULT export only (verified: `Object.keys(await import(...))`
// is `['default']`). A named `{ Schema }` import therefore type-checks — the
// module is `any` without declarations — and then throws at load time with
// "does not provide an export named 'Schema'". That failure kills the whole
// plugin, so this must stay a default import.
import { join, resolve } from 'node:path'

import Schema from '@deepseek-ai/schemastery'

import {
  DEFAULT_AGENT_CARD_PATH,
  DEFAULT_CALL_TIMEOUT_MS,
  DEFAULT_LISTEN_PORT,
  DEFAULT_TASK_MAX_RECORDS,
  DEFAULT_TASK_RETENTION_MS,
  TASK_DIR_NAME,
} from './constants.js'
import { resolveDshHome, unwrapVolatile, type AgentSelection } from './selection.js'

/** A `ctx.credentials` reference name — the shape the credential seam addresses. */
export const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/

/** A peer / contact name. Also used as a workspace directory component, so no separators. */
export const ENTITY_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

// ── Defaults owned by this file (configurable knobs) ──────────────────────
//
// Three defaults are NOT declared here: `DEFAULT_AGENT_CARD_PATH`,
// `DEFAULT_LISTEN_PORT` and `DEFAULT_CALL_TIMEOUT_MS` are imported from
// `src/constants.ts`. They are shared with module-level fallbacks (card
// parsing, the listener, the outbound client), so keeping a second copy in the
// schema was a silent double truth: the schema default and the fallback agreed
// only by coincidence, and a test could not tell them apart. Importing is the
// fix — the compiler now resolves ONE symbol for both roles.
export const DEFAULT_BASE_PATH = '/a2a'
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 60
export const DEFAULT_MAX_CONTEXT_TURNS = 5
export const DEFAULT_BLOCK_TIMEOUT_MS = 60_000
export const DEFAULT_CONTEXT_IDLE_TTL_MS = 1_800_000
export const DEFAULT_MAX_RESIDENT_CONTEXTS = 64
export const DEFAULT_MAX_BODY_BYTES = 1_000_000
export const DEFAULT_WORKSPACE_TITLE_PREFIX = 'A2A'
export const DEFAULT_CONTEXT_ID_PREFIX = 'a2a'

/**
 * Directory this plugin owns inside the Harness home, used when
 * `isolation.workspaceRoot` is left empty (see `resolveWorkspaceRoot`).
 *
 * It is a NAME, not a path: the parent is resolved at runtime from the live
 * Harness home, so nothing machine-specific can leak into the shipped patch.
 */
export const DEFAULT_WORKSPACES_DIR_NAME = 'a2a-workspaces'

const skillSchema = Schema.object({
  id: Schema.string().required(),
  name: Schema.string().required(),
  description: Schema.string().default(''),
  tags: Schema.array(Schema.string()).default([]),
})

/**
 * The full plugin configuration schema.
 *
 * `inbound`  — serving our agent to remote peers (server side).
 * `outbound` — delegating to remote agents (client side).
 * The two are deliberately disjoint: `inbound.peers` means "who may reach me"
 * while `outbound.contacts` means "who I may reach". Same word would have been
 * a trap, so they do not share a name.
 */
export const Config = Schema.object({
  /** Path prefix for the JSON-RPC endpoint. Must start with '/'. */
  basePath: Schema.string().default(DEFAULT_BASE_PATH),

  /**
   * Externally reachable URL advertised on the Agent Card.
   * MUST be set when serving through a reverse proxy or on a LAN address:
   * the webserver's bind address is typically 127.0.0.1 and publishing that
   * on a card is always wrong.
   */
  publicUrl: Schema.string(),

  card: Schema.object({
    name: Schema.string().default('dsh-a2a-bridge'),
    description: Schema.string().default('A DeepSeek Harness agent reachable over A2A.'),
    /** Cards are public by design (discovery needs an anonymous read). */
    public: Schema.boolean().default(true),
    skills: Schema.array(skillSchema).default([]),
    extendedSkills: Schema.array(skillSchema).default([]),
    provider: Schema.object({
      organization: Schema.string().default(''),
      url: Schema.string().default(''),
    }),
  }),

  inbound: Schema.object({
    enabled: Schema.boolean().default(true),

    /** peer name -> credential reference name (ADR-005 per-peer token). */
    peers: Schema.dict(Schema.object({ tokenEnv: Schema.string().required() })).default({}),

    /** Allow-list on top of authentication; empty means "all declared peers". */
    trustedPeers: Schema.array(Schema.string()).default([]),

    rateLimitPerMinute: Schema.natural().default(DEFAULT_RATE_LIMIT_PER_MINUTE),
    maxContextTurns: Schema.natural().default(DEFAULT_MAX_CONTEXT_TURNS),
    sendMode: Schema.union(['block', 'immediate'] as const).default('block'),
    blockTimeoutMs: Schema.natural().default(DEFAULT_BLOCK_TIMEOUT_MS),
    contextIdleTtlMs: Schema.natural().default(DEFAULT_CONTEXT_IDLE_TTL_MS),
    maxResidentContexts: Schema.natural().default(DEFAULT_MAX_RESIDENT_CONTEXTS),
    maxBodyBytes: Schema.natural().default(DEFAULT_MAX_BODY_BYTES),

    /**
     * Persisted task records — what makes `GetTask` survive a DSH restart.
     *
     * `dir` is volatile so the settings page can move it without remounting the
     * plugin; empty means "derive `<DSH_HOME>/a2a-tasks`", the same convention
     * `isolation.workspaceRoot` uses.
     *
     * Retention is a PAIR on purpose: age bounds staleness (a week-old task is
     * useless to a peer that has moved on), count bounds disk use under a burst
     * of short tasks. One bound cannot cover both — a busy hour and a forgotten
     * month fail in opposite directions.
     *
     * ALL THREE FIELDS ARE VOLATILE. This is not cosmetic: `dsh-settings` refuses
     * to write any path that is not under a volatile ancestor
     * (`Config field "<path>" is not volatile`, thrown before the revision check),
     * and the surface answer is the generic `settings/rejected`. Without
     * `.volatile()` here, every save that included these two numbers was rejected
     * no matter what revision was sent — which read as "a revision conflict" and
     * misled the investigation for several rounds.
     */
    tasks: Schema.object({
      dir: Schema.string().default('').volatile(),
      retentionMs: Schema.natural().default(DEFAULT_TASK_RETENTION_MS).volatile(),
      maxRecords: Schema.natural().default(DEFAULT_TASK_MAX_RECORDS).volatile(),
    }),

    /**
     * Which provider/model every A2A session runs on.
     *
     * Omitted: NO model. A2A then refuses every request with an actionable
     * "choose a model in the plugin page" error instead of silently borrowing a
     * deployment default the operator never chose. Set both to pin A2A traffic
     * to a specific model — useful when a particular provider must serve a
     * bare, programmatically-created session, and it is the "model is
     * pluggable" knob in its most direct form. A half-set pair counts as unset.
     *
     * VOLATILE AS A WHOLE PAIR — the honest shape. At runtime this field is a
     * `Volatile<{ provider, model }>` reference, not a plain object: the Loader
     * commits a Settings write into the running fiber's reference
     * (`equalExceptVolatile` / `_commitVolatile`) instead of remounting the
     * plugin. That is what makes a model chosen on the plugin page reach the
     * very next A2A turn with no restart. Marking each field volatile (the old
     * shape) described the runtime wrong: `config.inbound.agent.provider` was
     * an accessor object, not a string. `completeSelection()` in
     * `src/selection.ts` unwraps either shape, so both a profile patch written
     * under the old schema and the new one keep working. Empty defaults mean a
     * fresh install reads as "no pin" instead of "half-configured".
     */
    agent: Schema.object({
      provider: Schema.string().default(''),
      model: Schema.string().default(''),
    }).volatile(),

    /**
     * Which agent preset every inbound A2A session mounts.
     *
     * A PRESET IS WHAT BRINGS THE TOOLS. The Web bundle keeps the execution
     * tools (`tool-pwsh` / `tool-bash` / `tool-fs` / `tool-terminal`) off the
     * Host plane and each agent gets them from the preset it mounts, so a
     * session created without one can chat but cannot execute anything. This
     * field is therefore the knob that decides whether A2A can do work.
     *
     * EMPTY IS MEANINGFUL: it means "no explicit choice", and the runtime then
     * uses the deployment default (`agentPresets.resolve()` with the id
     * omitted). It is deliberately NOT defaulted to a preset NAME: rosters
     * differ per machine (this profile declares some subset of the shipped
     * presets, another may declare none), so a baked-in id would point at a
     * preset that does not exist somewhere else. See `src/inbound/preset.ts`
     * for the full priority chain.
     *
     * VOLATILE for the same reason as `agent`: the Loader commits a Settings
     * write into the running fiber's reference instead of remounting the plugin,
     * so a preset chosen on the plugin page reaches the very next A2A session.
     * The honest runtime type is therefore a `Volatile<string>` accessor, not a
     * string — read it through `configuredAgentPreset()` below.
     */
    agentPreset: Schema.string().default('').volatile(),

    isolation: Schema.object({
      workspaceMode: Schema.union(['per-peer', 'shared'] as const).default('per-peer'),
      /**
       * Root directory for the per-peer A2A workspaces.
       *
       * EMPTY IS THE PORTABLE DEFAULT (this field used to be `required()`).
       * A bundle patch ships inside the npm package and must pass validation on
       * a clean machine, so "required" forced the published `cordis.patch.yml`
       * to carry one developer's absolute path — which every other install then
       * pointed at a directory that does not exist (audit S1). Empty now means
       * "derive it from the running Harness"; `resolveWorkspaceRoot()` below
       * does that with `resolveDshHome()`, the same `homePaths` -> `$DSH_HOME`
       * -> `~/.dsh` order the rest of the plugin uses. A non-empty value is
       * still honoured verbatim, so deployments that pin a shared root keep
       * their behaviour.
       *
       * VOLATILE ON PURPOSE: the workspace root is user-facing configuration, so
       * it must be editable in the plugin's own configuration page (the DSH
       * native form writes it back to the profile patch). A non-volatile field
       * only exists in YAML/`cordis.patch.yml`, where users never look.
       *
       * Reading a volatile field returns an accessor, NOT a string — always go
       * through `resolveWorkspaceRoot()`, which unwraps it.
       */
      workspaceRoot: Schema.string().default('').volatile(),
      peerWorkspaces: Schema.dict(Schema.string()).default({}),
    }),

    /**
     * When true, a request with no `A2A-Version` header is rejected with
     * -32009, per spec §3.6.2 (MUST: empty means 0.3).
     * When false, an absent header is treated as 1.0 (deployment policy,
     * not spec) — the choice huangjuhua-aigc/dsh-a2a makes.
     */
    strictVersionHeader: Schema.boolean().default(true),

    /**
     * ADR-011: the listener this plugin owns (src/inbound/server.ts).
     * `host` must be ONE concrete local address; a wildcard bind is refused at
     * load time because binding every interface would expose this agent to
     * whatever network the machine is attached to.
     */
    listen: Schema.object({
      host: Schema.string().required(),
      port: Schema.natural().max(65535).default(DEFAULT_LISTEN_PORT),
    }),
  }),

  outbound: Schema.object({
    enabled: Schema.boolean().default(true),

    /** Name the outbound subagent provider registers under (ADR-006). */
    providerName: Schema.string().default('a2a'),

    /** ADR-004: static contact list + Agent Card well-known discovery. */
    contacts: Schema.array(
      Schema.object({
        name: Schema.string().required(),
        url: Schema.string().required(),
        agentCardPath: Schema.string().default(DEFAULT_AGENT_CARD_PATH),
        /** Optional credential reference name for this remote's Bearer token. */
        tokenEnv: Schema.string(),
        timeoutMs: Schema.number().default(DEFAULT_CALL_TIMEOUT_MS),
      }),
    ).default([]),
  }),

  /** ADR-007: A2A conversations must be visible, not headless. */
  session: Schema.object({
    workspaceTitlePrefix: Schema.string().default(DEFAULT_WORKSPACE_TITLE_PREFIX),
    contextIdPrefix: Schema.string().default(DEFAULT_CONTEXT_ID_PREFIX),
    /** Mirror remote progress into the local session so users can watch it. */
    mirrorRemoteProgress: Schema.boolean().default(true),
  }),
})

/** Resolved configuration shape after schemastery applies defaults. */
export interface A2ABridgeConfig {
  basePath: string
  publicUrl?: string
  card: {
    name: string
    description: string
    public: boolean
    skills: Array<{ id: string; name: string; description: string; tags: string[] }>
    extendedSkills: Array<{ id: string; name: string; description: string; tags: string[] }>
    provider: { organization: string; url: string }
  }
  inbound: {
    enabled: boolean
    peers: Record<string, { tokenEnv: string }>
    trustedPeers: string[]
    rateLimitPerMinute: number
    maxContextTurns: number
    sendMode: 'block' | 'immediate'
    blockTimeoutMs: number
    contextIdleTtlMs: number
    maxResidentContexts: number
    maxBodyBytes: number
    tasks: {
      /**
       * Declared `string` for the same reason `isolation.workspaceRoot` is: the
       * field is `.volatile()`, so the LIVE value is an accessor. Callers must go
       * through `unwrapVolatile()` — reading it directly is the bug that once made
       * a pin appear unset.
       */
      dir: string
      retentionMs: number
      maxRecords: number
    }
    /**
     * The lived-in shape of `agent` is a `Volatile` REFERENCE, not the pair
     * itself (see the schema comment above). Typing it as two plain optional
     * strings was a lie the old per-field `.volatile()` made easy to believe:
     * reading `.provider` at runtime returned an accessor object, so a plain
     * `typeof === 'string'` check saw every YAML pin as "unset".
     *
     * `get()` may return `undefined` only for a partially built config object
     * (a resolved Config always carries the pair); `''` means "not pinned".
     * `src/selection.ts` defines `AgentSelection` as the single honest type for
     * the pair, so it is reused rather than restated here.
     */
    agent?: { get(): AgentSelection | undefined }
    /**
     * The preset id to mount, as a `Volatile` REFERENCE (see the schema comment
     * above) — not a string. `get()` returns `''` while nothing was chosen,
     * which is the "use the deployment default" state, never "no preset".
     */
    agentPreset?: { get(): string }
    isolation: {
      workspaceMode: 'per-peer' | 'shared'
      workspaceRoot: string
      peerWorkspaces: Record<string, string>
    }
    strictVersionHeader: boolean
    listen: {
      host: string
      port: number
    }
  }
  outbound: {
    enabled: boolean
    providerName: string
    contacts: Array<{
      name: string
      url: string
      agentCardPath: string
      tokenEnv?: string
      timeoutMs: number
    }>
  }
  session: {
    workspaceTitlePrefix: string
    contextIdPrefix: string
    mirrorRemoteProgress: boolean
  }
}

/**
 * Resolve the workspace root the runtime actually uses.
 *
 * WHY THIS FALLBACK EXISTS (audit S1, "the deliverable itself is broken"): the
 * schema used to require `isolation.workspaceRoot`. The bundle patch is shipped
 * inside the package and has to pass activation validation on a fresh machine,
 * so "required" forced that patch to hard-code one developer's absolute path
 * (`C:/Users/<name>/.dsh/a2a-workspaces`). Every other install then created its
 * workspaces under a directory that does not exist — a failure far away from
 * the root cause.
 *
 * An empty value therefore means "derive it from the running Harness". The
 * parent directory comes from `resolveDshHome()`, which already implements the
 * only correct order (`homePaths` service -> `$DSH_HOME` -> `~/.dsh`); this
 * function adds just the directory NAME, so no drive letter, user name or
 * `.dsh` literal is restated here. An explicitly configured root wins verbatim
 * (trimmed), preserving deployments that deliberately share one root.
 */
export function resolveWorkspaceRoot(
  config: A2ABridgeConfig,
  ctx: { get(name: string): unknown } | undefined,
): string {
  // `isolation.workspaceRoot` is volatile, so at runtime it is an accessor, not a
  // string. Reading it directly would throw (or silently yield "[object Object]")
  // — the same trap that once made the YAML `agentPreset` pin appear unset.
  const raw = unwrapVolatile(config.inbound.isolation.workspaceRoot)
  const configured = typeof raw === 'string' ? raw.trim() : ''
  if (configured.length > 0) return configured
  return resolve(join(resolveDshHome(ctx), DEFAULT_WORKSPACES_DIR_NAME))
}

/**
 * Absolute directory holding persisted task records.
 *
 * Deliberately a SIBLING of the A2A workspaces root, not a child of it: the
 * workspace root is what peers see as a working directory, and task records are
 * plugin metadata — a peer that runs `Get-ChildItem` in its workspace should not
 * find the protocol's bookkeeping there.
 *
 * Same volatile protocol as `resolveWorkspaceRoot`: `inbound.tasks.dir` is
 * declared `string` but is an accessor at runtime, so it MUST be unwrapped before
 * the `typeof === 'string'` check. Skipping that check is the trap that has bitten
 * this file twice.
 */
export function resolveTaskDir(
  config: A2ABridgeConfig,
  ctx: { get(name: string): unknown } | undefined,
): string {
  const raw = unwrapVolatile(config.inbound.tasks.dir)
  const configured = typeof raw === 'string' ? raw.trim() : ''
  if (configured.length > 0) return configured
  return resolve(join(resolveDshHome(ctx), TASK_DIR_NAME))
}

/**
 * The agent preset the operator explicitly pinned, as a trimmed id.
 *
 * `undefined` means "no explicit choice" and lets the caller fall through to the
 * deployment default (`agentPresets.resolve()` with the id omitted) — it must
 * never be read as "mount nothing", which is the tool-less state this plugin is
 * fixing.
 *
 * WHY IT GOES THROUGH `unwrapVolatile`: `inbound.agentPreset` is declared
 * `.volatile()` so a Settings write reaches the running fiber without a
 * remount, which makes the live value a `Volatile<string>` ACCESSOR. Reading it
 * as a plain string is the exact bug that once made a YAML `inbound.agent` pin
 * invisible (the field was an accessor object, so `typeof === 'string'` was
 * always false). `unwrapVolatile()` is the single implementation of that
 * protocol; `src/selection.ts` owns it and both fields share it.
 */
export function configuredAgentPreset(config: A2ABridgeConfig): string | undefined {
  const value = unwrapVolatile(config.inbound.agentPreset)
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Cross-field validation. Throws at LOAD time rather than degrading silently
 * at runtime — a security knob that silently does nothing is worse than no
 * knob at all.
 */
export class ConfigError extends Error {}

export function assertConfigCoherent(config: A2ABridgeConfig): void {
  const fail = (message: string): never => {
    throw new ConfigError(`dsh-a2a-bridge: ${message}`)
  }

  if (!config.basePath.startsWith('/')) fail(`basePath must start with '/', got ${config.basePath}`)

  const declared = new Set(Object.keys(config.inbound.peers))

  for (const peer of declared) {
    if (peer === 'owner') fail(`peer name "owner" is reserved for the deployment owner`)
    if (!ENTITY_NAME.test(peer)) fail(`peer name ${JSON.stringify(peer)} must match ${ENTITY_NAME}`)
    const tokenEnv = config.inbound.peers[peer]?.tokenEnv
    if (tokenEnv === undefined || !CREDENTIAL_REF.test(tokenEnv)) {
      fail(`peers.${peer}.tokenEnv must be a credential REFERENCE name matching ${CREDENTIAL_REF}`)
    }
  }

  for (const peer of config.inbound.trustedPeers) {
    if (!declared.has(peer)) fail(`trustedPeers references undeclared peer ${JSON.stringify(peer)}`)
  }

  for (const peer of Object.keys(config.inbound.isolation.peerWorkspaces)) {
    if (!declared.has(peer)) fail(`isolation.peerWorkspaces references undeclared peer ${JSON.stringify(peer)}`)
  }

  const seen = new Set<string>()
  for (const contact of config.outbound.contacts) {
    if (!ENTITY_NAME.test(contact.name)) fail(`contact name ${JSON.stringify(contact.name)} must match ${ENTITY_NAME}`)
    if (seen.has(contact.name)) fail(`duplicate contact name ${JSON.stringify(contact.name)}`)
    seen.add(contact.name)
    if (contact.tokenEnv !== undefined && !CREDENTIAL_REF.test(contact.tokenEnv)) {
      fail(`contacts.${contact.name}.tokenEnv must be a credential reference name`)
    }
    if (contact.timeoutMs !== undefined && (!Number.isFinite(contact.timeoutMs) || contact.timeoutMs <= 0)) {
      fail(`contacts.${contact.name}.timeoutMs must be a positive number`)
    }
  }
}

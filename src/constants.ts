/**
 * The single home for every magic value in this plugin.
 *
 * ADR-008 (正规化 / 标准化): no module may restate these. Configurable knobs
 * belong in `src/config.ts` (schema-driven, user-overridable); protocol and
 * runtime invariants that MUST NOT drift between peers belong here.
 *
 * Anything here is a candidate for a test that pins it.
 */

// ── Protocol ───────────────────────────────────────────────────────────────

/**
 * The only A2A protocol version this bridge speaks.
 *
 * Both ends MUST agree: v0.3 and v1.0 are not aliases. A version mismatch
 * surfaces as -32009 (VersionNotSupportedError) when the header is explicit,
 * and as -32601 (with the v1.0 replacement named in the message) when a v0.3
 * method arrives. `-32609` does not exist in A2A — see ADR-010.
 */
export const A2A_PROTOCOL_VERSION = '1.0'

/** Accepted spellings for the `A2A-Version` request header. */
export const ACCEPTED_A2A_VERSIONS = Object.freeze(['1.0', '1.0.0'] as const)

export const A2A_VERSION_HEADER = 'a2a-version'

/**
 * Default port for the plugin's OWN inbound listener (ADR-011).
 * 3081 sits next to the DSH web GUI's 3080 and avoids it deliberately.
 */
export const DEFAULT_LISTEN_PORT = 3081

/** Well-known Agent Card paths. Served as `exact` routes. */
export const AGENT_CARD_PATH = '/.well-known/agent-card.json'
export const LEGACY_AGENT_CARD_PATH = '/.well-known/agent.json'

/**
 * The default path a CLIENT appends when discovering a remote.
 * Same value as AGENT_CARD_PATH today, but a separate name so a server-side
 * change cannot silently move the client's default with it.
 */
export const DEFAULT_AGENT_CARD_PATH = AGENT_CARD_PATH

/** The JSON-RPC / SSE / REST bindings we advertise on the card. */
export const JSONRPC_BINDING = 'JSONRPC'

/** @type discriminator for google.rpc.ErrorInfo carried in `error.data[]`. */
export const ERROR_INFO_TYPE = 'type.googleapis.com/google.rpc.ErrorInfo'
export const A2A_ERROR_DOMAIN = 'a2a-protocol.org'

// ── Session event vocabulary ───────────────────────────────────────────────

/**
 * The session event that closes one agent turn.
 *
 * A turn can FAIL INTERNALLY while the agent still looks idle: `whenIdle()`
 * resolves normally, no error is thrown, and the only evidence is this event's
 * `data.outcome`. The executor reads it so a failed turn is not reported to the
 * peer as `TASK_STATE_COMPLETED`.
 */
export const TURN_END_EVENT_TYPE = 'turn/end'

/** `turn/end.data.outcome` value meaning the turn ended in an error. */
export const TURN_OUTCOME_ERROR = 'error'

// ── HTTP ───────────────────────────────────────────────────────────────────

/**
 * JSON responses are always UTF-8. The charset parameter matters: without it a
 * client (PowerShell's Invoke-WebRequest among them) may decode the body as
 * Latin-1 and render every non-ASCII reply as mojibake.
 */
export const CONTENT_TYPE_JSON = 'application/json; charset=utf-8'
export const CONTENT_TYPE_SSE = 'text/event-stream'

/**
 * SSE response headers. `X-Accel-Buffering: no` stops a reverse proxy from
 * buffering the stream (a buffered SSE stream never reaches the peer).
 */
export const SSE_HEADERS = Object.freeze({
  'content-type': CONTENT_TYPE_SSE,
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
})

/**
 * Application-level heartbeat comment frame.
 *
 * Neither the A2A spec nor the official SDK specifies heartbeats or
 * `Last-Event-ID` resumption. We send this periodically so idle proxies do not
 * terminate a long-running task stream. It is an operational measure, not a
 * protocol requirement — peers MUST ignore unknown comment frames.
 */
export const SSE_HEARTBEAT_FRAME = ': ping\n\n'
export const SSE_HEARTBEAT_INTERVAL_MS = 15_000

/** Methods allowed on the JSON-RPC endpoint. Anything else -> 405. */
export const RPC_ALLOWED_METHOD = 'POST'
export const CARD_ALLOWED_METHOD = 'GET'

// ── Auth ───────────────────────────────────────────────────────────────────

export const BEARER_PREFIX = 'Bearer '
export const BEARER_PATTERN = /^Bearer\s+(.+)$/i
export const WWW_AUTHENTICATE = 'www-authenticate'

/** Success. Named because every bare `200` in a handler was a review miss. */
export const HTTP_OK = 200

/**
 * HTTP statuses used for transport-security failures. The response body is
 * still a valid JSON-RPC error envelope, so a client that parses only the body
 * and one that reads only the status are both served.
 */
export const HTTP_UNAUTHORIZED = 401
export const HTTP_FORBIDDEN = 403
/** Default route miss on the plugin's own listener (`server.ts`). */
export const HTTP_NOT_FOUND = 404
/** A write refused because the backing document moved since it was read. */
export const HTTP_CONFLICT = 409
export const HTTP_TOO_MANY_REQUESTS = 429
export const HTTP_PAYLOAD_TOO_LARGE = 413
export const HTTP_METHOD_NOT_ALLOWED = 405
export const HTTP_BAD_REQUEST = 400
export const HTTP_SERVICE_UNAVAILABLE = 503
export const HTTP_INTERNAL_SERVER_ERROR = 500
/** Used when a mutation is not a JSON request, which also blocks form CSRF. */
export const HTTP_UNSUPPORTED_MEDIA_TYPE = 415

/** Body code used for transport-security failures (never an A2A -320xx). */
export const TRANSPORT_ERROR_CODE = -32600

/**
 * Addresses whose meaning is "bind every interface".
 *
 * This is a SECURITY boundary, not a formatting detail: `assertConcreteHost`
 * refuses a wildcard bind so this agent's tool surface is not exposed to
 * whatever network the machine happens to be on. Keeping the spellings in one
 * pattern (instead of five `===` comparisons inside `isWildcard`) is what makes
 * "a new spelling was added but the check was not updated" visible in review.
 *
 * Why a regex instead of a frozen string array: an array of quoted addresses
 * would itself restate the very literals the audit gate forbids in logic, and a
 * second copy of that list is exactly how one spelling gets missed.
 *
 * `::1` is deliberately NOT here — it is loopback, not a wildcard.
 */
export const WILDCARD_HOST_PATTERN = /^(?:0\.0\.0\.0|::|::0|\[::\]|\*)$/

// ── Session identity (ADR-007) ─────────────────────────────────────────────

/**
 * Length of the sha256 digest slice used to derive a session id from an A2A
 * contextId. Long enough to avoid collisions, short enough to keep session ids
 * readable in the UI.
 */
export const SESSION_DIGEST_LENGTH = 24

/**
 * Upper bound on the normalized "project key" that seeds the stable A2A context.
 *
 * The cap is applied to the HASH INPUT, so two pathological keys sharing their
 * first N characters collapse into one conversation — acceptable, because at
 * that depth they name the same path.
 */
export const MAX_PROJECT_KEY_LENGTH = 200

// ── Limits ─────────────────────────────────────────────────────────────────

/**
 * Upper bound on a `diagnostic` string attached to a subagent result.
 * Anything longer is truncated — diagnostics are for humans, not for
 * unbounded memory growth.
 */
export const MAX_DIAGNOSTIC_BYTES = 4_096

/** Poll interval while waiting on a remote task that is not yet terminal. */
export const REMOTE_POLL_INTERVAL_MS = 1_000

/**
 * Fallback wait for ONE outbound call when the caller passes no timeout.
 *
 * The same value is the schema default for `outbound.contacts[].timeoutMs`
 * (`src/config.ts` imports THIS name). It lives here — not in `config.ts` — so
 * the schema default and the programmatic fallback cannot drift: `outbound/`
 * must not import `config.js` (layering), and a second copy of `300_000` there
 * was the double-truth pattern the audit gate exists to catch.
 */
export const DEFAULT_CALL_TIMEOUT_MS = 300_000

/**
 * Wait for a remote Agent Card fetch when the caller passes no timeout.
 *
 * Deliberately SHORTER than `DEFAULT_CALL_TIMEOUT_MS` and a separate name:
 * discovery is a health probe (a peer that cannot answer its card within this
 * window is unusable anyway), while a task call legitimately runs for minutes.
 * Reusing one number for both is the semantic overload this split prevents.
 */
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 30_000

/**
 * Window of the fixed-window rate limiter, in milliseconds.
 *
 * Coupled to `inbound.rateLimitPerMinute`: the limit is expressed per minute, so
 * the bucket MUST be one minute. Naming it here means a future configurable
 * window cannot silently diverge from the counter's unit.
 */
export const RATE_LIMIT_WINDOW_MS = 60_000

/**
 * How long a started turn may take to produce its first event before the
 * executor re-waits on `whenIdle()`.
 *
 * `whenIdle()` can resolve before the turn even starts; without this grace the
 * reply would be collected from an event stream that has not grown yet.
 */
export const TURN_START_GRACE_MS = 5_000

/**
 * Poll interval while waiting for that first event.
 *
 * NOT `REMOTE_POLL_INTERVAL_MS`: that one paces requests to a remote peer
 * (network), this one paces reads of a local event array (cheap, so it can be
 * an order of magnitude tighter).
 */
export const TURN_START_POLL_MS = 100

// ── Configuration API + model selection (GUI knob) ─────────────────────────

/**
 * Same-origin route the browser half calls to read/write the A2A model
 * selection. Deliberately NOT under `basePath` (`/a2a`): that prefix belongs to
 * the peer-facing JSON-RPC listener this plugin owns (ADR-011), and a config
 * route reachable by a remote peer would be a second, unintended control plane.
 */
export const CONFIG_ROUTE_PATH = '/a2a-bridge/config'

/**
 * Upper bound on one selection field. Provider and model ids are short in every
 * deployment seen so far; a 200-char ceiling rejects junk without constraining
 * a legitimate future provider name.
 */
export const MAX_SELECTION_FIELD_LENGTH = 200

/** A config document is two short strings; anything larger is not a config POST. */
export const MAX_CONFIG_BODY_BYTES = 4_096

/** Allowed methods on the configuration route. Surfaced verbatim in `Allow`. */
export const CONFIG_ROUTE_ALLOW = 'GET, POST'

/**
 * The Config field that stores the model pin, as a two-segment path under the
 * plugin's own config root (`inbound.agent` in `src/config.ts`).
 *
 * Kept here because the settings write channel and the read path must name the
 * same field: a typo in either would silently write a key nobody reads.
 */
export const SELECTION_CONFIG_NAMESPACE = 'inbound'
export const SELECTION_CONFIG_FIELD = 'agent'

/**
 * How many times a settings-backed selection write may run before a revision
 * conflict is reported. One retry covers the read-then-write race that the
 * browser payload cannot close (it carries no revision); a SECOND conflict means
 * another writer is genuinely active and must not be clobbered.
 */
export const SETTINGS_WRITE_ATTEMPTS = 2

/**
 * `SettingsConflictError`'s stable machine code. Matched structurally so this
 * plugin never imports the settings package (it is a peer at runtime, absent in
 * some compositions).
 */
export const SETTINGS_CONFLICT_CODE = 'SETTINGS_CONFLICT'

/**
 * Cap on how many `Volatile<T>` accessors one field read unwraps. A volatile
 * value is a single `.get()` hop; the cap only exists so a malformed object
 * with a self-returning `get()` cannot hang a request.
 */
export const MAX_VOLATILE_UNWRAP_DEPTH = 4

/** Environment override DSH itself uses for its user-data root. */
export const DSH_HOME_ENV = 'DSH_HOME'

/** Default user-data root directory under the OS home (matches dsh-home-paths). */
export const DSH_HOME_DIR_NAME = '.dsh'

/**
 * Whether the inbound dispatcher actually serves `SendStreamingMessage`.
 *
 * SINGLE SOURCE OF TRUTH for two places that must never disagree:
 *   - `buildAgentCard()` advertises `capabilities.streaming` from this value;
 *   - `dispatch()` decides its `SendStreamingMessage` answer from this value.
 *
 * A capability flag that drifts from the implementation is a defect that fails on
 * the PEER side: the peer reads the card, asks for a stream, and gets -32004 while
 * the serving side logs nothing unusual. Driving both sides from one constant
 * makes flipping it a deliberate, two-sided act instead of a silent omission.
 *
 * To enable streaming: implement the handler in `dispatch()`, set this to `true`,
 * and update the regression test that pins card default === this constant.
 */
export const INBOUND_STREAMING_IMPLEMENTED = true

/**
 * Retention for persisted A2A task records: seven days.
 *
 * The value only has to outlive a peer's polling window. A week is comfortably
 * longer than any interactive delegation and short enough that a forgotten
 * deployment cannot accumulate files indefinitely.
 */
export const DEFAULT_TASK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** Hard cap on persisted task records, so the directory stays bounded. */
export const DEFAULT_TASK_MAX_RECORDS = 1000

/** Directory name under the DSH user-data root that holds task records. */
export const TASK_DIR_NAME = 'a2a-tasks'

/**
 * Longest task id the store will turn into a file name.
 *
 * A v1.0 task id is a UUID (36 chars); the cap only has to be comfortably above
 * that while keeping the resulting file name inside the platform limit.
 */
export const MAX_TASK_ID_LENGTH = 128

/** Default page size when listing stored tasks. */
export const DEFAULT_TASK_LIST_LIMIT = 100

/**
 * Minimum gap between two progress `statusUpdate` frames on a streaming turn.
 *
 * A turn reports a handful of milestones, so this rarely coalesces anything today;
 * it exists so that a future finer-grained source cannot flood the peer's socket
 * one frame per session event. 200 ms keeps a multi-minute turn to a few dozen
 * frames at worst.
 */
export const STREAM_PROGRESS_MIN_INTERVAL_MS = 200

/**
 * Milliseconds in one day.
 *
 * The settings page offers retention in DAYS because a millisecond field is
 * unreadable, while the schema stores milliseconds because that is the unit the
 * store compares. This constant is the single conversion point.
 */
export const MS_PER_DAY = 86_400_000
/**
 * Delay before the seam probe reports, in milliseconds.
 *
 * Zero means "next macrotask", not "no timeout": `apply()` runs before most Host
 * services exist, so an inline probe logs `=0 … missing=<everything>` — the exact
 * opposite of the truth. Named here so the scheduling intent is explicit and the
 * hardcoded-number gate does not have to special-case a bare `0`.
 */
export const SEAM_PROBE_DELAY_MS = 0
/**
 * HOST tools an A2A session must not reach.
 *
 * These are the cross-session / cross-agent readers that the Harness registers
 * for every agent. Verified present on a live deployment via
 * `cordis_inspect_query host/Tool listTools`:
 *
 *   session_search / session_event_search   read other sessions' content
 *   session_trace / session_event_trace     read other sessions' lineage
 *   session_event_read                      read one full event of another session
 *   list_agents                             enumerate durable teammates
 *   team_task_*                             the shared team board
 *
 * A2A is a cross-machine delegation surface; a remote peer that can enumerate and
 * read this machine's other conversations can harvest the operator's history.
 * The list is applied through `tools.restrict()` for the agent's own scope, so it
 * narrows ONLY the A2A session and leaves the operator's own agent untouched.
 *
 * Names that a deployment does not register are harmless: the policy probes
 * visibility before restricting, so an absent name simply is not denied.
 */
export const A2A_DENIED_TOOLS = Object.freeze([
  'session_search',
  'session_event_search',
  'session_trace',
  'session_event_trace',
  'session_event_read',
  'list_agents',
  'team_task_create',
  'team_task_list',
  'team_task_get',
  'team_task_update',
] as const)
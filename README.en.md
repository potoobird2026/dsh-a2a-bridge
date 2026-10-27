# dsh-a2a-bridge

**Let DSH instances on a LAN delegate tasks to each other over A2A v1.0 — and turn every A2A conversation into a visible session you can open and watch, instead of a black-box call.**

> Version `0.1.0` (unreleased) · Protocol A2A **v1.0** · License MIT
> Local gates all pass (typecheck / 453 tests / build / verify:exports / verify:version), and **the two real machines have been interoperated bidirectionally**. Read [Current status (honest version)](#current-status-honest-version) before deciding to install anything.

---

## Why this exists: A2A conversations must be visible (ADR-007)

This is the project's first design goal, not an add-on. The requirement, in the user's own words (translated):

> A2A chats should get **their own workspace**. Every A2A agent-to-agent conversation should have a **session window just like a user↔DSH conversation**, so the user can always see **what the agents are running and doing** — no black-box operation.

Broken into four hard requirements:

| Requirement | Meaning | Where it lives |
|---|---|---|
| ① Dedicated workspace | A2A conversations get their own workspace, never mixed into your local ones | `src/session/session-binding.ts` → `ctx.get('workspaceRegistry')` |
| ② Session window | Every A2A conversation is an ordinary, openable session | `contextId` → `sessionId`, deterministic (sha256 slice) |
| ③ Live visibility | You can see what the agent is doing right now | `SessionMirror` (`src/session/events.ts`) + SSE frame decoding |
| ④ Not a black box | Returning only a final result is not acceptable | Task-state projection + per-turn progress written into the session (`developer/message` surface) |

Intended behaviour (ADR-007; binding lives in `src/session/`, wiring in `src/index.ts`, and the session event mirror in `src/session/events.ts` is wired into the entry): every inbound `contextId` binds to (or reuses) a **visible DSH session** that is placed in **one workspace named by `session.workspaceTitlePrefix` (default `A2A`)** — no peer and no timestamp in the title, so A2A does not add a sidebar row per conversation. Inside that workspace each session keeps its own cwd, `<root>/<peer>/<session-id>`, because an agent's cwd is its filesystem scope: sessions are isolated per peer, only the workspace is shared. On the outbound side, the local session shows "delegating to peer-b / remote status / reply received". Session ids are deterministic, so a peer returning with the same `contextId` lands in **the same session** — history survives, and it survives a process restart too.

> Counter-example we refuse: an HTTP tool that returns only final text. That is the black box this project exists to avoid.

---

## Architecture

```
┌─────────────────── Machine A  192.168.1.10  (DSH 0.2.1-rc.2) ─────────────────┐
│                                                                              │
│  user ──▶ DSH session ──▶ local agent                                        │
│                             │                                                │
│                             │ ctx.subagents provider "a2a"  (ADR-006)        │
│                             ▼                                                │
│                     src/outbound/client.ts                                   │
│                     ├─ discoverCard()   GET /.well-known/agent-card.json    │
│                     ├─ sendMessage()    POST /a2a  a2a-version: 1.0 + Bearer │
│                     └─ streamMessage()  SSE frames ──▶ session event mirror  │
│                                                          (ADR-007)           │
│                                                             │                │
│  visible A2A workspace ◀── src/session/session-binding.ts ◀─┘                │
│  "A2A"                       contextId ──sha256──▶ sessionId (deterministic) │
│                                                                              │
│  src/inbound/server.ts (own node:http listener, ADR-011; NOT ctx.webServer)  │
│   ├─ bind  inbound.listen.host:3081 (default 127.0.0.1; wildcard refused)   │
│   ├─ exact  /.well-known/agent-card.json ──▶ Agent Card (anonymous read)    │
│   ├─ exact  /.well-known/agent.json      ──▶ legacy alias                   │
│   └─ exact  /a2a ──▶ src/inbound/routes.ts                                  │
│                      order: method → auth → rate-limit → trust → version →  │
│                             body → parse → params → dispatch                │
│                      dispatch ──▶ one DSH turn in the bound session ──▶ Task│
└──────────────────────────────────────────────────────────────────────────────┘
          ▲                                          │
          │  A2A v1.0 JSON-RPC over HTTP (Bearer)     │  Task / statusUpdate / artifactUpdate
          │                                          ▼
┌─────────────────── Machine B  192.168.1.11  (DSH 0.2.1-rc.3) ─────────────────┐
│  Same plugin, mirrored role: inbound routes expose B's agent, outbound client │
│  reaches back to A.                                                          │
└──────────────────────────────────────────────────────────────────────────────┘
```

Layering discipline (ADR-008 — stop bugs from leaking across layers):

```
src/protocol/**  zero dependencies, only constants/types — unit-testable without
                 booting Cordis or opening a socket
src/security/**  only node:crypto + constants/types
src/inbound/**   protocol + security
src/outbound/**  protocol + security
src/session/**   protocol + security
src/index.ts     wire-up only
```

---

## Current status (honest version)

| Status | What |
|---|---|
| ✅ Implemented & verified | **Protocol layer** `src/protocol/*`: `wire` / `jsonrpc` / `parse` / `card` / `sse`, **zero dependencies**, verifiable without DSH |
| ✅ Implemented & verified | **Config schema** `src/config.ts` (includes `inbound.listen` and load-time validation `assertConfigCoherent`) |
| ✅ Implemented & verified | **Security primitives** `src/security/index.ts` (constant-time compare, per-peer identification, rate limiting, outbound redaction / surrogate repair); **rate-limit 429, `trustedPeers` 403, and 401 with `www-authenticate` are all wired up** |
| ✅ Implemented & verified | **Session binding** `src/session/session-binding.ts` + `workspace.ts` (contextId → sessionId, workspace naming and paths) |
| ✅ Implemented & verified | **Session event mirror** `src/session/events.ts` (`SessionMirror`, wired into `src/index.ts`; outbound progress is written to the `developer/message` surface and `dispose()` tears everything down) |
| ✅ Implemented & verified | **Inbound routes** `src/inbound/routes.ts` (card + JSON-RPC, body ceiling, layered auth) |
| ✅ Implemented & verified | **Inbound listener** `src/inbound/server.ts` (own `node:http` server, ADR-011; concrete IP bind, wildcard refused, sockets and SSE reaped on dispose) |
| ✅ Implemented & verified | **Outbound client** `src/outbound/client.ts` (card discovery, SendMessage, GetTask polling, SSE decoding) |
| ✅ Implemented & verified | **Subagent provider** `src/outbound/provider.ts` (ADR-006) and **outbound tools** `src/outbound/tools.ts` |
| ✅ Implemented & verified | **Plugin entry** `src/index.ts` and **bundle assembly** `cordis.patch.yml` (`inbound.listen` defaults to `127.0.0.1:3081`) |
| ✅ Verified (local gates) | `npx tsc -p tsconfig.json --noEmit` exit 0 · `npx vitest run` **453 passed / 453** (23 spec files) · `npx tsc -p tsconfig.build.json` exit 0 (**24 JS files** into `lib/`) · `node scripts/verify-exports.mjs` ✓ 6 export targets · `node scripts/verify-version.mjs` ✓ versions agree |
| ✅ Implemented & verified | **Wire integration tests** `tests/wire/` (real listener + real HTTP: inbound pipeline, card discovery, outbound client ↔ inbound server round-trip) |
| ⏳ Not finished | mesh tests (real multi-hop networks) |
| ❌ Not implemented | Cross-session tool deny-list, multi-agent, push notifications, mTLS |
| ✅ Verified (real machines) | Both A2A endpoints interoperate: Agent Card, Bearer auth, end-to-end SendMessage, session continuity, A2A workspace grouping, outbound mirror session |
| ✅ Verified (task state machine) | `GetTask` returns the same projection **across a restart** (disk-backed; `inbound.tasks` configures directory and retention) · `CancelTask` distinguishes unknown `-32001` from settled `-32002` |

> The "verified" above has two parts: **local gates** (measured 2026-10-26: typecheck, 453 tests, build artifacts, exports/version contracts) and **bidirectional interoperability between the two real machines** (Agent Card, Bearer auth, end-to-end SendMessage, session continuity, A2A workspace grouping, outbound mirror session). NOT covered: **mesh-style multi-hop networks** and executable cases under `tests/live` — they do not change the "the two machines interoperate" conclusion, but multi-hop / cross-subnet has not been measured.


---

## Quick start

Full steps: [`docs/installation.md`](docs/installation.md). Troubleshooting: [`docs/troubleshooting.md`](docs/troubleshooting.md).

Two installation facts worth memorizing first:

1. **Installing the plugin means editing two places**: the profile's `dependencies` **and** `dsh.profile.bundles`. Editing only one downloads the package without loading it — and usually without any error.
2. **Restart `dsh` afterwards**; newly added tools only appear in a **new session**.

Three more that save the most time:

3. **On your own machine, install from the plugin page** (sidebar → Plugins → install from a local directory or an npm spec). DSH writes both places for you, and uninstalling happens there too. Steps: [`docs/installation.md`](docs/installation.md) §3.1.
4. **The deploy directory must be pure ASCII.** A development path may contain non-ASCII characters (currently `…\开发\dsh-a2a-plugin`); an install target may not — DSH rewriting `package.json` corrupts the encoding otherwise.
5. **Pick a model after installing.** A2A has no default model; until you choose one, every request is rejected with `-32603`. See [Model selection](#model-selection-a2a-requires-a-model-chosen-in-the-plugin-page).

---

## Configuration

Every knob lives in `src/config.ts` and nowhere else (ADR-008: no literals in modules). Field-by-field reference below.

### Top level

| Field | Type | Default | Meaning |
|---|---|---|---|
| `basePath` | string | `"/a2a"` | JSON-RPC endpoint path. **Must start with `/`** (validated at load) |
| `publicUrl` | string | none (optional) | Externally reachable URL advertised on the Agent Card. **Must be set on a LAN** — the listener may bind `127.0.0.1`, and publishing that on a card is always wrong |

### `card`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `card.name` | string | `"dsh-a2a-bridge"` | Card name |
| `card.description` | string | `"A DeepSeek Harness agent reachable over A2A."` | Card description |
| `card.public` | boolean | `true` | Card is anonymously readable (discovery needs it). `false` closes anonymous reads |
| `card.skills` | array | `[]` | **Declared by the deployment**, never a projection of the tool registry (avoid disclosure); falls back to `general` when empty |
| `card.extendedSkills` | array | `[]` | Extended-card skills; non-empty makes `capabilities.extendedAgentCard = true` |
| `card.provider.organization` | string | `""` | Provider organization |
| `card.provider.url` | string | `""` | Provider URL |

`card.skills[]` / `card.extendedSkills[]` elements: `{ id: string(required), name: string(required), description: string="", tags: string[]=[] }`

### `inbound` (remote → me: server side)

| Field | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Serve A2A to remote peers |
| `peers` | dict | `{}` | **Who may reach me**: `peerName → { tokenEnv: string(required) }`. `tokenEnv` is a `ctx.credentials` **reference name**, never a token value |
| `trustedPeers` | string[] | `[]` | An allow-list on top of authentication; empty = all declared peers. **Referencing an undeclared peer fails at load** |
| `rateLimitPerMinute` | number | `60` | Requests per peer per minute (excess → 429) |
| `maxContextTurns` | number | `5` | Turns retained per context |
| `sendMode` | `"block"` \| `"immediate"` | `"block"` | Wait for completion or return at once |
| `blockTimeoutMs` | number | `60000` | Upper bound on blocking waits |
| `contextIdleTtlMs` | number | `1800000` | Idle context reclamation (30 min) |
| `maxResidentContexts` | number | `64` | Resident context ceiling |
| `maxBodyBytes` | number | `1000000` | Request body ceiling (excess → 413) |
| `isolation.workspaceMode` | `"per-peer"` \| `"shared"` | `"per-peer"` | Per-peer working directory = no cross-peer file reads |
| `isolation.workspaceRoot` | string | `""` (**optional**; the shipped patch omits it) | Root of A2A workspaces. **Empty is the portable default:** it derives `<DSH_HOME>/a2a-workspaces` (`homePaths` → `$DSH_HOME` → `~/.dsh`). A non-empty value is used verbatim, for deployments that pin one shared root |
| `isolation.peerWorkspaces` | dict | `{}` | Per-peer directory override; keys must be declared peers |
| `listen.host` | string | none (schema-required; the shipped `cordis.patch.yml` supplies `"127.0.0.1"`) | **ADR-011 listen address.** Must be ONE concrete local address (e.g. `192.168.1.10`); wildcards such as `0.0.0.0` / `::` / `*` throw `WildcardBindError` at load time |
| `listen.port` | number | `3081` | Listen port; avoids the GUI's `3080`. Open it inbound in the firewall |
| `strictVersionHeader` | boolean | `true` | Reject a missing `A2A-Version` header per spec §3.6.2 (`-32009`). `false` treats absence as 1.0 (deployment policy, not spec) |
| `agent.provider` / `agent.model` | string | none (**unset means no model selected**) | Which provider/model A2A sessions run on. **Set them as a pair**; a half-set pair counts as unset. Unset makes A2A reject every request (`-32603`) and point at the plugin page — see [Model selection](#model-selection-a2a-requires-a-model-chosen-in-the-plugin-page) |

### `outbound` (me → remote: client side)

| Field | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Allow delegating outward |
| `providerName` | string | `"a2a"` | Name registered into `ctx.subagents` (ADR-006) |
| `contacts` | array | `[]` | **Who I may reach**: static URL + Agent Card well-known discovery (ADR-004) |

`contacts[]` elements:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `name` | string(required) | — | Contact name; also a workspace directory segment; **must be unique** |
| `url` | string(required) | — | Remote JSON-RPC endpoint |
| `agentCardPath` | string | `"/.well-known/agent-card.json"` | Card path. A well-known suffix already present in `url` is stripped before appending, so it is never doubled |
| `tokenEnv` | string | none | Reference name of the Bearer token for this remote (optional) |
| `timeoutMs` | number | `300000` | Per-call timeout; must be positive |

> `inbound.peers` (who may enter) and `outbound.contacts` (whom I may reach) deliberately do not share a name — one shared word would be a trap.

### `session` (ADR-007)

| Field | Type | Default | Meaning |
|---|---|---|---|
| `workspaceTitlePrefix` | string | `"A2A"` | Workspace title — a single fixed name (no peer, no timestamp) |
| `contextIdPrefix` | string | `"a2a"` | New contextId prefix → `a2a-peer-b-<hash>` |
| `mirrorRemoteProgress` | boolean | `true` | Mirror remote progress into the local session for live viewing |

### Load-time validation (refuse to start)

- `basePath` not starting with `/` → reject
- peer name `owner` is reserved → reject
- peer / contact names must match `^[A-Za-z0-9][A-Za-z0-9_-]*$` (they become path segments; separators banned)
- `tokenEnv` must match `^[A-Za-z_][A-Za-z0-9_]*$` — **pasting a token value is rejected**
- `trustedPeers` / `peerWorkspaces` referencing an undeclared peer → reject
- duplicate contact names / `timeoutMs <= 0` → reject
- `listen.host` empty or a wildcard address (`0.0.0.0` / `::` / `[::]` / `*` / `::0`) → reject (`WildcardBindError`)

### Example configuration

```yaml
basePath: /a2a
publicUrl: http://192.168.1.10:3081/a2a   # reachable externally; the bind address usually must not be published
card:
  name: dsh-a2a-bridge
  description: Machine A — DSH on the LAN
  public: true
  skills:
    - id: general
      name: general
      description: General-purpose agent task execution.
inbound:
  enabled: true
  listen:
    host: 192.168.1.10        # a concrete address; wildcards are refused at load
    port: 3081
  peers:
    peer-b:
      tokenEnv: A2A_TOKEN_PEER_B          # a reference name; the value comes from ctx.credentials
  trustedPeers: [peer-b]
  sendMode: block
  isolation:
    workspaceMode: per-peer
    workspaceRoot: D:/a2a-workspaces   # optional; omit to derive <DSH_HOME>/a2a-workspaces
outbound:
  enabled: true
  providerName: a2a
  contacts:
    - name: peer-b
      url: http://192.168.1.11:3081/a2a
      tokenEnv: A2A_TOKEN_PEER_B
session:
  workspaceTitlePrefix: A2A
  mirrorRemoteProgress: true
```

> This is the **shape of the config object** the schema accepts. The shipped `cordis.patch.yml` already carries the same keys and defaults (`inbound.listen: { host: 127.0.0.1, port: 3081 }`). On a two-machine deployment, change `listen.host` to each machine's real LAN address and open `3081` in the firewall.

Credential resolution order (ADR-005, four layers): process env → managed document → `<cwd>/.env` → `$DSH_HOME/.env`. Resolved **per request, never cached**, so a rotated token takes effect on the next request without a restart.

---

## Model selection: A2A requires a model chosen in the plugin page

Which model A2A sessions run on is a **deployment decision, not something the plugin can guess**. This plugin therefore has **no default model**:

> **Until a model is selected, every A2A request is rejected with `-32603`, and the message tells you to pick one in the plugin page.**
> This is deliberate: `-32603` (internal error) means "the request is well-formed, the **server** is misconfigured", not `-32602`, which would blame the peer. The peer that sent the request usually cannot change local config — the human who can fix it is sitting in front of the DSH GUI, so the error message points at that page.

### Two entry points, ONE stored field

| Route | Lands in | Use when |
|---|---|---|
| **Plugin page config card** (recommended) | `inbound.agent` in the profile patch, written through DSH's `settings` service | Everyday use: a few clicks, applies to the **next** A2A session, **no restart** |
| `inbound.agent` pin in config | the same field, in the profile's `cordis.patch.yml` | You need a fixed binding that ships and reviews with the deployment |

- There is **one storage** for the pin, not two: both routes write `inbound.agent`. A profile-patch value overrides an inherited pin from the bundle patch, and the page always displays the value that is actually effective.
- The model the GUI shows and the model the executor uses go through the **same resolver** (`resolveEffective()`), so "page says A, execution uses B" cannot happen.
- `provider` and `model` are a **pair**: setting only one counts as unset.
- There is no deployment-level fallback model. That is a hard constraint — silently borrowing a deployment default would send A2A traffic to a model nobody chose.

### Where the model list comes from (runtime probing, not hardcoded)

The provider/model dropdowns are **not a hardcoded list**: every read asks the host runtime in real time.

```text
GET  /a2a-bridge/config   → { providers: [{ provider, models[] }], provider, model, source, configured }
POST /a2a-bridge/config   → save the selection (provider + model, each length-capped)
```

- The source is `ctx.llm.listProviders()` (`readModelCatalog()` in `src/config-api.ts`) — **which providers this machine configured, and which models each exposes, is decided entirely at runtime**. Adding a provider or a model needs no plugin code change; it appears in the dropdown automatically.
- When the host has no `llm` service, or the list read fails, the card says "No model provider is configured on this machine. Configure one in Settings → Models first" instead of showing a silently empty dropdown.
- This route is **deliberately not under `basePath` (`/a2a`)**: `/a2a` is the peer-facing JSON-RPC listener, and putting a config route under that prefix would hand peers a second control plane. It lives on same-origin `/a2a-bridge/config`, accepts only `application/json` POSTs (which also forces a CORS preflight cross-origin).
- The selection is **not written into `cordis.patch.yml`**: that file is the user's hand-authored "config as code" asset, and rewriting it from a browser request would corrupt a user-owned document.

### What you see when no model is selected

| Symptom | Meaning | Fix |
|---|---|---|
| A2A request returns `-32603` mentioning "no model selected" | Deployment has no model bound | Plugin page → A2A bridge → config → pick provider + model → Save |
| Config card shows "no model selected (click to configure)" | Same, at a glance | Same as above |
| Dropdown is empty, says "No model provider is configured on this machine" | Host has no usable provider | Settings → Models, configure a provider first |
| Saved successfully but the next turn still uses the old model | That A2A session is already running | A save applies to the **next** turn; an already-bound agent does not switch models |

Troubleshooting detail: [docs/troubleshooting.md](docs/troubleshooting.md) entry **D4**.

---

## Protocol notes

- The authority is `specification/a2a.proto` (A2A spec §1.4) — **not** the JSON Schema, and **not** any SDK's TS types.
- **v1.0 and v0.3 are not aliases**: `kind` discriminators are gone, enums use ProtoJSON spellings (`TASK_STATE_WORKING` / `ROLE_USER`), `SendMessage` returns `{ task: … }`, task references are `id` not `taskId`, cards use `supportedInterfaces[]`, and `configuration.blocking` became the semantically opposite `returnImmediately`. Both ends must agree on the version.
- **The error-code family is `-32001..-32009`. `-32609` does not exist** (a typo in the handoff document, see `research/05` §7.2). The JSON-RPC reserved range is `-32700..-32600`; `-32609` falls outside it.
- Authentication / rate-limit / trust failures deliberately **do not** use A2A semantic codes: they answer with HTTP statuses (401/403/429/413) while the **body remains a valid JSON-RPC error envelope**, so clients that read only the body and clients that read only the status both work.
- SSE: v1.0 dropped the `final` flag — **closing the stream is the terminal signal**. `sse.ts` provides the `: ping` comment frame (`sseHeartbeat()`; an operational keepalive, not a protocol requirement — peers must ignore unknown comment frames). **The streaming route IS wired into the inbound handler**: `SendStreamingMessage` answers `200 + text/event-stream` with `task` → one or more `statusUpdate` → `artifactUpdate` → terminal `statusUpdate` (see `src/inbound/stream-frames.ts` and `src/inbound/sse-response.ts`). A real-machine run produced 5 frames.

---

## Boundaries (limits and known risks, unfiltered)

1. **Plaintext HTTP + Bearer (ADR-003).** The MVP accepts LAN plaintext; the real risk is **token sniffing on the wire**. Mitigations: 32-byte random tokens, constant-time comparison, rate limiting, short-lived rotation — none of which replaces encryption. Upgrade path: plaintext → self-signed TLS (the webServer implementation supports `--tls-cert/--tls-key`) → Tailscale. Reopen this ADR if untrusted devices appear on the LAN.
2. **~~Cross-session tool deny-list is not implemented~~ — implemented.** `tools.restrict()` narrows the A2A session's OWN agent scope (not the plugin root scope), applies by default, and needs no configuration: `session_search` / `session_event_search` / `session_trace` / `session_event_trace` / `session_event_read` / `list_agents` / `team_task_*` are not visible to an A2A session, while the operator's own agent is untouched. Residual risk: this is a **name-based deny list**, so a future upstream tool with the same cross-session semantics re-opens the leak if the list is not kept in step.
3. **~~Task state does not survive a process restart~~ — implemented.** Task records are persisted to disk (`inbound.tasks`), so `GetTask` returns the same projection after a restart; `CancelTask` on an already-terminal task answers `-32002` instead of pretending to succeed.
4. **TLS has not reached the self-built listener yet.** The `ctx.webServer` layer supports `--tls-cert/--tls-key`, but after ADR-011 the A2A endpoint is served by the plugin's own `node:http` listener, **which currently has no TLS switch** — so the inbound path is plaintext HTTP + Bearer (ADR-003). Loading a certificate into that listener is a follow-up hardening item; the upgrade path is unchanged: plaintext → self-signed TLS → Tailscale.
5. **LAN reachability is solved by ADR-011.** Under the Desktop shell `ctx.webServer` is hard-bound to `127.0.0.1` (`desktopWebServerHost()` returns the constant, with a throwing assertion; `networkExposure: 'lan'` only opens an HTTPS edge and never exposes the upstream HTTP origin). The plugin therefore **no longer mounts** on `ctx.webServer`: `src/inbound/server.ts` creates its own `node:http` listener. `inbound.listen.host` must be a **concrete address** (`0.0.0.0` / `::` and other wildcards throw `WildcardBindError` at load), the default port is `3081`, and the lifecycle is tied to the Cordis fiber (sockets and SSE streams are reaped on dispose). Operators must open that port inbound in the firewall. Real-machine connectivity has been verified in both directions.
6. **Reference implementations without a LICENSE were used for paradigm only; no code was copied** (see Acknowledgements).
7. **This machine still runs DSH `0.2.1-rc.2` while `192.168.1.11` runs `rc.3`.** Seam changes across rc versions must be checked against the published `lib/*.d.ts`, not just the changelog.

---

## Verifying a deployment (run these two first)

```bash
# 1. Real-machine behaviour: card, auth, end-to-end SendMessage, session
#    continuity, task state machine.
A2A_LOCAL_URL=http://192.168.1.10:3081 \
A2A_REMOTE_URL=http://192.168.1.11:3081 \
A2A_TOKEN=<your token> npm run verify:live

# 2. Runtime seam probe: which optional capabilities this DSH actually provides.
npm run seams                 # the newest probe
npm run seams -- --compare    # diff against the last DIFFERENT probe
```

`seams` prints one line such as:

```
a2a: seams agentsResume=1 workspaceRegistry=1 workspaceUnarchive=1 … missing=none
```

Run it on **both machines and compare the two lines** — that is the runtime-visible
part of a cross-build difference (why a `.d.ts` diff is impossible, see
[docs/rc-seam-audit.md](docs/rc-seam-audit.md)). No such line in the log means the
**running build predates the probe**: restart DSH and retry.

> If the two task-state-machine checks in `verify:live` fail, the usual cause is the
> same "build older than feature" — restart and rerun.

## Troubleshooting (three most common; full list in [docs/troubleshooting.md](docs/troubleshooting.md))

> For "the code looks right but it just does not work", go straight to
> [troubleshooting §8](docs/troubleshooting.md) **D1–D9** —
> the nine bugs this project actually hit while implementing, each with symptom / root cause / fix.

**① A hostname does not connect, an IP does.**
Fake-IP style proxies resolve a domain into a reserved range while the peer listens on one **concrete address**, so "hostname always fails, IP works". Switch `url` / `publicUrl` to IP addresses.
(This plugin has **no** DNS re-check and **no** skip switch; the outbound address policy is a not-yet-implemented item — see `docs/threat-model.md` §4.2.)

**② A card reports `expired` → check NTP before touching code.**
Clock skew makes a card look expired to the verifier. On real machines, **suspect NTP drift first**, signature logic second. Align both boxes (`w32tm /query /status`) and retest; if a node has no NTP, signature-based approaches are simply unusable.

**③ Installed but nothing happens → check whether you edited only one place.**
Installing requires **both** `dependencies` **and** `dsh.profile.bundles`. One alone does not load, and usually logs nothing. Then restart `dsh`; new tools need a new session.

---

## Acknowledgements

Design ideas and implementation paradigms come from these projects — thanks to their authors:

| Project | License | What we took |
|---|---|---|
| [huangjuhua-aigc/dsh-a2a](https://github.com/huangjuhua-aigc/dsh-a2a) | MIT | per-peer token auth paradigm (constant-time compare iterating all candidates), `workspaceMode: per-peer` isolation, admin monitoring surface, `a2aTaskProjection` state projection |
| [TtTRz/dsh-a2a](https://github.com/TtTRz/dsh-a2a) | MIT | deterministic `contextId → SessionId` derivation, `A2A · {caller} {MM-DD} {HH:mm:ss}` workspace naming, visibility driven by `session.events` |
| [MicroWearld/dsh-subagent-a2a](https://github.com/MicroWearld/dsh-subagent-a2a) | **No LICENSE** | **Paradigm reference only** for the outbound subagent provider (`inject`, `capabilities`, never reject the seam, two-layer cancellation). **No code copied** — no LICENSE file means all rights reserved |
| [NelsonLongxiang/dsh-open-a2a-net](https://github.com/NelsonLongxiang/dsh-open-a2a-net) | MIT | layered test shape (unit / wire / mesh / gates / live), exports-contract gate, the "Proving a key is not a link" authentication≠authorization principle |

---

## License

MIT — see [`LICENSE`](LICENSE).

# dsh-a2a-bridge

**让局域网内的多个 DSH 实例通过 A2A v1.0 互相委派任务 —— 并且把每一次 A2A 对话都变成你能打开、能盯着看的可见会话，而不是一个黑箱调用。**

> 版本 `0.1.0`（未发布）· 协议 A2A **v1.0** · 许可 MIT
> 读者提示：本地门禁已全部跑通（typecheck / 453 用例 / build / verify:exports / verify:version），两台真机已双向联调通过。请先读[当前状态（诚实版）](#当前状态诚实版)，再决定要不要装。

---

## 为什么做它：A2A 会话必须是可见的（ADR-007）

这是本项目的第一设计目标，不是附加功能。用户原话：

> A2A 的聊天应该是**单独有一个工作区**，所有 A2A 之间的 Agent 聊天都应该**像用户跟 DSH 聊天一样有个会话窗口**，让用户也可以在会话窗口上**时刻看到 Agent 都在运行什么、做什么**，不至于黑箱操作。

拆成四条硬要求：

| 要求 | 含义 | 代码指向 |
|---|---|---|
| ① 独立工作区 | A2A 有独立工作区归属，不与你的本地会话混在一起 | `src/session/session-binding.ts` → `ctx.get('workspaceRegistry')` |
| ② 会话窗口 | 每个 A2A 对话就是一个可打开的普通会话 | `contextId` → `sessionId` 确定性派生（sha256 切片） |
| ③ 实时可见 | 能看到 agent 此刻在跑什么 | `SessionMirror`（`src/session/events.ts`）+ SSE 帧解码 |
| ④ 非黑箱 | 不能只丢回一个最终结果 | Task 状态投影 + 每轮进展写入会话（`developer/message` 面） |

目标行为（ADR-007，绑定逻辑在 `src/session/`、装配在 `src/index.ts`、会话事件镜像在 `src/session/events.ts` 并已接入入口）：入站每收到一个 `contextId`，就绑定/复用一个**可见的 DSH 会话**，并把它们放进**同一个工作区**——工作区标题取 `session.workspaceTitlePrefix`（默认 `A2A`），不带 peer、不带时间戳，所以 A2A 不会每个会话多出一行。工作区内每个会话仍保留自己的 cwd：`<root>/<peer>/<session-id>`，因为 agent 的 cwd 就是它的文件系统范围——**会话按 peer 隔离，只有工作区是共享的**。出站调用远端时，本地会话里同样会出现"正在委派给 peer-b / 远端状态 / 收到回复"。会话 id 是确定性的，所以远端带着同一个 `contextId` 回来会落回**同一个会话**，历史不丢、进程重启也能续。

> 反面参照：一个只返回最终文本的 HTTP 工具就是"黑箱"。本项目从 MVP 起就不接受这种形态。

---

## 架构

```
┌─────────────────── 机器 A  192.168.1.10  (DSH 0.2.1-rc.2) ───────────────────┐
│                                                                             │
│  用户 ──▶ DSH 会话 ──▶ 本机 agent                                            │
│                            │                                                │
│                            │ ctx.subagents provider "a2a"  (ADR-006)        │
│                            ▼                                                │
│                    src/outbound/client.ts                                   │
│                    ├─ discoverCard()   GET /.well-known/agent-card.json     │
│                    ├─ sendMessage()    POST /a2a   a2a-version: 1.0 + Bearer │
│                    └─ streamMessage()  SSE 帧 ──▶ 会话事件镜像 (ADR-007)      │
│                                                        │                    │
│  可见的 A2A 工作区 ◀── src/session/session-binding.ts ◀─┘                    │
│  "A2A"                        contextId ──sha256──▶ sessionId（确定性）      │
│                                                                             │
│  src/inbound/server.ts（自建 node:http，ADR-011；不挂 ctx.webServer）          │
│   ├─ bind  inbound.listen.host:3081（默认 127.0.0.1；通配地址加载期拒绝）      │
│   ├─ exact  /.well-known/agent-card.json ──▶ Agent Card（匿名可读）           │
│   ├─ exact  /.well-known/agent.json      ──▶ 旧路径别名                       │
│   └─ exact  /a2a ──▶ src/inbound/routes.ts                                  │
│                      顺序：method → auth → rate-limit → trust → version →   │
│                            body → parse → params → dispatch                 │
│                      dispatch ──▶ 绑定会话里跑一轮 DSH turn ──▶ Task 状态      │
└─────────────────────────────────────────────────────────────────────────────┘
          ▲                                          │
          │  A2A v1.0 JSON-RPC over HTTP (Bearer)     │  Task / statusUpdate / artifactUpdate
          │                                          ▼
┌─────────────────── 机器 B  192.168.1.11  (DSH 0.2.1-rc.3) ───────────────────┐
│  同一个插件，角色对称：入站路由把 B 的 agent 暴露出去，出站 client 反向访问 A      │
└─────────────────────────────────────────────────────────────────────────────┘
```

分层纪律（ADR-008，防上下游污染）：

```
src/protocol/**  零依赖，只依赖 constants/types —— 不起 Cordis、不开 socket 即可单测
src/security/**  只依赖 node:crypto + constants/types
src/inbound/**   protocol + security
src/outbound/**  protocol + security
src/session/**   protocol + security
src/index.ts     只做装配
```

---

## 当前状态（诚实版）

| 状态 | 内容 |
|---|---|
| ✅ 已实现且已验证 | **协议层** `src/protocol/*`：`wire` / `jsonrpc` / `parse` / `card` / `sse`，**零依赖**，可脱离 DSH 单独验证 |
| ✅ 已实现且已验证 | **配置 schema** `src/config.ts`（含 `inbound.listen` 与加载期交叉校验 `assertConfigCoherent`） |
| ✅ 已实现且已验证 | **安全原语** `src/security/index.ts`（常时比较、per-peer 识别、限流、出站脱敏/代理对修复）；**限流 429、`trustedPeers` 403、401 带 `www-authenticate` 均已接线** |
| ✅ 已实现且已验证 | **会话绑定** `src/session/session-binding.ts` + `workspace.ts`（contextId → sessionId、工作区命名与路径） |
| ✅ 已实现且已验证 | **会话事件镜像** `src/session/events.ts`（`SessionMirror`，已接入 `src/index.ts`；出站进展写入 `developer/message` 面，`dispose()` 统一回收） |
| ✅ 已实现且已验证 | **入站路由** `src/inbound/routes.ts`（card + JSON-RPC、body 上限、鉴权分层） |
| ✅ 已实现且已验证 | **入站监听器** `src/inbound/server.ts`（自建 `node:http`，ADR-011；绑具体 IP、拒绝通配、随 dispose 销毁 socket 与 SSE） |
| ✅ 已实现且已验证 | **出站 client** `src/outbound/client.ts`（卡片发现、SendMessage、GetTask 轮询、SSE 解码） |
| ✅ 已实现且已验证 | **subagent provider** `src/outbound/provider.ts`（ADR-006）与 **outbound tools** `src/outbound/tools.ts` |
| ✅ 已实现且已验证 | **插件入口** `src/index.ts` 与 **bundle 装配** `cordis.patch.yml`（`inbound.listen` 默认 `127.0.0.1:3081`） |
| ✅ 已验证（本地门禁） | `npx tsc -p tsconfig.json --noEmit` exit 0 · `npx vitest run` **453 passed / 453**（23 个 spec 文件）· `npx tsc -p tsconfig.build.json` exit 0（**24 个 JS** 到 `lib/`）· `node scripts/verify-exports.mjs` ✓ 6 个 exports 目标 · `node scripts/verify-version.mjs` ✓ 版本一致 |
| ✅ 已实现且已验证 | **wire 集成测试** `tests/wire/`（真实监听器 + 真实 HTTP：入站管线、卡片发现、出站 client ↔ 入站 server 回环） |
| ⏳ 未完成 | mesh 测试（真实多跳网络） |
| ❌ 未实现 | 多 agent、push notifications、mTLS |
| ✅ 已验证（真机） | 两台机器的 A2A 端点双向互通：Agent Card、Bearer 鉴权、SendMessage 端到端、会话连续性、A2A 工作区归组、出站镜像会话 |
| ✅ 已验证（任务状态机） | `GetTask` **跨重启**查回同一投影（写盘；`inbound.tasks` 可配目录与保留策略）· `CancelTask` 区分未知 `-32001` 与已终结 `-32002` |

> 上表的"已验证"含两部分：**本地门禁**（2026-10-26 实测：类型检查、453 个用例、构建产物、exports/版本契约）与**两台真机的双向联调**（Agent Card、Bearer 鉴权、SendMessage 端到端、会话连续性、A2A 工作区归组、出站镜像会话）。仍未覆盖的是 **mesh 形态的多跳网络**与 `tests/live` 的可执行用例——它们不改变"两台机器能互通"这一结论，但多跳 / 跨网段场景尚未实测。


---

## 快速开始

完整步骤见 [`docs/installation.md`](docs/installation.md)，排障见 [`docs/troubleshooting.md`](docs/troubleshooting.md)。

两条最重要的安装事实，先记住：

1. **装插件必须改两处**：profile 的 `dependencies` **和** `dsh.profile.bundles`。只改一处 = 包被下载但不装载，且没有任何报错。
2. **装完必须重启 `dsh`**；新增的工具要**开新会话**才可见。

再补三条最省事的：

3. **本机自用直接走插件页安装**（侧边栏「插件」→ 从本地目录或 npm 规格安装），DSH 会自动处理上面两处；卸载也在同一页。步骤见 [`docs/installation.md`](docs/installation.md) §3.1。
4. **部署目录必须是纯 ASCII**。开发目录可以含中文（当前是 `…\开发\dsh-a2a-plugin`），但安装目标不行 —— 中文路径会在 DSH 重写 `package.json` 时被编码破坏。
5. **装完要选模型**：A2A 没有默认模型，没选就每次请求都以 `-32603` 拒绝。见下文「模型选择」一节。

---

## 配置

所有可调项都在 `src/config.ts` 一处（ADR-008：模块内禁止字面量）。下面是逐字段对照。

### 顶层

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `basePath` | string | `"/a2a"` | JSON-RPC 端点路径，**必须以 `/` 开头**（加载期校验） |
| `publicUrl` | string | 无（可选） | 写在 Agent Card 上的对外可达 URL。**局域网部署必须显式设置** —— 监听器可能绑 `127.0.0.1`，把它印到卡片上永远是错的 |

### `card`

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `card.name` | string | `"dsh-a2a-bridge"` | 卡片名 |
| `card.description` | string | `"A DeepSeek Harness agent reachable over A2A."` | 卡片描述 |
| `card.public` | boolean | `true` | 卡片匿名可读（发现需要）。`false` 则关闭匿名读 |
| `card.skills` | array | `[]` | **由部署声明**，不是工具注册表的投影（避免信息泄露）；为空时用 `general` 兜底 |
| `card.extendedSkills` | array | `[]` | 扩展卡技能；非空时卡片 `capabilities.extendedAgentCard = true` |
| `card.provider.organization` | string | `""` | 提供方组织 |
| `card.provider.url` | string | `""` | 提供方 URL |

`card.skills[]` / `card.extendedSkills[]` 元素：`{ id: string(必填), name: string(必填), description: string="", tags: string[]=[] }`

### `inbound`（远端 → 我：服务端侧）

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 是否对外提供 A2A 服务 |
| `peers` | dict | `{}` | **谁可以访问我**。`peer名 → { tokenEnv: string(必填) }`；`tokenEnv` 是 `ctx.credentials` 的**引用名**，不是 token 值 |
| `trustedPeers` | string[] | `[]` | 在认证之上再叠一层白名单；空 = 已声明的 peer 全部。**引用未声明的 peer 会在加载期报错** |
| `rateLimitPerMinute` | number | `60` | 每 peer 每分钟请求上限（超出 → 429） |
| `maxContextTurns` | number | `5` | 一个上下文保留的轮数 |
| `sendMode` | `"block"` \| `"immediate"` | `"block"` | 是否同步等任务结束 |
| `blockTimeoutMs` | number | `60000` | 阻塞等待上限 |
| `contextIdleTtlMs` | number | `1800000` | 上下文空闲回收时间（30 分钟） |
| `maxResidentContexts` | number | `64` | 常驻上下文上限 |
| `maxBodyBytes` | number | `1000000` | 请求体上限（超出 → 413） |
| `isolation.workspaceMode` | `"per-peer"` \| `"shared"` | `"per-peer"` | 每个 peer 独立工作目录 = 防跨 peer 读文件 |
| `isolation.workspaceRoot` | string | `""`（**可省略**；随包 patch 就是省略的） | A2A 工作区根目录。**空值是可移植的默认**：省略即派生 `<DSH_HOME>/a2a-workspaces`（`homePaths` → `$DSH_HOME` → `~/.dsh`）。显式写值时按原样使用，供需要固定共享根目录的部署 |
| `isolation.peerWorkspaces` | dict | `{}` | 覆盖单个 peer 的目录；键必须是已声明的 peer |
| `listen.host` | string | 无（schema 必填；随包 `cordis.patch.yml` 给 `"127.0.0.1"`） | **ADR-011 监听地址**。必须是本机一个**具体**地址（如 `192.168.1.10`）；`0.0.0.0` / `::` / `*` 等通配在加载期抛 `WildcardBindError` |
| `listen.port` | number | `3081` | 监听端口，避开 GUI 的 `3080`；需在防火墙按此端口放行 |
| `strictVersionHeader` | boolean | `true` | 缺 `A2A-Version` 头时是否按规范 §3.6.2 拒（`-32009`）。`false` 则按 1.0 处理（部署策略，非规范） |
| `agent.provider` / `agent.model` | string | 无（**默认不设 = 未选模型**） | A2A 会话跑在哪个 provider/model 上。**必须成对设置**，只设一半等于没设。不设时 A2A 拒绝每次请求（`-32603`），提示去插件页选择 —— 详见下文「模型选择」一节 |

### `outbound`（我 → 远端：客户端侧）

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 是否允许向外委派 |
| `providerName` | string | `"a2a"` | 注册到 `ctx.subagents` 的 provider 名（ADR-006） |
| `contacts` | array | `[]` | **我可以访问谁**。静态 URL + Agent Card well-known 发现（ADR-004） |

`contacts[]` 元素：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `name` | string(必填) | — | 联系人名，同时用作工作区目录片段；**不可重复** |
| `url` | string(必填) | — | 远端的 JSON-RPC 端点 |
| `agentCardPath` | string | `"/.well-known/agent-card.json"` | 卡片路径。若 `url` 里已经带了 well-known 后缀会被剥掉再拼，避免拼两次 |
| `tokenEnv` | string | 无 | 访问该远端所用 token 的**引用名**（可选） |
| `timeoutMs` | number | `300000` | 单次调用超时，必须为正数 |

> `inbound.peers`（谁能进）与 `outbound.contacts`（我能出）刻意不共用一个词 —— 同名是最容易埋的坑。

### `session`（ADR-007）

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `workspaceTitlePrefix` | string | `"A2A"` | 工作区标题 —— 单一固定名，不拼 peer、不拼时间戳 |
| `contextIdPrefix` | string | `"a2a"` | 新 contextId 前缀，形如 `a2a-peer-b-<hash>` |
| `mirrorRemoteProgress` | boolean | `true` | 把远端进展镜像进本地会话，供用户实时观看 |

### 加载期校验（不通过就拒绝启动）

- `basePath` 不以 `/` 开头 → 拒绝
- peer 名 `owner` 是保留身份 → 拒绝
- peer 名 / 联系人名必须匹配 `^[A-Za-z0-9][A-Za-z0-9_-]*$`（会进路径，禁止分隔符）
- `tokenEnv` 必须匹配 `^[A-Za-z_][A-Za-z0-9_]*$` —— **写 token 值会被拒**
- `trustedPeers` / `peerWorkspaces` 引用未声明的 peer → 拒绝
- 联系人重名 / `timeoutMs <= 0` → 拒绝
- `listen.host` 为空或为通配地址（`0.0.0.0` / `::` / `[::]` / `*` / `::0`）→ 拒绝（`WildcardBindError`）

### 示例配置

```yaml
basePath: /a2a
publicUrl: http://192.168.1.10:3081/a2a   # 对外可达地址；监听绑定地址通常不能直接印上去
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
    host: 192.168.1.10        # 具体地址；通配会被加载期拒绝
    port: 3081
  peers:
    peer-b:
      tokenEnv: A2A_TOKEN_PEER_B          # 引用名，值走 ctx.credentials
  trustedPeers: [peer-b]
  sendMode: block
  isolation:
    workspaceMode: per-peer
    workspaceRoot: D:/a2a-workspaces   # 可省略；省略即派生 <DSH_HOME>/a2a-workspaces
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

> 这段是 schema 可接受的**配置形状**。随包的 `cordis.patch.yml` 已内置同一组键与默认值（`inbound.listen: { host: 127.0.0.1, port: 3081 }`）；部署到两台机器时，把 `listen.host` 改成各自的实际 LAN 地址，并在防火墙放行 `3081`。

凭据解析顺序（ADR-005，四层）：进程环境 → 托管文档 → `<cwd>/.env` → `$DSH_HOME/.env`。**每请求重新解析、不缓存**，所以轮换 token 下一个请求就生效，无需重启。

---

## 模型选择：A2A 必须在插件页选模型

A2A 会话跑在哪个模型上，是**部署决策，不是插件能猜的东西**。本插件因此**不设默认模型**：

> **未选择模型时，每一次 A2A 请求都会被拒绝，错误码 `-32603`，消息明确要求去插件页选择。**
> 这是刻意的：`-32603`（internal error）表示"请求合法、**服务端没配置**"，
> 而不是 `-32602`（把锅甩给 peer）。发请求的 peer 通常无权修改本机配置，
> 真正能修的人坐在 DSH 的 GUI 前面 —— 所以错误消息直接指向那个页面。

### 两个入口，同一个存储字段

| 途径 | 落点 | 适合 |
|---|---|---|
| **插件页配置卡片**（推荐） | profile patch 里的 `inbound.agent`，由 DSH 的 `settings` 服务写入 | 日常使用：点几下就改，下一轮 A2A 会话立即生效，**无需重启** |
| 配置里的 `inbound.agent` pin | 同一个字段，写在 profile 的 `cordis.patch.yml` | 需要"版本化、随部署走"的固定绑定 |

- pin 只有**一处存储**，不是两处：两条途径写的都是 `inbound.agent`。profile patch 里的值会覆盖随包 patch 继承来的 pin，页面展示的始终是**真正生效**的那个值。
- GUI 展示的模型与 executor 实际使用的模型走**同一个解析函数**（`resolveEffective()`），所以不会出现"页面显示 A 模型、实际跑 B 模型"。
- `provider` 与 `model` 是**一对**：只设一半等于没设（半设的一对按未设处理）。
- 没有部署级兜底模型。这条是硬约束 —— 静默借用某个部署默认值，等于让运维在不知情的情况下把 A2A 流量发到没选过的模型上。

### 模型列表从哪来（运行时探测，不是写死）

配置卡片里的 provider / model 下拉**不是硬编码列表**，而是每次读取时**实时问宿主运行时**：

```text
GET  /a2a-bridge/config   → { providers: [{ provider, models[] }], provider, model, source, configured }
POST /a2a-bridge/config   → 保存选择（provider + model，各自有长度上限）
```

- 数据源是 `ctx.llm.listProviders()`（`src/config-api.ts` 的 `readModelCatalog()`）—— **本机配了哪些 provider、每个 provider 下有哪些 model，完全由运行时决定**。换模型供应商、加模型，插件代码不用改，下拉里自动出现。
- 宿主没有 `llm` 服务、或读列表失败时，卡片显示"本机尚未配置任何模型提供方，请先在「设置 → 模型」中配置"，而不是显示一个空下拉。
- 该路由**刻意不在 `basePath`（`/a2a`）之下**：`/a2a` 是面向 peer 的 JSON-RPC 监听器，把配置路由放进那个前缀等于给 peer 开了第二条控制面。它挂在同源 `/a2a-bridge/config`，只接受 `application/json` 的 POST（同时迫使跨源请求走 CORS 预检）。
- 选择**不写进 `cordis.patch.yml`**：那个文件是用户手写的"配置即代码"资产，从浏览器请求里改写它会毁掉用户文档。

### 忘记选模型会看到什么

| 现象 | 含义 | 处置 |
|---|---|---|
| A2A 请求返回 `-32603`，消息含「尚未选择模型」 | 部署未配置模型 | 插件页 → A2A 桥接 → 配置 → 选 provider + model → 保存 |
| 插件页配置卡片显示"未选择模型（点击配置）" | 同上，摘要态提示 | 同上 |
| 下拉是空的，提示"本机尚未配置任何模型提供方" | 宿主没有可用 provider | 设置 → 模型，先配置一个 provider |
| 保存成功但下一轮仍是旧模型 | 该轮 A2A 会话已在进行中 | 保存只影响**下一轮**；已绑定的 agent 不换模型 |

排障细节见 [docs/troubleshooting.md](docs/troubleshooting.md) 的 **D4**。

---

## 协议实现说明

- 权威判据是 `specification/a2a.proto`（A2A 规范 §1.4），**不是 JSON Schema，也不是任何 SDK 的 TS 类型**。
- **v1.0 与 v0.3 不是别名关系**：`kind` 判别符被删除、枚举改成 ProtoJSON 拼写（`TASK_STATE_WORKING` / `ROLE_USER`）、`SendMessage` 返回 `{ task: … }`、任务引用是 `id` 而非 `taskId`、卡片改 `supportedInterfaces[]`、`configuration.blocking` 改成语义相反的 `returnImmediately`。两端必须同版本。
- **错误码族是 `-32001..-32009`。`-32609` 不存在**（交接文档笔误，见 `research/05` §7.2）。JSON-RPC 保留段是 `-32700..-32600`，`-32609` 落在保留段之外。
- 认证 / 限流 / 信任失败**不使用** A2A 语义错误码：走 HTTP 状态码（401/403/429/413），而 **body 仍是合法的 JSON-RPC 错误信封**，这样"只读 body"和"只看状态码"的客户端都能正确处理。
- SSE：v1.0 取消 `final` 标志，**关闭流本身就是终态信号**。`sse.ts` 备有 `: ping` 注释帧（`sseHeartbeat()`，运维保活手段，非协议要求，对端须忽略未知注释帧）；**流式路由已接入入站 handler**：`SendStreamingMessage` 返回 `200 + text/event-stream`，帧序为 `task` → 若干 `statusUpdate` → `artifactUpdate` → 终态 `statusUpdate`（实现见 `src/inbound/stream-frames.ts` 与 `src/inbound/sse-response.ts`）。真机实测为 5 帧。

---

## Boundaries（限制与已知风险，不粉饰）

1. **明文 HTTP + Bearer（ADR-003）**。MVP 选择局域网明文，真实风险是 **token 在明文链路上被嗅探**。缓解：32 字节强随机 token、常时比较、限流、短 TTL 轮换；但这些**都不能替代加密**。升级路径：明文 → 自签 TLS（webServer 实码支持 `--tls-cert/--tls-key`）→ Tailscale。若局域网出现不可信设备，本决策需重开。
2. **~~跨会话工具 deny-list 未实现~~ — 已实现。** `tools.restrict()` 作用于 A2A 会话**自己的 agent scope**（不是插件根 scope），默认生效、无需配置：`session_search` / `session_event_search` / `session_trace` / `session_event_trace` / `session_event_read` / `list_agents` / `team_task_*` 在 A2A 会话里不可见，操作者的本地 agent 不受影响。残余风险：这是**按名字的黑名单**，上游新增同语义的跨会话工具而名单未跟上时，泄露面会重新打开。
3. **~~任务状态不跨进程重启~~ 已实现**。任务记录写盘（`inbound.tasks`），`GetTask` 跨重启可查回同一投影；`CancelTask` 对已终结任务返回 `-32002` 而不是假装成功。
4. **TLS 仍未落到自建监听器上**。`ctx.webServer` 层支持 `--tls-cert/--tls-key`，但 ADR-011 之后 A2A 端点由插件自己的 `node:http` 监听器承载，**该监听器目前没有 TLS 开关**，所以入站链路是明文 HTTP + Bearer（ADR-003）。给监听器加载证书是后续加固项；升级路径不变：明文 → 自签 TLS → Tailscale。
5. **局域网可达性已由 ADR-011 解决**。Desktop 壳下 `ctx.webServer` 恒绑 `127.0.0.1`（`desktopWebServerHost()` 直接返回 `127.0.0.1`，并有抛错断言；`networkExposure: 'lan'` 只开 HTTPS 边缘、不暴露上游 HTTP 源）。因此本插件**不再挂** `ctx.webServer`，改为在 `src/inbound/server.ts` 自建 `node:http` 监听器：`inbound.listen.host` 必须是**具体地址**（`0.0.0.0` / `::` 等通配在加载期抛 `WildcardBindError`），默认端口 `3081`，生命周期绑 Cordis fiber（dispose 时销毁 socket 与 SSE）；部署时需为该端口开防火墙入站规则。真机联通已实测通过（双向）。
6. **无 LICENSE 的参考实现只参考范式、未复制代码**（见致谢）。
7. **本机 DSH 仍是 `0.2.1-rc.2`，远端 `192.168.1.11` 是 `rc.3`**；跨 minor/rc 的 seam 差异需逐条核对 `lib/*.d.ts`，不能只看 changelog。

---

## 验证（部署后先跑这两条）

```bash
# 1. 真机行为验证：卡片、鉴权、端到端 SendMessage、会话连续性、任务状态机
A2A_LOCAL_URL=http://192.168.1.10:3081 \
A2A_REMOTE_URL=http://192.168.1.11:3081 \
A2A_TOKEN=<你的 token> npm run verify:live

# 2. 运行时 seam 探针：这台机器的 DSH 实际提供了哪些可选能力
npm run seams                 # 最新一次探针
npm run seams -- --compare    # 与上一次「不同」的探针做差异对比
```

`seams` 输出形如：

```
a2a: seams agentsResume=1 workspaceRegistry=1 workspaceUnarchive=1 … missing=none
```

**两台机器各跑一次、对比两行**，就是跨版本差异在运行时可观察的那部分（为什么不能靠对比 `.d.ts`，见 [docs/rc-seam-audit.md](docs/rc-seam-audit.md)）。日志里没有这一行，说明**运行中的构建早于探针**——重启 DSH 再试。

> `verify:live` 的任务状态机两项若失败，最常见的同样是「构建早于功能」：重启后重跑即可。

## 排障（三条最常见，完整版见 [docs/troubleshooting.md](docs/troubleshooting.md)）

> 「代码看着对但就是不工作」→ 直接看
> [troubleshooting §8](docs/troubleshooting.md) 的 **D1–D9**：
> 本项目实装这一路真实踩中的 9 个坑，每条都是「症状 / 根因 / 修法」。

**① 用域名连不上、换成 IP 就好。**
fake-IP 类代理会把域名解析成保留地址，而对端只监听**具体地址**，于是"域名必失败、IP 正常"。把 `url` / `publicUrl` 换成 IP 即可。
（本插件**没有** DNS 复查、没有 `skip` 开关；出站地址策略属未实现项，见 `docs/threat-model.md` §4.2。）

**② 卡片报 `expired` → 先查 NTP，不要先改代码。**
时钟偏差会让卡片在验证方看来已经过期。真实机器上看到 `expired`，**第一怀疑对象是 NTP 偏差**，第二才是签名逻辑。两台机器 `w32tm /query /status` 对齐后再复测；若节点无 NTP，签名类方案直接不可用。

**③ 装完没反应 → 检查是不是只改了一处。**
装插件必须同时改 **`dependencies`** 和 **`dsh.profile.bundles`**，只改一处不装载、且通常**不报错**。改完还要重启 `dsh`，新工具要开新会话。

---

## 致谢

思路与实码范式来自以下项目，感谢作者：

| 项目 | 许可 | 本项目的取用 |
|---|---|---|
| [huangjuhua-aigc/dsh-a2a](https://github.com/huangjuhua-aigc/dsh-a2a) | MIT | per-peer token 鉴权范式（常时比较 + 遍历全部候选）、`workspaceMode: per-peer` 隔离、admin 监控面思路、`a2aTaskProjection` 状态投影 |
| [TtTRz/dsh-a2a](https://github.com/TtTRz/dsh-a2a) | MIT | `contextId → SessionId` 确定性派生、`A2A · {caller} {MM-DD} {HH:mm:ss}` 工作区命名、`session.events` 驱动会话可见性 |
| [MicroWearld/dsh-subagent-a2a](https://github.com/MicroWearld/dsh-subagent-a2a) | **无 LICENSE** | **仅参考出站 subagent provider 的注册范式**（`inject`、`capabilities`、禁止 seam reject、双层取消）。**未复制任何代码** —— 无 LICENSE 文件即"保留所有权利" |
| [NelsonLongxiang/dsh-open-a2a-net](https://github.com/NelsonLongxiang/dsh-open-a2a-net) | MIT | 分层测试形态（unit / wire / mesh / gates / live）、exports 契约门禁思路、"Proving a key is not a link" 的认证≠授权原则 |

---

## 许可

MIT，见 [`LICENSE`](LICENSE)。

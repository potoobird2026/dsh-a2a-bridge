# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。
日期格式 `YYYY-MM-DD`。

> **说明**：`0.1.0` 至今**没有发布过任何可安装版本**。下面的条目描述已落地的源码与**本地门禁实测结果**，不做隐式承诺。2026-10-26 收尾实测：`npx tsc -p tsconfig.json --noEmit` exit 0；`npx vitest run` **379 passed / 302**（15 个 spec 文件，含 wire 集成测试与会话镜像）；`npx tsc -p tsconfig.build.json` exit 0，产出 **24 个 JS** 到 `lib/`；`node scripts/verify-exports.mjs` ✓；`node scripts/verify-version.mjs` ✓；`node scripts/export-client-locale.mjs --check` ✓；`node scripts/verify-no-hardcode.mjs` **exit 0（0 error / 8 条 Host 侧中文 advisory）**。**两台真机联调仍未进行。**

---

## [Unreleased]

### Changed — 单例 A2A 工作区 + 工作区路径懒解析（2026-10-26 收尾轮）

- **工作区与会话 cwd 拆成两件事**：`WorkspaceDescriptor` 现在是 `{ title, path, cwd }`。`path` = 解析后的 A2A 根（**所有 peer、所有会话共用同一个**），`title` = `session.workspaceTitlePrefix`（默认 `A2A`，**不再拼 peer / 时间戳**），新增 `cwd` = `<root>/<peer>/<session-id>`。会话 cwd 仍按 peer 隔离（agent 的 cwd 就是它的文件系统范围），但工作区只有一个。`workspaceName` / `workspaceTitle` 及两个时间戳格式化辅助函数、`WORKSPACE_HASH_LENGTH` 一并删除（不留死代码）。
- 会话目录名改用**确定性 session id**：原来是 `<prefix>-<peer>-<MMDD>-<HHMMSS>-<hash6>`，带时钟，进程重启后同一会话可能落到第二个目录。
- **`inbound.isolation.workspaceRoot` 改为按需解析**：`SessionMirror` 与 `InboundExecutor` 的 `workspaceRoot` 类型为 `string | (() => string)`，统一走 `src/session/workspace.ts` 的 `resolveRootOption()`；`apply()` 里不再解析一次字符串。插件页改路径后**下一轮会话**即生效，无需重启（与模型 / preset 的语义一致）。启动日志保留一次采样并标明是「当前值」。
- 插件页文案同步：工作区提示与「已保存」改为「下一轮 A2A 会话即使用新路径，无需重启」（中英各 2 条），`locale/zh-CN.json` / `locale/en.json` 由 `scripts/export-client-locale.mjs` 重新导出。
- ⚠️ **已知限制（本轮核对）**：DSH `@deepseek-ai/dsh-workspace` 0.2.1-rc.2 的 `WorkspaceEntity.attachSession` 要求会话 header 的 canonical cwd **严格等于** workspace path（`index.js:122`），不做「包含于」判断；注册表启动 bootstrap 也按不同 cwd 分组。也就是说本设计里 `<root>/<peer>/<session>` 这一层会话目录能否归入 `A2A` 行，取决于运行时是否接受「cwd 在 workspace 之内」；若不接受，attach 会被拒并只记日志（A2A 调用照常）。代码内的 `REGISTRY NOTE`（`src/session/workspace.ts`）记录了同一事实。

### Added — A2A 会话模型选择（GUI 可配置，无默认模型）

- **模型选择成为部署决策，而不是插件的隐式默认。** `inbound.agent: { provider, model }` 支持在配置里 pin；两处都未设时，A2A **拒绝每一次请求**（`-32603`）并提示"去插件页选模型"，而不是静默借用一个运维没选过的模型。半设的一对（只有 provider 或只有 model）按未设处理。
- `src/config-api.ts`：同源配置路由 `/a2a-bridge/config`（**刻意不在 `basePath` `/a2a` 之下** —— 那是面向 peer 的 JSON-RPC 监听器，配置路由放进去等于给 peer 开第二条控制面）。GET 返回 `{ providers, provider, model, source, configured }`，POST 保存选择；只接受 `application/json`（同时迫使跨源请求走 CORS 预检）。
- `src/selection.ts`：选择的**唯一存储**是插件自己的 `inbound.agent` Config —— 插件页通过 DSH 的 `settings` 服务把它写进 **profile patch**（`cordis.patch.yml`）。`resolveDshHome()` 按 `homePaths` → `$DSH_HOME` → `~/.dsh` 三层解析根目录，`resolveWorkspaceRoot()` 用它派生默认工作区根。早期实现曾自建 `selection.json`，已在同一轮删除（见下方 `Removed`）。
- `src/client.ts`（浏览器侧「A2A 模型」卡片）：provider/model 下拉的**数据源是运行时探测** `ctx.llm.listProviders()`（`readModelCatalog()`），**不是硬编码列表** —— 换供应商、加模型无需改插件代码。宿主没有 `llm` 服务或读取失败时，卡片明确提示"先在设置 → 模型配置提供方"，而不是显示空下拉。
- 优先级与 executor 共用同一个 `resolveEffective()`，因此"页面显示 A 模型、实际跑 B 模型"不可能发生。GUI 选择优先于 YAML pin。
- 无需重启：保存后**下一轮** A2A 会话立即生效；已绑定的 agent 不换模型。

### Added — 标准化门禁与文档（2026-10-26 第二轮）

- **`scripts/verify-no-hardcode.mjs`（新门禁）**：把 ADR-008「禁硬编码」从纪律变成可执行门禁。扫描 `src/**/*.ts`（排除 `src/dsh-ambient.d.ts`），八类规则：绝对路径 / 本机身份 / 厂商名 / 主机字面量 / 魔法数字 / 默认值重复定义 / Client 中文绕过 locale / Host 侧中文（advisory）。
  - 三条判定口径：**注释不算违规**（先剥离注释再扫描，行号不变）；**命名常量的定义行不算违规**（`const DEFAULT_PORT = 3081` 是魔法数字的正确归宿）；**类字段 `readonly code = -32602` 不豁免**（它在重复定义已存在的具名错误码）。
  - 允许名单两种维护方式，都要求写理由：`ALLOWLIST` 数组、行内 `// hardcode-audit-allow: <理由>`。
  - 支持 `--report` 报告模式（只打印，exit 0）。
  - **当前状态：门禁绿 —— exit 0（0 error / 8 条 advisory）。** 引入时它是**故意红的**：命中 24 条 error + 8 条 advisory，全部登记在 `docs/standards-audit.md` §3；收尾轮把 error 清零，8 条 Host 侧中文按设计保持 advisory。
- **`docs/standards-audit.md`（新增）**：全仓库硬编码审计报告。逐条「文件:行 + 问题 + 建议」，含最严重 3 条（随包 patch 写死本机绝对路径 / 默认值双真值 / 裸 JSON-RPC 错误码）、10 条文档与脚本层不一致、以及 4 类"已核对且合规"的显式确认（`src/**` 内**零**盘符/用户名/厂商名硬编码）。
- **`docs/postmortem-2026-10-26.md`（新增）**：PowerShell 数组展平导致按字符替换、把 `executor.ts` 所有 `e` 换成 `x` 的事故复盘。含时间线、技术根因（`Get-Content` 返回 `string[]` 而非字符串、展平后替换算子降级为按字符）、恢复方式（依据 `lib/` 编译产物 + `.d.ts` + source map 重建，**并明确说明注释与原始字节未恢复**）、防复发措施（git、禁止脚本批量改源码、`lib/` 纳入版本控制）。如实记录未美化。
- **`docs/troubleshooting.md` 新增 §8 `D1–D9`**：本轮实装**真实踩中并已修掉**的 9 个坑，每条含「症状 / 根因 / 修法」+ 可检索关键词：
  D1 `ctx.get()` 在 `apply()` 里拿不到服务（Cordis 只激活 `inject` 列表）·
  D2 工具必须 `defineTool()`（否则 schema 变 `type: null`，**每次 LLM 请求都被 provider 拒绝**）·
  D3 `session.events` 不存在（必须 `snapshotEvents()`）·
  D4 `agents.create()` 必须传 `agentOptions`（否则 `{{model}}` 无法解析，turn 第 1 步就失败）·
  D5 `endReason` 默认 `undefined` 被映射成 `TASK_STATE_CANCELED`（成功轮次被误判）·
  D6 turn 失败时 `whenIdle()` 正常返回（谎报 `TASK_STATE_COMPLETED`）·
  D7 `plugins.row.config` 的 key 形态是 `<清单名>#<row id>`（形态错则**不渲染也不报错**，issue #55）·
  D8 `tsconfig` 需要 `moduleDetection: "legacy"` 才能产出 classic-script 的 `client.js` ·
  D9 中文路径（`开发`）会被 DSH 重写 `package.json` 时编码破坏（部署路径必须 ASCII）。
  同时在 §0 顶部与 §1 分诊表加了指向 §8 的入口。
- **`docs/installation.md`**：新增 §3.0「选择安装方式」与 §3.1「在本机 DSH 的插件页里安装 / 卸载」（安装后的三项确认：标题描述存在、**有配置入口**、状态非 `failed`/`overridden`；启用/停用 ≠ 卸载；GUI 与 CLI 的等价映射）；新增 §3.4「手工改 profile（两个位置都要改）」；把 `bundles` 与 `dependencies` 的区别讲透（一句话记法：**`dependencies` 决定"代码在不在"，`bundles` 决定"装不装上去"**，并指出 `dsh.bundle.patch` 只声明"读哪个 patch"，真正决定装配的是 profile 的 `bundles`）。§9 核对清单补充插件页三项、ASCII 部署路径、`workspaceRoot` 覆盖、模型已选择。
- **`README.md` / `README.zh-CN.md`**：新增「模型选择」整节（无默认模型、`-32603` 拒绝语义与为什么不甩锅给 peer、两条互斥途径及优先级、模型列表来自运行时探测、忘记选模型会看到什么）；`inbound` 配置表补 `agent.provider` / `agent.model` 两行；快速开始补三条（插件页安装、ASCII 部署路径、装完要选模型）；排障节加指向 `troubleshooting §8 D1–D9` 的入口。

### Removed

- **`selection.json` 通道已移除，配置统一写 profile patch。** `src/selection.ts` 的 `createSelectionStore()` / `selectionFilePath()` / `SelectionStore` 与 `src/constants.ts` 的 `SELECTION_FILE_NAME` / `SELECTION_DIR_NAME` 一并删除；`resolveDshHome()`、`createSettingsSelection()`、`resolveProfileEntryId()`、`completeSelection()`、`AgentSelection` 保留（前者仍被 `resolveWorkspaceRoot()` 用来派生 `<DSH_HOME>/a2a-workspaces`）。
  - 测试同步：删除 11 个只测旧存储的用例（原子替换 / 缺失文件 / 损坏 JSON / 临时文件清理 / `selectionFilePath()` 路径拼接，以及 `config-api.spec.ts` 里一个只对文件内容断言的用例）；`config-api.spec.ts` 的 gateway 夹具改为内存实现，HTTP 层覆盖不变。
  - 用户可见文案同步：`locale/*.json` 与 `src/client.ts` 字典里提到 `selection.json` 的 `status.sourcePinned` / `status.adoptedLegacy` 已改述为"插件配置中的 `inbound.agent`"。

### Changed

- **`.github/workflows/ci.yml`**：新增独立门禁 step `verify no hardcode`（遵循既有纪律：**独立成 step，不与其它步骤 `&&` 串联** —— `tsc` 报错仍会 emit，串联会让后续步骤被静默跳过）。同时修正了已过期的注释：原文称"仓库没有 `package-lock.json`，所以 `npm ci` 会失败"，而该文件**现在已在仓库根**；缓存启用条件相应更新。
- `scripts/verify-exports.mjs` 头注释修正：原文称「`lib/` 默认被 `.gitignore` 排除」，与 `.gitignore` 明确写下的「`lib/` is tracked ON PURPOSE」**直接矛盾**。这条自相矛盾的注释会让人以为不必提交 `lib/`，而事故复盘恰恰依赖 `lib/` 恢复。现改为说明"即使 `lib/` 已在版本库，也仍须重新 build 后再验"。
- `scripts/verify-version.mjs` 头注释删除已过期的「本机未安装 node_modules，未实际运行验证」。

### Fixed

- **`scripts/verify-no-hardcode.mjs` 从 25 条 error 清零，exit 0（0 error / 8 条 advisory）。**
  - 默认值双真值改为 import（S2）：`DEFAULT_LISTEN_PORT` / `DEFAULT_AGENT_CARD_PATH` / `DEFAULT_CALL_TIMEOUT_MS` 统一由 `src/constants.ts` 持有，`src/config.ts` 只 import。
  - 裸 JSON-RPC 错误码与 HTTP 状态码全部改用具名常量（S3）：新增 `HTTP_OK` / `HTTP_NOT_FOUND`，`-32603` → `ERR_INTERNAL`、`-32700` → `ERR_PARSE`、`-32602` → `ERR_INVALID_PARAMS`。
  - 魔法数字逐个命名进 `src/constants.ts`：`TURN_START_GRACE_MS` / `TURN_START_POLL_MS` / `DEFAULT_DISCOVERY_TIMEOUT_MS` / `RATE_LIMIT_WINDOW_MS`，通配主机清单收成 `WILDCARD_HOST_PATTERN`（正则，避免在逻辑里重述主机字面量）。
  - **没有为了过门禁新增 pragma 或 allowlist 例外**；原 `fontWeight: 600` 例外改为具名常量 `FONT_WEIGHT_BANNER` 后从 allowlist 删除。
  - 新增两个防回归用例集：`tests/unit/config-defaults.spec.ts`（schema 默认值必须等于 constants 的值 + 空 `workspaceRoot` 派生语义）与 `tests/unit/server-host.spec.ts`（通配绑定必须被拒）。
- 文档与实现漂移三处：
  - `docs/installation.md` 的 `workspaceRoot` 行补警告：随包 `cordis.patch.yml` 给的是**开发机绝对路径**，换机器部署必须显式覆盖（审计条目 S1）。
  - `docs/installation.md` 示例安装命令中的本机绝对路径改为占位，并加**部署路径必须 ASCII**的警告（对照 D9）。
  - `docs/security-setup.md` 开头新增「端口口径已按 ADR-011 修正」的对照表：该手册写于 ADR-011 之前，正文用 **43120 = webServer/GUI 端口**并称"必须同时改三处：`publicUrl`、webserver `--port`、防火墙规则"；实际上 A2A 已由插件自建监听器承载（默认 **3081**），与 webServer `--port` **无关**。给出映射表并说明"正文端口数值尚未逐处替换，以本表为准"。**全文重写未做**（那是一次独立的文档修订，避免在本次审计里改动安全分析结论）。


### Added — 协议层 `src/protocol/`（零依赖）

- `wire.ts`：A2A **v1.0** 权威数据结构 —— 9 个任务状态（ProtoJSON 拼写）、`ROLE_USER`/`ROLE_AGENT`、统一 `Part`（无 `kind` 判别符）、`Task`/`Artifact`/`StatusUpdate`/`ArtifactUpdate`、`AgentCard`（`supportedInterfaces[]` + `httpAuthSecurityScheme` + `securityRequirements`）、`SendMessage`/`GetTask`/`ListTasks` 信封。显式声明了 v0.3 → v1.0 的 6 处破坏性变更。
- `jsonrpc.ts`：JSON-RPC 2.0 编解码与错误构造。错误码族 `-32001..-32009` 具名导出（`ERR_TASK_NOT_FOUND` … `ERR_VERSION_NOT_SUPPORTED`），**`-32609` 不存在**（交接文档笔误）。`errorDetails()` 生成 `google.rpc.ErrorInfo`（`type.googleapis.com/google.rpc.ErrorInfo`）。
- `parse.ts`：入参解码（`parsePart`/`parseParts`/`parseMessage`/`parseTaskStatus`/`requireTaskId`）、v0.3 旧方法名识别与替代名提示、`versionIsAcceptable()` 版本头判定。
- `card.ts`：`buildAgentCard()`（技能由**部署声明**，绝不投影工具注册表；缺省技能用 `general` 兜底）与 `parseAgentCard()`（发现侧解析 + 非致命告警 + `AgentCardError`）。
- `sse.ts`：`sseFrame()`/`sseHeartbeat()`、`SseFrameDecoder`（跨 chunk 的 UTF-8 半码点保持，`TextDecoder(stream:true)`）、`parseFrameJson()`。SSE 头含 `x-accel-buffering: no`，防反向代理缓冲导致流永不达对端。
- `index.ts`：唯一对外 barrel，禁止 import 其他层。

### Added — 配置与常量

- `src/config.ts`：schemastery 配置 schema，覆盖 `basePath`/`publicUrl`/`card.*`/`inbound.*`/`outbound.*`/`session.*`；所有默认值单点定义。
- `assertConfigCoherent()`：加载期交叉校验 —— `basePath` 必须以 `/` 开头、`owner` 为保留 peer 名、peer/contact 名匹配 `^[A-Za-z0-9][A-Za-z0-9_-]*$`、`tokenEnv` 必须是凭据**引用名**（`^[A-Za-z_][A-Za-z0-9_]*$`，粘贴 token 值会被拒）、`trustedPeers`/`peerWorkspaces` 不得引用未声明 peer、联系人不得重名、`timeoutMs` 必须为正。
- `src/constants.ts`：协议与运行时不变量的唯一归属（版本、卡片路径、SSE 头与心跳、HTTP 状态码、会话摘要长度、诊断字节上限、轮询间隔）。
- `src/types.ts`：跨层共享类型（`PeerIdentity`/`OWNER_IDENTITY`/`SessionBinding`/`Result`）、终态任务状态单一权威 `TERMINAL_TASK_STATES`、`taskStateFromTurnEnding()`（token 上限结算为 COMPLETED 而非 FAILED，真实原因走 `metadata.dsh.stopReason`）。

### Added — 安全原语 `src/security/`

- `constantTimeEqual()`：长度不等时先烧一次自比较，避免长度差异可测。
- `identifyPeer()`：遍历**全部**候选 peer，命中后不提前退出 —— 响应时间既不泄露是谁命中，也不泄露声明了多少 peer。
- `RateLimiter`：固定窗口限流，时钟可注入（测试无需 sleep）+ `sweep()` 清理静默身份。
- `redactSecrets()` / `wellFormed()` / `sanitizeOutbound()`：出站文本统一擦除 `sk-*`、`gh[pousr]_*`、`AKIA*`、JWT、`Bearer …` 等凭据；修复未配对的 UTF-16 代理项（CJK/emoji 被跨 chunk 切断时会产生"合法 JSON 但对端无法重新编码"的字符串）。
- `clampDiagnostic()`：诊断串按共享字节预算截断。

### Added — 会话可见性 `src/session/`（ADR-007）

- `sessionIdFor()`：`contextId` → `sessionId` 的**确定性**派生（sha256 切片 24 位）。确定性是刻意设计：远端带着同一 `contextId` 回来必须落回同一会话，否则历史静默消失、进程重启即断档。
- `newContextId()` / `workspaceName()` / `workspaceTitle()` / `workspacePath()`：工作区命名 `<prefix>-<peer>-<MMDD>-<HHMMSS>-<hash6>`、人类可读标题 `A2A · peer MM-DD HH:MM`、`per-peer`/`shared` 两种 cwd 解析。
- `asWorkspaceRegistry()`：结构化探测 `ctx.get('workspaceRegistry')`，服务缺失时优雅降级（硬 inject 会让插件在无该服务的 profile 上永久 pending）。

### Added — 入站 `src/inbound/`

- `registerInboundRoutes()`：挂载 `/.well-known/agent-card.json`、`/.well-known/agent.json`（旧别名）、`<basePath>` 三条 exact 路由，返回 disposer。
- `makeRpcHandler()`：顺序严格为 method → auth → 限流 → trust → version → body → parse → params → dispatch（顺序变化会改变攻击者可获得的信息）。
- 鉴权失败分层：401（未知 token，附 `www-authenticate: Bearer`）/ 403（不在 trustedPeers）/ 429（限流）/ 413（超限），**body 始终是合法 JSON-RPC 信封**。
- `readBody()`：带字节上限的流式读取；显式 `Buffer → toString('utf8') → JSON.parse`（**不**对 Buffer 直接取属性 —— 这是会导致"恒报 messageId is required"的经典坑）。
- ~~`asWebServer()`~~：初版用于结构化探测 `ctx.get('webServer')`；ADR-011 后入站改走自建监听器，该探测已随 `registerInboundRoutes()` 的 `RouteHost` 改造移除。

### Added — 出站 `src/outbound/`

- `discoverCard()`：抓取 + 解析 Agent Card；`stripCardPath()` 先剥掉已存在的 well-known 后缀再拼接，避免请求两次拼接的路径。
- `sendMessage()`：`POST` JSON-RPC `SendMessage`，**必带 `a2a-version: 1.0`**；服务端返回非终态时用 `GetTask` 轮询到终态；兼容"只回 message 不回 task"的对端。
- `pollUntilTerminal()`：轮询带 deadline；超时返回 `terminatedEarly: true` 而不是伪装成成功。
- `streamMessage()`：`SendStreamingMessage` + `SseFrameDecoder` 逐帧回调，`reader.releaseLock()` 保证清理。

### Added — 入站监听器 `src/inbound/server.ts`（ADR-011）

- 自建 `node:http` 监听器，**不再挂 `ctx.webServer`**（Desktop 壳下后者恒绑 `127.0.0.1`，远端不可达）。`InboundServer` 实现 `RouteHost` 接口，同时支持 exact / prefix 路由，测试中可换假宿主。
- `assertConcreteHost()` / `isWildcard()`：加载期拒绝 `0.0.0.0` / `::` / `[::]` / `*` / `::0`，抛 `WildcardBindError`；必须绑本机一个具体地址。
- 生命周期：`start()` 绑定并回填实际端口（支持 `port: 0` 让 OS 选端口）；`stop()` 先 `end()` 所有跟踪中的 SSE 响应，再 `destroy()` 全部 socket，最后 `close()` —— 避免 keep-alive 让 `close()` 永挂。
- `trackStreaming(res)`：SSE 长连接单独记账，因为 `closeAllConnections()` 不回收长连接路由。

### Added — 执行体 `src/inbound/executor.ts`

- `InboundExecutor`：`SendMessage` → 在绑定会话里跑一轮 DSH turn；`GetTask` 查任务；任务投影与终态结算走 `taskStateFromTurnEnding()`（token 上限结算为 `COMPLETED`，真实原因留在 `metadata.dsh.stopReason`）。
- `cardForDeployment()`：按部署配置构造 Agent Card，卡上的 `url` 用 `publicUrl` 或监听地址拼，**绝不用 webServer 的 origin**。

### Added — 出站 provider / 工具（ADR-006）

- `src/outbound/provider.ts`：`A2aSubagentProvider` —— 注册进 `ctx.subagents`，`inheritsParentContext = false`，不 reject seam，双层取消，`finally` 清理 timer。
- `src/outbound/tools.ts`：`a2a_call` / `a2a_list` 两个工具，作为 provider 的补充通道。

### Added — 会话事件镜像 `src/session/`（ADR-007 ②③④）

- `events.ts`：`SessionMirror` —— 入站侧不重复发布事件（executor 跑的就是真实 DSH 会话），只负责把会话放进 A2A 工作区并统一回收；出站侧把远端进展写成 `developer/message` 面事件，用户能在聊天视图里实时看到"正在委派 / 远端状态 / 收到回复"。
- 刻意避开 `user/message`（会伪造成用户发言）、`assistant/message`（需要完整结算记录，会注入假回合）与 `plugin:` 记录（会话 UI 不渲染，等于静默无效）；没有可用 `append` 时降级为插件日志且只提示一次。
- `workspace.ts`：`ensureWorkspace` / `ensureWorkspaceDirectory` / `attachSession` / `workspaceForPeer` —— 工作区与服务缺失时优雅降级。
- `src/index.ts` 接入 `SessionMirror`，并在 `ctx.effect` 里 `dispose()` 统一清理订阅与 agent 句柄。

### Added — 插件入口与装配

- `src/index.ts`：`inject = ['agents']`（硬依赖），`webServer` / `subagents` / `tools` / `credentials` 全部用 `ctx.get()` 探测 —— 硬 inject 在缺服务的 profile 上会让插件永久 pending。
- 入站：构造 executor + `InboundDeps`（限流器、per-request 凭据解析、trustedPeers），在 `ctx.effect` 内 `registerInboundRoutes(server, …)` 并 `server.start()`；dispose 时注销路由并 `server.stop()`。
- 出站：`ctx.subagents` 可用则注册 provider，`ctx.tools` 可用则注册两个工具，缺服务只 warn 不崩。
- `cordis.patch.yml`：`insert` 一个 `a2a-bridge` 条目，内置全部默认值，含 **`inbound.listen: { host: 127.0.0.1, port: 3081 }`**（默认只允许本机调用，部署时改成 LAN 地址）。

### Added — wire 集成测试 `tests/wire/`

- `inbound.spec.ts`：真实 `InboundServer` + 真实 HTTP（`port: 0` 让 OS 选端口），覆盖卡片匿名读、401/403/429/413、版本头、JSON-RPC 管线 —— 这是 ADR-011 真正被证明的地方：监听不 bind、路由不匹配或顺序不对都会失败。
- `roundtrip.spec.ts`：本项目的出站 `sendMessage()` / `discoverCard()` 打自己的入站 server，验证两半对卡片形状、版本头、认证方案、信封与任务形状的理解一致。

### Added — 本地门禁实测（2026-10-26）

- `npx tsc -p tsconfig.json --noEmit` → **exit 0**。
- `npx vitest run` → **379 passed / 379**，**16 个 spec 文件**：`tests/unit/` 下 `protocol.{wire,jsonrpc,parse,card,sse}.spec.ts` + `security.spec.ts` + `session.spec.ts`，以及 `tests/wire/` 下 `inbound.spec.ts`、`roundtrip.spec.ts`（真实监听器 + 真实 HTTP，含出站 client ↔ 入站 server 回环）。
- `npx tsc -p tsconfig.build.json` → **exit 0**，产出 **24 个 JS** 到 `lib/`。
- `node scripts/verify-exports.mjs` → ✓ 6 个 exports 目标全部存在。
- `node scripts/verify-version.mjs` → ✓ 版本一致。
- 依赖用国内镜像 `https://registry.npmmirror.com` 安装（npm 官方源对 `typescript` 持续 `ECONNRESET`）。

### Added — 工程骨架

- `package.json`：包名 `dsh-a2a-bridge`、`type: module`、双入口 `exports`（`.` 与 `./protocol`）与 `./cordis.patch.yml`、`dsh.bundle.patch` 声明、`engines: { node: ">=22.19.0", dsh: ">=0.2.1-rc.2 <0.3.0" }`。
- `tsconfig.json` / `tsconfig.build.json` / `vitest.config.ts` / `.gitignore` / `LICENSE`（MIT）。
- `scripts/verify-exports.mjs`（exports 指向的构建产物必须存在）、`scripts/verify-version.mjs`（版本一致性门禁）。
- `tests/helpers/`（`fake-ctx` / `echo-adapter` / `free-port` / `sse-reader`）与 6 个 unit spec：`tests/unit/protocol.{wire,jsonrpc,parse,card,sse}.spec.ts` + `tests/unit/security.spec.ts` —— 纯函数层，不起 Cordis、不开 socket。

### Added — 文档

- `README.zh-CN.md` / `README.md`（中英对应）：以 ADR-007 会话可见性开篇、ASCII 架构图、逐字段配置对照、诚实的当前状态表、Boundaries。
- `docs/installation.md`：安装前置、两处修改（`dependencies` + `dsh.profile.bundles`）、隔离 profile 验证、TLS 与 LAN 绑定、回滚。
- `docs/troubleshooting.md`：交接文档第 5 节 16 条 + `research/05` §7.1 新增 22 条合并去重后的完整坑点表与处置手册。

### Decisions

- **ADR-001** 协议路线 A2A；**ADR-002** 版本策略 v1.0 并钉死 peer 范围；**ADR-003** MVP 明文 HTTP + 强 Bearer（中期 Tailscale）；**ADR-004** 静态 URL + Agent Card well-known 发现；**ADR-005** per-peer token 经 `ctx.credentials` 引用名；**ADR-006** 出站 = subagent provider 为主 + tools 为辅；**ADR-007** A2A 会话必须是可见的一等公民工作区；**ADR-008** 正规化/标准化开发纪律（禁硬编码、交叉复核、Bug 三步法、分层）；**ADR-009** 团队分工；**ADR-010** 用官方 SDK 的 `DefaultRequestHandler` + `JsonRpcTransportHandler`，**绝不用** `/server/express`；**ADR-011** 入站传输改为**插件自建 `node:http` 监听器**、绑具体 LAN IP（拒绝通配），**不再挂 `ctx.webServer`**。

### Changed

- 修正交接文档两处错误，并已在代码注释与文档中标注：
  - **`-32609` 不存在**。v1.0 错误码族是 `-32001..-32009`；`-32609` 落在 JSON-RPC 保留段（`-32700..-32600`）之外。
  - **`ctx.webServer` 支持 TLS**（`createServer({cert, key}, listener)`，`--tls-cert/--tls-key`）。交接文档「不提供 TLS」不成立 → TLS 是可选配置而非不可达，ADR-003 的升级路径因此成立。
- **入站装配从 `ctx.webServer` 改为自建监听器（ADR-011）**：`registerInboundRoutes()` 不再接收 webServer，改为面向 `RouteHost` 接口（`register(route) → disposer`），因此既能挂 `InboundServer`，也能在测试里挂假宿主。
- `src/config.ts` 新增 `inbound.listen: { host, port }`；`host` **必填且必须是具体地址**，`port` 默认 `3081`。
- `cordis.patch.yml` 不再省略入站配置，改为给出 `listen: { host: 127.0.0.1, port: 3081 }` 的安全默认。

### Fixed

- **局域网可达性（原 Known issue）**：Desktop 壳下 `ctx.webServer` 恒绑 `127.0.0.1` 且有抛错断言、`networkExposure: 'lan'` 只开 HTTPS 边缘 → 改用 `src/inbound/server.ts` 自建监听器绑具体 LAN IP，端点因此可被 peer 访问。
- **SSE 连接不随 dispose 回收（原 Known issue）**：`InboundServer` 单独跟踪长连接响应，`stop()` 里先 `end()` 再 `destroy()` 全部 socket，不依赖 `closeAllConnections()`。
- **安全审计缺陷**：限流 429 已接线；`trustedPeers` 403 已实现；401 响应带 `www-authenticate: Bearer`。三者都在 `makeRpcHandler` 的顺序链里（auth → rate-limit → trust → version）。
- **typecheck 抓到的真 bug**（均已修复，`tsc --noEmit` exit 0 为证）：
  - `@types/node` 在 DSH checkout 里是**空壳**（只有 `LICENSE` + `package.json`，没有 `index.d.ts`），靠 junction 指向它提供不了类型 → 必须真实安装 `@types/node`。
  - `buildAgentCard()` 对 readonly 字段赋值 → 改为构造 `readonly` 对象。
  - `DiscoveredContact` 缺 `agentCardPath` 字段 → 补上。
  - `crypto.randomUUID` 未导入 → 补 `node:crypto` 导入。
  - `parseJsonRpc()` 失败分支的 `id` 类型不匹配 → 收敛为 `string | number | null`。
  - 使用不存在的 `req.signal` → 改为基于 `req.once('close')` 的 `AbortController`。

### In progress（仍在实现，插件可装载）

- mesh 测试与真机联调脚本（`tests/live` 目前仅有 README）。

### Not implemented

- 跨会话工具 deny-list。
- 多 agent（`/agents/<id>` 形态）。
- Push notifications（卡片 `capabilities.pushNotifications` 恒 `false`）。
- mTLS。
- ~~**入站 SSE 流式**~~ → **已实现**：路由识别 async iterable 并走 SSE；`SendStreamingMessage` 返回 `task` → `statusUpdate` → `artifactUpdate` → 终态；卡片 `capabilities.streaming` 与 dispatch 分支由同一个常量驱动，翻转即同时生效。

### Known issues

- ~~**任务状态不跨进程重启**~~ → **已实现**：任务记录写盘（`inbound.tasks`，目录与保留策略可配），`GetTask` 跨重启可查；`CancelTask` 区分未知（-32001）与已终结（-32002）。
- ~~**跨 rc seam 未逐条核对**~~ → **已整理为审计文档**：`docs/rc-seam-audit.md` 逐项列出 12 个 seam 的用途、缺失后果与现有证据，并说明远端把宿主包打进 `app.asar`、无法做 `.d.ts` 字节对比，因此以**启动期 seam 探针**（`a2a: seams … missing=…`）与行为验证为主证据，残余风险单列在第 5 节。

### Unverified

- **（历史）首次真机联调前**：两台机器的 A2A 端点尚未互通，且当时对端只有文件读取权限、无法远程执行。两者均已不是阻塞项：双向联调已于 2026-10-26 完成。
- **mesh / live 无执行用例**：`tests/mesh` 无 spec 文件，`tests/live` 仅有 README；现有 453 个通过用例覆盖 unit 与 wire 两层，不含真实网络跳数、防火墙与两个独立 DSH 进程。
- ~~**监听器未经真机验证**~~ → **已由真机联调验证**：双向 `SendMessage` 成功，入站监听器的 bind 与连通性均已在真实 LAN 上跑通。

### Security

- 威胁模型现状见 README「Boundaries」：明文 HTTP + Bearer 的 token 嗅探风险是**已知且已接受**的 MVP 取舍，缓解手段不替代加密。
- 出站统一脱敏 + 代理对修复，避免凭据与畸形编码越过机界。
- 凭据只以引用名出现在配置中，加载期强制校验；每请求重新解析、不缓存，轮换即时生效。

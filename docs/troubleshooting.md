# 排障手册（Troubleshooting）

> 合并口径：**交接文档第 5 节 16 条** + **`research/05-其余仓库与社区踩坑.md` §7.1 新增 22 条**，去重后共 **40 条（T1–T40）**，其中 **3 条来自本地实码/实测新增（T24、T34、T40）**。
> 每条都保留来源标记，末尾附[来源映射表](#7-来源映射不可能漏条) —— 可逐条核对"哪些条目被合并、没有丢"。
>
> **⚠ 先看 §8。** T1–T40 是调研阶段汇总的**外部**坑点；**§8 的 D1–D9 是本项目实装这一路真实踩中、并已修掉的 9 个坑**，
> 每个都带「症状 / 根因 / 修法」。遇到"代码看着对但就是不工作"，先查 §8。

---

## 0. 三条必读（能省掉 90% 的时间）

**① 用域名连不上、换成 IP 就好。**（见 [T31](#t31-用域名连不上换成-ip-就好)）
fake-IP 类代理把域名解析成保留地址，而对端只监听**具体地址**，于是"域名必失败、IP 正常"。把配置里的 `url` / `publicUrl` 换成 IP 即可。本插件没有 DNS 复查，也没有 `skip` 开关。

**② 卡片报 `expired` → 先查 NTP，别先改代码。**（见 [T32](#t32-时钟偏差--卡片-expired)）
真实机器上看到 `expired`，第一怀疑对象是时钟偏差，第二才是签名/验证逻辑。`w32tm /query /status` / `timedatectl` 对齐后复测。节点没有 NTP，签名类方案直接不可用。

**③ 装完没反应 → 先确认是不是只改了一处。**（见 [T11](#t11-装插件必须改两处只改一处静默不装载)）
必须同时改 **`dependencies`** 和 **`dsh.profile.bundles`**。只改一处不装载，且通常**不报错**。改完重启 `dsh`，新工具要开**新会话**。

---

## 1. 先分诊：问题在哪一层

| 层 | 典型症状 | 先看 |
|---|---|---|
| **装载层** | 插件"装上了"但工具/路由全不存在；`dsh` 启动无报错 | T11、T12、T13、T15、T16 |
| **实装层**（本项目自身踩中） | 服务拿不到 / 工具被 provider 拒 / 会话读不到事件 / 成功轮次被判失败 / 插件页不渲染 | **§8 的 D1–D9** |
| **连接层** | 连接被拒 / 超时 / DNS 报错 / 证书错 | T34、T31、T7–T10 |
| **鉴权层** | 401 / 403 / 429 / 413 | T37、T36、T35 |
| **协议层** | 200 但 body 是错误信封；`-32001..-32009`；`messageId is required` | T17、T18、T19、T20、T22 |
| **执行/会话层** | 任务不结终态、会话窗不出现、重启后任务丢 | T25、T29、T26、T23、T24 |
| **工程层** | 本地全绿、干净机器崩；打包产物缺文件；Node 类型全缺 | T1、T3、T27、T28、T40 |

**先定位再改**：单次只改一个变量。改完出现新失败 → 回退，重新定位，禁止连锁打补丁。

---

## 2. 完整坑点表（T1–T40）

### 一、环境与版本

| # | 症状 | 根因 | 处置 | 来源 |
|---|---|---|---|---|
| **T1** | `pnpm add <peer>` 后报 `Cannot find package '@deepseek-ai/dsh-scope'`，级联出更深一层的过期依赖 | npm `latest` dist-tag 仍指向旧 `0.0.1-rc.x` 世代，而插件声明 `>=0.1.0-rc.6/7` | peer 依赖**钉死精确版本**（本项目已钉 `0.2.1-rc.2` 世代），禁 `>=` 开放式范围；**绝不单独安装** `@deepseek-ai/dsh-*` | H1、N1 |
| **T2** | 插件加载即崩，或类型全错但运行时"看起来正常" | 包自身世代（如 `0.1.7-alpha.2`）与运行时世代（`0.2.1-rc.x`）错配 | 认 `engines.dsh: >=0.2.1-rc.2 <0.3.0`；跨世代不兼容，别试 | N4 |
| **T3** | `tsc` 报 25 个错，而 `vitest` 全绿；`ctx.timer`/`ctx.tools` 之类的模块增强"声明了但没用" | lockfile 把插件根与 peer 解析到**两份 cordis**（如 4.0.4 / 4.0.1），增强打在另一份副本的 `Context` 上 | CI 用**干净机器 + 冻结 lockfile + 独立 typecheck**；本地单实例会让门禁假绿 | N2 |
| **T4** | 升级后模块加载失败（值级 ESM 导入直接炸）、类型出现真错误 | 只看了 changelog，没核对导出面 | 升级时**逐 seam 对照已发布包的 `lib/*.d.ts` + `lib/*.js`**；历史案例：`isTokenDelta` 被移除且无替代 | N22 |
| **T5** | 跨版本 executor 读会话时字段缺失/结构不符 | 会话格式已演进到 **v4**（`message-source-kind`） | 跨版本读写必须显式适配；不要假设 v1 结构 | N20（unverified） |
| **T6** | `pnpm peers check` 和 `node import(...)` 都过了，插件照样不加载 | 它们**不走 DSH 的 runtime module resolver** | 加载测试只能用真实 `dsh` 启动 + 真实 profile | H3 |
| **T40** | `tsc` 报一堆 Node 内置模块类型缺失（`node:http`、`Buffer`、`process` 等），但 `node_modules/@types/node` 明明存在 | DSH checkout 里的 `@types/node` 是**空壳**（只有 `LICENSE` + `package.json`，**没有 `index.d.ts`**）；靠 junction / symlink 指过去提供不了任何类型 | 必须**真实安装** `@types/node`（本项目 devDependency 已声明）；不要用 junction/软链"借用"宿主 checkout 的类型 | 本地实测（本项目新增） |

### 二、安装与装载

| # | 症状 | 根因 | 处置 | 来源 |
|---|---|---|---|---|
| **T7** | `dsh plugin` 报参数错误 / `--profile` 被当成 pnpm 参数 | `--profile` 写在 pnpm 参数之后 | `--profile` **必须在 pnpm 参数之前**（DSH v0.2.1-alpha.1 起） | H4 |
| **T8** | `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` | pnpm 11 默认禁止 Git 依赖执行 prepare | 把 pnpm 打印的**完整 `allowBuilds` 条目**（含 Git source + resolved commit）写进该 profile 的 `pnpm-workspace.yaml`，保留原有设置；**不要**全局放行 | H5 |
| **T9** | 装完把 desktop 搞坏，回滚困难 | 直接在桌面 profile 上试 | 先 `--profile a2a-test --from-default-profile web`，`--port 3100 --no-open` 验证通过再迁 | H6 |
| **T10** | 改了 `web` profile 没生效 | Desktop 靠**工作目录**选 profile，不是 `web` | Desktop 用 `--profile desktop`；Desktop 通常不传 `--profile` | H7 |
| **T11** | 包装上了，但路由/工具/会话全都不存在；**无报错** | 只改了 `dependencies`，没改 `dsh.profile.bundles`（或反之） | **两处都改**，改完重启；新工具要开**新会话** | 安装纪律（H5.2 精神 + 团队约束表） |
| **T12** | bundle 装载报错 / 找不到入口 | bundle 入口不是根 `index.js` 再导出 `lib/index.js` | 根入口做薄壳再导出 `lib/index.js`，不要直接把 `lib/` 指成入口 | N12 |
| **T13** | `ERR_PACKAGE_PATH_NOT_EXPORTED`，README 宣称的子路径用不了 | `exports` map 没声明 README 里写的子路径 | `exports` 必须与 README 严格一致；CI 加**产物契约门禁**（`pnpm verify:exports`） | N3 |
| **T14** | 发布产物在干净机器上缺依赖文件 | 打包未自包含 | `alwaysBundle: id => !id.startsWith('node:')` 形态的自包含打包 | N21 |
| **T15** | 改了配置不生效；「明明改了 yml」 | `cordis.patch.yml` 在**装配时**读取 | 改完**重启 `dsh`**；例外是 GUI registry（保存即热重载） | H13 |
| **T16** | 装完出现更诡异的版本冲突 | 单独 `pnpm add` 了 `@deepseek-ai/dsh-*`，或改了 profile 的 workspace 设置 | 保持 `nodeLinker: hoisted` + `autoInstallPeers: false` **原样**；peer 由 DSH 的 resolver 提供 | H2 |

### 三、协议与请求

| # | 症状 | 根因 | 处置 | 来源 |
|---|---|---|---|---|
| **T17** | 静默失败，或报错位置远离根因；`-32601` 提示替代方法 | v0.3 / v1.0 **不是别名关系**：`taskId`→`id`、裸 `Task`→`{task}`、`working`→`TASK_STATE_WORKING`、`user`→`ROLE_USER`、`kind` 判别符删除、`blocking`→`returnImmediately`（**语义相反**） | 两端锁 v1.0；出站**必带** `a2a-version: 1.0` | H8 |
| **T18** | JSON-RPC/REST **恒定**报 `message.messageId is required`，即使请求体完整 | `readBody()` 返回 `Buffer`，代码做 `body.message ?? {}` —— **Buffer 没有 `.message`** | 显式 `Buffer → toString('utf8') → JSON.parse`；REST 与 JSON-RPC 两条路径都要覆盖测试 | N10 |
| **T19** | 浏览器/跨源客户端预检失败；`OPTIONS` 返回 405 | 入站端点没处理 CORS/`OPTIONS` | 支持 `OPTIONS` 预检并按需回 CORS 头（当前 `routes.ts` 只允许 `POST`/`GET`，**尚未实现 OPTIONS**） | N11（中置信度，有旁证） |
| **T20** | 超时后重发 → **同一任务被执行两次** | `-32005` 意味着**投递已落地**，peer 可能仍在跑 | 先按 task id **对账**再决定是否重发；幂等键由 caller 生成并贯穿请求 | N6 |
| **T21** | `POST /a2a/direct` 只对"接收它的那台宿主"生效 | 直接投递**不中继** | 跨宿主必须走路由式接口；不要假设 direct 会转发 | N7 |
| **T22** | 多 agent 部署下，根路径卡片的内容"不对" | 根 `/.well-known/agent-card.json` **只返回第一个 agent**（`/` 没有默认 agent） | 多 agent 时逐个 `/agents/<id>` 取卡片 | H16 |

### 四、运行时与生命周期

| # | 症状 | 根因 | 处置 | 来源 |
|---|---|---|---|---|
| **T23** | 插件卸载/重载后端口仍被占、监听器泄漏 | 生命周期没绑 Cordis fiber | 监听器随加载启动、随 dispose 关闭（含 socket）；用 `ctx.effect` 注册 disposer | H12 |
| **T24** | 热重载后旧 SSE 连接还在，客户端收到半死流 | `closeAllConnections()` **不回收**长连接 HTTP 路由 | 自己跟踪每条 SSE 连接，用 `ctx.effect` disposer 显式关闭 | 本地 `dsh-host-webserver` 实码（本项目新增） |
| **T25** | 重启后任务查不到 / 状态回退 | 任务状态**不跨进程重启**（未接会话持久化时投影无 log 可冷折叠） | 重启前让在途任务收尾；要跨重启就得先接持久化 | H14 |
| **T26** | 多 context 并发时互相串味 | 一个 executor 实例服务该 agent 的**所有** context | 一个 executor 对应一个 agent；按 `contextId` 严格分账 | H15 |
| **T27** | 发布产物缺文件（如 `lib/client.js` 不存在） | `tsc` 报错**仍会 emit**，但 `&&` 链在此中断 | 别用 `&&` 串 typecheck 与打包；分别检查退出码，打包前断言产物齐全 | N13 |
| **T28** | `test` 全绿但 `tsc` 红；发版才发现类型错 | **Vitest 不做类型检查** | `typecheck` 必须是**独立** CI 门禁步骤 | N14 |
| **T29** | API 创建的会话目录永不出现；排队的 prompt 永不被消费 | `session/create` 只注册内存记录，会话不物化 | 用 GUI 创建；或 API 创建后**在 GUI 里打开一次** | N5 |
| **T30** | 导入的会话 id 与本地会话撞名/塌缩 | 命名空间未隔离 | 导入会话 id 必须加前缀（本项目用 `a2a-<peer>-<hash>`） | N17 |

### 五、网络与时钟

| # | 症状 | 根因 | 处置 | 来源 |
|---|---|---|---|---|
| **T31** | 写域名时连接失败/超时，换 IP 正常 | fake-IP 代理把域名解析成保留地址；或对端只绑定具体地址，与域名解析结果不同 | ① 换成 **IP**；② 核对对端 `inbound.listen.host`（本插件**无** DNS 复查、**无** skip 开关） | N8 |
| **T32** | 卡片在验证方 `expired` | 时钟偏差（NTP 未同步） | 先对时再复测；无 NTP 的环境不要用签名类方案 | N9 |
| **T33** | nonce 环在 p2p 下内存无限增长 / 重放窗口难维护 | 有状态 nonce 环不适合去中心拓扑 | 改用**时间戳窗口**（无状态） | N19 |
| **T34** | 本机 `curl 127.0.0.1` 正常，远端连不上，报"连接被拒"；误判为防火墙 | Desktop 壳下 `ctx.webServer` **恒绑 `127.0.0.1`**；`networkExposure` 只控制 HTTPS 边缘，**永不暴露上游 HTTP 源** | **已由 ADR-011 解决**：插件自建 `node:http` 监听器（`src/inbound/server.ts`），绑 `inbound.listen.host` 指定的具体 LAN IP，默认端口 `3081`。排障时确认监听地址与防火墙 | 本地 `dsh-plugin-desktop` 实码（本项目新增） |

### 六、安全与治理

| # | 症状 | 根因 | 处置 | 来源 |
|---|---|---|---|---|
| **T35** | 匿名扫描者拿到了内部能力清单；或"验签通过"被当成"存在信任关系" | 卡片没做分面；把认证当授权 | 匿名只给 minimal 面；记住 **"Proving a key is not a link"** —— 能验签 ≠ 有链接关系 | N15 |
| **T36** | 一条 token 泄露导致控制面与 peer 面同时失守 | 两套接口共用凭据 | **控制面与 peer 面两套凭据**；浏览器侧无法签卡片密钥，必须有独立通道 | N16 |
| **T37** | 某个 peer 能读到别的 peer 的文件 | 工作区没隔离 | `workspaceMode: per-peer`；per-peer token 是隔离的前提 | H10 |
| **T38** | 分发/商用时的许可风险 | 参考仓库**无 LICENSE**（`MicroWearld/dsh-subagent-a2a`：LICENSE 404，package.json 却写 BSD-3-Clause，声明与文件矛盾） | 无 LICENSE = **保留所有权利**：只能参考范式，**严禁复制源码** | H11（已核实） |
| **T39** | 排障时把"网络不通"和"被信任拒绝"混为一谈，越修越乱 | 故障没分层 | 明确区分 `unreachable`（传输层）与 `rejected`（信任层），分别上报 | N18 |

---

## 3. 重点坑详述

### T18 readBody 返回 Buffer 未 parse（A2A 服务端经典坑）

```ts
// ❌ 恒错：Buffer 没有 .message
const body = await readBody(req)
const message = body.message ?? {}

// ✅
const raw = (await readBody(req)).toString('utf8')
const body = raw.length === 0 ? {} : JSON.parse(raw)
const message = (body as any).message ?? {}
```

**为什么难查**：请求体看起来完全正确，错误信息却指向业务字段（`messageId is required`），让人怀疑客户端。本项目在 `src/inbound/routes.ts` 里已显式解码并在注释里钉住这条（TtTRz issue #1）。REST 与 JSON-RPC 两条路径都要测。

### T19 缺 CORS / OPTIONS

入站端点必须能应答 `OPTIONS` 预检，否则浏览器侧客户端（含 GUI 内嵌页面）会在预检阶段就失败，且控制台只显示"CORS 错误"，看不到你的路由逻辑。

现状：`src/inbound/routes.ts` 的 RPC 路由只允许 `POST`（其它 → 405），卡片路由只允许 `GET`。**OPTIONS 尚未实现** —— 这是待办，不是已修。

### T3 双 cordis 副本 → 模块增强静默失效

典型现场：`tsc` 报 25 个错，而测试全绿。原因是根 `Context` 来自 cordis 4.0.4，而 `ctx.timer` / `ctx.tools` / `ctx.systemPrompt` 的模块增强声明是针对 4.0.1 副本的，永远作用不到根 `Context`。

排查：

```powershell
# 在 profile 目录找所有 cordis 副本
Get-ChildItem -Recurse -Directory -Filter cordis | Select-Object FullName
# 或用 pnpm 看解析结果
pnpm why @deepseek-ai/cordis
```

多个版本共存 = 立刻停下来对齐，不要在错误现场继续开发。

### T1 peer 依赖级联错配

`latest` 指向旧世代 → 裸装 peer 落到过期版本 → 又级联出更深一层的过期传递 peer → 最终报一个**跟根因毫无关系**的包找不到。

纪律：peer 依赖钉死精确版本；任何 `@deepseek-ai/dsh-*` 都不要自己装；出问题先 `pnpm why`，不要先改代码。

### T28 Vitest 不做类型检查

`vitest run` 通过只说明**运行时行为**符合断言。类型错误、导出面漂移、`lib/*.d.ts` 缺失它都看不见。

CI 顺序固定为：`lint → typecheck → build → test → verify:exports → verify:version`，**`typecheck` 与 `test` 必须是两个独立步骤**，不能靠 `&&` 把失败吞掉（见 T27）。

### T34 Desktop 下 `ctx.webServer` 恒绑 127.0.0.1（**已由 ADR-011 解决**）

本地 `dsh-plugin-desktop` 实码：

```js
/** The upstream HTTP origin is never exposed; LAN intent controls only the HTTPS edge. */
function desktopWebServerHost(_exposure) { return "127.0.0.1" }
// 兜底断言
if (ctx.webServer.host !== desktopWebServerHost(resolved.networkExposure))
  throw new Error("dsh-plugin-desktop: desktop shell WebServer host does not match networkExposure")
```

所以 `networkExposure: "lan"` **不能**让 `/a2a` 被局域网访问：它只开 GUI 的 HTTPS 边缘，上游 HTTP 源恒为 `127.0.0.1`。

**处置（已实现，不再是"待定"）**：插件不挂 `ctx.webServer`，改为 `src/inbound/server.ts` 自建 `node:http` 监听器（ADR-011）：

1. bind `inbound.listen.host` 指定的**具体地址**（如 `192.168.1.10`），默认端口 `3081`；
2. 通配地址（`0.0.0.0` / `::` / `*`）在加载期抛 `WildcardBindError`，不允许"全接口暴露"；
3. 生命周期绑 `ctx.effect`：`start()` 监听，dispose 时 `stop()` 先 `end()` SSE、再 `destroy()` socket；
4. 该端口需要**单独开防火墙入站规则**（见 §5）。

排障口径：先看 `Get-NetTCPConnection -LocalPort 3081` 的 `LocalAddress`。若为 `127.0.0.1`，说明配置没改成 LAN 地址；若已是 LAN 地址但仍连不上，再查防火墙与 `publicUrl`。

### T40 `@types/node` 在 DSH checkout 里是空壳

症状：`tsc` 报 `node:http`、`node:crypto`、`Buffer`、`process` 等类型全部缺失，但 `node_modules/@types/node` 目录"明明在"。

根因：DSH checkout 内的 `@types/node` 只有 `LICENSE` 与 `package.json`，**没有 `index.d.ts`**。用 junction / symlink 把项目指向它，等于指向一个没有类型声明的空目录 —— 补充任何 `paths` 映射都不会生效。

处置：**真实安装** `@types/node`（本项目 `devDependencies` 已声明 `^22.10.0`），使用国内镜像安装：

```powershell
npm install --registry=https://registry.npmmirror.com
```

不要把"借用宿主 checkout 的类型"当作节省安装的手段 —— 这是本项目 typecheck 抓到的真实缺陷之一。

### T31 用域名连不上、换成 IP 就好

**症状**：`outbound.contacts[].url` 写域名时连接失败或超时；同一地址换成 IP 立刻正常。

**根因**（两种都很常见）：

1. fake-IP 类代理把域名解析成一个保留地址（如 `198.18.x.x`），请求打到了不存在的主机上；
2. 对端监听的是**具体地址**（本插件拒绝通配绑定），而域名在你这台机器上解析出的地址，
   与对端实际绑定的不是同一个。

**修法**：① 换成 IP（首选）；② 确认对端 `inbound.listen.host` 就是你打算连的那个地址。

> **注意（曾写错，已更正）**：本插件**没有** DNS 复查、没有地址策略，也**没有 `skip` 开关**。
> 如果在别处看到 `A2A endpoint host ... resolves to a reserved network` 这类报错，
> **那不是本插件发出的**。出站地址策略见 `docs/threat-model.md` §4.2「未实现项 #2」。

### T32 时钟偏差 → 卡片 `expired`

```powershell
w32tm /query /status            # Windows
# timedatectl                    # Linux
```

判读口径（来自参考实现的测试文档）：真实机器上 `expired` **首先怀疑 NTP 偏差**。两台机器偏差超过卡片有效期，任何签名校验都会失败，且错误信息不会提示"是时间问题"。

### T11 装插件必须改两处，只改一处静默不装载

| 只改这个 | 结果 |
|---|---|
| 只改 `dependencies` | 包下载了，**bundle 不装配** → 路由/工具/会话全无，通常无报错 |
| 只改 `dsh.profile.bundles` | 指向未安装的包 → 启动报错，或静默跳过 |

正确姿势：两处都改 → 重启 `dsh` → **开新会话**验证工具可见。

### T24 SSE 连接不随 dispose 回收

`dsh-host-webserver` 的 gzip 中间件会刻意跳过 `text/event-stream`（好消息：SSE 能用），但 `closeAllConnections()` **不会**回收挂在长连接 HTTP 路由上的 SSE 流（坏消息：会泄漏）。

约束：插件必须自己维护 SSE 连接集合，并在 `ctx.effect` 的 disposer 里逐条 `end()`。热重载后如果客户端收到"半死流"，先查这里。

### T29 会话不物化

`session/create` 只写内存记录：会话目录**不会出现**，排队中的 prompt **永不被消费**。症状极具迷惑性 —— 会话"存在"但没有任何反应。

处置：优先用 GUI 创建；API 创建后**在 GUI 里打开一次**让它物化。这条直接影响 ADR-007 的会话可见性验收，联调时务必先确认会话真的物化了。

### T20 `-32005` 已落地，盲目重发 = 双重执行

超时**不等于**没投递。`-32005` 的社区语义是"投递已落地、媒体类型不受支持"。此时重发会在 peer 上产生第二个执行。

处置：caller 生成幂等键并贯穿请求；超时后先按 task id 对账（`GetTask`），确认非终态再决定是否重发。

---

## 4. 错误码速查

### JSON-RPC 保留段

| 码 | 含义 | 本项目的用法 |
|---|---|---|
| `-32700` | Parse error | body 不是合法 JSON |
| `-32600` | Invalid Request | 同时也是**传输安全失败的 body 码**（认证/限流失败时 HTTP 状态码另给 401/403/429） |
| `-32601` | Method not found | 收到 v0.3 方法名时，消息里点名 v1.0 替代方法 |
| `-32602` | Invalid params | `params` 非对象、`id` 缺失等 |
| `-32603` | Internal error | 内部错误（不回显细节，避免泄露路径）。**本项目用它表示两种"错在服务端"的情况**：① 真实内部错误；② **尚未选择 A2A 会话模型**（`MODEL_NOT_SELECTED_CODE`）。刻意不用 `-32602` —— 请求本身合法，不该把锅甩给 peer。见 [README.zh-CN.md](../README.zh-CN.md) 的「模型选择」一节 |

### A2A 保留段 `-32001..-32009`

| 码 | 名称 |
|---|---|
| `-32001` | `TaskNotFound` |
| `-32002` | `TaskNotCancelable` |
| `-32003` | `PushNotificationNotSupported` |
| `-32004` | `UnsupportedOperation` |
| `-32005` | `ContentTypeNotSupported`（社区实测含义见 T20：**投递已落地**） |
| `-32006` | `InvalidAgentResponse` |
| `-32007` | `ExtendedCardNotConfigured` |
| `-32008` | `ExtensionSupportRequired` |
| `-32009` | `VersionNotSupported`（版本头缺失/不接受） |

### ⚠️ 两个必须记住的"不存在"

1. **`-32609` 不存在。** JSON-RPC 保留段是 `-32700..-32600`，`-32609` 落在保留段之外；A2A 的版本错误码是 **`-32009`**。交接文档里的 `-32609` 是笔误。
2. **不要自造 `-32050…` 之类的码。** 认证/限流/信任失败走 **HTTP 状态码**（401/403/429/413），而 body 仍是合法 JSON-RPC 信封（用 `-32600`）。

### HTTP 状态

| 状态 | 场景 |
|---|---|
| `400` | body 解析失败 / params 不是对象 |
| `401` | 未知 token（附 `www-authenticate: Bearer`） |
| `403` | 已认证但不在 `trustedPeers` |
| `405` | 方法不允许（RPC 只允许 `POST`，卡片只允许 `GET`） |
| `413` | body 超过 `maxBodyBytes` |
| `429` | 超过 `rateLimitPerMinute` |
| `503` | 内部错误（不回显细节） |

---

## 5. 采集证据（Windows）

```powershell
# 1) 端点到底有没有在监听、绑在哪
Get-NetTCPConnection -LocalPort 3081 -ErrorAction SilentlyContinue |
  Select-Object LocalAddress, LocalPort, State

# 2) 从对端看端口通不通
Test-NetConnection 192.168.1.10 -Port 3081

# 3) 卡片（匿名，不需要 token）
curl.exe -s http://192.168.1.10:3081/.well-known/agent-card.json

# 4) JSON-RPC（带版本头与 Bearer）
curl.exe -s -X POST http://192.168.1.10:3081/a2a `
  -H "content-type: application/json" -H "a2a-version: 1.0" `
  -H "authorization: Bearer <TOKEN>" `
  -d '{"jsonrpc":"2.0","id":1,"method":"ListTasks","params":{}}'

# 5) 实际生效的配置（含 profile）
dsh --profile a2a-test --dump-config

# 6) 端口占用者
netstat -ano | findstr :3081
```

关键判读：**`LocalAddress` 若是 `127.0.0.1`，远端一定连不上** —— 这就是 T34 的配置侧表现（监听器本身已实现，检查 `inbound.listen.host` 是否写成了 LAN 地址）。

> 本项目**尚未跑过两台真机联调**；以上命令是核对手段，不是"已验证互通"的脚本。本地门禁（typecheck / 193 用例含 wire 集成测试 / build）已通过，但真机连通性仍是待办。日志请以 `dsh` 启动终端的实际输出为准，不要假设日志文件路径。

---

## 6. 两处已证伪 + 一处常见误解

| 说法 | 结论 | 依据 |
|---|---|---|
| "存在 `-32609` 错误码" | ❌ **笔误**。v1.0 错误码族是 `-32001..-32009`；版本错误是 `-32009` | `research/05` §7.2；`src/protocol/jsonrpc.ts` |
| "`ctx.webServer` 不提供 TLS" | ❌ **不成立**。实码支持 `createServer({cert, key}, listener)`，启动参数 `--tls-cert` / `--tls-key` | `dsh-host-webserver` 实码 + README:45/57；ADR-003 已据此修正 |
| "开 `networkExposure: lan` 就能让 A2A 被局域网访问" | ❌ **误解**。它只控制 HTTPS 边缘，上游 HTTP 源恒为 `127.0.0.1`（见 T34） | 本地 `dsh-plugin-desktop` 实码 |

---

## 7. 来源映射（不可能漏条）

### 交接文档第 5 节 16 条

| 原编号 | 主题 | 合并到 |
|---|---|---|
| 1 | 版本必须钉死 | T1 |
| 2 | 不单独安装 Harness peers（`autoInstallPeers`/`hoisted`） | T16 |
| 3 | `pnpm peers check` / `node import` 不是加载测试 | T6 |
| 4 | `--profile` 在 pnpm 参数之前 | T7 |
| 5 | Git 安装 `allowBuilds` | T8 |
| 6 | 先用隔离 profile 验证 | T9 |
| 7 | Desktop 用 `--profile desktop` | T10 |
| 8 | v1.0 与 v0.3 不兼容（10 项差异） | T17 |
| 9 | "webServer 不提供 TLS" | **已证伪**，见 §6 |
| 10 | Bearer + per-peer 隔离 | T37 |
| 11 | 多仓库无 LICENSE | T38 |
| 12 | 生命周期绑 Cordis fiber | T23 |
| 13 | `cordis.patch.yml` 装配时读取 | T15 |
| 14 | 任务状态不跨进程重启 | T25 |
| 15 | 一个 executor 服务该 agent 全部 context | T26 |
| 16 | 根 well-known 只返回第一个 agent | T22 |

### `research/05` §7.1 新增 22 条

| 原编号 | 主题 | 合并到 |
|---|---|---|
| N1 | npm `latest` 旧世代级联 | T1 |
| N2 | 双 cordis 副本 | T3 |
| N3 | `exports` map 缺子路径 | T13 |
| N4 | 包世代与运行时错配 | T2 |
| N5 | 会话不物化 | T29 |
| N6 | `-32005` 已落地，重发=双执行 | T20 |
| N7 | `POST /a2a/direct` 不中继 | T21 |
| N8 | 域名解析不一致（fake-IP 代理 / 对端只绑具体地址） | T31 |
| N9 | 时钟偏差 → `expired` | T32 |
| N10 | `readBody` 返回 Buffer 未 parse | T18 |
| N11 | 缺 CORS/OPTIONS | T19 |
| N12 | bundle 入口需根 `index.js` 再导出 | T12 |
| N13 | `tsc` 报错仍 emit、`&&` 链吞步骤 | T27 |
| N14 | Vitest 不类型检查 | T28 |
| N15 | 卡片分面 / 认证≠授权 | T35 |
| N16 | 控制面与 peer 面两套凭据 | T36 |
| N17 | 命名防塌缩 | T30 |
| N18 | 故障分类分层 | T39 |
| N19 | 时间戳窗口取代 nonce 环 | T33 |
| N20 | 会话格式 v4 | T5 |
| N21 | 打包自包含 `alwaysBundle` | T14 |
| N22 | 升级逐 seam 核对 | T4 |

### 本项目新增（本地实码实证）

| 编号 | 主题 | 依据 |
|---|---|---|
| T24 | SSE 连接不随 dispose 回收 | `dsh-host-webserver`：`closeAllConnections()` 不清理长连接路由 |
| T34 | Desktop 下 `ctx.webServer` 恒绑 `127.0.0.1` | `dsh-plugin-desktop`：`desktopWebServerHost()` 恒返回 `127.0.0.1` + 一致性断言；**已由 ADR-011 自建监听器解决** |
| T40 | `@types/node` 在 DSH checkout 里是空壳 | 本地实测：checkout 内 `@types/node` 只有 `LICENSE` + `package.json`，无 `index.d.ts` |

---

## 8. 本轮实装踩坑（D1–D9）：症状 / 根因 / 修法

> 这 9 条不是调研抄来的，是**这个插件本体在实装中真实踩中并已修掉**的。
> 它们的共同特征：**代码看上去完全正确，类型检查和单元测试也不会红** ——
> 因为失败发生在 Cordis 装配期、provider 校验期或客户端渲染期，全在 `tsc`/`vitest` 的视野之外。
> 每条都给了源码里"已经钉住这条"的位置，改代码前先读那段注释。

### 速查表

| # | 关键词（拿来搜） | 症状 | 根因（一句话） | 修法（一句话） |
|---|---|---|---|---|
| **D1** | `ctx.get` / `credentials` / `undefined` / `apply` | `apply()` 里 `ctx.get('credentials')`（或 `subagents` / `tools`）是 `undefined`，服务明明已安装 | **Cordis 只激活 `inject` 列表里声明的服务**，其余服务在 `apply()` 执行时尚未激活 | 必须用 `ctx.inject([...], cb)` 在**回调里**取，或每次调用时惰性 `ctx.get()`；不要把结果存进闭包变量 |
| **D2** | `defineTool` / `type: null` / provider 拒绝 / 400 | 每次 LLM 请求都被 provider 拒绝；工具 schema 变成 `type: null` | 工具定义没走 `defineTool()`，手写的对象缺少 `parameters` 的 JSON Schema 包装 | 一切工具必须 `defineTool({ name, description, parameters, execute })` |
| **D3** | `session.events` / `snapshotEvents` / 回复为空 | A2A 任务终态正常，但回复永远是 `(no text reply on this turn)` | 真实的 DSH session **没有 `.events` 属性**，只有 `snapshotEvents()` / `ownEvents()` | 读事件统一走 `readEvents()` 适配器（`snapshotEvents` → `ownEvents` → `events`） |
| **D4** | `agentOptions` / `{{model}}` / `persona-prefix` | `agents.create()` 后在**第一轮第 1 步**就失败：`prompt variable "{{model}}" has no value` | 创建 agent 时没传 `agentOptions: { provider, model }`，系统提示里的 `{{model}}` 无法解析 | `agents.create({ sessionId, meta, agentOptions })`；没有模型时应**先拒绝请求**，别创建空会话 |
| **D5** | `endReason` / `TASK_STATE_CANCELED` / 成功被判取消 | 明明成功的一轮，对端收到 `TASK_STATE_CANCELED` | `endReason` 默认 `undefined`，而 `taskStateFromTurnEnding()` 把 `undefined` 映射成 CANCELED | 默认值必须是 `'stop'`（正常完成），只有"准入丢消息"才该是 undefined |
| **D6** | `whenIdle` / 谎报 `COMPLETED` / 无回复 | turn 内部失败（如 transport 报错），`whenIdle()` 却**正常 resolve**，任务被报成 `TASK_STATE_COMPLETED` 且无正文 | `whenIdle()` 只表示"空闲"，不表示"成功"；真实结局只在 `turn/end` 事件的 `data.outcome` 里 | 结算前必须读 `turn/end` 的 outcome（只看 baseline 之后的新事件），error 则改判失败 |
| **D7** | `plugins.row.config` / `#` / issue #55 / 配置项不显示 | 插件页**不出现**配置入口，**也没有任何报错** | key 形态必须是 `<清单里的名字>#<row id>`；形态错就查不到，静默失败 | 按 `<包名|include:rowid>#<rowid>` 注册多种拼写；形态错是**没有日志**的，只能靠这份文档 |
| **D8** | `moduleDetection` / `client.js` / `export {}` | 浏览器报 `Uncaught SyntaxError: Unexpected token 'export'`，插件页白屏 | `tsconfig` 默认把 `.ts` 当模块，emit 时会给 `client.ts` 追加 `export {}`，而 classic `<script>` 不能解析 | `tsconfig.json` 必须 `"moduleDetection": "legacy"`，让 `client.ts` 以 classic-script 形态产出 |
| **D9** | 中文路径 / `开发` / package.json 编码 / 乱码 | DSH 重写 `package.json` 后文件编码被破坏，插件装不上或元数据乱码 | 部署路径含中文（如 `<中文目录>\开发\…`），工具链在重写 JSON 时按非 UTF-8 编解码 | **部署路径必须是纯 ASCII**；开发路径可含中文，但安装/部署目录不可 |

---

### D1 · `ctx.get()` 在 `apply()` 里拿不到服务

**症状**：插件装载成功、日志正常、路由都注册了，但每个入站请求都返回 `401 unauthorized`，而且**没有任何更具体的诊断信息**。加日志后发现 `ctx.get('credentials')` 是 `undefined`。

**根因**：Cordis 的服务激活是**按 `inject` 列表驱动的**。`apply(ctx)` 执行时，只有 `inject` 里列出的服务保证已激活；其余服务（`credentials` / `subagents` / `tools` / `webServer` / `llm`）此刻可能还没出现在组合里。把 `ctx.get('credentials')` 的结果**存进闭包变量**，等于把"此刻还是 undefined"这个事实永久钉死。

**修法**（`src/index.ts:104-114` 有完整注释）：

```ts
// ❌ apply() 里抓一次就存起来
const credentials = ctx.get('credentials')   // undefined，且永远是 undefined

// ✅ 方案 A：每次调用时惰性取
const credentialsNow = () => ctx.get('credentials') as CredentialsLike | undefined

// ✅ 方案 B：声明式等待服务就绪，回调里取
ctx.inject(['tools'], () => {
  const tools = ctx.get('tools') as ToolsLike   // 到这里一定已激活
})
```

**关键取舍**（这条容易做反）：

- **不要**把 `credentials` / `tools` / `subagents` 加进静态 `inject`。硬 inject 一个 profile 可能永不提供的服务，会让**整个插件永久 pending**（不是报错，是永远不启动）。
- 正确形态是：静态 `inject` 只放**真正硬依赖**（本项目只有 `['agents']`），其余用 `ctx.inject([...])` 按需进入，或用惰性 `ctx.get()` 优雅降级。
- 已验证位置：`src/index.ts:231`（`webServer`）、`:378`（`subagents`）、`:395`（`tools`）。

---

### D2 · 工具必须用 `defineTool()`，否则 `type: null`

**症状**：插件装载正常、工具名在列表里可见，但**每一次 LLM 请求都被 provider 拒绝**。错误信息通常指向 `parameters` 的 schema 非法，而报错位置在 provider 侧，看起来像"网络/鉴权问题"，极难联想到工具定义。

**根因**：DSH 工具的 `parameters` 必须是真实的 JSON Schema。手写一个 `{ name, description, parameters }` 对象、但 `parameters` 里没有 `type: 'object'` 包装时，序列化出去会变成 `type: null`。provider 的严格校验会拒绝**整个请求**（不是跳过这个工具）—— 所以症状是"什么都调不了"。

**修法**：一切工具都走 `@deepseek-ai/dsh-tools` 的 `defineTool()`。
`src/outbound/tools.ts:7` 的注释已经把这条钉死了，`:62` / `:107` / `:134` 三个工具都用它。

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'

const tool = defineTool({
  name: 'a2a_call',
  description: '…',
  parameters: Schema.object({ contact: Schema.string().required() }),
  execute: async (args) => { /* … */ },
})
```

**自检**：`src/dsh-ambient.d.ts:20` 声明了 `defineTool` 的形状 —— 这个环境声明是**手写的**，它不是 DSH 提供类型的地方。工具定义改完，唯一可靠的验证是**发一次真实 LLM 请求**，不是 `tsc`。

---

### D3 · `session.events` 不存在，必须 `snapshotEvents()`

**症状**：A2A 任务正常结终态、状态是 `COMPLETED`，但回复正文永远是 `(no text reply on this turn)`。会话 UI 里明明有内容。

**根因**：真实的 DSH session 对象**没有 `.events` 属性**。它有 `snapshotEvents(fromSeq?, toSeqExclusive?)` 和 `ownEvents()`。读 `.events` 得到 `undefined`，`collectReplyText()` 于是永远收集到空字符串 —— 不抛错、不告警。

**修法**（`src/inbound/executor.ts:40-60`）：统一走适配器，不要在任何地方直接读 `.events`。

```ts
export function readEvents(session: SessionLike | undefined): readonly unknown[] {
  if (session === undefined) return []
  if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
  if (typeof session.ownEvents === 'function') return session.ownEvents()
  return session.events ?? []          // 只为更老的构建兜底，不是主路径
}
```

**为什么用适配器而不是直接调 `snapshotEvents`**：这是**跨版本 seam**。不同 rc 暴露的方法名不同，硬写一个方法名会在升级时直接崩；探测式适配器降级而非崩溃。这与 T4「升级逐 seam 核对」是同一个约束的两面。

---

### D4 · 创建 agent 必须传 `agentOptions`，否则 `{{model}}` 无法解析

**症状**：`SendMessage` 返回 200，任务也是终态，但**没有任何回复**；日志里是
`prompt variable "{{model}}" has no value for this assembly (section "deployment:persona-prefix")`，
失败发生在 turn 的**第 1 步**。

**根因**：DSH 的系统提示里含 `{{model}}` 模板变量，由 agent 的 `agentOptions` 填充。`agents.create()` 不传 `agentOptions` 时没有被绑定的模型，模板变量无值 → 组装期直接失败。**因为失败发生在组装期而不是执行期，它不会以异常形式冒出来**，看起来像"agent 没说话"。

**修法**（`src/inbound/executor.ts:105-115`、`:328-335`）：

```ts
const handle = await this.options.agents.create({
  sessionId,
  meta: { cwd },
  agentOptions: { provider, model },   // 必须显式绑定
})
```

**配套纪律**：没有模型时**先拒绝请求，不要创建 agent**（`src/inbound/executor.ts:202-208`）。否则会在 DSH 里留下一个空白、误导性的会话 —— 用户看到"有会话"但里面什么都没有，比直接报错更难查。

**产品化口径**：本项目把这个错误码定为 `-32603`（不是 `-32602`）：请求本身合法，**服务端没配置**。错误消息直接指示"去插件页选模型"，因为能修这个问题的人坐在 GUI 前面，不一定是发请求的 peer。见 [README.zh-CN.md](../README.zh-CN.md) 的「模型选择」一节。

---

### D5 · `endReason` 默认 `undefined` → 成功轮次被判成 CANCELED

**症状**：一轮完全正常的对话，对端收到的状态是 `TASK_STATE_CANCELED`。本地日志一切正常。

**根因**：`src/types.ts:83-86` 的映射是

```ts
if (endReason === undefined) return 'TASK_STATE_CANCELED'
if (endReason === 'error') return 'TASK_STATE_FAILED'
if (endReason === 'cancelled' || endReason === 'canceled') return 'TASK_STATE_CANCELED'
```

`undefined` → CANCELED 这条分支是**为"消息在准入阶段被丢弃、根本没开始"**设计的。如果实现里把 `endReason` 声明成 `let endReason: string | undefined`（不初始化）然后走正常路径，就会命中这条兜底分支。

**修法**（`src/inbound/executor.ts:219-223`）：默认值必须是 `'stop'`。

```ts
let endReason: string | undefined = 'stop'   // 默认正常完成
```

**为什么这个坑危险**：它是"**错得看起来对**"—— 状态是合法枚举值、HTTP 200、任务结终态，链路全绿。只有读 `metadata.dsh.stopReason` 才能看出真相，而 peer 一般不会读。

---

### D6 · turn 失败时 `whenIdle()` 正常返回 → 谎报 COMPLETED

**症状**：agent 内部失败（实际观察到的是 `[TRANSPORT] DeepSeek Messages transport failed`），`whenIdle()` **正常 resolve**、不抛异常，任务被报成 `TASK_STATE_COMPLETED`，正文为空。**peer 完全无法察觉这是一次失败**。

**根因**：`whenIdle()` 的语义是"agent 不再忙"，**不是"turn 成功了"**。turn 的真实结局只写在 `turn/end` 事件的 `data.outcome` 字段里。

**修法**（`src/inbound/executor.ts:256-264` + `src/constants.ts:52-65`）：结算前读 `turn/end`：

```ts
const events = readEvents(agent.session)
if (endedWithError(events, baseline)) endReason = 'error'
```

**必须只看 `baseline` 之后的新事件**。否则同一会话里上一次失败会让之后**每一次成功**都被判成失败 —— 这是同一处逻辑的镜像陷阱，`src/inbound/executor.ts:368-374` 的注释专门写了。

**同源的第三个坑（一起记住）**：`whenIdle()` 还可能**在 turn 真正开始之前**就 resolve。此时事件流还没增长，回复会被从"空的尾巴"里收集。本项目的处置是给一个**有界宽限期**（`:234-247`）：先等事件数超过 baseline，再等一次 idle；宽限期有上限，所以真正的空 turn 仍会完成而不会挂死。

---

### D7 · `plugins.row.config` 的 key 形态是 `<清单名>#<row id>`（issue #55）

**症状**：插件装好了、功能正常，但**插件页里没有配置入口**。控制台无报错、无警告、无诊断 —— 它只是**不渲染**。

**根因**：插件页行的注册 key 是 `<清单里的名字>#<row id>` 两段式，**两部分都不是猜得出来的**：

- 清单名可能是裸包名（`dsh-a2a-bridge`），也可能是 Loader 条目 id 的 `include:` 包装形态（`include:a2a-bridge`）；
- row id 来自本包 `cordis.patch.yml` 里那个 `id`。

拼错（少 `#<row id>`、或用错名字拼写）→ 查不到 → **静默无界面**。

**修法**（`src/client.ts:64-87`）：把每一种可能的拼写都注册一遍。这**不是冗余 hack** —— 每个 key 一个单元格，多注册是 shadowing-free 的，比赌某一种拼写安全。

```ts
const SLOT_KEYS = [
  `${PACKAGE_NAME}#${ROW_ID}`,
  `include:${ROW_ID}#${ROW_ID}`,
  PACKAGE_NAME,
  `include:${PACKAGE_NAME}`,
]
```

**注意双写风险**：`ROW_ID` 必须等于 `cordis.patch.yml` 的 `id`，这是**两处必须同步**的值，而目前没有门禁保护。已记录在 [standards-audit.md](standards-audit.md) 的 **H2**，建议补一条脚本门禁。

---

### D8 · `tsconfig` 需要 `moduleDetection: "legacy"` 才能产出 classic-script 的 `client.js`

**症状**：插件页白屏 / 客户端逻辑完全不执行，浏览器控制台是
`Uncaught SyntaxError: Unexpected token 'export'`。

**根因**：`src/client.ts` 是**浏览器 classic script**（它不是 ESM，靠 `ctx.slots` 的懒工厂注册）。但项目是 `"type": "module"`，在 `module: NodeNext` 下 TypeScript 会把**没有 import/export 的 `.ts` 也当模块**，emit 时追加 `export {}` 使其成为 ESM。classic `<script>` 无法解析 → 整个客户端文件不执行。

**修法**（[`tsconfig.json:8-16`](../tsconfig.json#L8)）已生效，**不要改回去**：

```jsonc
"moduleDetection": "legacy"   // 按 import/export 判定，client.ts 因此产出 classic script
```

本项目其他文件都有真实 import/export，不受影响。

**验证方式**：`tsc` 绿了不代表这条对。要看产物：

```powershell
Select-String -Path lib\client.js -Pattern '^export'
# 必须没有任何命中；有命中说明又变回 ESM 了
```

---

### D9 · 中文路径（`开发`）会被 DSH 重写 `package.json` 时编码破坏

**症状**：安装时 `package.json` 被 DSH 重写后**编码损坏**（出现乱码或非法字节），随后插件装载失败、或插件页元数据（`meta.title` / `meta.description`）显示为乱码。

**根因**：DSH 安装/装配流程会**重写 `package.json`**。当部署路径含非 ASCII 字符（如中文目录名 `开发`），工具链在读取-重写 JSON 时按非 UTF-8 编解码，把路径回写进文件时破坏编码。这是**工具链层面的编码假设问题**，不是本项目代码的 bug —— 所以改代码修不掉。

**修法**：

1. **部署目录必须是纯 ASCII**。开发目录可以含中文（`<你的开发目录>\dsh-a2a-plugin` 是常见情形），但**安装目标**必须是 ASCII，例如 `<安装目录>` 或 `<安装目录>`。
2. `package.json` 里不要出现任何非 ASCII 值（本项目已满足）。
3. 中文**内容**可以放在 `locale/*.json` 里 —— 那是数据文件，不参与 `package.json` 重写。
4. 跨机部署时，用 `dsh plugin add file:<ASCII 路径>`，别直接把中文路径的检出目录当部署目录。

**判据**：装完后 `Get-Content package.json -Raw | ConvertFrom-Json` 能成功；若失败或中文变问号，就是这个坑。

---

## 9. 已移除的通道（模型选择）

### `$DSH_HOME/a2a-bridge/selection.json` —— 已删除

- **症状**：按旧文档去 `$DSH_HOME/a2a-bridge/selection.json` 找模型选择，文件不存在；或按旧说明手工创建该文件，插件**完全不读**。
- **现状**：`selection.json` 通道**已移除**。`createSelectionStore()`、`selectionFilePath()` 以及 `src/constants.ts` 里的 `SELECTION_FILE_NAME` / `SELECTION_DIR_NAME` 一并删除；配置**统一写 profile patch**（插件自己的 `inbound.agent` 字段，经 DSH 的 `settings` 服务写入）。
- **修法**：不要创建、迁移或备份该文件。选模型只有两个入口 —— 插件页配置卡片（推荐）或 `cordis.patch.yml` 里的 `inbound.agent` —— 两者写的是**同一个字段**。
- **为什么删**：一个决定只能有一处存储。私有文件既不在 `cordis.patch.yml`、也不在 Settings 页面里可见，还会**压过** YAML pin，导致"页面显示 A、实际跑 B"，以及支持时答不出"配置到底在哪"。
- **保留项**：`resolveDshHome()` 仍在（`resolveWorkspaceRoot()` 用它派生默认工作区根 `<DSH_HOME>/a2a-workspaces`），`createSettingsSelection()` / `resolveProfileEntryId()` / `completeSelection()` / `AgentSelection` 也都在。


## 10. 「浏览…」弹出应用内目录列表，而不是系统对话框（正常现象，非插件缺陷）

- **症状**：插件页点「浏览…」，出现的是一个可逐层点击的目录面板（含「上一级」「使用此目录」），而不是 Windows 的文件夹选择框。
- **这不是本插件的 bug**：插件优先调用宿主的 `remote.directoryPicker.pick()`，系统对话框由**宿主侧的 native 后端**提供。宿主挂了哪个后端，插件就只能用哪个。
- **实测证据**（`<DSH_HOME>/../logs/host/*.log` 的 `plugin.snapshot` 里能看到实际挂载项）：

  ```
  include:directory-picker                          @deepseek-ai/dsh-host-directory-picker-auto
  include:desktop-directory-picker-browse-host      @deepseek-ai/dsh-host-directory-picker-browse
  include:desktop-directory-picker-browse-surface   @deepseek-ai/dsh-client-ui-directory-picker-browse
  ```

  即：`auto` 在启动时**选择了 `browse`**，native 后端与 native 前端都没有被挂载。
- **`auto` 的判定规则**（决定它选谁）：

  ```js
  if (allowsRemoteAuthorities || !isLoopbackHost(bindHost)) return 'browse'
  if (ssh) return 'browse'
  if (platform === 'win32' || platform === 'darwin') return 'native'
  ```

  其中 `allowsRemoteAuthorities = trustedHosts.some(isRemoteAuthority)`，而 `trustedHosts` 的 schema 默认是 `[]`；`isLoopbackHost()` **只解析 IP 字面量**（`127/8`、`::1`），不接受主机名。
- **已排除 / 未确定（据实标注，不做推断）**：

  | 判定条件 | 结论 | 依据 |
  |---|---|---|
  | `!isLoopbackHost(bindHost)` | **已排除** | `dsh-plugin-desktop` 的 `desktopWebServerHost()` **恒返回 `'127.0.0.1'`**（且对 `ctx.webServer.host` 有抛错断言），即 bindHost 一定是回环 IP 字面量 |
  | `ssh` | 很可能排除 | 插件的宿主进程无任何 `SSH_*` 环境变量；但 `launchedThroughSsh()` 读的是启动快照，无法从外部完全确认 |
  | `allowsRemoteAuthorities` | **未确定** | `trustedHosts` 在桌面侧由「启动器 LAN 快照 ∪ profile 显式项」合并（`webRuntimeTrustedHosts`），该合并点的代码看起来**不按 `networkExposure` 门控**；但实际合并结果无法从磁盘读出 |
  | `platform` | win32 | 确定 |

  用一个伪造 `Host` 头的请求去试探 Host 栅栏是**无效证据**：GUI 在栅栏之后还有浏览器鉴权，任何 Host 都返回 403。
- **修法（两条，取舍不同）**：
  1. **接受它**（推荐）：应用内面板已支持**直接输入绝对路径回车跳转**，不必逐层点击；工作区与任务记录两个字段共用同一个面板。
  2. **换成 native**：在 profile 组合里覆盖 picker 行，让 native 后端起效。**这条路不需要先搞清 `auto` 为何选了 browse**——直接挂 native 即可。代价：native 会在**主机**上弹窗，若该部署允许远程浏览器连入，这会成为一个可被远端触发的弹窗面。
- **不要**把「弹的是面板」判断成插件未检测到 picker：探针名 `remote.directoryPicker` 与方法 `pick` / `list` / `createDirectory` 都已核对过，是正确的。
- **一条方法论教训**（值得留在文档里）：本节的初稿曾写「最可能是 host 不是 IP 字面量」，随后被 `desktopWebServerHost()` 的实现直接推翻。**"最可能"不能当证据**——没查到实现就不要写结论，写"未确定"。



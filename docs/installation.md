# 安装与部署

> 目标读者：要在两台（或多台）局域网机器上把 DSH 用 A2A 连起来的运维/开发者。
> 先读 [README「当前状态」](../README.zh-CN.md#当前状态诚实版) 与 [troubleshooting](troubleshooting.md)。

---

## 0. 先看清一件事：本地可构建，但真机未联调

`package.json` 里 `main` 指向 `./lib/index.js`，`dsh.bundle.patch` 指向 `./cordis.patch.yml`，两者现在都已就位：

- 依赖已安装（`node_modules` 存在），构建产物已生成（`lib/` 下 **20 个 JS**）；
- 插件入口 `src/index.ts` 与 bundle 装配 `cordis.patch.yml` 已落地，入站监听器 `src/inbound/server.ts`、会话镜像 `src/session/events.ts` 也已实现；
- 本地门禁实测通过：`tsc --noEmit` exit 0、`vitest run` **193 passed / 193**（9 个 spec 文件，含 wire 集成测试）、`tsc -p tsconfig.build.json` exit 0、`verify:exports` ✓、`verify:version` ✓。

仍有一件事**没做**：

1. `192.168.1.10` ↔ `192.168.1.11` 的**真机联调尚未进行**（`tests/mesh` / `tests/live` 也还没有可执行用例）。

所以本文档现在可以当作**可执行的安装路径**，但"装完必然互通"仍不是承诺。


---

## 1. 前置条件

| 项 | 要求 | 怎么核对 |
|---|---|---|
| DSH 版本 | `engines.dsh: >=0.2.1-rc.2 <0.3.0` | `dsh --version`；本机实测 `0.2.1-rc.2`，远端 `192.168.1.11` 为 `0.2.1-rc.3` |
| Node | `>= 22.19.0` | `node -v` |
| 协议版本 | **两端都必须是 A2A v1.0** | v0.3 不是别名关系，混用会静默失败或报错位置远离根因 |
| 网络 | 两台机器同网段、可互 ping；**A2A 端口（默认 `3081`）已放行** | `ping 192.168.1.11`；防火墙见 §6 |
| 时钟 | 两台机器 NTP 已同步 | `w32tm /query /status`（Windows）/ `timedatectl`（Linux） |
| 凭据 | 每个 peer 一个 32 字节随机 token，存进 `ctx.credentials` | 见 §5 |
| 远端权限 | 能在**两台**机器上执行部署与重启 | 只读访问不够：要能启动/重启对端的 DSH 进程。仅能读文件时联调无法完成 |

> **时钟不是形式主义**：卡片验证依赖时间窗口，偏差会让卡片在验证方看来 `expired`。真实机器上看到 `expired`，第一怀疑对象是 NTP。

---

## 2. 依赖安装与构建（源码安装路径）

在仓库根目录：

```powershell
# 首次：用国内镜像安装。npm 官方源对 typescript 会持续 ECONNRESET。
npm install --registry=https://registry.npmmirror.com

npm run typecheck       # 必须是独立门禁：Vitest 不做类型检查
npm run build           # 产出 lib/
npm run verify:exports  # 产物契约：exports 指向的文件真实存在
npm run verify:version  # 版本一致性
npm test                # vitest run
```

关于 lockfile：`npm ci` **要求已有 `package-lock.json`**。仓库不随源码提交 lockfile（当前工作副本里的 `package-lock.json` 是本地 `npm install` 生成的），所以全新检出后**第一次必须用 `npm install` 生成它**（同时生成 `node_modules`），之后才可以用 `npm ci` 做可复现安装。用镜像安装时，`npm ci` 也要带上同样的 `--registry`。

预期产物（实测）：`lib/` 下 **20 个 JS**；`verify:exports` 报告 **6 个 exports 目标全部存在**。

三个必须知道的构建事实：

1. **`tsc` 报错仍会 emit**。用 `&&` 串联时，`tsc` 非零退出会中断后续步骤，导致发布产物**缺文件**。所以 `typecheck` 与 `build` 要分开看结果，不要只信"命令跑完了"。
2. **Vitest 全绿不等于类型正确**。`test` 通过不能替代 `typecheck`。
3. **协议层零依赖**（`src/protocol/**` 只依赖 `constants`/`types`），可以脱离 DSH 单独 `node --input-type=module` 验证；但 `pnpm peers check` 和独立 `node import(...)` **不是**插件加载测试 —— 它们不走 DSH 的 runtime module resolver。


---

## 3. 安装：两条路，都必须落到「两个位置」

安装这件事最容易无声失败，因为它牵涉**两个独立的位置**，只改一个通常**不报错**：

| 位置 | 作用 | 只改它的后果 |
|---|---|---|
| profile 的 `dependencies` | 让包管理器把**代码**装进这个 profile | 包被下载，**但从不装配**：路由、工具、会话全都不存在，通常无任何报错 |
| `dsh.profile.bundles` | 告诉 DSH **装配**这个 bundle（执行 `cordis.patch.yml`） | 指向一个没装上的包 → 启动报错，或被静默跳过 |

一句话记法：**`dependencies` 决定"代码在不在"，`bundles` 决定"装不装上去"。** 两者缺一不可。

> 注意 `bundles` 不是本插件的自定义字段，而是 DSH profile 的标准结构。`package.json` 里的 `dsh.bundle.patch` 只是告诉 DSH"装配我时读哪个 patch 文件"，真正**决定是否装配**的是 profile 的 `bundles`。

**改完必须重启 `dsh`；新增的工具要开新会话才可见。**

### 3.0 选择安装方式

| 方式 | 适合 | 是否自动处理两个位置 |
|---|---|---|
| **插件页安装**（GUI） | 用户在本机 DSH 里日常使用 | ✅ DSH 同时写 `dependencies` 与 `bundles` |
| **`dsh plugin` CLI** | 脚本化、隔离 profile 验证 | ✅ 同上 |
| **手工改 profile** | 排障、理解机制 | ❌ 两个位置都要自己改 |

下面 3.1 讲插件页（用户最常用），3.2 讲隔离 profile 与 CLI，3.3 讲手工改（排障用）。

### 3.1 在本机 DSH 的插件页里安装 / 卸载

适合"插件就装在这台机器的 DSH 里、我自己用"的常态场景。

**安装**

1. 启动本机 DSH（Desktop 直接打开即可，**不要**自己另起一个 server —— GUI 的 URL 由 DSH 决定）。
2. 打开 Web GUI → 侧边栏进入**插件**页（插件管理器；不同版本可能叫「插件 / Plugins」，条目可能标为「Bundle / 套件」）。
3. 安装这个包：
   - 来自本地目录：选择"从本地路径 / 目录安装"，指向**本仓库根目录**（该目录里必须有 `package.json` 与 `cordis.patch.yml`）；
   - 来自 npm 规格：填入 `<包名>@<精确版本>`（例如 `dsh-a2a-bridge@0.1.0`）。
4. 安装后确认三件事，缺任何一件都算没装好：
   - 插件列表里出现 `dsh-a2a-bridge`，且**有标题与描述**（来自 `locale/*.json` 的 `meta.title` / `meta.description`）；若显示成包名或描述为空，说明 locale 资源没被读到。
   - 该行有**配置入口**（齿轮/展开）。如果没有，去看 [troubleshooting](troubleshooting.md) 的 **D7** —— 这是 key 形态错，且不会报错。
   - 状态为**已启用**，不是 `failed`（失败）或 `overridden`（被更高优先级层覆盖）。
5. **重启 DSH**，然后开一个**新会话**验证工具可见（旧会话不会凭空多出新工具）。

**卸载**

1. 插件页 → 找到 `dsh-a2a-bridge` → 卸载（移除该 bundle）。
2. **重启 DSH**。卸载 bundle 只影响 `bundles`；若有残留，按 3.3 检查 `dependencies` 里是否还有这一条。
3. 客户端缓存：卸载后如果插件页仍有卡片残留，刷新页面（GUI 前端会重建 slot 树）。

**启用 / 停用（≠ 卸载）**

插件页的开关只切换该 bundle 的启用状态，**不卸载包**。停用后重启即不再装配，配置与 `locale` 资源都保留 —— 排障时优先用停用而不是卸载，这样能保留现场做二分定位。

> **GUI 不可用时**：以上操作在 CLI 上分别对应 `dsh plugin --profile <p> add <spec>` 与 `dsh plugin --profile <p> remove <包名>`，见 3.2。

### 3.2 先用隔离 profile 验证（不要污染 desktop）

```bash
dsh --profile a2a-test --from-default-profile web --dump-config > /dev/null
dsh plugin --profile a2a-test add <包路径或 npm 规格>@<精确版本>
dsh --profile a2a-test --port 3100 --no-open
```

- **`--profile` 必须写在 pnpm 参数之前**（DSH v0.2.1-alpha.1 起）。
- **Desktop 用 `--profile desktop`，不是 `web`**：本机 Desktop 靠工作目录选 profile，通常不传 `--profile`。
- 在隔离 profile 上跑通、确认 `/a2a` 与卡片可访问，再迁到 desktop。

### 3.3 本地路径 / Git 安装

- 本地路径：`dsh plugin --profile a2a-test add file:<仓库根目录的绝对路径>`
  - **路径必须是纯 ASCII。** 中文目录名（例如 `开发`）会在 DSH 重写 `package.json` 时破坏文件编码，导致装载失败或插件页元数据乱码 —— 见 [troubleshooting](troubleshooting.md) 的 **D9**。开发目录可以含中文，**部署目录不行**。
  - Windows 路径分隔符建议用正斜杠或双反斜杠，避免被 shell 当转义。
- Git 安装：pnpm 11 可能报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`。必须把 pnpm 打印的**完整 `allowBuilds` 条目**（含 Git source 与 resolved commit）写进该 profile 的 `pnpm-workspace.yaml`，**保留原有设置**后重跑。
  - 只允许 `dsh-a2a` 一个包**不够**；
  - **不要**全局允许所有 build scripts。

### 3.4 手工改 profile（排障用，两个位置都要改）

只在排障或需要理解机制时用。改 profile 的 `cordis.yml`：

```yaml
# 位置 ①：让包被装上
dependencies:
  dsh-a2a-bridge: link:<仓库根目录的绝对路径>   # 或 npm 规格 dsh-a2a-bridge@0.1.0

dsh:
  profile:
    # 位置 ②：让它被装配
    bundles:
      - dsh-a2a-bridge
```

两处含义不同，别混：`dependencies` 是包管理器层面的"把代码取来"，`bundles` 是 Loader 层面的"把它插进组合"。改完重启 `dsh`。

### 3.5 绝对不能动的东西

profile 生成的 `pnpm-workspace.yaml` 里这两项必须原样保留：

```yaml
nodeLinker: hoisted
autoInstallPeers: false
```

以及：**绝不要单独 `pnpm add` 任何 `@deepseek-ai/dsh-*`**。DSH 通过自己的 runtime module resolver 提供它们；单独安装会让 npm 上过期的 `latest` dist-tag 遮蔽宿主运行时，并级联出更深一层的错配（`Cannot find package '@deepseek-ai/dsh-scope'`）。peer 依赖必须是钉死版本，禁 `>=` 开放式范围。

---

## 4. 配置

完整字段表见 [README「配置」](../README.zh-CN.md#配置)。部署时必须显式设置的只有这几项：

| 字段 | 为什么必须设 |
|---|---|
| `publicUrl` | 卡片上对外公布的地址。监听绑定地址可能是 `127.0.0.1`，把它印到卡片上永远是错的 |
| `inbound.listen.host` / `inbound.listen.port` | **ADR-011 监听器地址**。`host` 必须是本机一个**具体地址**（如 `192.168.1.10`），`0.0.0.0` / `::` 等通配会在加载期直接报错；`port` 默认 `3081`，需在防火墙放行 |
| `inbound.peers` | 每个 peer 一条，值为 `{ tokenEnv: <引用名> }` —— **引用名**，不是 token |
| `outbound.contacts` | 我能访问谁：`name` + `url` + `agentCardPath` + 可选 `tokenEnv` |
| `inbound.strictVersionHeader` | 默认 `true` 时，缺 `A2A-Version` 头的请求会被 `-32009` 拒；确认对端不发头再改 `false` |

> `inbound.isolation.workspaceRoot` **不再必填**：**可省略；省略即派生 `<DSH_HOME>/a2a-workspaces`**（随包的 `cordis.patch.yml` 就是省略的 —— 它必须能在任何一台机器上通过激活期校验）。只有需要某个固定的共享根目录时才显式写，值按原样使用。

改配置的生效方式：

- `cordis.patch.yml` 在**装配时**读取 → 改完必须重启 `dsh`；
- GUI registry 是例外（保存即热重载）。

---

## 5. 凭据（ADR-005）

- 配置**只存引用名**（如 `A2A_TOKEN_PEER_B`），值放在 `ctx.credentials` 可达处。加载期校验正则 `^[A-Za-z_][A-Za-z0-9_]*$`，**粘贴 token 值会被直接拒绝**。
- 解析顺序（四层）：进程环境 → 托管文档 → `<cwd>/.env` → `$DSH_HOME/.env`。
- **每请求重新解析、不缓存** → 轮换 token 下一个请求即生效，无需重启。
- 生成 token：

  ```powershell
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  [Convert]::ToBase64String($bytes)
  ```

- 两端约定：A 的 `outbound.contacts[peer-b].tokenEnv` 指向的**值**，必须等于 B 的 `inbound.peers[peer-a].tokenEnv` 指向的**值**。引用名可以不同，值必须相同。
- 控制面凭据与 peer 面凭据**不要共用**（一条 token 泄了不该同时失去两样东西）。

> 威胁模型与更细的凭据运维（生成、轮换、per-peer 归档、审计）见 [`docs/threat-model.md`](threat-model.md) 与 [`docs/security-setup.md`](security-setup.md)。

---

## 6. 网络与传输

### 6.1 端口与绑定

A2A 走**插件自己的监听器**（ADR-011），不再使用 DSH 的 web 端口：默认 `inbound.listen.port = 3081`（避开 GUI 的 `3080`），`basePath` 默认 `/a2a`，卡片在 `/.well-known/agent-card.json`。

`inbound.listen.host` 必须是**具体地址**。两台机器的典型配置：

```yaml
# 机器 A（192.168.1.10）
inbound:
  listen: { host: 192.168.1.10, port: 3081 }
# 机器 B（192.168.1.11）
inbound:
  listen: { host: 192.168.1.11, port: 3081 }
```

Windows 放行入站（管理员 PowerShell）：

```powershell
New-NetFirewallRule -DisplayName "DSH A2A" -Direction Inbound -Protocol TCP -LocalPort 3081 -Action Allow -Profile Private
```

### 6.2 ⚠️ Desktop 形态下 `ctx.webServer` 恒绑 `127.0.0.1` —— 已由 ADR-011 解决

这不是配置问题，是实码行为（本地 `dsh-plugin-desktop` 实证）：

```js
/** The upstream HTTP origin is never exposed; LAN intent controls only the HTTPS edge. */
function desktopWebServerHost(_exposure) { return "127.0.0.1" }
```

- `networkExposure`（`loopback` | `lan`）**只控制 HTTPS 边缘**（给浏览器 GUI 用），**永不暴露上游 HTTP 源**；
- 它是 `.volatile()`，不持久化，改完**必须重启** DSH；
- `lan` 还必须同时开 `openBrowser`，否则拒绝启动。

**处置（已实现）**：插件**不挂** `ctx.webServer`，而是在 `src/inbound/server.ts` 自建 `node:http` 监听器（ADR-011），绑 `inbound.listen.host` 指定的具体地址、监听 `3081`，随 `ctx.effect` 生命周期启动/停止（`stop()` 显式 `end()` SSE、`destroy()` socket）。网关层不需要反向代理；若后续要加密，再给该监听器加载证书或前置 TLS 代理。


### 6.3 TLS

`ctx.webServer` **支持 TLS**（`createServer({cert, key}, listener)`，启动参数 `--tls-cert` / `--tls-key`）。交接文档里"webServer 不提供 TLS"的说法已被证伪。

- TLS 是**全局 webServer 配置**，不是本插件的参数 —— 插件没有 per-plugin TLS 开关；
- ADR-011 之后 A2A 端点由插件自建监听器承载，**该监听器目前没有 TLS 开关**，证书需要后续自己加载（或前置 TLS 代理）；
- MVP 默认是**明文 HTTP + 强 Bearer**（ADR-003）。升级路径：明文 → 自签 TLS → Tailscale。

---

## 7. 验收

### 7.1 卡片可读（匿名）

```powershell
curl.exe -s http://192.168.1.10:3081/.well-known/agent-card.json
```

期望：v1.0 卡片，含 `supportedInterfaces[]`（`protocolBinding: "JSONRPC"`、`protocolVersion: "1.0"`）、`capabilities`、`skills`。
不应看到 `url` + `preferredTransport` 这种 v0.3 字段。

### 7.2 JSON-RPC 可达

```powershell
curl.exe -s -X POST http://192.168.1.10:3081/a2a `
  -H "content-type: application/json" `
  -H "a2a-version: 1.0" `
  -H "authorization: Bearer <TOKEN>" `
  -d '{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{"message":{"messageId":"11111111-1111-1111-1111-111111111111","role":"ROLE_USER","parts":[{"text":"ping"}]},"configuration":{"returnImmediately":false}}}'
```

排错口径（按顺序看）：

| 现象 | 含义 |
|---|---|
| 无响应 / 连接被拒 | 根本没监听在 LAN 地址上 → 回头看 §6.2 |
| `401` + body `{"error":{"code":-32600,"message":"unauthorized"}}` | token 不匹配或凭据没解析到 |
| `403` | 认证过了，但 peer 不在 `trustedPeers` |
| `429` | 超过 `rateLimitPerMinute` |
| `413` | body 超过 `maxBodyBytes` |
| `-32009` | 版本头缺失或不接受 → 发 `a2a-version: 1.0` |
| `-32601` 且消息里提到 v1.0 替代方法 | 用了 v0.3 的点分方法名 |

### 7.3 会话可见性（ADR-007）

装好之后，发一次 `SendMessage`，然后看 DSH 侧边栏：应出现**一个**名为 `A2A` 的工作区（标题取 `session.workspaceTitlePrefix`，不再带 peer/时间戳），并出现对应的 A2A 会话行，能看到本轮进展。这是本项目的核心验收项 —— **只返回了结果但没出现会话，就是没通过**。

> 归组限制：DSH `@deepseek-ai/dsh-workspace` 0.2.1-rc.2 判定会话归属时要求 header 的 cwd **严格等于**工作区路径。本插件把会话 cwd 放在工作区**之内**（`<root>/<peer>/<session-id>`，按 peer 隔离），所以在该版本上会话会以“未分组”出现、attach 只记日志；若你的运行时版本接受“cwd 包含于工作区”，会话会归入 `A2A` 行。详见 `CHANGELOG.md` 的已知限制。

> 注意：`session/create` 类 API 只注册内存记录、不会物化会话目录。若用 API 创建会话，**必须在 GUI 里打开一次**，否则目录永远不出现、排队的 prompt 也永不被消费。优先用 GUI 创建。

---

## 8. 升级 / 卸载 / 回滚

**插件页（GUI）**：插件页里对该条目做升级/卸载，然后**重启 DSH**；详见 §3.1。

**CLI**：

```bash
# 升级（保持隔离 profile 先验）
dsh plugin --profile a2a-test add <spec>@<新精确版本>

# 卸载
dsh plugin --profile a2a-test remove dsh-a2a-bridge
```

回滚要点：

1. 同时回滚**两处**（`dependencies` 与 `dsh.profile.bundles`），否则又回到"只改一处"的静默失败；
2. 升级时**逐 seam 核对已发布包的 `lib/*.d.ts` + `lib/*.js`**，不要只看 changelog（历史事故：`isTokenDelta` 导出被移除且无替代 → 值级 ESM 导入直接导致模块加载失败）；
3. 任务状态**不跨进程重启**：重启前先让在途任务收尾，否则状态无处可查。

---

## 9. 安装核对清单

- [ ] 两端 DSH 版本都落在 `>=0.2.1-rc.2 <0.3.0`，且**同为 v1.0 协议**
- [ ] `node -v` ≥ 22.19.0
- [ ] 两台机器 NTP 已同步
- [ ] 依赖用国内镜像装好（`npm install --registry=https://registry.npmmirror.com`），且 `typecheck` / `build` / `test` / `verify:exports` / `verify:version` / `verify:no-hardcode` 各自通过（不是靠 `&&` 链"跑完了"）
- [ ] `dependencies` 与 `dsh.profile.bundles` **都改了**（插件页安装会自动处理两处；手工改必须两处都改）
- [ ] 插件页里该条目**有标题与描述**、**有配置入口**、状态是**已启用**（不是 `failed` / `overridden`）
- [ ] 装完**重启了 dsh**，且新工具在**新会话**里验证
- [ ] **部署目录是纯 ASCII**（含中文的目录会导致 `package.json` 编码损坏，见 D9）
- [ ] `inbound.isolation.workspaceRoot` 按需覆盖（**可省略**；省略即派生 `<DSH_HOME>/a2a-workspaces`）
- [ ] A2A 会话模型已选择：插件页配置里选好 provider + model，或配置里 pin 了 `inbound.agent`；否则每次 A2A 请求都会被 `-32603` 拒绝
- [ ] `inbound.listen.host` 是各自机器的**具体 LAN 地址**（不是 `0.0.0.0`、不是 `127.0.0.1`）
- [ ] `publicUrl` 是 LAN 可达地址，不是 `127.0.0.1`
- [ ] 每个 peer 的 `tokenEnv` 是引用名，值确实能从四层解析到
- [ ] 防火墙已放行 A2A 监听端口（默认 `3081`，仅 Private profile）
- [ ] `Get-NetTCPConnection -LocalPort 3081` 显示 `LocalAddress` 是 LAN 地址，不是 `127.0.0.1`
- [ ] 卡片可匿名读、JSON-RPC 可带 Bearer 调通
- [ ] 侧边栏出现 `A2A` 工作区与 A2A 会话行（ADR-007 验收；归组限制见 §7.3 注）
- [ ] `pnpm-workspace.yaml` 里 `nodeLinker: hoisted` 与 `autoInstallPeers: false` 原样保留
- [ ] 没有单独安装任何 `@deepseek-ai/dsh-*`


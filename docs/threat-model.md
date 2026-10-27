# dsh-a2a-bridge 威胁模型

> 版本：v1（MVP，明文 HTTP 阶段）
> 日期：2026-10-26
> 依据：ADR-003（LAN 加密方案）、ADR-004（发现机制）、ADR-005（认证模型）、ADR-007（会话可见性）、ADR-008（正规化开发）
> 代码基准：`src/security/index.ts`、`src/config.ts`、`src/inbound/routes.ts`、`src/outbound/client.ts`、`src/session/session-binding.ts`
> 复核触发：见 §5。**本文件不替代 ADR**；策略变更必须先写 ADR 再改代码（ADR-008「禁止就地打补丁」）。

---

## 0. 范围、资产与信任边界

### 0.1 部署形态

```
 192.168.1.10 (机器 A)                              192.168.1.11 (机器 B)
 ┌──────────────────────────────┐                  ┌──────────────────────────────┐
 │ DSH + dsh-a2a-bridge         │  http://…/a2a    │ DSH + dsh-a2a-bridge         │
 │  ├ inbound  : /a2a (Bearer)  │ ───────────────► │  ├ inbound  : /a2a (Bearer)  │
 │  ├ outbound : contacts       │ ◄─────────────── │  ├ outbound : contacts       │
 │  └ 管理/监控面（loopback）    │                  │  └ 管理/监控面（loopback）    │
 └──────────────────────────────┘                  └──────────────────────────────┘
         同一二层广播域（LAN），无 TLS（MVP）
```

### 0.2 资产

| 资产 | 说明 | 泄露后果 |
|---|---|---|
| per-peer Bearer token | 32 字节随机，经 `ctx.credentials` 引用名解析 | 完全冒充该 peer |
| 模型文本（回复 / artifact） | 我方 agent 产出的内容 | 业务与文件内容外泄 |
| peer 会话内容 | 其它 peer 的提问与输出（存于 DSH session log） | 跨身份信息泄露 |
| 本机文件系统 | `<workspaceRoot>/<peer>/` 及沙箱可见范围 | 代码/凭据外泄、被写入 |
| 模型额度与 agent 槽位 | `maxContextTurns` / `maxResidentContexts` / 上游 token 费用 | 资源耗尽（经济型 DoS） |
| 管理/监控面 | 全体访客原话的聚合视图 | 一次性泄露全部会话 |

### 0.3 信任边界（明确写死，避免"以为有"）

1. **LAN ≠ 可信网络**。ADR-003 只声明"物理边界相对可信"，不等于"同网段主机可信"。
2. **认证 ≠ 授权**（ADR-004 横向原则）：验过 token 只证明"是哪个 peer"，不证明"这个 peer 与该 task 有链接关系"；归属必须另查。
3. **`workspaceMode: per-peer` 不是路径 jail**（见 T-02），它只是"不同 cwd + 依赖 DSH 沙箱"。
4. **控制面与 peer 面凭据必须分离**（ADR-004 / T-09）。
5. **去势（defang）是降噪，不是权限边界**。任何"因为做了去势所以可以放宽 peer 权限"的论证一律无效。

---

## T-01 明文 HTTP 上的 Bearer 嗅探（ADR-003 已明确接受）

**风险描述**
MVP 走 `http://192.168.1.11:<port>/a2a`。`Authorization: Bearer <token>` 以明文经过二层网络。同网段的任何主机都可经交换机端口镜像、ARP 欺骗、被入侵主机上的抓包、或（若链路含无线）空口监听取得该头。同时被嗅探的还有**响应正文**——即模型输与 artifact 内容。ADR-003 选择明文是先验已知的取舍，不是疏漏。

**影响**
- 拿到 token 即获得该 peer 的全部能力：提交任务、读自己的 task、驱动模型消耗额度。
- 冒名 peer 的 agent **仍然**可经 `session_search` / `session_event_read` / `list_agents` 读到**其它 peer 的会话内容**——deny-list 已实现，但它是**按名字的黑名单**：一旦上游新增同语义的跨会话工具而名单未跟上，泄露面就会重新打开。这是残余风险，不是已消除项。
- 若管理面误判 loopback（T-09），冒名者还可能有二次路径。
- 归因污染：A2A 日志会把攻击行为记在受害 peer 名下。
- 轮换窗口内可重放：抓到即用，无需破解。

**缓解措施（现状 + 要求）**

| # | 措施 | 状态 | 代码坐标 |
|---|---|---|---|
| 1 | 32 字节 CSPRNG token（hex 64 字符），**每 peer 一枚**，泄露面收敛到单 peer | 由部署落实 | `config.ts:81`（只存引用名）、`docs/security-setup.md` §1 |
| 2 | 常时比较 + 长度不等也 burn 一次比较 | ✅ 已实现 | `security/index.ts:26-34` |
| 3 | 遍历全部候选、命中后不提前退出 | ✅ 已实现 | `security/index.ts:42-52` |
| 4 | 失败只回 `401 unauthorized`，不区分"无 token / 错 token / 未知 peer" | ✅ 已实现 | `routes.ts:125-140`、`routes.ts:143-146` |
| 5 | 限流（默认 60/min） | ⚠️ **类已实现、路由未接线**（见 T-07） | `security/index.ts:68-95`、`config.ts:86` |
| 6 | 不记录 `Authorization` 头；错误体不含内部细节 | 要求（需在实现日志时遵守） | `routes.ts:148-151` 只回 `internal error` |
| 7 | 只在 Windows 防火墙 `Private` 配置文件上开放单端口，`RemoteAddress` 限定 `192.168.1.10` | 要求 | `docs/security-setup.md` §5 |
| 8 | 轮换：每请求重新解析 credentials，轮换下一请求生效 | ✅ 接口就位（`resolvePeerSecrets` 每请求调用，不缓存） | `routes.ts:78-79, 130` |
| 9 | 升级路径：自签 TLS（webserver 实码支持 `cert/key`）→ Tailscale | 已备路径 | `docs/security-setup.md` §4 |

**残余风险**
**高，且被明确接受。** 上述 1–8 项都不改变"链路上是明文"这一事实：被动嗅探方在轮换窗口内仍可完整重放；模型输出正文同样暴露；token 不比"口令"更强，只是更难猜。接受主体是用户（ADR-003 拍板），记录在案。**接受的前提条件一旦破坏，必须重开 ADR——判据见 §3。**

---

## T-02 跨 peer 会话与文件访问（per-peer 不是路径 jail）

**风险描述**
`workspaceMode: per-peer` 的全部实现是：为每个 peer 解析出一个不同的 `cwd` 传给 `agents.create`。

- `session-binding.ts:73-80`：`join(root, slug(peer))`——**没有 `resolve()` 后 `startsWith(root)` 之类的越界校验**。
- `config.ts:97`：`peerWorkspaces` 的覆盖值可以是任意绝对路径（指向 root 之外是**有意支持**的：「把某个可信 peer 指到真实 repo」）。
- 真正的隔离来自 DSH 自身：沙箱范围 + 跨会话工具"按 cwd 相等性授权"。
- **跨会话工具 deny-list 已实现**（2026-10-27）。落地方式不是上游预留的 `unsafeAllowCrossSessionSearch` 逃生阀，而是 Harness 官方的 `tools.restrict()`：在 `agents.create({ setup })` 的 **agent 自己的 scoped 创建上下文**上调用 `restrict({ deny: [...] })`。这一点是硬要求——`restrict()` 收窄的是"调用方 agent scope"，若从插件根上下文调用会限制错 scope，看起来生效而对 peer 的会话毫无影响。
  - 实现：`src/inbound/tool-policy.ts`（策略逻辑）+ `src/constants.ts` 的 `A2A_DENIED_TOOLS`（名单）+ `src/inbound/executor.ts` 的 `openAgent`（挂载点）。
  - 名单（经 `cordis_inspect_query host/Tool listTools` 在真实部署上核对）：`session_search` / `session_event_search` / `session_trace` / `session_event_trace` / `session_event_read` / `list_agents` / `team_task_create` / `team_task_list` / `team_task_get` / `team_task_update`。
  - **只作用于 A2A 会话**：操作者的本地 agent 不受影响。
  - 名单是**先探测可见性再限制**：`restrict()` 对未注册的名字会失败，而失败会导致整个限制不生效（session 保持未收窄），所以只把本机真实注册的名字交给它。未注册的名字被记录为 absent，不视为错误。
  - **默认生效、不需要配置**：executor 在未注入 `deniedTools` 时使用 `A2A_DENIED_TOOLS`。
  - **best-effort 但绝不静默**：策略失败不会让 A2A 请求失败（对话仍应答），但会在日志里明确写出"未能应用"——一个"turn 成功但工具集未收窄"的会话是安全缺口，必须让人看见。

**影响**
若 DSH 版本不提供"跨会话工具按 cwd 授权"（或 peer 被指到同一 cwd，或误配 `shared` 模式），peer A 派出的 agent 可以：
- `session_search` / `session_event_read` 读到 peer B 的提问与模型输出（跨 ADR-005 身份边界）；
- `list_agents` 枚举本机全部 agent（含用户本地会话），泄露"这台机器上还有谁、在做什么"；
- fs 类工具若沙箱配置宽松，可读到 `cwd` 之外的文件（per-peer 不提供任何路径约束）。
后果是**单向静默泄露**：A2A 日志只记 peer A 的合法任务，事后无法归因。

**缓解措施**

| # | 措施 | 状态 |
|---|---|---|
| 1 | 默认 `workspaceMode: per-peer`；`shared` 只允许单 peer 部署 | ✅ 默认值正确（`config.ts:95`） |
| 2 | peer 名受 `ENTITY_NAME` 白名单（`[A-Za-z0-9][A-Za-z0-9_-]*`）约束，且 `slug()` 再兜一层，排除目录穿越 | ✅ `config.ts:21, 202-207`、`session-binding.ts:102-104` |
| 3 | 起工作目录失败即**拒绝请求**，绝不静默降级到共享目录 | 要求（实现 `ensureWorkspace` 时照做） |
| 4 | 沙箱收紧：`permission` 预设 + `sandbox-policy` 同时收紧；A2A agent 一律 `approval/policy: never`（无人值守，确定性拒绝审批） | 要求（参考 research/05 §9.3） |
| 5 | **实现跨会话工具 deny-list**（上面 6 个工具 + `team_task_*`） | ✅ **已实现**（`tool-policy.ts` + `A2A_DENIED_TOOLS` + `executor.openAgent`）。未采用上游的 `unsafeAllowCrossSessionSearch` 逃生阀，改用官方 `tools.restrict()` 作用于 agent 自己的 scope |
| 6 | 加载期拒绝危险组合：`workspaceMode: shared` 且 `peers` 数量 > 1 | ❌ 未实现（建议加进 `assertConfigCoherent`） |
| 7 | 部署审阅 `peerWorkspaces` 的每个绝对路径；在 README Boundaries 声明"指向 root 之外 = 放弃路径隔离" | 要求 |

**残余风险**
**中-高。** 即使完成第 5、6 项，`peerWorkspaces` 仍可把 peer 指到真实 repo，此时 A 能改 B 的代码目录（属于有意的运维便利，但必须在部署文档里显式承认）。此外 fs 工具的路径能力由 DSH 沙箱决定，本插件无法复核——"沙箱真的生效"必须靠实机验证，不能靠文档假设。

---

## T-03 出站 SSRF（本场景**要允许**局域网私有地址）

**风险描述**
出站侧有两条 fetch：`client.ts:41-57`（抓 Agent Card）与 `client.ts:143-147 / 192-197 / 244`（JSON-RPC 与 SSE）。当前**没有任何地址策略**：
- `discoverCard` 用 `redirect: 'follow'`（`client.ts:52`）——重定向可把请求带到任意目标，**且只校验首跳是无效的**；
- `fetchWithTimeout`（`client.ts:270-282`）只做超时，不做 scheme/host/port 校验。

**这里不能照抄"兜底拒绝私有地址"。** 本场景的对端就是 `192.168.1.11`，兜底拒绝会直接把功能打死。正确策略是：

> **默认允许 RFC1918 / ULA LAN 段 + 显式禁止链路本地与云元数据地址。**

需要显式禁止的目标：

| 目标 | 原因 |
|---|---|
| `169.254.169.254` | 云实例元数据（AWS/GCP/Azure 通用地址）——拿到即等于拿到实例凭据 |
| `169.254.0.0/16` | 链路本地整段，含各种设备管理面 |
| `fe80::/10` | IPv6 链路本地 |
| `::1`、`127.0.0.0/8` | 回环上的本地服务（如本机 GUI `127.0.0.1:43120`、DSH 上游 HTTP 源） |
| `0.0.0.0`、`::` | 未指定地址，行为依平台而异，一律拒绝 |
| 非 `http/https` scheme | `file:` / `gopher:` 等 |
| URL 内含 userinfo（`user:pass@`） | 凭据混淆 + 部分解析器差异 |

**影响**
- 元数据地址可达 ⇒ 读实例凭据，且结果可经 task artifact **回显给远端**（把 SSRF 变成可回读的内网探测通道）。
- 回环可达 ⇒ 远端可借用我们的进程身份访问本机管理面/监控面（与 T-09 叠加）。
- 重定向可达 ⇒ 攻击者只需在远端放一个 302，即可绕过任何"只校验配置里的首跳 URL"的检查。
- 出站请求携带我方 Bearer（`authHeaders`，`client.ts:106-108`）⇒ 重定向还可能把**我方 token** 送到第三方主机。

**缓解措施**

| # | 措施 | 状态 |
|---|---|---|
| 1 | contacts 只来自**静态配置**（ADR-004），协议里没有"peer 提供 URL"的入口 | ✅ 结构性防线（`config.ts:116-125`） |
| 2 | 地址策略：默认允许 LAN，显式 deny 上表；scheme 限 `http/https`；拒绝 userinfo | ❌ 未实现（任务项） |
| 3 | `redirect: 'manual'` + **逐跳复检**（每跳都跑一次地址策略），而不是 `follow` | ❌ 当前是 `follow` |
| 4 | DNS 解析后再校验 IP，并把**已验证的 IP 钉住**（防 DNS rebinding 把校验与连接拆到两次解析） | ❌ 未实现 |
| 5 | 端口白名单（按部署实际端口，如 43120），减少横向扫描价值 | ❌ 未实现 |
| 6 | 请求超时已有（`fetchWithTimeout`），防止长挂 | ✅ |

**残余风险**
**策略实现前：高；实现后：中。** 允许 LAN 的代价就是"被委派的 agent 有受限于 LAN 的探测能力"——它仍可访问 `192.168.1.x` 上的其它 HTTP 服务（如某台机器的管理页），并可能在响应中留下痕迹。这是本场景为了可用性主动接受的能力，不应通过"再拒绝私有地址"来消除，而应通过端口白名单 + 静态 contacts + 出站日志来收敛。

---

## T-04 提示注入：去势（defang）vs 直接拒绝

**风险描述**
peer 的 `message.parts[].text` 会进入我们的模型上下文。远端（或其上游模型）可嵌入 ChatML 标记、伪系统消息、角色前缀、工具调用引导、"忽略以上指令"类措辞，诱导我方 agent 做它本不该做的事：读 cwd 之外的文件、发起更多出站请求、把其它 peer 的内容带出、或在 artifact 里夹带密钥。

**影响**
后果完全取决于 agent 的权限面，而非注入文本本身：
- 有跨会话工具（T-02 未收敛）⇒ 读到其它 peer 会话；
- 有出站能力（T-03）⇒ 变成内网探测器；
- 能读 `.env` / 环境（T-05）⇒ 密钥外流。
所以注入是"放大器"，真正决定损失的是权限面。

**取舍：为什么是去势，不是拒绝**

| 维度 | 直接拒绝（reject） | 去势（defang） |
|---|---|---|
| 误杀率 | **高**。合法内容里出现 `system:`、`<\|im_start\|>`、代码片段里的角色名非常常见；对端在**转述第三方文本**时更甚，而这正是 A2A 的核心用法之一 | 低，只替换可疑片段为 `[filtered]` |
| 可观测性 | 对端拿不到细化原因（A2A 无对应错误码），排障成本高，容易变成"两台机器互相 400"（BUG 循环） | 任务继续，双方都能看到被替换的位置 |
| 安全收益 | 略高（直接不执行） | 略低（仍可能被纯语义说服） |
| 组合性 | 与"转述/中继"场景冲突 | 与 `sanitizeOutbound` 对称，易统一 |

**决策：去势。** 与 huangjuhua-aigc/dsh-a2a 一致。但必须原样保留它的立场声明：

> 去势在这里是 **noise reduction（降噪）**，**绝不可**被引用来论证"因此可以放宽 peer 驱动的 agent 的权限"。

**缓解措施**

| # | 措施 | 状态 |
|---|---|---|
| 1 | inbound 在进入模型前做 `filterInbound`（7 条正则：ChatML / 角色前缀 / override 措辞，替换为 `[filtered]`） | ❌ **当前 `src/security` 无此函数，未实现**（属 inbound 层职责，不得塞进 `security/index.ts` 的既有导出之外就地硬改） |
| 2 | 沙箱 + 最小工具集 + `approval/policy: never`（确定性拒绝审批，不等一个没人看的人机确认） | 要求 |
| 3 | 不把 peer 文本拼进 system prompt；不把 peer 文本当配置/路径输入 | 要求（实现 dispatch 时遵守） |
| 4 | 跨会话 deny-list（T-02） | ✅ **已实现**（`src/inbound/tool-policy.ts`）：`tools.restrict()` 作用于 A2A 会话自己的 agent scope，默认生效 |
| 5 | 出站 `redactSecrets`（T-05）作为"已被诱导后的最后一道拦截" | ✅ `security/index.ts:117-121` |
| 6 | artifact 与 diagnostic 同样过 `sanitizeOutbound` | 要求（目前文本主路径已过：`client.ts:163,170,204`） |

**残余风险**
**中-高，且不可消除。** 自然语言注入没有正则可穷举；去势只能挡"模板化"标记，挡不住语义级说服。真正的兜底是权限面收窄（沙箱 + deny-list + 最小工具集 + 确定性拒绝审批），不是过滤。任何"提高过滤覆盖率"的努力都不应替代权限面工作。

---

## T-05 出站密钥泄露：`redactSecrets` 的覆盖与遗漏

**风险描述**
我们是"模型文本出境"的一侧。模型完全可能读到（或在上下文里拼出）密钥：`.env`、日志、配置、错误栈。一旦随回复或 artifact 出境，就落到对端机器的会话日志里，长期留存。

**现状（`security/index.ts:107-121`，7 条正则）**

| # | 正则 | 覆盖 |
|---|---|---|
| 1 | `sk-[A-Za-z0-9_-]{16,}` | OpenAI / DeepSeek / Stripe `sk_live_` 等（同时会吃掉 `sk-ant-`） |
| 2 | `sk-ant-[A-Za-z0-9_-]{16,}` | Anthropic（第 1 条已能命中，此条为显式冗余，可读性优先） |
| 3 | `gh[pousr]_[A-Za-z0-9]{16,}` | GitHub PAT / OAuth / app token |
| 4 | `xox[baprs]-[A-Za-z0-9-]{10,}` | Slack |
| 5 | `AKIA[0-9A-Z]{16}` | AWS access key id（**仅 id，不含 secret**） |
| 6 | `eyJ…18+`.3 段 | JWT |
| 7 | `Bearer\s+[A-Za-z0-9._-]{16,}` → `Bearer [redacted]` | 明文 Bearer 头 |

调用点：`sanitizeOutbound`（`security/index.ts:139-141`）= `wellFormed(redactSecrets(text))`，出站文本路径全部经过它。

**遗漏（必须逐条写清，别指望它兜住）**

1. **我们自己的 per-peer token（64 hex）不匹配任何一条**——没有前缀。这是与本项目最相关的一条：A2A token 若出现在 agent 可见环境里，redact 拦不住。
2. AWS **secret access key**（40 字符，无前缀）——不覆盖。
3. Google API key `AIza[0-9A-Za-z_-]{35}`、npm `npm_[A-Za-z0-9]{36}`、HuggingFace `hf_…`、PyPI `pypi-…`——不覆盖。
4. **PEM 私钥块**（`-----BEGIN … PRIVATE KEY-----`）——不覆盖。
5. Basic auth 的 base64（`Authorization: Basic …`）、`password=` / `passwd=` / `token=` / `secret=` 键值对——不覆盖。
6. **短于 16 字符的 token** 与自定义格式——刻意不覆盖（避免大面积误伤），但意味着弱口令/短 token 会直接出境。
7. 分隔符变体：`Bearer` 后的 token 若含 `/`、`+`、`=`、`:`（标准 base64），第 7 条**不命中**。
8. 正则作用于"看起来像密钥"的字符串：语义化描述（"我把 API key 放在 A2A_PEER_ALICE 里"）不拦。

**影响**
单次泄露即长期有效凭据外泄，且落在对端可读的会话日志中；对端若再被嗅探（T-01）则二次扩散。若泄露的是 A2A peer token，等于把 T-01 的影响直接送上门。

**缓解措施**

| # | 措施 | 状态 |
|---|---|---|
| 1 | 已有 7 条正则 + 统一出口 `sanitizeOutbound` | ✅ |
| 2 | **密钥对模型不可见**：不进 cwd、不进 `<cwd>/.env`（agent 沙箱可读），只用 `$DSH_HOME/.env` 或进程环境（research/05 §9.9） | 要求（第一优先，治本） |
| 3 | 补 64-hex 高熵启发式（需 UUID / commit hash 白名单防误伤） | ❌ 待做 |
| 4 | 补 PEM 块、Google `AIza`、npm、`Basic`、`xxx=` 形式 | ❌ 待做 |
| 5 | 记录"命中计数"（不记录内容）用于发现异常外泄 | ❌ 待做 |
| 6 | 顺序纪律：`redactSecrets` → `wellFormed` → 截断；截断后**不要**再引入未过滤文本 | 要求 |
| 7 | artifact / diagnostic / SSE 帧 / 错误 message 全部走同一出口（"未来第二个出口不得只捡一半"） | 部分（文本主路径已过） |

**残余风险**
**中。** 正则永远追不上凭据格式的全部变体，第 3–5 项做完也只是提高命中率，不能承诺"无泄露"。唯一可承诺的底线是第 2 项：**敏感值不出现在 agent 可读的任何地方**。redact 是最后一道网，不是唯一一道。

---

## T-06 枚举探测（别人的 task 与不存在的 task 必须**完全一致**）

**风险描述**
持有合法 token 的一方（或被攻陷的 peer）可以遍历 task id / contextId，通过响应差异推断"别人的任务是否存在、什么状态、多大"。差异可来自：HTTP 状态、JSON-RPC code、message 文案、`error.data[]` 内容、字段是否存在（如 `artifacts` 缺省 vs `[]`）、状态码只在存在时出现（如 `-32002 already terminal`）。

**影响**
- 泄露业务存在性与时间线（"谁在什么时候派过任务"）；
- 推断 peer 名单规模与活跃度；
- 为后续定向攻击选目标（例如先确认某人有一个在飞的任务，再猜 contextId 做 DoS）。

**缓解措施**

| # | 措施 | 状态 |
|---|---|---|
| 1 | **不区分"不存在"与"不属于你"**：同一 HTTP 状态、同一 code、同一 message、同一 `data[]` 形状；`metadata.taskId` 回显**请求值**（而不是查到的值） | 要求（`dispatch` 实现时统一走一个 helper，禁止两条分支各写一份） |
| 2 | 归属双查：live slot 按 `activation.peer !== peer` 过滤；从 projection 读回时**再**按记录里的 peer 校验（"记录的 peer 是权威，不是 activation 的"） | 要求（参考 huangjuhua §5.4-3） |
| 3 | task id 用 `randomUUID()`（不可猜）；不接受 peer 任意指定 task id | 要求 |
| 4 | `GetTask` / `SubscribeToTask` / `CancelTask` 三条路径**共用同一个不存在/无权限应答**（含 `CancelTask` 对不存在与对他人都是 `-32001`，绝不能让 `-32002` 只在"存在"时出现） | 要求 |
| 5 | 401 / 403 / 429 只反映身份与配额，**不反映 task 是否存在**（ADR-005 失败分层） | ✅ 结构上已分离（`routes.ts:125-140` 只判身份） |
| 6 | 内部异常一律 `internal error`，不把路径/堆栈带上线 | ✅ `routes.ts:148-151` |
| 7 | 测试钉住："两次响应的 error code 必须相等"（上游 `e2e.spec.ts` 做法） | ❌ 待补 |

**残余风险**
**低-中。** 语义层可以做到完全一致，但**时序**仍可能泄露（见 T-08）：命中 map 与未命中 map 的分支成本不同。另外 `ListTasks` 的 `totalSize` 只泄露自己的规模（可接受）。若未来允许 peer 自带 id，必须重新评估"自造 id 探测占用"这一路径。

---

## T-07 限流与 turn 上限绕过

**风险描述**
当前设计：限流按 peer 身份、60s 固定窗（`config.ts:86`）；turn 上限按 contextId（`config.ts:87`）。绕过面：

| 绕过 | 机制 |
|---|---|
| **新 contextId 重置 turn 计数** | turn 上限的 key 是 contextId，peer 每次换新 contextId 就能无限驱动模型——"每次 5 turn"的隐式成本约束形同虚设 |
| **认证前无限流** | `authenticate`（`routes.ts:125-140`）在 `readBody` 之前，但没有速率限制；401 洪泛与 token 暴力猜解完全不受约束 |
| **进程内状态** | `RateLimiter.hits` 是内存 Map；重启清零；多实例/反代后各进程独立计数 |
| **固定窗边界突发** | 窗口交界处可打出接近 2× 的瞬时量 |
| **无并发上限** | block 模式（`blockTimeoutMs` 60s）+ SSE 长连接可堆积占用 agent 槽位与连接 |
| **实现缺口** | **`routes.ts` 里根本没有 429 分支**，`RateLimiter` 未被任何模块引用；`trustedPeers` 也没有 403 分支 |
| **半接线残留** | `routes.ts:320-328` 有个 `withinRateLimit()` helper：只做 `observed >= limit` 判断，且函数体里塞了 `sendJson as unknown` / `void HTTP_TOO_MANY_REQUESTS` 两行可疑语句（既不发送也不返回信封）。它**没有被任何 handler 调用**，属于死代码——接线时必须删掉或重写，不要在它上面继续加逻辑 |

**影响**
- 经济型 DoS：上游模型 token 费用、`maxResidentContexts`（64）槽位、内存（每个 context 一个 agent）；
- 对端可把我们变成其免费算力；也可用饱和请求拒绝对其它 peer 服务；
- token 暴力猜解在无认证前限流时理论上可行（32 字节随机实际不可行，但会污染日志、耗尽连接）。

**缓解措施**

| # | 措施 | 状态 |
|---|---|---|
| 1 | `RateLimiter` 类：可注入 clock、按 key 滑动计时、`sweep()` 清理 | ✅ `security/index.ts:68-95` |
| 2 | **接线**：`authenticate` 成功后立即 `allow(peer)`，失败返回 `429` + 合法 JSON-RPC 信封 | ❌ 待做 |
| 3 | **认证失败独立限流**（按 IP，阈值更严，如 10/min），防止 401 洪泛与猜解 | ❌ 待做 |
| 4 | turn 上限改按 **(peer, contextId)** 且额外加"每 peer 并发上下文数上限"，避免换 contextId 绕过 | ❌ 待做 |
| 5 | 定期 `sweep()`（如每 60s，`unref()`），防 Map 无限增长 | ❌ 待做 |
| 6 | 窗口语义明确化（滑动数组已近似滑动窗；注意数组长度受 `perMinute` 约束，别退化成 O(n) 无界） | 部分 |
| 7 | 429 响应除 `Retry-After` 外不泄露内部计数 | 要求 |
| 8 | 超 turn 上限返回 **REJECTED 任务**（正常应答），不是错误码——对端能读懂原因 | 要求（参考上游设计） |

**残余风险**
**中。** 限流只能约束"速率"，不能约束"配额"：在合法额度内（60/min × 5 turns = 300 turn/min）仍可耗尽费用。真正的上限要靠在部署层设 `rateLimitPerMinute` 与上游模型预算，而不是指望默认值。

---

## T-08 时间侧信道（常时比较、遍历全部候选）

**风险描述**
认证路径的比较与迭代可能泄露 token 长度、前缀、命中位置、以及 peer 数量。攻击者在局域网内做大量采样并统计（RTT 抖动可被平均掉）。

**现状与已做的正确实现**

- `constantTimeEqual`（`security/index.ts:26-34`）：`timingSafeEqual` 要求等长，所以长度不等时**先做一次自比较**（`timingSafeEqual(left, left)`）再返回 false——"长度错"不会比"字节错"更快。
- `identifyPeer`（`security/index.ts:42-52`）：`if (constantTimeEqual(token, secret) && matched === undefined)`——左侧比较**无条件执行**，命中后也不 break；`matched` 只赋值一次（重复 secret 时先声明者胜）。
- 空 token / `undefined` 在函数入口返回 `undefined`，不进入循环。

**仍存在的泄露（必须写清）**

| # | 泄露 | 说明 |
|---|---|---|
| 1 | **peer 数量** | 总耗时随候选数线性增长。泄露的是"声明了几个 peer"，不是"哪个命中"。2 个 peer 时几乎不可观测，但结论要写进模型 |
| 2 | **credentials 解析层级** | `resolvePeerSecrets` 是**全量**解析（每请求遍历所有 peer 调 `credentials.resolve`），其 I/O 成本远大于比较成本；若未来为性能改成"命中即停"或"懒解析"，会立刻引入新的可观测差异 |
| 3 | **401 与 200 的固定成本差** | JSON 序列化、header 写入等固定成本差异远大于比较级差异，实际淹没比较信号——这是好事，但意味着比较级"常时"的收益要靠**不引入短路**来守住 |
| 4 | **map 迭代顺序** | 等于配置声明顺序。一旦有人把循环改成 `break` 或 `return` 提前退出，命中位置立刻可测——必须用测试钉住（见 `tests/unit/security.spec.ts` 的"多 peer 时每个都能命中"） |
| 5 | **owner 通道顺序（未来）** | 若实现 owner token 优先比对，必须"先比完 owner 再走 peer 表"，且 owner 比较同样常时；否则 owner 命中会比 peer 命中快 |
| 6 | **task 存在性时序** | 见 T-06：命中 map 与未命中的分支成本不同；应让两条路径做同样多的工作（同构应答构造） |

**缓解措施**

| # | 措施 | 状态 |
|---|---|---|
| 1 | `constantTimeEqual` 长度不等也 burn 比较 | ✅ |
| 2 | `identifyPeer` 遍历全部候选、不提前退出 | ✅（需测试锁定） |
| 3 | `resolvePeerSecrets` 全量解析，不短路 | ✅（`routes.ts:78-79` 契约） |
| 4 | 日志不记录"哪个 peer 命中"、不记录比较耗时 | 要求 |
| 5 | 401/403/429 响应体固定长度（可选加固） | ❌ 待做 |
| 6 | task 查询的"存在/不存在"两条路径同构 | 要求（T-06 第 1 项） |

**残余风险**
**低。** 数量泄露（第 1 项）已知并接受：局域网 RTT 抖动通常远大于每次比较的差异，且"有几个 peer"本身不算敏感。真正的风险是**未来改动引入短路**——用测试而非注释来防。

---

## T-09 管理面 / 监控面暴露（loopback + token 双闸）

**风险描述**
ADR-007 要求"非黑箱"——用户要能看到每个 peer 在做什么。这意味着必然存在一个**聚合视图**：它展示所有访客的原话与 agent 输出。这类面一旦与 peer 面同端口、或经反向代理/端口转发可达，等价于把全量会话内容一次性开放。

**现状**
`config.ts` **尚无 `admin` 段**，`routes.ts` 只挂 3 条路由（`card ×2` + `basePath`，`routes.ts:295-299`）。即：管理面尚未实现——**正因为尚未实现，约束必须在写第一行代码前定死**（ADR-008：安全旋钮不能先声明后失效）。

**影响**
- 会话内容外泄（含其它 peer 的隐私、模型输出、可能夹带的密钥）；
- 若被当作写接口，可伪造观测数据、误导用户判断"agent 在做什么"；
- 与 T-03（回环可达）叠加时，远端可借我们的进程身份读到它。

**缓解措施（硬约束，逐条可验收）**

| # | 约束 | 说明 |
|---|---|---|
| 1 | **闸一：loopback 硬边界** | `req.socket.remoteAddress` ∈ {`127.0.0.1`, `::1`}，或 `remoteAddress === localAddress`。这是**边界**，不是认证 |
| 2 | **闸二：独立 admin token** | 与任何 peer token **不同源、不同值**（ADR-004「控制面独立凭据」） |
| 3 | 两闸**同时**满足才放行；token 单独正确不够 | 原话：「token 单独永远不够，因为这个面展示每个访客的话，且可能经端口转发被触达」 |
| 4 | **未配 admin token ⇒ 整面不挂载**（不是挂载后返 401） | 不挂载 = 无路由 = 无可探测面 |
| 5 | 非 `GET` ⇒ `405`；路径用 `${basePath}/admin` 前缀 | 减少写操作面 |
| 6 | **不可经反向代理暴露** | 代理会让 `remoteAddress` 变成 `127.0.0.1`，闸一失效。若必须，改为"仅 UDS"或"仅 GUI 进程内调用" |
| 7 | 不用 `X-Forwarded-For` / `Origin` 判 loopback | 可伪造 |
| 8 | 浏览器侧 CSRF：loopback + GET 可被任意网页发起（DNS rebinding / 表单 GET） | 需校验 `Origin`/`Host`，且无 token 请求不返回敏感内容；最稳是"仅进程内调用，不开 HTTP" |

**残余风险**
**中（未实现前为"设计债"，实现后为"本机信任假设"）。** loopback 无密钥 = 宽容，不是认证（research/05 §9.11）：本机其它用户/进程可读；浏览器侧 CSRF 需要额外 Origin 校验。最彻底的做法是不开 HTTP 管理面，而走 GUI 进程内调用——但那要考虑 ADR-007 的可视化诉求，需另写 ADR 权衡。

---

## 3. ADR-003 重开判据（明文 Bearer 的接受条件何时失效）

ADR-003 的接受建立在 4 个前提上：**两台固定机器 / 同一物理边界 / 无不可信设备 / 不跨越公网**。以下任一条件成立，**必须重开 ADR-003（新写 ADR-011，不得就地修改 ADR-003）**：

1. **局域网出现任何非受控设备**：访客 Wi-Fi、IoT、BYOD、临时接入的调试机、家人设备。
2. **端点不再只绑 LAN**：任何形式的公网暴露（端口转发、UPnP、frp、ngrok、cloudflared 裸隧道）、或经 VPN 跨站点。
3. **链路含无线或共享介质**：Wi-Fi、电力猫、HUB（非交换机）。
4. **token 需人工传递**：经 IM/邮件/口头/截图转录（传递过程本身成为泄露点）。
5. **机器数 > 2**，或出现"临时 peer"（一次性联调、演示）。
6. **合规或审计要求**：等保、客户安全评审、任何"传输必须加密"的书面要求。
7. **容器/云主机部署**：同宿主机或同 VPC 的其它租户可能嗅探或访问元数据地址（与 T-03 联动）。
8. **发现异常信号**：401 激增、出现来源不明的成功请求、ARP 表异常、抓包中出现 Bearer、日志里出现重复的同一 token 使用但来源 IP 不同。
9. **管理员本人不再能确认"这个网段里只有这两台机器"**——不确定性本身就是判据。

重开时不必推倒重来：按 `docs/security-setup.md` §4 的三档路径，自签 TLS 是**配置级**切换（webserver 实码支持 `--tls-cert/--tls-key`），Tailscale 是网络级切换，二者都不需要改协议层。

---

## 4. 残余风险汇总与未实现项

### 4.1 汇总

| 编号 | 威胁 | 残余风险 | 主要兜底 |
|---|---|---|---|
| T-01 | 明文 Bearer 嗅探 | **高（已接受）** | 一 peer 一 token + 轮换 + 升级路径 |
| T-02 | 跨 peer 会话/文件 | **中-高** | DSH 沙箱 + cwd 隔离 + （待补）deny-list |
| T-03 | 出站 SSRF | **高→中** | 静态 contacts + （待补）地址策略 |
| T-04 | 提示注入 | **中-高** | 权限面收窄（非过滤） |
| T-05 | 出站密钥泄露 | **中** | 密钥对模型不可见（治本） |
| T-06 | 枚举探测 | **低-中** | 应答同构 + 归属双查 |
| T-07 | 限流/turn 绕过 | **中** | 接线 + 双层限流 + 部署配额 |
| T-08 | 时间侧信道 | **低** | 常时比较 + 不短路（测试锁定） |
| T-09 | 管理面暴露 | **中** | 双闸 + 未配即不挂载 |

### 4.2 未实现项（按风险排序，均为明确任务，不是"已知可接受"）

| # | 未实现项 | 对应威胁 | 验收方式 |
|---|---|---|---|
| 1 | 跨会话工具 deny-list：`session_search` / `session_event_search` / `session_trace` / `session_event_trace` / `session_event_read` / `list_agents` + `unsafeAllowCrossSessionSearch`（默认 false） | T-02 | 单测：注入 stub 工具注册表，断言 6 个工具在 peer 会话中被拒；shared 单 peer 时逃生阀可开 |
| 2 | 出站地址策略（默认允许 LAN + deny `169.254.169.254` / 链路本地 / 回环 / 非 http(s) / userinfo）、`redirect: 'manual'` 逐跳复检、DNS 后 IP 校验与 pinning | T-03 | 单测：对每个目标返回策略拒绝；重定向到元数据地址被拒 |
| 3 | `filterInbound`（去势 7 条正则） | T-04 | 单测：ChatML/角色前缀被替换为 `[filtered]`，正常文本不被改 |
| 4 | `routes.ts` 接线 `RateLimiter`（429）+ `trustedPeers`（403）+ 认证失败 IP 限流 | T-07 | 单测：第 N+1 次 429，信封合法；越窗恢复 |
| 5 | turn 上限改按 `(peer, contextId)` + 每 peer 并发上下文上限 | T-07 | 单测：换新 contextId 不能重置 |
| 6 | 管理面（未声明、未实现），实现时必须满足 T-09 的 8 条硬约束 | T-09 | 集成测试：非 loopback 401/拒连；无 token 时路由不存在 |
| 7 | `redactSecrets` 补 64-hex 高熵、PEM 块、`AIza`/`npm_`、`Basic`、`xxx=` | T-05 | 单测：每条新增模式命中且不误伤 UUID/commit hash |
| 8 | `assertConfigCoherent` 增补：`workspaceMode: shared` 且 peers > 1 拒绝加载 | T-02 | 单测：加载期抛 `ConfigError` |

### 4.3 与上游的差异（引用时必须区分）

- 上游 huangjuhua-aigc/dsh-a2a 的 `security.ts` 已含 `filterInbound`；**本仓库尚未移植**，不得在文档中声称已具备。
- 上游的 `admin` 面已实现（loopback + token 双闸）；**本仓库只有约束，没有代码**。
- 上游 `RateLimiter` 已在 router 中接线；**本仓库已实现类但未接线**。

---

## 5. 复核触发条件

出现以下任一情况，本文件必须复核并同步更新（并检查是否需要新 ADR）：

1. 新增任何出站目的地（新 contact）或改变 `redirect` 策略；
2. 新增路由（尤其管理面）或改变鉴权顺序；
3. DSH 版本升级（跨会话工具的授权语义可能变化——这是 T-02 的前提条件，必须逐 seam 核对 `lib/*.d.ts`，不能只看 changelog）；
4. 部署形态变化（新增机器、开无线、开公网、换容器）；
5. `security/index.ts` 的导出被改动（任何新增/删除模式、任何循环改动都要过 T-08 的测试）；
6. 发生任何安全事件（401 激增、可疑 token 使用、异常出站请求）。

---

*本文件的每一项缓解措施都应能落到代码坐标或部署步骤上。写不出坐标的"缓解措施"一律不算缓解。*

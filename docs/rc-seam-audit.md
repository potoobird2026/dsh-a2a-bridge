# 跨 rc 版本 seam 审计

本文说明：本插件依赖 DSH 宿主提供的哪些能力、这些能力缺失时会发生什么、以及**在不同 DSH 运行时版本之间**（例如两台机器跑不同 rc）如何发现差异。

> 文中以「机器 A / 机器 B」指代部署，不记录任何具体地址、主机名或路径。

---

## 1. 为什么需要这份文档

插件不 import 宿主的实现，只通过结构契约调用宿主服务。这意味着：

- 宿主版本变了、某个服务或方法没了，**编译器不会报错**——契约是我们自己声明的窄接口；
- 运行时表现为 `ctx.get('x')` 返回 `undefined`，于是 `if (x !== undefined)` 的守卫被跳过，**功能静默不发生**。

这类"静默不发生"在本项目历史上出现过多次（`credentials`、`subagents`、`tools`、`workspaceRegistry` 都在 `apply()` 期间读取过，因此永远是 `undefined`）。所以审计的重点不是"接口长什么样"，而是**缺失时如何被看见**。

---

## 2. 能验证什么、不能验证什么

| 手段 | 可行性 | 说明 |
|---|---|---|
| 对比两端的 `lib/*.d.ts` | ❌ 远端不可行 | 桌面端把宿主包打进 `app.asar`；SMB 只能读到打包文件，读不到包内 `.d.ts` |
| 对比 `node_modules` 里的宿主包 | ❌ | 运行时目录只含 `node` / `pnpm` / `python` 依赖，不含 `@deepseek-ai/*` |
| 读取运行时版本号 | ✅ | 运行时目录的 `runtime.json` 含 `desktopVersion` |
| **行为验证**（真机跑一遍） | ✅ | `npm run verify:live` 覆盖卡片、鉴权、端到端 SendMessage、会话连续性、任务状态机 |
| **启动期 seam 探针** | ✅ | 插件启动时打印一行 `a2a: seams ... missing=...`，两台机器可直接对比 |

结论：**在远端无法做字节级接口比对**，因此本审计以「行为证据 + 探针日志」作为主证据，并在第 5 节明确残余风险。

---

## 3. seam 清单

「缺失后果」是该方法不存在时的**用户可见**表现；「现有证据」指仓库里能复现的验证。

### 3.1 关键 seam（缺失即破坏可见承诺）

| 服务 / 方法 | 用途 | 缺失后果 | 现有证据 |
|---|---|---|---|
| `agents.get / create / resume` | 建立与重开 A2A 会话 | `resume` 缺失 → **重启后每条对话永久不可达** | `tests/unit/executor.spec.ts`；真机日志 `resuming it instead of creating a new one` |
| `session.snapshotEvents / ownEvents` | 读回回复文本 | 缺失 → 回复恒为空，任务却报 `COMPLETED`（曾发生） | 单测 + 真机 `TASK_STATE_COMPLETED reply="ONE"` |
| `session.append` | 镜像写入会话事件 | 缺失 → 会话可见性失效（ADR-007 的黑箱） | `tests/unit/session.spec.ts`；真机镜像会话 |
| `workspaceRegistry.create / attachSession` | 把会话归入 A2A 工作区 | 缺失 → 会话散落在「未分组」 | 真机工作区注册表含 `A2A` 及其会话 |
| `workspaceRegistry.unarchiveSession` | 恢复被归档的 A2A 会话 | 缺失 → 会话在跑但**侧栏看不见** | 真机 `archivedSessionIds` 排查记录 |
| `workingDirectory.set` | 每会话独立工作目录 | 缺失 → 隔离失效，所有会话共用一个目录 | 真机 `Get-Location` 返回 `<根>/<对端>/<会话>` |
| `agentPresets.resolve / mount` | 给会话挂执行工具集 | `mount` 缺失 → 会话**没有执行工具** | 日志 `agent preset mounted requested=standard effective=standard` |
| `credentials.resolve` | 解析 token 引用名 | 缺失 → 所有入站请求 401 | `tests/unit/executor-task-seam.spec.ts` + 真机 |
| `settings.describe / update` | 插件页读写配置 | 缺失 → 无法选模型（页面回退到只读提示） | `tests/unit/config-api.spec.ts` |

### 3.2 可降级的 seam（缺失只损失一条路径）

| 服务 / 方法 | 缺失后果 |
|---|---|
| `llm.listProviders / listModels` | 模型下拉为空，配置页提示去「设置 → 模型」先配 provider |
| `subagents.registerProvider` | 出站只剩工具路径（`a2a_call`），作为 subagent provider 不可用 |
| `tools.register` | `a2a_call` / `a2a_list` 不可用（provider 路径仍可） |
| `webServer.register` | 配置页的 HTTP 路由不可用；表单通道仍可写 |
| `homePaths` | 退化到 `$DSH_HOME`，再退化到 `~/.dsh` |
| `remote.directoryPicker.pick / list` | 只能手动输入绝对路径（页面有降级文案） |

---

## 4. 怎么用探针比较多台机器

插件启动时输出一行（`src/diagnostics.ts`）：

```
a2a: seams agentsResume=1 workspaceRegistry=1 workspaceUnarchive=1 workingDirectory=1 \
     agentPresets=1 credentials=1 settings=1 llm=1 subagents=1 tools=1 homePaths=1 \
     missing=none
```

约定：

- `missing=` **永远存在**，包括 `missing=none`，所以可以直接 grep；
- 关键 seam 缺失时额外出现 `critical-missing=`，列出具体名字；
- 两台机器各抓一行对比，**差集就是版本差异的运行时可观察部分**。

不需要手工翻日志：`npm run seams` 打印最新一次探针，`npm run seams -- --compare` 给出上一次「不同」探针与当前的逐项差异（同一构建重复启动产生的相同行会被跳过，否则差异恒为空）。

升级 DSH 前后各抓一次，是最低成本的前后对比。

---

## 5. 残余风险（明确列出，不假装已消除）

1. **方法签名变化无法自动发现**：例如 `create()` 的选项对象新增必填字段。探针只能判断"方法在不在"，不能判断"参数对不对"。补偿：`npm run verify:live` 的行为检查。
2. **行为证据只覆盖被测路径**：`verify:live` 覆盖卡片/鉴权/发送/连续性/任务状态机，**不覆盖** SSE 流式、push notifications、多 agent 等尚未实现的路径。
3. **打包差异不可见**：远端 `app.asar` 内部结构无法读取，只能从行为反推。
4. **探针本身依赖 `ctx.get`**：若某个服务改成异步装配，探针可能报缺失而实际稍后可用。当前实现里关键服务都是同步可用的。

---

## 6. 未做项

- `tests/mesh`：多跳网络形态的可执行测试仍是空的（`tests/live` 只有 README）。
- ~~自动化前后对比~~ → **已做成脚本**：`npm run seams`（`--all` 全部探针 / `--compare` 与上一次不同探针做差异 / `--require` 缺少探针时返回非 0，可用于安装后自检）。它只读日志，不碰插件运行时。
- 远端 `app.asar` 解包比对：需要额外工具，收益低于行为验证，暂不做。

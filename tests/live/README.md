# 真机联调测试（live tests）

本目录放的是**需要真实对端机器**才能跑的测试：两台（或多台）DSH 实例在同一
局域网内，通过 A2A v1.0 互相发现 Agent Card、发送任务、接收 SSE 流。

## 1. 默认为什么跳过

- **测试机不具备条件**：CI 的 runner 上不存在第二台 DSH，也没有对方 peer 的
  凭据和 Agent Card；硬跑只会得到超时，把门禁变成随机红灯。
- **凭据不能进仓库**：ADR-005 规定 per-peer token 只通过 `ctx.credentials` /
  环境变量解析，`.gitignore` 明确忽略 `.env*`。真机测试必须由执行者本机注入，
  不可能在 CI 里复现。
- **结果不确定**：依赖局域网、防火墙、mDNS/静态地址、对端负载与限流，属于
  集成验证而非单元回归；回归门禁需要确定性。
- **隔离副作用**：live 用例会在对端创建真实 workspace / session，跑一次就留下
  痕迹，不能像单测那样随手重跑。

因此 `vitest.config.ts` 里有：

```ts
exclude: ['tests/live/**'],
```

即默认 `npm test` **完全不会加载本目录**。

## 2. 怎么开启

三个条件同时满足才会真正执行：

1. 本机已 `npm install`（本仓库当前**未提交 node_modules，也未提交
   package-lock.json**，所以先确认依赖装好）；
2. 设置 `DSH_A2A_LIVE=1`；
3. 提供对端地址与 token（见下表）。

约定：本目录下的用例文件统一命名为 `*.live.ts`（例如
`tests/live/roundtrip.live.ts`），并在 `describe` 上做环境门控，这样即使有人
绕过 exclude 直接加载本目录，也不会在没配置时失败：

```ts
import { describe, it } from 'vitest'

const live = process.env.DSH_A2A_LIVE === '1'

describe.skipIf(!live)('A2A 真机往返', () => {
  it('SendMessage → 终态 Task', async () => {
    // ...
  })
})
```

推荐做法：给 live 用例一个**独立配置**，而不是临时改默认配置。在仓库根新建
`vitest.live.config.ts`（建议提交，方便团队复用）：

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/live/**/*.live.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
```

运行（PowerShell）：

```powershell
$env:DSH_A2A_LIVE = '1'
$env:DSH_A2A_LIVE_URL = 'http://192.168.1.103:43120/a2a'
$env:DSH_A2A_LIVE_TOKEN = '<对端 owner token>'
npx vitest run --config vitest.live.config.ts
```

bash / zsh：

```bash
DSH_A2A_LIVE=1 \
DSH_A2A_LIVE_URL='http://192.168.1.103:43120/a2a' \
DSH_A2A_LIVE_TOKEN='<对端 owner token>' \
npx vitest run --config vitest.live.config.ts
```

不要为了跑 live 去删 `vitest.config.ts` 里的 `exclude`——那会让普通
`npm test` 在 CI 上拉起真机用例并超时。Vitest 不同版本对 CLI `--exclude`
是「覆盖」还是「追加」行为并不一致，所以本说明以独立 config 为准。

## 3. 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `DSH_A2A_LIVE` | 是 | 必须为 `1`，否则所有 live 用例 skip |
| `DSH_A2A_LIVE_URL` | 是 | 对端 JSON-RPC 端点，含 `/a2a` 前缀，如 `http://host:port/a2a` |
| `DSH_A2A_LIVE_TOKEN` | 是 | 对端为本机 peer 配置的 Bearer token（只从环境读，不落盘） |
| `DSH_A2A_LIVE_CARD_URL` | 否 | Agent Card 地址；缺省由 `DSH_A2A_LIVE_URL` 推导 `/.well-known/agent-card.json` |
| `DSH_A2A_LIVE_TIMEOUT_MS` | 否 | 单次往返上限，缺省 `30000` |
| `DSH_A2A_LIVE_CONTEXT_ID` | 否 | 复用已有 contextId，用于验证「同一 context 落到同一 session」 |

## 4. 真机测试应当覆盖什么

live 目录只放**本地替身无法证明**的假设：

- 对端 SDK 解析我们发出的 SSE 帧（尤其是中文/emoji 跨 chunk 的编码）；
- `a2a-version: 1.0` 头与 `-32009` 版本协商；
- Agent Card 的 `interfaces` / `protocolVersion` 能被真实 SDK 接受；
- 401 / 429 在真实 reverse proxy 后的行为；
- 任务终态帧后立即关流，对端确实把任务判为终态。

纯协议编解码、鉴权、限流、脱敏等逻辑应继续用 `tests/helpers/` 下的替身做
单元测试，不要放进本目录。

## 5. 现状与风险

- 本机**未安装 node_modules**，本目录的说明与脚本都**未实际运行验证**；
  首次真机执行时请以实际报错为准修正环境变量名。
- live 用例不要写 `test.each` 式的大批量重试：对端有限流，重试会掩盖协议 bug。
- 无论成败，不要打印 token；诊断信息走 `clampDiagnostic` 截断后再输出。

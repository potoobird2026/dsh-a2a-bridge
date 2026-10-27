/**
 * 测试夹具：手搓的 Cordis `ctx` 替身。
 *
 * 为什么不用真的 `Context`：
 *   - 真 Context 要拉起整棵 Cordis 依赖树，单测会从「毫秒级」变成「秒级」；
 *   - 本机 `@deepseek-ai/*` 包里 **0 个 `.d.ts`**，`import type { Context } from
 *     '@deepseek-ai/cordis'` 拿不到类型（这也是 tsconfig 保留
 *     `noImplicitAny:false` + `skipLibCheck:true` 的原因，不要改回去）；
 *   - 本机**未安装 node_modules**，引入 cordis 运行时会让夹具连加载都失败。
 *
 * 所以这里声明的是 Cordis Context 的**结构子集**，最后用
 * `as unknown as Context` 交给调用方断言（调用方可以自己从 cordis 引入类型，
 * 或者直接把这个结构当契约用）。夹具本身不 import 任何 cordis 包。
 *
 * 覆盖的行为（只覆盖被插件实际依赖的部分，见 src/inbound/routes.ts 与
 * src/session/session-binding.ts）：
 *   - `ctx.get(name)`：服务定位。可注入任意服务替身；未注入返回 `undefined`
 *     （插件对 `webServer` / `workspaceRegistry` 都是「探测失败即降级」，这条要能测）。
 *   - `ctx.agents.get(id)` / `ctx.agents.create(spec)`：内存版 agent 表。
 *   - `ctx.logger`：记录型 logger，断言日志内容而不污染 stdout。
 *   - `ctx.effect(fn)`：立即执行 fn，返回幂等 disposer（Cordis 的 effect 约定）。
 *
 * 已知缺口：没有实现 `ctx.on/emit`。需要事件行为时请在用例里显式补一个
 * 最小 emitter，不要在这里猜 Cordis 的事件语义。
 *
 * 说明：Vitest **不做类型检查**，本文件的类型问题不会被 `npm test` 发现；
 * 本机未安装 node_modules，本文件未实际运行验证。
 */

// ── 日志替身 ───────────────────────────────────────────────────────────────

export type FakeLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface FakeLogRecord {
  readonly level: FakeLogLevel
  readonly args: readonly unknown[]
  /** `logger.child('xxx')` 的 scope，根 logger 为 undefined。 */
  readonly scope: string | undefined
}

/**
 * 记录型 logger。`records` 与所有 child 共享同一个底层数组，
 * 因此 `ctx.logger.child('a').records` 也能看到根上的日志。
 */
export interface FakeLogger {
  readonly records: ReadonlyArray<FakeLogRecord>
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
  child(scope: string): FakeLogger
}

/** 构造一个记录型 logger；scope 只影响新写入记录的 `scope` 字段。 */
export function makeFakeLogger(scope?: string): FakeLogger {
  const records: FakeLogRecord[] = []

  const make = (currentScope: string | undefined): FakeLogger => {
    const write = (level: FakeLogLevel) => (...args: unknown[]): void => {
      records.push({ level, args, scope: currentScope })
    }
    return {
      records,
      debug: write('debug'),
      info: write('info'),
      warn: write('warn'),
      error: write('error'),
      child: (childScope: string) =>
        make(currentScope === undefined ? childScope : `${currentScope}.${childScope}`),
    }
  }

  return make(scope)
}

// ── agent 替身 ─────────────────────────────────────────────────────────────

export interface FakeAgent {
  readonly id: string
  readonly [extra: string]: unknown
}

export interface FakeAgents {
  get(id: string): FakeAgent | undefined
  create(spec?: Record<string, unknown>): FakeAgent
}

/**
 * 内存 agent 表。
 *
 * id 由 `spec.id` 指定，缺省按 `fake-agent-1`、`fake-agent-2` … 递增，
 * 保证同一用例内确定性（不要用随机 id，否则断言会飘）。
 */
export function makeFakeAgents(): FakeAgents {
  const agents = new Map<string, FakeAgent>()
  let nextId = 1

  return {
    get(id: string): FakeAgent | undefined {
      return agents.get(id)
    },
    create(spec: Record<string, unknown> = {}): FakeAgent {
      const id = typeof spec.id === 'string' && spec.id.length > 0
        ? spec.id
        : `fake-agent-${nextId++}`
      const agent: FakeAgent = { ...spec, id }
      agents.set(id, agent)
      return agent
    },
  }
}

// ── ctx 替身 ───────────────────────────────────────────────────────────────

export type FakeDisposer = () => void

/**
 * Cordis `Context` 的结构子集。
 *
 * 刻意叫 `Context`：调用处可以写 `makeFakeCtx() as unknown as Context`，
 * 与真实类型保持同名、看完即可替换。它**不是** `@deepseek-ai/cordis` 的类型。
 */
export interface Context {
  get(name: string): unknown
  readonly agents: FakeAgents
  readonly logger: FakeLogger
  effect(fn: () => unknown): FakeDisposer
}

export interface FakeCtxOverrides {
  /** 注入 `ctx.get(name)` 能解析到的服务；未列出的 name 返回 undefined。 */
  readonly services?: Record<string, unknown>
  /** 部分覆盖 agent 表；未覆盖的方法保留默认实现。 */
  readonly agents?: Partial<FakeAgents>
  /** 替换 logger（例如想让日志进 sink）；缺省用记录型 logger。 */
  readonly logger?: FakeLogger
}

/**
 * 造一个 Cordis ctx 替身。
 *
 * `effect(fn)` 语义与 Cordis 对齐：**立即执行** fn；若 fn 返回函数，
 * 该函数即清理逻辑；`effect` 返回的 disposer 幂等（重复调用只清理一次）。
 * fn 抛错会直接冒泡——真 Cordis 也会把错误暴露出来，吞掉会让用例假绿。
 *
 * @example
 * const ctx = makeFakeCtx({
 *   services: { webServer: { register: () => () => {}, getOrigin: () => '', port: 0 } },
 * })
 * const dispose = ctx.effect(() => () => cleanupCalled++)
 */
export function makeFakeCtx(overrides: FakeCtxOverrides = {}): Context {
  const services = overrides.services ?? {}
  const logger = overrides.logger ?? makeFakeLogger()
  const defaultAgents = makeFakeAgents()
  const agents: FakeAgents = {
    get: overrides.agents?.get ?? defaultAgents.get,
    create: overrides.agents?.create ?? defaultAgents.create,
  }

  const ctx: Context = {
    get(name: string): unknown {
      if (Object.prototype.hasOwnProperty.call(services, name)) return services[name]
      // 便捷回落：`ctx.get('agents')` 与 `ctx.agents` 指同一替身。
      if (name === 'agents') return agents
      return undefined
    },
    agents,
    logger,
    effect(fn: () => unknown): FakeDisposer {
      const cleanup = fn()
      let disposed = false
      return (): void => {
        if (disposed) return
        disposed = true
        if (typeof cleanup === 'function') cleanup()
      }
    },
  }

  // 结构子集 → Cordis 类型空间。真正的 `Context` 由调用方从
  // `@deepseek-ai/cordis` 引入（本机没有 .d.ts），这里做一次显式断言，
  // 让 `const ctx: Context = makeFakeCtx()` 这类写法在用例里成立。
  return ctx as unknown as Context
}

/**
 * 测试夹具：确定性的回显 LLM adapter（stub）。
 *
 * 为什么需要它：inbound / outbound 的流式路径必须在**真实时序**下被测，
 * 而不是等一个真模型。这个 adapter 不联网、不依赖 node_modules、每次同样输入
 * 产出同样帧序列，因此断言可以写死。
 *
 * `hold()` 是这个夹具的核心：
 *   - `hold()` 返回一个 `release` 函数；在 release 之前，随后启动的 `stream()`
 *     会**挂住且一帧都不产出**。
 *   - 这正好覆盖三类难测的 in-flight 行为：
 *       1. SSE stream 重连：先 hold 住，断开客户端，再放行，断言第一帧不丢；
 *       2. cancel mid-run：hold 期间 abort，断言 adapter 抛 AbortError 且不再产出；
 *       3. teardown 终态帧：hold 住让请求停在「已建立、未结束」，此时 dispose
 *          插件，再 release，断言终态帧（finish）仍然被写出或连接被正确关闭。
 *
 * 约定：**`hold()` 必须在 `stream()` 开始前调用**。`stream()` 在入口处对当前
 * 未释放的 gate 取快照并逐个等待；已经开始产出后再 hold 不会回溯生效。
 *
 * 说明：Vitest **不做类型检查**，本文件的类型问题不会被 `npm test` 发现；
 * 本机未安装 node_modules，本文件未实际运行验证。
 */

/** adapter 产出的流式帧，形状对齐文本增量 + 结算信号。 */
export type EchoStreamChunk =
  | { readonly type: 'text-delta'; readonly text: string }
  | { readonly type: 'finish'; readonly reason: string }

export interface EchoAdapterOptions {
  /** 精确指定要产出的文本片段（按顺序逐帧）；优先级高于 text。 */
  readonly chunks?: readonly string[]
  /** 固定回显文本；缺省时从最后一条 user 消息推导 `echo:<text>`。 */
  readonly text?: string
  /** `finish` 帧的 reason，默认 `stop`。 */
  readonly endReason?: string
  /** 每帧之间的延迟（毫秒），默认 0。只有测「慢流」时才需要 > 0。 */
  readonly delayMs?: number
}

export interface EchoStreamOptions {
  /** 中止信号：等待 gate、帧间延迟、逐帧产出都会检查它。 */
  readonly signal?: AbortSignal
}

export interface EchoCall {
  readonly request: unknown
  readonly signal: AbortSignal | undefined
  /** 仅用于诊断顺序，不要据此写断言。 */
  readonly startedAt: number
}

export interface HoldGate {
  readonly opened: Promise<void>
  release(): void
}

/**
 * 确定性回显 adapter。
 *
 * 不是 `@deepseek-ai/dsh-llm` 的实现，只满足其调用面里被本插件用到的
 * 「`stream()` 返回 AsyncGenerator」这一条；测试里按结构使用即可。
 */
export class EchoAdapter {
  private readonly chunks: readonly string[] | undefined
  private readonly text: string | undefined
  private readonly endReason: string
  private readonly delayMs: number

  /** 尚未释放的 gate。 */
  private readonly gates = new Set<HoldGate>()

  /** 每次 `stream()` 的调用记录，供断言「被调了几次、带了什么」。 */
  readonly calls: EchoCall[] = []

  constructor(options: EchoAdapterOptions = {}) {
    this.chunks = options.chunks
    this.text = options.text
    this.endReason = options.endReason ?? 'stop'
    this.delayMs = options.delayMs ?? 0
  }

  /** 当前仍挂着的 gate 数量（释放后归零）。 */
  get held(): number {
    return this.gates.size
  }

  /**
   * 装一道闸门，阻塞**随后启动**的 stream。
   *
   * @returns 幂等的 release 函数；重复调用不会报错，也不会释放别的 gate。
   */
  hold(): () => void {
    let settle!: () => void
    const opened = new Promise<void>((resolve) => {
      settle = resolve
    })

    let gate!: HoldGate
    const release = (): void => {
      // delete 返回 false 说明已经释放过，直接忽略。
      if (!this.gates.delete(gate)) return
      settle()
    }
    gate = { opened, release }
    this.gates.add(gate)
    return release
  }

  /** 放行所有当前挂起的 gate（teardown / afterEach 兜底，避免用例挂死）。 */
  releaseAll(): void {
    for (const gate of [...this.gates]) gate.release()
  }

  /**
   * 产出确定性帧序列。
   *
   * 帧序：`text-delta` × N → `finish`。没有 gate 时同步开始产出（首个
   * `next()` 才真正执行，这是 async generator 的语义）。
   */
  async *stream(
    request: unknown = {},
    options: EchoStreamOptions = {},
  ): AsyncGenerator<EchoStreamChunk, void, unknown> {
    const { signal } = options
    this.calls.push({ request, signal, startedAt: Date.now() })

    throwIfAborted(signal)

    // 快照：hold() 必须在 stream 开始前调用。
    for (const gate of [...this.gates]) {
      await waitForGate(gate.opened, signal)
    }

    const text = this.text ?? extractLastUserText(request)
    const pieces = this.chunks ?? (text.length > 0 ? [text] : [])

    for (const piece of pieces) {
      throwIfAborted(signal)
      if (this.delayMs > 0) await sleep(this.delayMs, signal)
      if (piece.length > 0) yield { type: 'text-delta', text: piece }
    }

    throwIfAborted(signal)
    yield { type: 'finish', reason: this.endReason }
  }
}

/** 工厂：与 `new EchoAdapter(options)` 等价，便于用例一行声明。 */
export function makeEchoAdapter(options: EchoAdapterOptions = {}): EchoAdapter {
  return new EchoAdapter(options)
}

// ── 内部工具 ───────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 从最后一条 user 消息里取纯文本；取不到时回退 `echo`。 */
function extractLastUserText(request: unknown): string {
  if (!isRecord(request)) return 'echo'
  const messages = request.messages
  if (!Array.isArray(messages)) return 'echo'

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!isRecord(message) || message.role !== 'user') continue
    const text = messageText(message)
    if (text.length > 0) return `echo:${text}`
  }
  return 'echo'
}

function messageText(message: Record<string, unknown>): string {
  if (typeof message.text === 'string') return message.text

  for (const key of ['parts', 'content'] as const) {
    const value = message[key]
    if (!Array.isArray(value)) continue
    const pieces: string[] = []
    for (const part of value) {
      if (isRecord(part) && typeof part.text === 'string') pieces.push(part.text)
    }
    if (pieces.length > 0) return pieces.join('')
  }
  return ''
}

function abortError(signal?: AbortSignal): Error {
  const error = new Error('EchoAdapter: stream aborted')
  error.name = 'AbortError'
  if (signal?.reason !== undefined) (error as Error & { cause?: unknown }).cause = signal.reason
  return error
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw abortError(signal)
}

function waitForGate(opened: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return opened
  throwIfAborted(signal)

  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      reject(abortError(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    opened.then(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError(signal))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(abortError(signal))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

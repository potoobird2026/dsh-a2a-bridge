/**
 * 测试夹具：chunk-safe 的 SSE 帧读取器。
 *
 * 为什么必须 chunk-safe：DSH 的流式模型解码器不是 chunk-safe 的，中文/emoji
 * 可能在一个码点中间被切开，留下孤立的 UTF-16 代理项。终端上看不见，但
 * `JSON.stringify` 会输出「语法合法、Go/Rust/Python 无法重新编码」的 JSON。
 *
 * 所以：**逐块用 `TextDecoder` 的 `{ stream: true }` 解码**，把不完整的尾部
 * 字节留在 decoder 内部，绝不允许「先把所有 Uint8Array 拼成一个大数组，
 * 一次性 `toString()` / `decode()`」。后者会在码点边界上直接产生 U+FFFD，
 * 这个 bug 在本机仓库的 src/protocol/sse.ts 已有专门实现，这里保持同样的
 * 解码纪律，但走独立的读取路径，这样「解码器本身错了」和「HTTP 流给错了」
 * 能被区分开。
 *
 * 注意 `{ stream: true }` 是 `decode(chunk, options)` 的参数，不是
 * `new TextDecoder()` 的构造参数（构造参数只有 fatal / ignoreBOM，多写的键
 * 会被静默忽略，看着对、其实没生效）。这里按 API 的正确位置传。
 *
 * 用法：
 *   for await (const frame of readSseFrames(response.body!)) { ... }
 *
 * 说明：Vitest **不做类型检查**，本文件的类型问题不会被 `npm test` 发现；
 * 本机未安装 node_modules，本文件未实际运行验证。
 */

const FRAME_BOUNDARY = /\r?\n\r?\n/

/**
 * 把 SSE 字节流逐帧读成 `data:` 字符串（跳过多余行、注释帧、heartbeat）。
 *
 * 生成器是惰性的：调用方 `break` 或抛错时会 `cancel()` 底层 reader，
 * 避免测试结束后还留着未关闭的 HTTP 连接。
 */
export async function* readSseData(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, unknown> {
  const decoder = new TextDecoder('utf-8', { fatal: false })
  const reader = stream.getReader()
  let buffer = ''
  let finished = false

  const drainCompleteFrames = (): string[] => {
    const frames: string[] = []
    for (;;) {
      const boundary = buffer.search(FRAME_BOUNDARY)
      if (boundary < 0) break

      const raw = buffer.slice(0, boundary)
      // 吃掉分隔符本身（\n\n 或 \r\n\r\n），不要把它留在下一帧开头。
      const separator = /^\r?\n\r?\n/.exec(buffer.slice(boundary))
      buffer = buffer.slice(boundary + (separator?.[0].length ?? 2))

      const data = dataOf(raw)
      if (data !== undefined) frames.push(data)
    }
    return frames
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      // 关键：stream: true —— 不完整的 UTF-8 序列会被 TextDecoder 扣住。
      buffer += decoder.decode(value, { stream: true })

      for (const data of drainCompleteFrames()) yield data
    }

    // 冲刷 decoder 里可能还留着的半个码点。
    const tail = decoder.decode()
    if (tail.length > 0) buffer += tail

    for (const data of drainCompleteFrames()) yield data

    // 宽容处理：对端在最后一帧后没写空行就关流。规范的发送方不会这样，
    // 但「关流即终态」的实现很容易漏掉最后一个空行，测试夹具不应因此卡死。
    if (buffer.trim().length > 0) {
      const data = dataOf(buffer)
      buffer = ''
      if (data !== undefined) yield data
    }

    finished = true
  } finally {
    if (!finished) {
      // 消费者提前退出：主动取消，确保底层连接被回收。
      try {
        await reader.cancel()
      } catch {
        // 连接可能已经断了，取消失败不影响用例结论。
      }
    }
    reader.releaseLock()
  }
}

/**
 * 逐帧读取并 JSON 解析（A2A v1.0 的帧体是 JSON-RPC 响应）。
 *
 * 解析失败直接抛错而不是跳过：静默跳过会让「服务端发了一帧坏 JSON」的用例
 * 假绿。错误信息里带上帧的前 200 字符，方便定位。
 */
export async function* readSseFrames(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown, void, unknown> {
  for await (const data of readSseData(stream)) {
    try {
      yield JSON.parse(data) as unknown
    } catch {
      const preview = data.length > 200 ? `${data.slice(0, 200)}…` : data
      throw new Error(`SSE 帧不是合法 JSON: ${preview}`)
    }
  }
}

/** 收齐整个流的全部帧（适用于「连接已结束」之后再做断言的用例）。 */
export async function readAllSseFrames(stream: ReadableStream<Uint8Array>): Promise<unknown[]> {
  const frames: unknown[] = []
  for await (const frame of readSseFrames(stream)) frames.push(frame)
  return frames
}

/** 收齐整个流的全部原始 data 字符串（不解 JSON，用于测编码/分帧本身）。 */
export async function readAllSseData(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const frames: string[] = []
  for await (const data of readSseData(stream)) frames.push(data)
  return frames
}

/**
 * 从一帧原始文本里抽出 data 行。
 *
 * 按 SSE 规范：`data` 字段可重复，多行用 `\n` 连接；以 `:` 开头的是注释
 * （heartbeat `: ping` 走这里被丢掉）；`event:` / `id:` / `retry:` 不参与。
 */
function dataOf(rawFrame: string): string | undefined {
  const lines = rawFrame.split(/\r?\n/)
  const dataLines: string[] = []

  for (const line of lines) {
    if (line.startsWith(':')) continue
    if (!line.startsWith('data:')) continue
    dataLines.push(line.slice('data:'.length).replace(/^ /, ''))
  }

  if (dataLines.length === 0) return undefined
  return dataLines.join('\n')
}

/** 便于测试单帧边界：把一段完整 SSE 文本切成任意大小的字节块。 */
export function chunkBytes(text: string, size = 1): Uint8Array[] {
  if (size <= 0) throw new Error('chunkBytes: size 必须 > 0')
  const bytes = new TextEncoder().encode(text)
  const chunks: Uint8Array[] = []
  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(bytes.slice(offset, offset + size))
  }
  return chunks
}

/** 用给定的字节块拼一个 `ReadableStream<Uint8Array>`，用于模拟网络分片。 */
export function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

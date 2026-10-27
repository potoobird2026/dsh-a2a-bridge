/**
 * SSE framing + the chunk-safe incremental decoder.
 *
 * The CJK split test is the whole reason `SseFrameDecoder` exists: a naive
 * `TextDecoder` per chunk leaves a lone surrogate / U+FFFD in the payload, and
 * the resulting JSON is valid on the wire but corrupt semantically.
 */

import { describe, expect, it } from 'vitest'

import { SSE_HEARTBEAT_FRAME } from '../../src/constants.js'
import { SseFrameDecoder, parseFrameJson, sseFrame, sseHeartbeat } from '../../src/protocol/sse.js'
import type { A2AStreamResponse } from '../../src/protocol/wire.js'

const encoder = new TextEncoder()

function encode(text: string): Uint8Array {
  return encoder.encode(text)
}

describe('sseFrame', () => {
  it('sseFrame(7, { task }) 使用 JSON-RPC 信封前缀并以空行结尾', () => {
    const payload: A2AStreamResponse = {
      task: { id: 'task-1', status: { state: 'TASK_STATE_WORKING' } },
    }
    const frame = sseFrame(7, payload)
    expect(
      frame.startsWith('data: {"jsonrpc":"2.0","id":7,"result":{"task":'),
    ).toBe(true)
    expect(frame.endsWith('\n\n')).toBe(true)
    expect(frame).toBe(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 7, result: payload })}\n\n`)
  })

  it('id 支持字符串，帧仍可被解析回原 payload', () => {
    const payload: A2AStreamResponse = {
      statusUpdate: {
        taskId: 'task-1',
        status: { state: 'TASK_STATE_COMPLETED' },
      },
    }
    const frame = sseFrame('req-1', payload)
    expect(frame.startsWith('data: {"jsonrpc":"2.0","id":"req-1","result":')).toBe(true)
    const data = frame.slice('data: '.length).trimEnd()
    expect(parseFrameJson(data)).toEqual({ jsonrpc: '2.0', id: 'req-1', result: payload })
  })

  it('id 为 null 时也输出 (JSON-RPC notification 情形)', () => {
    const frame = sseFrame(null, { task: { id: 't-1', status: { state: 'TASK_STATE_WORKING' } } })
    expect(frame.startsWith('data: {"jsonrpc":"2.0","id":null,"result":{"task":')).toBe(true)
  })

  it('帧内的 JSON 不会包含裸换行（一帧一行 data）', () => {
    const frame = sseFrame(1, {
      task: { id: 't-1', status: { state: 'TASK_STATE_WORKING' } },
    })
    const lines = frame.split('\n')
    expect(lines.filter((line) => line.startsWith('data: '))).toHaveLength(1)
    expect(lines[lines.length - 1]).toBe('')
    expect(lines[lines.length - 2]).toBe('')
  })
})

describe('sseHeartbeat', () => {
  it('心跳帧是注释帧常量', () => {
    expect(sseHeartbeat()).toBe(SSE_HEARTBEAT_FRAME)
    expect(sseHeartbeat()).toBe(': ping\n\n')
  })
})

describe('SseFrameDecoder — 分帧', () => {
  it('单个完整帧一次 push 即可取出', () => {
    const decoder = new SseFrameDecoder()
    const frames = decoder.push(encode('data: {"jsonrpc":"2.0","id":1}\n\n'))
    expect(frames).toEqual(['{"jsonrpc":"2.0","id":1}'])
  })

  it('一次 push 多个帧时全部取出', () => {
    const decoder = new SseFrameDecoder()
    const frames = decoder.push(encode('data: {"id":1}\n\ndata: {"id":2}\n\n'))
    expect(frames).toHaveLength(2)
    expect(frames[0]).toBe('{"id":1}')
    expect(frames[1]).toBe('{"id":2}')
  })

  it('两段 ASCII 跨帧边界切开仍能正确重组', () => {
    const decoder = new SseFrameDecoder()
    const bytes = encode('data: {"id":42,"result":{"ok":true}}\n\n')
    const split = 20
    const first = decoder.push(bytes.subarray(0, split))
    const second = decoder.push(bytes.subarray(split))
    expect(first).toEqual([])
    expect(second).toHaveLength(1)
    expect(parseFrameJson(second[0]!)).toEqual({
      id: 42,
      result: { ok: true },
    })
  })

  it('容忍 \\r\\n\\r\\n 帧边界', () => {
    const decoder = new SseFrameDecoder()
    const frames = decoder.push(encode('data: {"id":1}\r\n\r\n'))
    expect(frames).toEqual(['{"id":1}'])
  })

  it('多行 data: 按 SSE 规范以换行拼接', () => {
    const decoder = new SseFrameDecoder()
    const frames = decoder.push(encode('data: {"id":\ndata: 1}\n\n'))
    expect(frames).toHaveLength(1)
    expect(frames[0]).toBe('{"id":\n1}')
  })

  it('纯注释（心跳）帧不产生数据帧', () => {
    const decoder = new SseFrameDecoder()
    expect(decoder.push(encode(SSE_HEARTBEAT_FRAME))).toEqual([])
    // 心跳后面的真实帧仍能取出
    expect(decoder.push(encode('data: {"id":1}\n\n'))).toEqual(['{"id":1}'])
  })

  it('不完整的尾部帧被缓冲，补齐后才输出', () => {
    const decoder = new SseFrameDecoder()
    expect(decoder.push(encode('data: {"id":1}\n'))).toEqual([])
    expect(decoder.push(encode('\ndata: {"id":2}\n\n'))).toHaveLength(2)
  })

  it('flush 在无残余时返回空数组', () => {
    const decoder = new SseFrameDecoder()
    decoder.push(encode('data: {"id":1}\n\n'))
    expect(decoder.flush()).toEqual([])
  })
})

describe('SseFrameDecoder — chunk-safe（CJK 字节被切开）', () => {
  const CHINESE_TEXT = '你好，世界'
  const payload = {
    jsonrpc: '2.0',
    id: 42,
    result: {
      message: {
        messageId: 'm-1',
        role: 'ROLE_AGENT',
        parts: [{ text: CHINESE_TEXT }],
      },
    },
  }
  const frame = `data: ${JSON.stringify(payload)}\n\n`
  const bytes = encode(frame)

  // 在“你”(U+4F60, UTF-8 E4 BD A0) 的字节序列中间切开。
  const charIndex = frame.indexOf('你')
  const charByteOffset = encode(frame.slice(0, charIndex)).length
  const splitAt = charByteOffset + 1

  it('前提：切点确实落在一个中文字符的 UTF-8 序列内部', () => {
    expect(charIndex).toBeGreaterThanOrEqual(0)
    expect(bytes[charByteOffset]).toBe(0xe4)
    expect(splitAt).toBeLessThan(bytes.length)
    // 用“朴素”解码证明这一刀切坏了字符
    expect(new TextDecoder('utf-8').decode(bytes.subarray(0, splitAt))).toContain('\uFFFD')
  })

  it('两次 push 拆分后重组无替换字符，且 JSON 语义正确', () => {
    const decoder = new SseFrameDecoder()
    const first = decoder.push(bytes.subarray(0, splitAt))
    const second = decoder.push(bytes.subarray(splitAt))
    // 第一段不含完整帧边界，因此不应吐出任何帧
    expect(first).toEqual([])

    const frames = [...first, ...second]
    expect(frames).toHaveLength(1)

    const data = frames[0]!
    expect(data).not.toContain('\uFFFD')
    expect(data).toContain(CHINESE_TEXT)

    const parsed = parseFrameJson(data) as typeof payload
    expect(parsed).toBeDefined()
    expect(parsed.jsonrpc).toBe('2.0')
    expect(parsed.id).toBe(42)
    expect(parsed.result.message.parts[0]!.text).toBe(CHINESE_TEXT)
  })

  it('逐字节喂入整帧也不会产生替换字符', () => {
    const decoder = new SseFrameDecoder()
    const frames: string[] = []
    for (const byte of bytes) {
      frames.push(...decoder.push(Uint8Array.of(byte)))
    }
    expect(frames).toHaveLength(1)
    expect(frames[0]).not.toContain('\uFFFD')
    const parsed = parseFrameJson(frames[0]!) as typeof payload
    expect(parsed.result.message.parts[0]!.text).toBe(CHINESE_TEXT)
  })

  it('任意切点（含多段切分）都能重组出同一帧', () => {
    const decoder = new SseFrameDecoder()
    const cutPoints = [3, 17, splitAt, splitAt + 2, bytes.length - 4]
    const chunks: string[] = []
    let previous = 0
    for (const cut of cutPoints) {
      expect(cut).toBeGreaterThanOrEqual(previous)
      expect(cut).toBeLessThanOrEqual(bytes.length)
      chunks.push(...decoder.push(bytes.subarray(previous, cut)))
      previous = cut
    }
    chunks.push(...decoder.push(bytes.subarray(previous)))
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toBe(JSON.stringify(payload))
  })

  it('分块喂入多帧（含中文）时顺序与内容均保持', () => {
    const payloads = [
      { jsonrpc: '2.0', id: 1, result: { message: { parts: [{ text: '第一帧' }] } } },
      { jsonrpc: '2.0', id: 2, result: { task: { id: '任务-1' } } },
    ]
    const stream = encode(payloads.map((p) => `data: ${JSON.stringify(p)}`).join('\n\n') + '\n\n')
    const decoder = new SseFrameDecoder()
    const out: string[] = []
    const chunkSize = 7
    for (let offset = 0; offset < stream.length; offset += chunkSize) {
      out.push(...decoder.push(stream.subarray(offset, offset + chunkSize)))
    }
    expect(out).toHaveLength(2)
    expect(out.map((data) => parseFrameJson(data))).toEqual(payloads)
    expect(out.join('\n')).not.toContain('\uFFFD')
  })
})

describe('parseFrameJson', () => {
  it('合法 JSON 解析为对象', () => {
    expect(parseFrameJson('{"jsonrpc":"2.0","id":1}')).toEqual({ jsonrpc: '2.0', id: 1 })
  })

  it('非法 JSON 返回 undefined 而不抛错', () => {
    expect(parseFrameJson('{oops')).toBeUndefined()
    expect(parseFrameJson('')).toBeUndefined()
  })

  it('合法 JSON 数组 / 原始值照常解析', () => {
    expect(parseFrameJson('[1,2]')).toEqual([1, 2])
    expect(parseFrameJson('null')).toBeNull()
  })
})

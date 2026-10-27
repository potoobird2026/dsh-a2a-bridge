/**
 * Inbound parsing / validation (method table, Part, Message, Task status,
 * version negotiation).
 *
 * The strictness pinned here is the contract with v0.3 peers: reject loudly,
 * name the v1.0 replacement, never half-understand a request.
 */

import { describe, expect, it } from 'vitest'

import {
  InvalidParamsError,
  isLegacyMethod,
  isRecord,
  legacyMethodReplacement,
  parseMessage,
  parsePart,
  parseParts,
  parseRole,
  parseTaskStatus,
  partsToText,
  requireTaskId,
  resolveMethod,
  versionIsAcceptable,
} from '../../src/protocol/parse.js'
import { A2A_PROTOCOL_VERSION } from '../../src/constants.js'

describe('resolveMethod — v1.0 方法表', () => {
  it.each([
    ['SendMessage', 'send'],
    ['SendStreamingMessage', 'stream'],
    ['GetTask', 'get'],
    ['ListTasks', 'list'],
    ['CancelTask', 'cancel'],
    ['SubscribeToTask', 'subscribe'],
    ['CreateTaskPushNotificationConfig', 'push_create'],
    ['GetTaskPushNotificationConfig', 'push_get'],
    ['ListTaskPushNotificationConfigs', 'push_list'],
    ['DeleteTaskPushNotificationConfig', 'push_delete'],
    ['GetExtendedAgentCard', 'extended_card'],
  ])('resolveMethod(%s) === %s', (method, operation) => {
    expect(resolveMethod(method)).toBe(operation)
  })

  it('v0.3 方法名不被解析为操作', () => {
    expect(resolveMethod('message/send')).toBeUndefined()
    expect(resolveMethod('tasks/get')).toBeUndefined()
    expect(resolveMethod('agent/getAuthenticatedExtendedCard')).toBeUndefined()
  })

  it('undefined / 未知方法返回 undefined', () => {
    expect(resolveMethod(undefined)).toBeUndefined()
    expect(resolveMethod('SendMessage ')).toBeUndefined()
    expect(resolveMethod('sendmessage')).toBeUndefined()
  })

  it('legacyMethodReplacement 给出 v1.0 替代名', () => {
    expect(legacyMethodReplacement('message/send')).toBe('SendMessage')
    expect(legacyMethodReplacement('message/stream')).toBe('SendStreamingMessage')
    expect(legacyMethodReplacement('tasks/get')).toBe('GetTask')
    expect(legacyMethodReplacement('tasks/cancel')).toBe('CancelTask')
    expect(legacyMethodReplacement('tasks/resubscribe')).toBe('SubscribeToTask')
    expect(legacyMethodReplacement('tasks/pushNotificationConfig/set')).toBe(
      'CreateTaskPushNotificationConfig',
    )
    expect(legacyMethodReplacement('agent/getAuthenticatedExtendedCard')).toBe(
      'GetExtendedAgentCard',
    )
  })

  it('legacyMethodReplacement 对 v1.0 / undefined 方法返回 undefined', () => {
    expect(legacyMethodReplacement('SendMessage')).toBeUndefined()
    expect(legacyMethodReplacement(undefined)).toBeUndefined()
  })

  it('isLegacyMethod 区分两套命名', () => {
    expect(isLegacyMethod('message/send')).toBe(true)
    expect(isLegacyMethod('SendMessage')).toBe(false)
    expect(isLegacyMethod(undefined)).toBe(false)
  })
})

describe('requireTaskId', () => {
  it('requireTaskId(undefined) 抛 InvalidParamsError', () => {
    expect(() => requireTaskId(undefined)).toThrow(InvalidParamsError)
    expect(() => requireTaskId(undefined)).toThrow(/id is required/)
  })

  it('空字符串 / 非字符串同样抛错', () => {
    expect(() => requireTaskId('')).toThrow(InvalidParamsError)
    expect(() => requireTaskId(42)).toThrow(InvalidParamsError)
    expect(() => requireTaskId(null)).toThrow(InvalidParamsError)
  })

  it('InvalidParamsError 的 code 固定为 -32602', () => {
    try {
      requireTaskId(undefined)
      expect.unreachable('requireTaskId 应当抛错')
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidParamsError)
      expect((error as InvalidParamsError).code).toBe(-32602)
    }
  })

  it('requireTaskId("abc") === "abc"', () => {
    expect(requireTaskId('abc')).toBe('abc')
  })

  it('支持自定义参数名', () => {
    expect(requireTaskId('abc', 'taskId')).toBe('abc')
    expect(() => requireTaskId(undefined, 'taskId')).toThrow(/taskId is required/)
  })
})

describe('isRecord', () => {
  it('只接受普通对象', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord({ a: 1 })).toBe(true)
    expect(isRecord(null)).toBe(false)
    expect(isRecord([])).toBe(false)
    expect(isRecord('x')).toBe(false)
    expect(isRecord(undefined)).toBe(false)
  })
})

describe('parsePart — v1.0 统一 Part', () => {
  it('v0.3 嵌套 file Part 被丢弃', () => {
    const parsed = parsePart({
      kind: 'file',
      file: { name: 'a.txt', uri: 'https://x/a.txt' },
    })
    expect(parsed).toBeUndefined()
  })

  it('v0.3 {kind:"text"} 仍能解析，kind 被忽略而非被解释', () => {
    const parsed = parsePart({ kind: 'text', text: 'hello' })
    expect(parsed).toBeDefined()
    expect(parsed!.text).toBe('hello')
    expect(parsed!.data).toBeUndefined()
    expect((parsed as unknown as Record<string, unknown>).kind).toBeUndefined()
  })

  it('扁平 file Part（url + filename + mediaType）被接受', () => {
    const parsed = parsePart({
      url: 'https://x/a.txt',
      filename: 'a.txt',
      mediaType: 'text/plain',
    })
    expect(parsed).toBeDefined()
    expect(parsed!.url).toBe('https://x/a.txt')
    expect(parsed!.filename).toBe('a.txt')
    expect(parsed!.mediaType).toBe('text/plain')
  })

  it('data Part 被接受（含 falsy 值）', () => {
    expect(parsePart({ data: { a: 1 } })!.data).toEqual({ a: 1 })
    expect(parsePart({ data: 0 })!.data).toBe(0)
    expect(parsePart({ data: false })!.data).toBe(false)
    expect(parsePart({ data: null })!.data).toBeNull()
  })

  it('raw 二进制 Part 被接受', () => {
    const bytes = new Uint8Array([1, 2, 3])
    const parsed = parsePart({ raw: bytes, filename: 'b.bin' })
    expect(parsed).toBeDefined()
    expect(parsed!.raw).toBe(bytes)
    expect(parsed!.filename).toBe('b.bin')
  })

  it('空对象 / 非对象 / 只有 kind 的对象被丢弃', () => {
    expect(parsePart({})).toBeUndefined()
    expect(parsePart(null)).toBeUndefined()
    expect(parsePart('text')).toBeUndefined()
    expect(parsePart({ kind: 'data' })).toBeUndefined()
  })

  it('保留 metadata', () => {
    const parsed = parsePart({ text: 'hi', metadata: { trace: 't-1' } })
    expect(parsed!.metadata).toEqual({ trace: 't-1' })
  })
})

describe('parseParts / partsToText', () => {
  it('parseParts 丢弃无法识别的元素', () => {
    const parts = parseParts([
      { text: 'hello' },
      { kind: 'file', file: { name: 'a.txt', uri: 'https://x/a.txt' } },
      { data: { n: 1 } },
    ])
    expect(parts).toHaveLength(2)
    expect(parts[0]!.text).toBe('hello')
    expect(parts[1]!.data).toEqual({ n: 1 })
  })

  it('parseParts 对非数组返回空数组', () => {
    expect(parseParts(undefined)).toEqual([])
    expect(parseParts({})).toEqual([])
  })

  it('partsToText 拼接 text 并序列化 data，丢弃 file/raw', () => {
    const parts = parsePart({ text: 'hello' })!
    const dataPart = parsePart({ data: { n: 1 } })!
    const filePart = parsePart({ url: 'https://x/a.txt' })!
    expect(partsToText([parts, dataPart, filePart])).toBe('hello\n{"n":1}')
  })
})

describe('parseRole', () => {
  it('识别 ProtoJSON 角色名', () => {
    expect(parseRole('ROLE_USER')).toBe('ROLE_USER')
    expect(parseRole('ROLE_AGENT')).toBe('ROLE_AGENT')
    expect(parseRole('ROLE_UNSPECIFIED')).toBe('ROLE_UNSPECIFIED')
  })

  it('未知角色归一为 ROLE_UNSPECIFIED', () => {
    expect(parseRole('user')).toBe('ROLE_UNSPECIFIED')
    expect(parseRole(1)).toBe('ROLE_UNSPECIFIED')
    expect(parseRole(undefined)).toBe('ROLE_UNSPECIFIED')
  })
})

describe('parseMessage', () => {
  it('解析 v1.0 消息', () => {
    const message = parseMessage({
      messageId: 'm-1',
      role: 'ROLE_USER',
      parts: [{ text: 'hello' }],
      contextId: 'ctx-1',
      taskId: 't-1',
    })
    expect(message).toBeDefined()
    expect(message!.messageId).toBe('m-1')
    expect(message!.role).toBe('ROLE_USER')
    expect(message!.parts).toHaveLength(1)
    expect(message!.contextId).toBe('ctx-1')
    expect(message!.taskId).toBe('t-1')
  })

  it('缺 messageId 或 messageId 为空时返回 undefined', () => {
    expect(parseMessage({ role: 'ROLE_USER', parts: [] })).toBeUndefined()
    expect(parseMessage({ messageId: '', role: 'ROLE_USER', parts: [] })).toBeUndefined()
    expect(parseMessage(null)).toBeUndefined()
  })
})

describe('parseTaskStatus', () => {
  it('解析合法状态', () => {
    const status = parseTaskStatus({ state: 'TASK_STATE_WORKING' })
    expect(status).toBeDefined()
    expect(status!.state).toBe('TASK_STATE_WORKING')
  })

  it('拒绝 v0.3 小写状态与未知状态', () => {
    expect(parseTaskStatus({ state: 'working' })).toBeUndefined()
    expect(parseTaskStatus({ state: 'TASK_STATE_NOPE' })).toBeUndefined()
    expect(parseTaskStatus({})).toBeUndefined()
    expect(parseTaskStatus(null)).toBeUndefined()
  })
})

describe('versionIsAcceptable — A2A-Version 头协商（规范 §3.6.2）', () => {
  it('strict 模式下缺失版本头不通过', () => {
    const result = versionIsAcceptable(undefined, true)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.requested).toBe('')
  })

  it('非 strict 模式下缺失版本头通过', () => {
    const result = versionIsAcceptable(undefined, false)
    expect(result.ok).toBe(true)
  })

  it('strict 模式下空 / 仅空白版本头不通过', () => {
    expect(versionIsAcceptable('', true).ok).toBe(false)
    expect(versionIsAcceptable('   ', true).ok).toBe(false)
  })

  it('接受 1.0 与 1.0.0（允许前后空白）', () => {
    expect(versionIsAcceptable(A2A_PROTOCOL_VERSION, true).ok).toBe(true)
    expect(versionIsAcceptable('1.0.0', true).ok).toBe(true)
    expect(versionIsAcceptable(' 1.0 ', true).ok).toBe(true)
  })

  it('拒绝 0.3 等其他版本', () => {
    const result = versionIsAcceptable('0.3', true)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.requested).toBe('0.3')
    expect(versionIsAcceptable('2.0', false).ok).toBe(false)
  })
})

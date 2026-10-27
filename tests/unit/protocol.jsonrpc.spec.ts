/**
 * JSON-RPC 2.0 envelopes + the A2A error vocabulary.
 *
 * The error-code block is deliberately one assertion per code: these numbers
 * go on the wire and a peer's retry/fallback logic keys off them.
 */

import { describe, expect, it } from 'vitest'

import { A2A_ERROR_DOMAIN, ERROR_INFO_TYPE } from '../../src/constants.js'
import {
  ERR_CONTENT_TYPE_NOT_SUPPORTED,
  ERR_EXTENDED_CARD_NOT_CONFIGURED,
  ERR_EXTENSION_SUPPORT_REQUIRED,
  ERR_INTERNAL,
  ERR_INVALID_AGENT_RESPONSE,
  ERR_INVALID_PARAMS,
  ERR_INVALID_REQUEST,
  ERR_METHOD_NOT_FOUND,
  ERR_PARSE,
  ERR_PUSH_NOT_SUPPORTED,
  ERR_TASK_NOT_CANCELABLE,
  ERR_TASK_NOT_FOUND,
  ERR_UNSUPPORTED_OPERATION,
  ERR_VERSION_NOT_SUPPORTED,
  INTERNAL_ERROR,
  errorDetails,
  invalidParams,
  jsonRpcError,
  jsonRpcResult,
  methodNotFound,
  parseJsonRpc,
  taskNotFound,
  versionNotSupported,
} from '../../src/protocol/jsonrpc.js'

describe('A2A 错误码精确值（-32001..-32009）', () => {
  it.each([
    ['TaskNotFound', ERR_TASK_NOT_FOUND, -32001],
    ['TaskNotCancelable', ERR_TASK_NOT_CANCELABLE, -32002],
    ['PushNotificationNotSupported', ERR_PUSH_NOT_SUPPORTED, -32003],
    ['UnsupportedOperation', ERR_UNSUPPORTED_OPERATION, -32004],
    ['ContentTypeNotSupported', ERR_CONTENT_TYPE_NOT_SUPPORTED, -32005],
    ['InvalidAgentResponse', ERR_INVALID_AGENT_RESPONSE, -32006],
    ['ExtendedCardNotConfigured', ERR_EXTENDED_CARD_NOT_CONFIGURED, -32007],
    ['ExtensionSupportRequired', ERR_EXTENSION_SUPPORT_REQUIRED, -32008],
    ['VersionNotSupported', ERR_VERSION_NOT_SUPPORTED, -32009],
  ])('%s 的错误码为 %i', (_name, actual, expected) => {
    expect(actual).toBe(expected)
  })

  it('JSON-RPC 保留错误码不被 A2A 域占用', () => {
    expect(ERR_PARSE).toBe(-32700)
    expect(ERR_INVALID_REQUEST).toBe(-32600)
    expect(ERR_METHOD_NOT_FOUND).toBe(-32601)
    expect(ERR_INVALID_PARAMS).toBe(-32602)
    expect(ERR_INTERNAL).toBe(-32603)
  })

  it('A2A 错误码区间内没有 -32609（该码不存在）', () => {
    const a2aCodes = [
      ERR_TASK_NOT_FOUND,
      ERR_TASK_NOT_CANCELABLE,
      ERR_PUSH_NOT_SUPPORTED,
      ERR_UNSUPPORTED_OPERATION,
      ERR_CONTENT_TYPE_NOT_SUPPORTED,
      ERR_INVALID_AGENT_RESPONSE,
      ERR_EXTENDED_CARD_NOT_CONFIGURED,
      ERR_EXTENSION_SUPPORT_REQUIRED,
      ERR_VERSION_NOT_SUPPORTED,
    ]
    expect(a2aCodes).not.toContain(-32609)
  })
})

describe('JSON-RPC 信封', () => {
  it('jsonRpcResult 构造成功响应', () => {
    const response = jsonRpcResult(7, { task: { id: 't-1' } })
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { task: { id: 't-1' } },
    })
    expect(response.error).toBeUndefined()
  })

  it('jsonRpcError 构造错误响应（无 data）', () => {
    const response = jsonRpcError(null, ERR_PARSE, 'parse error')
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: ERR_PARSE, message: 'parse error' },
    })
    expect(response.result).toBeUndefined()
    expect(response.error!.data).toBeUndefined()
  })

  it('jsonRpcError 携带 data 时保留 data', () => {
    const data = [{ '@type': ERROR_INFO_TYPE }]
    const response = jsonRpcError('req-1', ERR_INVALID_PARAMS, 'bad params', data)
    expect(response.error!.data).toEqual(data)
  })
})

describe('ErrorInfo details', () => {
  it('errorDetails 冒号 reason/domain/@type', () => {
    const details = errorDetails('SOME_REASON') as Array<Record<string, unknown>>
    expect(details).toHaveLength(1)
    expect(details[0]!['@type']).toBe(ERROR_INFO_TYPE)
    expect(details[0]!.reason).toBe('SOME_REASON')
    expect(details[0]!.domain).toBe(A2A_ERROR_DOMAIN)
    expect(details[0]!.metadata).toBeUndefined()
  })

  it('errorDetails 合并 metadata', () => {
    const details = errorDetails('SOME_REASON', { taskId: 't-1' }) as Array<Record<string, unknown>>
    expect(details[0]!.metadata).toEqual({ taskId: 't-1' })
  })

  it('versionNotSupported 使用 -32009 并携带 requested/supported', () => {
    const error = versionNotSupported('0.3', '1.0')
    expect(error.code).toBe(ERR_VERSION_NOT_SUPPORTED)
    expect(error.message).toContain('0.3')
    expect(error.message).toContain('1.0')
    const details = error.data as Array<Record<string, unknown>>
    expect(details[0]!.reason).toBe('VERSION_NOT_SUPPORTED')
    expect(details[0]!.metadata).toEqual({ requested: '0.3', supported: '1.0' })
  })

  it('taskNotFound 使用 -32001 并在 message 中带上 taskId', () => {
    const error = taskNotFound('t-404')
    expect(error.code).toBe(ERR_TASK_NOT_FOUND)
    expect(error.message).toContain('t-404')
  })
})

describe('parseJsonRpc', () => {
  it('非对象输入返回 ParseError', () => {
    const result = parseJsonRpc('not json')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe(ERR_PARSE)
      expect(result.id).toBeNull()
    }
  })

  it('数组输入返回 ParseError（不支持批次）', () => {
    const result = parseJsonRpc([])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ERR_PARSE)
  })

  it('jsonrpc !== "2.0" 时返回 InvalidRequest 并保留 id', () => {
    const result = parseJsonRpc({ jsonrpc: '1.0', id: 9, method: 'SendMessage' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe(ERR_INVALID_REQUEST)
      expect(result.id).toBe(9)
    }
  })

  it('合法请求返回 ok 与 method/params', () => {
    const result = parseJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'SendMessage',
      params: { message: { messageId: 'm-1' } },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.request.jsonrpc).toBe('2.0')
      expect(result.request.id).toBe(1)
      expect(result.request.method).toBe('SendMessage')
      expect(result.request.params).toEqual({ message: { messageId: 'm-1' } })
    }
  })

  it('缺省 id 归一为 null，缺省 method 归一为 undefined', () => {
    const result = parseJsonRpc({ jsonrpc: '2.0' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.request.id).toBeNull()
      expect(result.request.method).toBeUndefined()
    }
  })
})

describe('其余错误构造器', () => {
  it('methodNotFound 在 message 中点名 v1.0 替代方法', () => {
    const error = methodNotFound('message/send', 'SendMessage')
    expect(error.code).toBe(ERR_METHOD_NOT_FOUND)
    expect(error.message).toContain('message/send')
    expect(error.message).toContain('SendMessage')
  })

  it('methodNotFound 无替代方法时只报方法名', () => {
    const error = methodNotFound('NoSuchMethod')
    expect(error.message).toBe('method not found: NoSuchMethod')
  })

  it('invalidParams 使用 -32602', () => {
    const error = invalidParams('id is required')
    expect(error.code).toBe(ERR_INVALID_PARAMS)
    expect(error.message).toBe('id is required')
  })

  it('INTERNAL_ERROR 不泄漏内部细节', () => {
    expect(INTERNAL_ERROR.code).toBe(ERR_INTERNAL)
    expect(INTERNAL_ERROR.message).toBe('internal error')
    expect(INTERNAL_ERROR.data).toBeUndefined()
  })
})

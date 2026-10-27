/**
 * Wire vocabulary: task states, message roles, stream payload keys.
 *
 * Cheap tests, but they pin the ProtoJSON spelling — the one thing v0.3 peers
 * will send in lowercase and v1.0 peers must never emit.
 */

import { describe, expect, it } from 'vitest'

import { A2A_PROTOCOL_VERSION, JSONRPC_BINDING } from '../../src/constants.js'
import {
  MESSAGE_ROLES,
  STREAM_KEYS,
  TASK_STATES,
  defaultInterface,
  isTaskState,
  streamKeyOf,
} from '../../src/protocol/wire.js'

describe('TASK_STATES', () => {
  it('恰好九个 v1.0 状态，且为 ProtoJSON 大写拼写', () => {
    expect(TASK_STATES).toHaveLength(9)
    expect(TASK_STATES).toContain('TASK_STATE_WORKING')
    expect(TASK_STATES).toContain('TASK_STATE_INPUT_REQUIRED')
    expect(TASK_STATES).toContain('TASK_STATE_REJECTED')
    expect(TASK_STATES).not.toContain('working')
    expect(TASK_STATES).not.toContain('TASK_STATE_CANCELLED')
  })

  it('isTaskState 只接受表内大写值', () => {
    expect(isTaskState('TASK_STATE_COMPLETED')).toBe(true)
    expect(isTaskState('completed')).toBe(false)
    expect(isTaskState(undefined)).toBe(false)
    expect(isTaskState(3)).toBe(false)
  })
})

describe('MESSAGE_ROLES', () => {
  it('使用 ROLE_* 拼写', () => {
    expect(MESSAGE_ROLES).toEqual(['ROLE_UNSPECIFIED', 'ROLE_USER', 'ROLE_AGENT'])
  })
})

describe('STREAM_KEYS / streamKeyOf', () => {
  it('四个流事件键', () => {
    expect(STREAM_KEYS).toEqual(['task', 'message', 'statusUpdate', 'artifactUpdate'])
  })

  it('streamKeyOf 返回唯一非空键', () => {
    expect(streamKeyOf({ task: { id: 't', status: { state: 'TASK_STATE_WORKING' } } })).toBe('task')
    expect(streamKeyOf({ message: {} as never })).toBe('message')
    expect(streamKeyOf({ statusUpdate: {} as never })).toBe('statusUpdate')
    expect(streamKeyOf({ artifactUpdate: {} as never })).toBe('artifactUpdate')
  })

  it('streamKeyOf 对空响应返回 undefined', () => {
    expect(streamKeyOf({})).toBeUndefined()
  })

  it('streamKeyOf 按固定优先级返回第一个键', () => {
    expect(
      streamKeyOf({
        task: { id: 't', status: { state: 'TASK_STATE_WORKING' } },
        message: {} as never,
      }),
    ).toBe('task')
  })
})

describe('defaultInterface', () => {
  it('使用常量中的协议版本与绑定方式', () => {
    const iface = defaultInterface('https://agent.example.test/a2a')
    expect(iface).toEqual({
      url: 'https://agent.example.test/a2a',
      protocolBinding: JSONRPC_BINDING,
      protocolVersion: A2A_PROTOCOL_VERSION,
    })
    expect(iface.protocolBinding).toBe('JSONRPC')
    expect(iface.protocolVersion).toBe('1.0')
  })
})

/**
 * Agent Card construction / parsing — pinned against A2A v1.0.
 *
 * These tests exist because the v0.3 card shape is still widespread and it is
 * easy to "helpfully" re-add a member v1.0 deleted. Every assertion here is a
 * boundary the implementation must not cross.
 */

import { describe, expect, it } from 'vitest'

import {
  A2A_PROTOCOL_VERSION,
  INBOUND_STREAMING_IMPLEMENTED,
  JSONRPC_BINDING,
} from '../../src/constants.js'
import {
  AgentCardError,
  buildAgentCard,
  cardLabel,
  parseAgentCard,
} from '../../src/protocol/card.js'
import type { A2AAgentSkill } from '../../src/protocol/wire.js'

const BASE_INPUT = {
  name: 'dsh-a2a-bridge',
  description: 'A2A v1.0 bridge for DeepSeek Harness',
  version: '0.1.0',
  url: 'https://agent.example.test/a2a',
} as const

/** Members v1.0 removed from the card; the builder must never emit them. */
const REMOVED_V0_3_MEMBERS = [
  'protocolVersion',
  'url',
  'preferredTransport',
  'additionalInterfaces',
  'supportsAuthenticatedExtendedCard',
  'security',
] as const

describe('buildAgentCard — v1.0 shape', () => {
  const card = buildAgentCard(BASE_INPUT)
  const raw = card as unknown as Record<string, unknown>

  it.each([...REMOVED_V0_3_MEMBERS])('不输出 v0.3 成员 %s', (member) => {
    expect(raw[member]).toBeUndefined()
    expect(member in raw).toBe(false)
  })

  it('supportedInterfaces 只有一项，且形状符合 v1.0', () => {
    expect(card.supportedInterfaces).toHaveLength(1)
    const iface = card.supportedInterfaces[0]!
    expect(iface.url).toBe(BASE_INPUT.url)
    expect(iface.protocolBinding).toBe('JSONRPC')
    expect(iface.protocolBinding).toBe(JSONRPC_BINDING)
    expect(iface.protocolVersion).toBe('1.0')
    expect(iface.protocolVersion).toBe(A2A_PROTOCOL_VERSION)
  })

  it('基础字段与默认能力值', () => {
    expect(card.name).toBe(BASE_INPUT.name)
    expect(card.description).toBe(BASE_INPUT.description)
    expect(card.version).toBe(BASE_INPUT.version)
    expect(card.defaultInputModes).toEqual(['text/plain'])
    expect(card.defaultOutputModes).toEqual(['text/plain'])
    // Follows the implementation constant: when streaming is wired this is true,
    // and the card may only claim it because `dispatch` really does stream.
    expect(card.capabilities.streaming).toBe(INBOUND_STREAMING_IMPLEMENTED)
    expect(card.capabilities.pushNotifications).toBe(false)
    expect(card.capabilities.extendedAgentCard).toBe(false)
  })

  it('能力位跟随实现：默认不声明流式，显式传入才生效', () => {
    // 回归测试。曾经默认 true，而 dispatch 对 SendStreamingMessage 恒返回
    // -32004 —— 对端看到能力位会尝试流式,然后收到「未实现」。能力位必须如实
    // 反映实现,否则失败点会跑到对端去,本地看不到任何异常。
    //
    // 默认值现在来自常量 INBOUND_STREAMING_IMPLEMENTED，dispatch 读同一个常量。
    // 所以这条断言同时钉住两边：翻转常量会在这里失败，提醒实现必须一起落地。
    expect(buildAgentCard(BASE_INPUT).capabilities.streaming).toBe(INBOUND_STREAMING_IMPLEMENTED)
    expect(buildAgentCard({ ...BASE_INPUT, streaming: true }).capabilities.streaming).toBe(true)
  })

  it('未声明 skills 时使用 FALLBACK_SKILL', () => {
    expect(card.skills).toHaveLength(1)
    expect(card.skills[0]!.id).toBe('general')
  })

  it('显式声明的 skills 原样保留', () => {
    const skills: readonly A2AAgentSkill[] = [
      { id: 'echo', name: 'Echo', description: 'echoes input', tags: ['echo', 'text'] },
    ]
    const declared = buildAgentCard({ ...BASE_INPUT, skills })
    expect(declared.skills).toEqual(skills)
  })

  it('extendedSkills 非空时 capabilities.extendedAgentCard 为 true', () => {
    const skill: A2AAgentSkill = { id: 'x', name: 'X', description: 'x', tags: [] }
    const extended = buildAgentCard({ ...BASE_INPUT, extendedSkills: [skill] })
    expect(extended.capabilities.extendedAgentCard).toBe(true)
    // 注意：extendedSkills 只影响能力位，不应泄漏进公开的 skills 列表。
    expect(extended.skills).toHaveLength(1)
    expect(extended.skills[0]!.id).toBe('general')
  })

  it('无 authRequired 时不输出 securitySchemes / securityRequirements', () => {
    expect(raw.securitySchemes).toBeUndefined()
    expect(raw.securityRequirements).toBeUndefined()
    expect('security' in raw).toBe(false)
  })

  it('authRequired: true 使用 httpAuthSecurityScheme.bearer，并输出 securityRequirements', () => {
    const withAuth = buildAgentCard({ ...BASE_INPUT, authRequired: true })
    const schemes = withAuth.securitySchemes as
      | Record<string, { httpAuthSecurityScheme?: { scheme: string } }>
      | undefined
    expect(schemes).toBeDefined()
    expect(schemes?.bearer?.httpAuthSecurityScheme?.scheme).toBe('Bearer')
    // v0.3 的裸 securitySchemes.bearer 形状不应出现
    expect((schemes?.bearer as unknown as Record<string, unknown> | undefined)?.type).toBeUndefined()
    expect(withAuth.securityRequirements).toBeDefined()
    expect(Array.isArray(withAuth.securityRequirements)).toBe(true)
    expect(withAuth.securityRequirements).toHaveLength(1)
    expect(withAuth.securityRequirements![0]!.schemes.bearer).toBeDefined()
    // v0.3 的 security 成员仍然是 undefined
    expect((withAuth as unknown as Record<string, unknown>).security).toBeUndefined()
  })
})

describe('cardLabel', () => {
  it('返回 name + 首个 skill 名称', () => {
    const card = buildAgentCard(BASE_INPUT)
    expect(cardLabel(card)).toBe('dsh-a2a-bridge (general)')
  })
})

describe('parseAgentCard — v1.0 解析与接口选择', () => {
  const v1Card = {
    name: 'remote-agent',
    description: 'remote agent',
    version: '1.0.0',
    supportedInterfaces: [
      { url: 'https://remote.example.test/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
    ],
    capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{ id: 'echo', name: 'Echo', description: 'echoes', tags: ['echo'] }],
  }

  it('解析合法 v1.0 card 并选中 JSONRPC 接口', () => {
    const parsed = parseAgentCard(v1Card)
    expect(parsed.card.name).toBe('remote-agent')
    expect(parsed.card.skills[0]!.id).toBe('echo')
    expect(parsed.selectedInterface.url).toBe('https://remote.example.test/a2a')
    expect(parsed.selectedInterface.protocolBinding).toBe('JSONRPC')
    expect(parsed.warnings).toEqual([])
  })

  it('优先选择 JSONRPC 接口，而不是简单取第一个', () => {
    const parsed = parseAgentCard({
      ...v1Card,
      supportedInterfaces: [
        { url: 'https://remote.example.test/grpc', protocolBinding: 'GRPC', protocolVersion: '1.0' },
        { url: 'https://remote.example.test/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
      ],
    })
    expect(parsed.selectedInterface.protocolBinding).toBe('JSONRPC')
    expect(parsed.selectedInterface.url).toBe('https://remote.example.test/a2a')
    expect(parsed.warnings).toEqual([])
  })

  it('没有 JSONRPC 接口时回退到第一个并记录 warning', () => {
    const parsed = parseAgentCard({
      ...v1Card,
      supportedInterfaces: [
        { url: 'https://remote.example.test/grpc', protocolBinding: 'GRPC', protocolVersion: '1.0' },
      ],
    })
    expect(parsed.selectedInterface.protocolBinding).toBe('GRPC')
    expect(parsed.warnings.length).toBeGreaterThan(0)
    expect(parsed.warnings[0]).toContain('no JSONRPC interface')
  })

  it('接口 protocolVersion 为 0.3 时抛错（不静默降级）', () => {
    expect(() =>
      parseAgentCard({
        ...v1Card,
        supportedInterfaces: [
          { url: 'https://remote.example.test/a2a', protocolBinding: 'JSONRPC', protocolVersion: '0.3' },
        ],
      }),
    ).toThrow(/0\.3/)
  })

  it('接口缺省 protocolVersion 时按 1.0 处理并记录 warning', () => {
    const parsed = parseAgentCard({
      ...v1Card,
      supportedInterfaces: [{ url: 'https://remote.example.test/a2a', protocolBinding: 'JSONRPC' }],
    })
    expect(parsed.card.supportedInterfaces[0]!.protocolVersion).toBe('1.0')
    expect(parsed.warnings.some((w) => w.includes('protocolVersion'))).toBe(true)
  })

  it('v0.3 形状（顶层 url + preferredTransport，无 supportedInterfaces）抛错且信息提到 v0.3', () => {
    const v03Card = {
      name: 'legacy-agent',
      description: 'A v0.3 card',
      version: '0.3.0',
      url: 'https://legacy.example.test/a2a',
      preferredTransport: 'JSONRPC',
      capabilities: { streaming: true, pushNotifications: false },
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: [],
    }
    expect(() => parseAgentCard(v03Card)).toThrow(AgentCardError)
    expect(() => parseAgentCard(v03Card)).toThrow(/v0\.3/)
    expect(() => parseAgentCard(v03Card)).toThrow(/preferredTransport/)
  })

  it('没有 supportedInterfaces 且没有 url 时抛错', () => {
    expect(() => parseAgentCard({ name: 'x' })).toThrow(/no supportedInterfaces/)
  })

  it('非对象输入抛错', () => {
    expect(() => parseAgentCard(null)).toThrow(AgentCardError)
    expect(() => parseAgentCard([])).toThrow(/not an object/)
  })

  it('缺 name 抛错', () => {
    expect(() =>
      parseAgentCard({
        supportedInterfaces: [
          { url: 'https://remote.example.test/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
        ],
      }),
    ).toThrow(/no name/)
  })
})

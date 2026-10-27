/**
 * Provider streaming path.
 *
 * `src/outbound/provider.ts` had NO unit coverage until now, which is exactly how
 * its streaming branch could have stayed dead code. The three network calls are
 * injectable seams (`discoverCard` / `send` / `stream`), so this test drives the
 * real provider logic without an HTTP server.
 *
 * What is pinned:
 *   - a peer advertising `streaming: true` is consumed through the STREAM, and each
 *     progress label reaches `onProgress` (that is the local mirror updating live);
 *   - a peer that does not advertise streaming keeps the polling path, untouched;
 *   - a stream that closes without a terminal state is NOT reported as success.
 */

import { describe, expect, it } from 'vitest'

import type { DiscoveredContact } from '../../src/outbound/client.js'
import { A2aSubagentProvider, type ProviderOptions } from '../../src/outbound/provider.js'
import { buildAgentCard } from '../../src/protocol/card.js'
import type { A2AStreamResponse, TaskState } from '../../src/protocol/wire.js'

const CONTACT = {
  name: 'peer-b',
  url: 'http://127.0.0.1:9/a2a',
  agentCardPath: '/.well-known/agent-card.json',
  tokenEnv: 'A2A_TOKEN_PEER_B',
  timeoutMs: 5_000,
}

function discovered(streaming: boolean): DiscoveredContact {
  return {
    card: buildAgentCard({
      name: 'remote-agent',
      description: 'test agent',
      version: '0.1.0',
      url: CONTACT.url,
      authRequired: true,
      streaming,
    }),
    url: CONTACT.url,
    agentCardPath: CONTACT.agentCardPath,
    warnings: [],
  }
}

function agentMessage(text: string): { messageId: string, role: 'ROLE_AGENT', parts: Array<{ text: string }> } {
  return { messageId: 'msg-1', role: 'ROLE_AGENT', parts: [{ text }] }
}

interface Harness {
  readonly provider: A2aSubagentProvider
  readonly phases: Array<{ phase: string, detail?: string }>
  readonly exchanges: Array<{ direction: string, text: string }>
  readonly calls: { send: number, stream: number }
}

function harness(options: {
  streaming: boolean
  streamResult?: { text: string, state?: TaskState }
  frames?: A2AStreamResponse[]
}): Harness {
  const phases: Array<{ phase: string, detail?: string }> = []
  const exchanges: Array<{ direction: string, text: string }> = []
  const calls = { send: 0, stream: 0 }

  const providerOptions: ProviderOptions = {
    providerName: 'a2a',
    contacts: [CONTACT],
    resolveToken: async () => 'token',
    discoverCard: async () => discovered(options.streaming),
    send: async () => {
      calls.send += 1
      return { text: 'POLLED-ANSWER', terminatedEarly: false }
    },
    stream: async (_contact, _input, streamOptions) => {
      calls.stream += 1
      for (const frame of options.frames ?? []) streamOptions?.onStreamFrame?.(frame)
      return options.streamResult ?? { text: 'STREAMED-ANSWER', state: 'TASK_STATE_COMPLETED' as TaskState }
    },
    onProgress: (progress) => phases.push({ phase: progress.phase, detail: progress.detail }),
    onExchange: (exchange) => exchanges.push({ direction: exchange.direction, text: exchange.text }),
  }

  return { provider: new A2aSubagentProvider(providerOptions), phases, exchanges, calls }
}

async function run(harnessed: Harness) {
  const runHandle = await harnessed.provider.start({
    prompt: [{ type: 'text', text: 'hello peer' }],
    signal: new AbortController().signal,
  })
  return runHandle.result
}

const PROGRESS_FRAME = {
  statusUpdate: {
    taskId: 'task-1',
    status: { state: 'TASK_STATE_WORKING' as TaskState, message: agentMessage('已发送，等待模型') },
  },
} as A2AStreamResponse

const ARTIFACT_FRAME = {
  artifactUpdate: {
    taskId: 'task-1',
    artifact: { artifactId: 'task-1-result', parts: [{ text: 'STREAMED-ANSWER' }] },
    index: 0,
    lastChunk: true,
  },
} as A2AStreamResponse

const TERMINAL_FRAME = {
  statusUpdate: { taskId: 'task-1', status: { state: 'TASK_STATE_COMPLETED' as TaskState } },
} as A2AStreamResponse

describe('provider: streaming preference', () => {
  it('consumes the stream when the card advertises streaming, and mirrors each label', async () => {
    const harnessed = harness({
      streaming: true,
      frames: [PROGRESS_FRAME, ARTIFACT_FRAME, TERMINAL_FRAME],
      streamResult: { text: 'STREAMED-ANSWER', state: 'TASK_STATE_COMPLETED' as TaskState },
    })

    const result = await run(harnessed)

    expect(harnessed.calls.stream).toBe(1)
    expect(harnessed.calls.send).toBe(0)
    expect(result.stopReason).toBe('completed')
    expect(result.output).toEqual([{ type: 'text', text: 'STREAMED-ANSWER' }])

    // The progress label reached the mirror: that is what the local window shows
    // WHILE the remote turn is still running.
    expect(harnessed.phases.some((entry) => entry.phase === 'waiting' && entry.detail === '已发送，等待模型')).toBe(true)
    expect(harnessed.exchanges).toEqual([
      { direction: 'outgoing', text: 'hello peer' },
      { direction: 'incoming', text: 'STREAMED-ANSWER' },
    ])
  })

  it('keeps the polling path when the card does not advertise streaming', async () => {
    const harnessed = harness({ streaming: false })

    const result = await run(harnessed)

    expect(harnessed.calls.stream).toBe(0)
    expect(harnessed.calls.send).toBe(1)
    expect(result.stopReason).toBe('completed')
    expect(result.output).toEqual([{ type: 'text', text: 'POLLED-ANSWER' }])
  })

  it('does not report success when the stream closed without a terminal state', async () => {
    const harnessed = harness({
      streaming: true,
      frames: [PROGRESS_FRAME],
      // No `state`: the peer closed the stream before the task settled.
      streamResult: { text: '' },
    })

    const result = await run(harnessed)

    expect(result.stopReason).toBe('error')
    expect(result.output).toEqual([])
    expect(harnessed.phases.some((entry) => entry.phase === 'failed')).toBe(true)
  })
})

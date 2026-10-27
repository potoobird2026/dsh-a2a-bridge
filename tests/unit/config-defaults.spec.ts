/**
 * Pin the defaults that `src/config.ts` IMPORTS from `src/constants.ts`.
 *
 * Why this test exists: the schema default and the module-level fallback used to
 * be two independent literals — `DEFAULT_LISTEN_PORT` was declared in BOTH
 * files. No test could see the drift, because both copies happened to hold the
 * same number, so changing one only moved half the system (the listener bound
 * one port while the card advertised another). The import removed the second
 * declaration; these assertions prove the schema still reaches the imported
 * value, so a future "let me just inline the number here" edit fails loudly.
 */

import { join, resolve as resolvePath } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  Config,
  configuredAgentPreset,
  resolveTaskDir,
  resolveWorkspaceRoot,
  type A2ABridgeConfig,
} from '../../src/config.js'
import {
  DEFAULT_AGENT_CARD_PATH,
  DEFAULT_CALL_TIMEOUT_MS,
  DEFAULT_LISTEN_PORT,
  DEFAULT_TASK_MAX_RECORDS,
  DEFAULT_TASK_RETENTION_MS,
} from '../../src/constants.js'

/**
 * Minimal input that satisfies the required fields; everything else defaults.
 *
 * `listen.host` is required by design (a wildcard bind is refused), and a
 * contact is the only way to observe the per-contact defaults.
 */
const MINIMAL_INPUT = {
  inbound: { listen: { host: '192.0.2.10' } },
  outbound: { contacts: [{ name: 'peer', url: 'http://192.0.2.20/a2a' }] },
}

/** `Config` is a callable schemastery schema: calling it resolves defaults. */
function resolvedConfig(input: unknown = MINIMAL_INPUT): A2ABridgeConfig {
  return (Config as unknown as (value: unknown) => A2ABridgeConfig)(input)
}

describe('config defaults owned by src/constants.ts', () => {
  it('defaults the listener port to DEFAULT_LISTEN_PORT', () => {
    expect(resolvedConfig().inbound.listen.port).toBe(DEFAULT_LISTEN_PORT)
  })

  it('defaults a contact card path to DEFAULT_AGENT_CARD_PATH', () => {
    expect(resolvedConfig().outbound.contacts[0]?.agentCardPath).toBe(DEFAULT_AGENT_CARD_PATH)
  })

  it('defaults a contact timeout to DEFAULT_CALL_TIMEOUT_MS', () => {
    expect(resolvedConfig().outbound.contacts[0]?.timeoutMs).toBe(DEFAULT_CALL_TIMEOUT_MS)
  })
})

describe('workspace root default (removed `required()`)', () => {
  it('accepts an omitted workspaceRoot — the shipped patch must not need one', () => {
    // `workspaceRoot` is VOLATILE now (users edit it in the plugin's own config
    // page), so the parsed schema yields an accessor rather than a raw string.
    // Read it the way production does instead of asserting on the object shape.
    const field = resolvedConfig().inbound.isolation.workspaceRoot as unknown as { get(): string }
    expect(typeof field.get).toBe('function')
    expect(field.get()).toBe('')
  })

  it('derives <DSH_HOME>/a2a-workspaces when workspaceRoot is empty', () => {
    const root = resolveWorkspaceRoot(resolvedConfig(), {
      get: (name: string) => (name === 'homePaths' ? 'D:/harness-home' : undefined),
    })
    expect(root).toBe(resolvePath(join('D:/harness-home', 'a2a-workspaces')))
  })

  it('honours an explicitly configured workspaceRoot verbatim (only trimmed)', () => {
    const input = {
      ...MINIMAL_INPUT,
      inbound: {
        ...MINIMAL_INPUT.inbound,
        isolation: { workspaceRoot: ' D:/shared/a2a ' },
      },
    }
    // Verbatim means verbatim: no resolve() rewrite, so a deployment that pins a
    // UNC path or a relative root keeps exactly what it wrote.
    expect(resolveWorkspaceRoot(resolvedConfig(input), undefined)).toBe('D:/shared/a2a')
  })
})

/**
 * `inbound.tasks` decides whether `GetTask` survives a restart, and `dir` is
 * VOLATILE (the settings page moves it), so its read path is pinned exactly like
 * `workspaceRoot`: the schema yields an accessor, and reading it as a plain string
 * would report every explicit choice as "not configured".
 *
 * Retention is pinned as a PAIR because the two bounds answer different questions
 * — see the schema comment. A test that only checked one would let the other
 * silently become zero (which disables that half of the policy).
 */
describe('inbound.tasks (persisted task records)', () => {
  it('defaults dir to empty and both retention bounds to their constants', () => {
    const tasks = resolvedConfig().inbound.tasks
    const dir = tasks.dir as unknown as { get(): string }
    expect(typeof dir.get).toBe('function')
    expect(dir.get()).toBe('')
    // Retention bounds are VOLATILE so the settings page can write them, which makes
    // the live value an ACCESSOR. Reading it directly would hand `sourceOf()` an
    // object, fail `Number.isFinite`, and silently become 0 — "keep forever". Assert
    // the accessor shape (that shape is the contract the write path depends on: a
    // non-volatile field is rejected by `dsh-settings`) AND the unwrapped defaults.
    const retention = tasks.retentionMs as unknown as { get(): number }
    const maxRecords = tasks.maxRecords as unknown as { get(): number }
    expect(typeof retention.get).toBe('function')
    expect(typeof maxRecords.get).toBe('function')
    expect(retention.get()).toBe(DEFAULT_TASK_RETENTION_MS)
    expect(maxRecords.get()).toBe(DEFAULT_TASK_MAX_RECORDS)
  })

  it('derives <DSH_HOME>/a2a-tasks when dir is empty', () => {
    const dir = resolveTaskDir(resolvedConfig(), {
      get: (name: string) => (name === 'homePaths' ? 'D:/harness-home' : undefined),
    })
    expect(dir).toBe(resolvePath(join('D:/harness-home', 'a2a-tasks')))
  })

  it('honours an explicitly configured dir verbatim (only trimmed)', () => {
    const input = {
      ...MINIMAL_INPUT,
      inbound: {
        ...MINIMAL_INPUT.inbound,
        tasks: { dir: ' D:/shared/a2a-tasks ' },
      },
    }
    expect(resolveTaskDir(resolvedConfig(input), undefined)).toBe('D:/shared/a2a-tasks')
  })

  it('tolerates a plain string dir (a partially built config object)', () => {
    const config = { inbound: { tasks: { dir: 'D:/plain' } } } as unknown as A2ABridgeConfig
    expect(resolveTaskDir(config, undefined)).toBe('D:/plain')
  })
})

/**
 * `inbound.agentPreset` decides whether an A2A session gets ANY execution tool,
 * so its READ path is pinned here: a `.volatile()` field is an accessor at
 * runtime, and reading it as a plain string would report every explicit choice
 * as "not pinned" — the same silent-fallback shape that once hid a YAML
 * `inbound.agent` pin.
 */
describe('inbound.agentPreset (volatile string)', () => {
  const withPreset = (value: unknown): A2ABridgeConfig =>
    resolvedConfig({
      ...MINIMAL_INPUT,
      inbound: { ...MINIMAL_INPUT.inbound, agentPreset: value },
    })

  it('reads an explicitly chosen preset', () => {
    expect(configuredAgentPreset(withPreset('pinned-preset'))).toBe('pinned-preset')
  })

  it('reports "not pinned" for the shipped empty default', () => {
    expect(configuredAgentPreset(resolvedConfig())).toBeUndefined()
  })

  it('trims, and treats a whitespace-only value as "not pinned"', () => {
    expect(configuredAgentPreset(withPreset('   '))).toBeUndefined()
    expect(configuredAgentPreset(withPreset('  spaced  '))).toBe('spaced')
  })

  it('tolerates a plain string (a partially built config object)', () => {
    const plain = { inbound: { agentPreset: 'plain' } } as unknown as A2ABridgeConfig
    expect(configuredAgentPreset(plain)).toBe('plain')
  })
})

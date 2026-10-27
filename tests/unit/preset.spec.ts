/**
 * Unit tests for `src/inbound/preset.ts` — the agent-preset priority chain.
 *
 * What is pinned here is the policy that decides whether an A2A session gets a
 * toolset at all:
 *   - an explicit `inbound.agentPreset` WINS and the registry is not consulted,
 *   - with nothing pinned, the deployment default is asked for by calling
 *     `resolve()` with NO argument (the documented "default" form — inventing an
 *     id would defeat the point of not hard-coding one),
 *   - when neither exists the answer is `undefined` WITH a reason, so the caller
 *     can log a precise warning instead of degrading silently,
 *   - a mount failure is reported, never swallowed: containment belongs to the
 *     executor, which keeps the conversation alive.
 *
 * The registry is a plain fake; no Cordis composition is booted, which is what
 * the module's structural contract buys.
 */

import { describe, expect, it } from 'vitest'

import {
  listAgentPresetIds,
  mountAgentPresetOn,
  presetIdOf,
  resolveAgentPreset,
  type AgentPresetDirectoryLike,
} from '../../src/inbound/preset.js'

/** A registry fake that records how it was addressed. */
function makeDirectory(options: {
  resolve?: (id?: string) => unknown
  mount?: (ctx: unknown, id?: string) => unknown
  composedPreset?: (ctx: unknown) => string | undefined
  list?: () => unknown
}): {
  directory: AgentPresetDirectoryLike
  resolveCalls: Array<string | undefined>
  mountCalls: Array<{ ctx: unknown; id: string | undefined }>
} {
  const resolveCalls: Array<string | undefined> = []
  const mountCalls: Array<{ ctx: unknown; id: string | undefined }> = []

  const directory: AgentPresetDirectoryLike = {
    resolve: async (id?: string) => {
      resolveCalls.push(id)
      return options.resolve === undefined ? { id: 'standard' } : options.resolve(id)
    },
    mount: async (ctx: unknown, id?: string) => {
      mountCalls.push({ ctx, id })
      return options.mount === undefined ? { id } : options.mount(ctx, id)
    },
    ...(options.composedPreset === undefined ? {} : { composedPreset: options.composedPreset }),
    ...(options.list === undefined ? {} : { list: async () => options.list?.() }),
  }

  return { directory, resolveCalls, mountCalls }
}

// ── Priority: configured → default → none ─────────────────────────────────

describe('resolveAgentPreset priority', () => {
  it('uses the configured preset and never consults the registry', async () => {
    const { directory, resolveCalls } = makeDirectory({})

    const resolution = await resolveAgentPreset('pinned-by-operator', directory)

    expect(resolution).toEqual({ id: 'pinned-by-operator', source: 'configured', reason: undefined })
    // A pinned id must not be second-guessed by a default that is also set.
    expect(resolveCalls).toEqual([])
  })

  it('falls back to the deployment default by calling resolve() with NO id', async () => {
    const { directory, resolveCalls } = makeDirectory({ resolve: () => ({ id: 'deployment-default' }) })

    const resolution = await resolveAgentPreset(undefined, directory)

    expect(resolution).toEqual({ id: 'deployment-default', source: 'default', reason: undefined })
    // Exactly one call, and the argument list is empty: `resolve()` with an
    // omitted id IS the "give me the default" contract.
    expect(resolveCalls).toEqual([undefined])
  })

  it('treats a blank configuration as "not pinned" instead of an empty preset id', async () => {
    const { directory } = makeDirectory({ resolve: () => ({ id: 'deployment-default' }) })

    const resolution = await resolveAgentPreset('   ', directory)

    expect(resolution.source).toBe('default')
    expect(resolution.id).toBe('deployment-default')
  })

  it('reports "none" with a reason when nothing is pinned and no registry exists', async () => {
    const resolution = await resolveAgentPreset(undefined, undefined)

    expect(resolution.id).toBeUndefined()
    expect(resolution.source).toBe('none')
    // The reason names the MISSING SERVICE, not just "no preset": that is what
    // tells an operator to look at the composition instead of the picker.
    expect(resolution.reason).toMatch(/agentPresets/)
  })

  it('reports "none" with a reason when resolve() throws', async () => {
    const { directory } = makeDirectory({
      resolve: () => {
        throw new Error('agent-preset/not-found: Unknown agent preset: undefined')
      },
    })

    const resolution = await resolveAgentPreset(undefined, directory)

    expect(resolution.id).toBeUndefined()
    expect(resolution.source).toBe('none')
    expect(resolution.reason).toMatch(/not-found/)
  })

  it('reports "none" when resolve() answers without a usable id', async () => {
    const { directory } = makeDirectory({ resolve: () => ({}) })

    const resolution = await resolveAgentPreset(undefined, directory)

    expect(resolution).toEqual({
      id: undefined,
      source: 'none',
      reason: 'agentPresets.resolve() reported no default preset',
    })
  })

  it('accepts a bare-string identity from a flattened registry line', async () => {
    const { directory } = makeDirectory({ resolve: () => 'flattened' })

    await expect(resolveAgentPreset(undefined, directory)).resolves.toEqual({
      id: 'flattened',
      source: 'default',
      reason: undefined,
    })
  })
})

// ── Mount ─────────────────────────────────────────────────────────────────

describe('mountAgentPresetOn', () => {
  it('mounts onto the agent setup context and reports the composed preset', async () => {
    const agentCtx = { name: 'agent-ctx' }
    const { directory, mountCalls } = makeDirectory({
      composedPreset: (ctx) => (ctx === agentCtx ? 'effective-id' : undefined),
    })

    const effective = await mountAgentPresetOn(directory, agentCtx, 'requested-id')

    expect(mountCalls).toEqual([{ ctx: agentCtx, id: 'requested-id' }])
    // The EFFECTIVE id, read back from the registry, not the requested one.
    expect(effective).toBe('effective-id')
  })

  it('mounts the runtime default when no id was resolved', async () => {
    const { directory, mountCalls } = makeDirectory({})

    await mountAgentPresetOn(directory, {}, undefined)

    // `undefined` is forwarded, which the registry reads as "the default".
    expect(mountCalls).toEqual([{ ctx: {}, id: undefined }])
  })

  it('throws when the registry service is missing (the caller logs and continues)', async () => {
    await expect(mountAgentPresetOn(undefined, {}, 'id')).rejects.toThrow(/agentPresets/)
  })

  it('propagates a rejected mount instead of reporting a success it did not observe', async () => {
    const { directory } = makeDirectory({
      mount: () => {
        throw new Error('Agent preset binding requires a scoped context')
      },
    })

    await expect(mountAgentPresetOn(directory, {}, 'id')).rejects.toThrow(/scoped context/)
  })

  it('tolerates a registry line without composedPreset()', async () => {
    const { directory } = makeDirectory({})

    await expect(mountAgentPresetOn(directory, {}, 'id')).resolves.toBeUndefined()
  })
})

// ── Roster (the picker's option source) ───────────────────────────────────

describe('listAgentPresetIds', () => {
  it('reports "unavailable" when there is no registry at all', async () => {
    await expect(listAgentPresetIds(undefined)).resolves.toEqual({ ids: [], available: false })
  })

  it('reports "unavailable" (not "empty") when list() throws', async () => {
    const { directory } = makeDirectory({
      list: () => {
        throw new Error('registry is still activating')
      },
    })

    await expect(listAgentPresetIds(directory)).resolves.toEqual({ ids: [], available: false })
  })

  it('reports "unavailable" when list() is not an array', async () => {
    const { directory } = makeDirectory({ list: () => ({ presets: [] }) })

    await expect(listAgentPresetIds(directory)).resolves.toEqual({ ids: [], available: false })
  })

  it('distinguishes an EMPTY roster from an unavailable one', async () => {
    const { directory } = makeDirectory({ list: () => [] })

    await expect(listAgentPresetIds(directory)).resolves.toEqual({ ids: [], available: true })
  })

  it('collects ids from the roster objects and drops malformed rows', async () => {
    const { directory } = makeDirectory({
      list: () => [{ id: 'first' }, { id: '' }, { name: 'no-id' }, 'second', null],
    })

    await expect(listAgentPresetIds(directory)).resolves.toEqual({
      ids: ['first', 'second'],
      available: true,
    })
  })
})

describe('presetIdOf', () => {
  it('never guesses an id from an unrelated shape', () => {
    expect(presetIdOf(undefined)).toBeUndefined()
    expect(presetIdOf({ id: 42 })).toBeUndefined()
    expect(presetIdOf('  ')).toBeUndefined()
    expect(presetIdOf({ id: '  spaced  ' })).toBe('spaced')
  })
})

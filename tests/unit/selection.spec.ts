/**
 * Unit tests for `src/selection.ts` — read/write of the A2A model pin.
 *
 * One backend is covered: `createSettingsSelection()`, the plugin's own volatile
 * `inbound.agent` Config, written through the Harness `settings` service. The
 * legacy `selection.json` store was deleted with its channel, so the file-system
 * cases (missing file, corrupt JSON, atomic replace) went with it — testing a
 * storage path that no longer exists is how dead code stays alive.
 */

import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  SelectionConflictError,
  SelectionSettingsUnavailableError,
  completeSelection,
  createSettingsSelection,
  resolveDshHome,
  resolveProfileEntryId,
  type SettingsLike,
} from '../../src/selection.js'

// ── The one definition of "a complete pin" ─────────────────────────────────

describe('completeSelection', () => {
  it('returns a trimmed selection when both fields are set', () => {
    expect(completeSelection({ provider: '  deepseek-account ', model: ' deepseek-flash ' })).toEqual({
      provider: 'deepseek-account',
      model: 'deepseek-flash',
    })
  })

  it('rejects a half-set pin instead of building an unusable agent', () => {
    expect(completeSelection({ provider: 'deepseek-account' })).toBeUndefined()
    expect(completeSelection({ model: 'deepseek-flash' })).toBeUndefined()
  })

  it('rejects empty and whitespace-only fields', () => {
    expect(completeSelection({ provider: '', model: '' })).toBeUndefined()
    expect(completeSelection({ provider: '   ', model: 'deepseek-flash' })).toBeUndefined()
    expect(completeSelection(undefined)).toBeUndefined()
    expect(completeSelection('longcat/LongCat-2.5-Preview')).toBeUndefined()
  })

  it('unwraps a WHOLE-pair Volatile reference (`.get()` returns the pair)', () => {
    // This is the shape `config.inbound.agent` has once the object itself is
    // `.volatile()` in src/config.ts.
    expect(
      completeSelection({
        get: () => ({ provider: 'longcat', model: 'LongCat-2.5-Preview' }),
      }),
    ).toEqual({ provider: 'longcat', model: 'LongCat-2.5-Preview' })
  })

  it('unwraps per-FIELD Volatile accessors (the current config.ts shape)', () => {
    // `provider: Schema.string().volatile()` makes each field `{ get(): string }`,
    // NOT a string. A plain typeof check made this pin unreachable.
    expect(
      completeSelection({
        provider: { get: () => 'deepseek-account' },
        model: { get: () => 'deepseek-pro' },
      }),
    ).toEqual({ provider: 'deepseek-account', model: 'deepseek-pro' })
  })

  it('treats a throwing or missing accessor as unset instead of crashing', () => {
    expect(
      completeSelection({
        provider: {
          get: () => {
            throw new Error('not ready')
          },
        },
        model: { get: () => 'm' },
      }),
    ).toBeUndefined()
    expect(completeSelection({ provider: { get: () => 42 }, model: 'm' })).toBeUndefined()
  })

  it('bounds a pathological self-returning accessor', () => {
    const loop: { get: () => unknown } = { get: () => loop }
    expect(completeSelection({ provider: loop, model: 'm' })).toBeUndefined()
  })

  it('does not mistake a half-initialised volatile pair for a pin', () => {
    expect(
      completeSelection({
        provider: { get: () => 'deepseek-account' },
        model: { get: () => '' },
      }),
    ).toBeUndefined()
  })
})

// ── Settings-backed gateway (the supported channel) ────────────────────────

const ENTRY_ID = 'a2a-bridge'

interface UpdateCall {
  ns: string
  patch: Record<string, unknown>
  expected: number | undefined
}

const CONFLICT = Object.assign(new Error('settings namespace changed'), {
  code: 'SETTINGS_CONFLICT',
})

function makeSettings(options: {
  revision?: number
  descriptors?: unknown
  conflictsBeforeSuccess?: number
  describeThrows?: boolean
  updateThrows?: unknown
  describeAsPromise?: boolean
} = {}): { settings: SettingsLike; calls: UpdateCall[]; revision: () => number } {
  let revision = options.revision ?? 0
  let remainingConflicts = options.conflictsBeforeSuccess ?? 0
  const calls: UpdateCall[] = []
  const provided = options.descriptors as Record<string, unknown>[] | undefined
  const primary = provided?.[0] ?? { ns: ENTRY_ID, schema: {}, value: {}, applies: 'live' }

  return {
    calls,
    revision: () => revision,
    settings: {
      describe: () => {
        if (options.describeThrows === true) throw new Error('settings is not ready')
        const answer = [{ ...primary, revision }]
        return options.describeAsPromise === true ? Promise.resolve(answer) : answer
      },
      async update(ns: string, patch: object, expectedRevision?: number): Promise<void> {
        if (options.updateThrows !== undefined) throw options.updateThrows
        if (remainingConflicts > 0) {
          remainingConflicts -= 1
          throw CONFLICT
        }
        if (expectedRevision !== undefined && expectedRevision !== revision) throw CONFLICT
        calls.push({ ns, patch: patch as Record<string, unknown>, expected: expectedRevision })
        revision += 1
      },
    },
  }
}

describe('createSettingsSelection', () => {
  it('reads the live volatile pin and reports the descriptor revision', () => {
    const selection = createSettingsSelection({
      settings: () => makeSettings({ revision: 7 }).settings,
      entryId: () => ENTRY_ID,
      configSelection: () => ({
        provider: { get: () => 'longcat' },
        model: { get: () => 'LongCat-2.5-Preview' },
      }),
    })

    expect(selection.read()).toEqual({ provider: 'longcat', model: 'LongCat-2.5-Preview' })
    expect(selection.available()).toBe(true)
    expect(selection.revision?.()).toBe(7)
  })

  it('writes the exact inbound.agent patch at the observed revision', async () => {
    const fake = makeSettings({ revision: 2 })
    const selection = createSettingsSelection({
      settings: () => fake.settings,
      entryId: () => ENTRY_ID,
      configSelection: () => undefined,
    })

    await selection.write({ provider: 'deepseek-account', model: 'deepseek-pro' })

    expect(fake.calls).toEqual([
      {
        ns: ENTRY_ID,
        patch: {
          inbound: { agent: { provider: 'deepseek-account', model: 'deepseek-pro' } },
        },
        expected: 2,
      },
    ])
    expect(fake.revision()).toBe(3)
  })

  it('retries once on a revision conflict when the caller did not pin a revision', async () => {
    const fake = makeSettings({ conflictsBeforeSuccess: 1 })
    const selection = createSettingsSelection({
      settings: () => fake.settings,
      entryId: () => ENTRY_ID,
      configSelection: () => undefined,
    })

    await selection.write({ provider: 'p', model: 'm' })

    expect(fake.calls).toHaveLength(1)
  })

  it('surfaces a conflict instead of clobbering when the caller pinned a revision', async () => {
    const fake = makeSettings({ revision: 5 })
    const selection = createSettingsSelection({
      settings: () => fake.settings,
      entryId: () => ENTRY_ID,
      configSelection: () => undefined,
    })

    await expect(
      selection.write({ provider: 'p', model: 'm' }, { expectedRevision: 4 }),
    ).rejects.toBeInstanceOf(SelectionConflictError)
    expect(fake.calls).toHaveLength(0)
  })

  it('fails with a conflict after the retry budget is exhausted', async () => {
    const fake = makeSettings({ conflictsBeforeSuccess: 5 })
    const selection = createSettingsSelection({
      settings: () => fake.settings,
      entryId: () => ENTRY_ID,
      configSelection: () => undefined,
    })

    await expect(selection.write({ provider: 'p', model: 'm' })).rejects.toBeInstanceOf(
      SelectionConflictError,
    )
  })

  it('reports unavailable when there is no settings service', async () => {
    const selection = createSettingsSelection({
      settings: () => undefined,
      entryId: () => ENTRY_ID,
      configSelection: () => undefined,
    })

    expect(selection.available()).toBe(false)
    expect(selection.revision?.()).toBeUndefined()
    await expect(selection.write({ provider: 'p', model: 'm' })).rejects.toBeInstanceOf(
      SelectionSettingsUnavailableError,
    )
  })

  it('reports unavailable when the plugin is not a profile entry', async () => {
    const fake = makeSettings()
    const selection = createSettingsSelection({
      settings: () => fake.settings,
      entryId: () => undefined,
      configSelection: () => undefined,
    })

    expect(selection.available()).toBe(false)
    await expect(selection.write({ provider: 'p', model: 'm' })).rejects.toBeInstanceOf(
      SelectionSettingsUnavailableError,
    )
  })

  it('reports unavailable when the entry is not exposed as live-editable Settings', async () => {
    const fake = makeSettings({ descriptors: [{ ns: 'someone-else', revision: 0 }] })
    const selection = createSettingsSelection({
      settings: () => fake.settings,
      entryId: () => ENTRY_ID,
      configSelection: () => undefined,
    })

    expect(selection.revision?.()).toBeUndefined()
    await expect(selection.write({ provider: 'p', model: 'm' })).rejects.toBeInstanceOf(
      SelectionSettingsUnavailableError,
    )
  })

  it('maps a throwing describe() to "unavailable" with the cause attached', async () => {
    const fake = makeSettings({ describeThrows: true })
    const selection = createSettingsSelection({
      settings: () => fake.settings,
      entryId: () => ENTRY_ID,
      configSelection: () => undefined,
    })

    // `write()` may be synchronous; wrap it so `.catch` exists either way.
    const error = await Promise.resolve(selection.write({ provider: 'p', model: 'm' }))
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SelectionSettingsUnavailableError)
    expect((error as Error).cause).toBeInstanceOf(Error)
  })

  it('propagates a non-conflict settings failure unchanged (never swallowed)', async () => {
    const boom = new Error('profile patch is read-only')
    const fake = makeSettings({ updateThrows: boom })
    const selection = createSettingsSelection({
      settings: () => fake.settings,
      entryId: () => ENTRY_ID,
      configSelection: () => undefined,
    })

    await expect(selection.write({ provider: 'p', model: 'm' })).rejects.toBe(boom)
  })

  it('handles a promise-shaped describe(): revision() cannot await it, write() can', async () => {
    const fake = makeSettings({ revision: 6, describeAsPromise: true })
    const selection = createSettingsSelection({
      settings: () => fake.settings,
      entryId: () => ENTRY_ID,
      configSelection: () => undefined,
    })

    // The synchronous accessor reports "no revision" rather than a lie.
    expect(selection.revision?.()).toBeUndefined()
    // The async write path awaits it and still applies at revision 6.
    await selection.write({ provider: 'p', model: 'm' })
    expect(fake.calls[0]?.expected).toBe(6)
  })

  it('serialises overlapping writes: every writer either lands or reports a conflict', async () => {
    const fake = makeSettings()
    const selection = createSettingsSelection({
      settings: () => fake.settings,
      entryId: () => ENTRY_ID,
      configSelection: () => undefined,
    })

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        selection.write({ provider: `p${index}`, model: `m${index}` }),
      ),
    )

    // Each write either succeeded or lost a real race; none may throw anything
    // outside the documented taxonomy.
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(SelectionConflictError)
      }
    }
    expect(fake.calls.length + results.filter((row) => row.status === 'rejected').length).toBe(8)
    // Every recorded write used a revision that was current when it applied.
    expect(fake.calls.every((call, index) => call.expected === index)).toBe(true)
  })
})

describe('resolveProfileEntryId', () => {
  it('reads ctx.fiber.entry.options.id (verified on shipped plugins)', () => {
    expect(resolveProfileEntryId({ fiber: { entry: { options: { id: 'a2a-bridge' } } } })).toBe(
      'a2a-bridge',
    )
  })

  it('returns undefined for a child context, a missing fiber, or a non-string id', () => {
    expect(resolveProfileEntryId({})).toBeUndefined()
    expect(resolveProfileEntryId(undefined)).toBeUndefined()
    expect(resolveProfileEntryId({ fiber: {} })).toBeUndefined()
    expect(resolveProfileEntryId({ fiber: { entry: { options: { id: '' } } } })).toBeUndefined()
    expect(resolveProfileEntryId({ fiber: { entry: { options: { id: 42 } } } })).toBeUndefined()
  })
})

// ── Harness home resolution (the workspace-root default lives on it) ──────

describe('resolveDshHome', () => {
  // `resolve()` normalises drive letters and separators, so expectations use it
  // too — comparing raw strings would make these tests platform-dependent.
  it('prefers the homePaths service value over the environment', () => {
    const ctx = { get: (name: string) => (name === 'homePaths' ? 'D:/harness-home' : undefined) }
    expect(resolveDshHome(ctx, { DSH_HOME: 'D:/from-env' }, () => 'D:/os-home')).toBe(
      resolve('D:/harness-home'),
    )
  })

  it('accepts a getter function and a { home } record (both observed service shapes)', () => {
    const asFunction = { get: () => () => 'D:/harness-home-fn' }
    const asRecord = { get: () => ({ home: 'D:/harness-home-record' }) }

    expect(resolveDshHome(asFunction, {}, () => 'D:/os-home')).toBe(
      resolve('D:/harness-home-fn'),
    )
    expect(resolveDshHome(asRecord, {}, () => 'D:/os-home')).toBe(
      resolve('D:/harness-home-record'),
    )
  })

  it('falls back to DSH_HOME when the service is absent', () => {
    const ctx = { get: () => undefined }
    expect(resolveDshHome(ctx, { DSH_HOME: 'D:/from-env' }, () => 'D:/os-home')).toBe(
      resolve('D:/from-env'),
    )
  })

  it('ignores a blank DSH_HOME, which would otherwise resolve to the cwd', () => {
    const ctx = { get: () => undefined }
    expect(resolveDshHome(ctx, { DSH_HOME: '   ' }, () => 'D:/os-home')).toBe(
      resolve(join('D:/os-home', '.dsh')),
    )
  })

  it('falls back to <os home>/.dsh when neither the service nor the env exists', () => {
    expect(resolveDshHome(undefined, {}, () => 'D:/os-home')).toBe(
      resolve(join('D:/os-home', '.dsh')),
    )
  })

  it('survives a throwing homePaths getter', () => {
    const ctx = {
      get: () => () => {
        throw new Error('not ready')
      },
    }
    expect(resolveDshHome(ctx, {}, () => 'D:/os-home')).toBe(
      resolve(join('D:/os-home', '.dsh')),
    )
  })
})

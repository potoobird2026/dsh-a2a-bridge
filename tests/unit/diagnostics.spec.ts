/**
 * Startup seam probe.
 *
 * The probe exists because a missing seam is SILENT: `ctx.get('x')` is undefined,
 * the `if (x !== undefined)` guard is skipped, and the feature just does not
 * happen. These tests pin the two properties that make it useful in the field:
 *
 *   - `missing=` is ALWAYS present (so `missing=none` is greppable, not absent),
 *   - a seam that breaks a user-visible promise is named separately as
 *     `critical-missing=`, instead of hiding among eleven flags.
 */

import { describe, expect, it } from 'vitest'

import { describeSeams, probeSeams, type SeamFacts } from '../../src/diagnostics.js'

const ALL_PRESENT: SeamFacts = {
  agentsResume: true,
  workspaceRegistry: true,
  workspaceUnarchive: true,
  workingDirectory: true,
  agentPresets: true,
  credentials: true,
  settings: true,
  llm: true,
  subagents: true,
  tools: true,
  homePaths: true,
}

describe('describeSeams', () => {
  it('says missing=none when every seam is present', () => {
    const line = describeSeams(ALL_PRESENT)
    expect(line).toContain('missing=none')
    expect(line).not.toContain('critical-missing')
    // Every flag is emitted, so two machines can be compared field by field.
    expect(line).toContain('agentsResume=1')
    expect(line).toContain('workspaceUnarchive=1')
  })

  it('names a non-critical gap without raising the critical flag', () => {
    const line = describeSeams({ ...ALL_PRESENT, llm: false })
    expect(line).toContain('missing=llm')
    expect(line).not.toContain('critical-missing')
  })

  it('raises critical-missing for a seam that breaks a visible promise', () => {
    const line = describeSeams({ ...ALL_PRESENT, agentsResume: false, workspaceUnarchive: false })
    expect(line).toContain('missing=agentsResume,workspaceUnarchive')
    // Both matter: without resume a restart orphans every conversation, and
    // without unarchive an A2A session can run invisibly.
    expect(line).toContain('critical-missing=agentsResume,workspaceUnarchive')
  })
})

describe('probeSeams', () => {
  it('reports a present resume/unarchive as true', () => {
    const facts = probeSeams({
      agents: { resume: () => undefined },
      get: (name: string) => {
        // `asWorkspaceRegistry` recognises a registry by its `create` method, so a
        // fake without it is (correctly) treated as "no registry at all".
        if (name === 'workspaceRegistry') {
          return { create: () => undefined, unarchiveSession: () => undefined }
        }
        if (name === 'workingDirectory') return { set: () => undefined }
        return { present: true }
      },
    })
    expect(facts.agentsResume).toBe(true)
    expect(facts.workspaceRegistry).toBe(true)
    expect(facts.workspaceUnarchive).toBe(true)
    expect(facts.workingDirectory).toBe(true)
    expect(facts.tools).toBe(true)
  })

  it('never throws when a service getter throws', () => {
    const facts = probeSeams({
      agents: {},
      get: () => {
        throw new Error('service not composed')
      },
    })
    expect(Object.values(facts).every((ok) => ok === false)).toBe(true)
  })

  it('treats a service that exists but lacks the method as missing', () => {
    const facts = probeSeams({
      agents: {} as { resume?: unknown },
      // A registry that exists but has no `unarchiveSession` is exactly the
      // rc-drift case the probe is for: the service is there, the method is not.
      get: (name: string) => (name === 'workspaceRegistry' ? { create: () => undefined } : undefined),
    })
    expect(facts.agentsResume).toBe(false)
    expect(facts.workspaceRegistry).toBe(true)
    expect(facts.workspaceUnarchive).toBe(false)
    expect(facts.workingDirectory).toBe(false)
  })
})

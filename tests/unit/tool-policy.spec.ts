/**
 * A2A tool policy — the deny list that keeps a remote peer from reading this
 * machine's OTHER sessions.
 *
 * The exposure this guards is real and was measured on a live deployment via
 * `cordis_inspect_query host/Tool listTools`: `session_search`,
 * `session_event_search`, `session_trace`, `session_event_trace`,
 * `session_event_read`, `list_agents` and `team_task_*` are all registered for
 * every agent, including an inbound A2A session.
 *
 * The mechanism is the Harness's own `tools.restrict()`, applied on the AGENT's
 * scoped creation context — which is why the receiver matters and is asserted
 * below rather than assumed.
 */

import { describe, expect, it, vi } from 'vitest'

import { A2A_DENIED_TOOLS } from '../../src/constants.js'
import { applyToolPolicy, type ToolsScopeLike } from '../../src/inbound/tool-policy.js'

function scopeWith(tools: ToolsScopeLike): unknown {
  return { tools }
}

describe('applyToolPolicy', () => {
  it('denies every policy name that is actually registered', () => {
    const registered = new Set(['session_search', 'session_event_read', 'read_file'])
    const restrict = vi.fn()
    const tools: ToolsScopeLike = {
      get: (name: string) => (registered.has(name) ? { name } : undefined),
      restrict,
    }

    const outcome = applyToolPolicy(scopeWith(tools), ['session_search', 'session_event_read'], vi.fn())

    expect(outcome.applied).toEqual(['session_search', 'session_event_read'])
    expect(outcome.absent).toEqual([])
    expect(outcome.error).toBeUndefined()
    expect(restrict).toHaveBeenCalledWith({ deny: ['session_search', 'session_event_read'] })
  })

  it('probes visibility first, so restrict never receives an unknown name', () => {
    // `tools.restrict` FAILS on unknown names. Passing one would throw and the
    // session would end up unrestricted — the exact failure this guards.
    const registered = new Set(['session_search'])
    const restrict = vi.fn()
    const tools: ToolsScopeLike = {
      get: (name: string) => (registered.has(name) ? { name } : undefined),
      restrict,
    }

    const outcome = applyToolPolicy(
      scopeWith(tools),
      ['session_search', 'session_event_search', 'session_trace'],
      vi.fn(),
    )

    expect(outcome.applied).toEqual(['session_search'])
    expect(outcome.absent).toEqual(['session_event_search', 'session_trace'])
    expect(restrict).toHaveBeenCalledTimes(1)
    expect(restrict).toHaveBeenCalledWith({ deny: ['session_search'] })
  })

  it('reports loudly when there is no tools service instead of claiming success', () => {
    const log = vi.fn()
    const outcome = applyToolPolicy({ otherService: true }, ['session_search'], log)

    expect(outcome.applied).toEqual([])
    expect(outcome.error).toBeDefined()
    // A silently-unrestricted session is the dangerous outcome; the log is the
    // only signal a human gets, so it must name the problem.
    expect(log.mock.calls.length).toBeGreaterThan(0)
    expect(String(log.mock.calls[0]?.[0])).toContain('cannot be applied')
  })

  it('reports loudly when restrict refuses the list', () => {
    const restrict = vi.fn(() => {
      throw new Error('unknown tool name')
    })
    const tools: ToolsScopeLike = {
      get: () => ({ name: 'anything' }),
      restrict,
    }

    const outcome = applyToolPolicy(scopeWith(tools), ['session_search'], vi.fn())

    expect(outcome.applied).toEqual([])
    expect(outcome.error).toContain('refused the deny list')
  })

  it('says so when nothing on this deployment matches the policy', () => {
    const restrict = vi.fn()
    const tools: ToolsScopeLike = { get: () => undefined, restrict }

    const outcome = applyToolPolicy(scopeWith(tools), ['session_search'], vi.fn())

    expect(outcome.applied).toEqual([])
    expect(restrict).not.toHaveBeenCalled()
  })

  it('reports the names it could NOT deny on the same line as the ones it did', () => {
    // A security control that is silent about its own gaps is worse than no
    // control: "denied 5" reads as "the policy covers everything" when half the
    // list was not denyable here. `restrict` only reaches GLOBAL tools, so
    // scope-local names show up as absent — they must be named, not implied.
    const log = vi.fn()
    const registered = new Set(['session_search'])
    const tools: ToolsScopeLike = {
      get: (name: string) => (registered.has(name) ? { name } : undefined),
      restrict: vi.fn(),
    }

    applyToolPolicy(scopeWith(tools), ['session_search', 'list_agents'], log)

    const line = String(log.mock.calls[0]?.[0] ?? '')
    expect(line).toContain('denied 1 cross-session tool(s): session_search')
    expect(line).toContain('not denyable on this deployment: list_agents')
  })

  it('invokes get as a METHOD, so a service reading `this.view` keeps its receiver', () => {
    // Regression. An earlier version detached the method —
    //     const probe = tools.get; probe(name)
    // — and the real service body is `return this.view(scope).visible.get(name)`.
    // With the receiver lost that throws exactly
    // "Cannot read properties of undefined (reading 'view')", and because this
    // runs inside `agents.create({ setup })` it took the whole A2A request down
    // with a bare -32602. This fake reproduces that failure shape verbatim.
    const tools = {
      view: (_scope?: unknown) => ({ visible: new Map([['session_search', { name: 'session_search' }]]) }),
      get(this: { view?: unknown }, name: string) {
        if (this.view === undefined) {
          throw new TypeError("Cannot read properties of undefined (reading 'view')")
        }
        return (this.view as (s?: unknown) => { visible: Map<string, unknown> })().visible.get(name)
      },
      restrict: vi.fn(),
    }

    const outcome = applyToolPolicy(scopeWith(tools), ['session_search'], vi.fn())

    expect(outcome.error).toBeUndefined()
    expect(outcome.applied).toEqual(['session_search'])
  })

  it('defaults to the shipped deny list when the caller passes none', () => {
    // The constant is the security posture; pinning that it really contains the
    // cross-session readers (and not, say, an empty array) is the point.
    expect(A2A_DENIED_TOOLS).toContain('session_search')
    expect(A2A_DENIED_TOOLS).toContain('session_event_search')
    expect(A2A_DENIED_TOOLS).toContain('session_event_read')
    expect(A2A_DENIED_TOOLS).toContain('list_agents')
    expect(A2A_DENIED_TOOLS.length).toBeGreaterThan(0)
  })
})

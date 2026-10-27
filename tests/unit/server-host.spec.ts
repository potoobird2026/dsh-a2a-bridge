/**
 * Wildcard-bind refusal — a SECURITY boundary, so it gets its own test.
 *
 * `isWildcard()` used to be five `===` comparisons against quoted addresses in
 * the middle of `server.ts`. They moved to a single anchored pattern in
 * `src/constants.ts`; a typo in that pattern would silently ACCEPT a wildcard
 * bind and expose this agent's tools on every network the machine is on. Nothing
 * else in the suite would notice, which is exactly why these cases are pinned.
 */

import { describe, expect, it } from 'vitest'

import { WildcardBindError, assertConcreteHost, isWildcard } from '../../src/inbound/server.js'

describe('isWildcard', () => {
  it('recognises every spelling of "all interfaces"', () => {
    for (const host of ['0.0.0.0', '::', '::0', '[::]', '*', '  0.0.0.0  ', '::']) {
      expect(isWildcard(host), host).toBe(true)
    }
  })

  it('does not mistake loopback or a concrete address for a wildcard', () => {
    for (const host of ['127.0.0.1', '::1', '192.0.2.10', '10.1.2.3', 'fe80::1']) {
      expect(isWildcard(host), host).toBe(false)
    }
  })
})

describe('assertConcreteHost', () => {
  it('refuses a wildcard and an empty host at load time', () => {
    expect(() => assertConcreteHost('0.0.0.0')).toThrow(WildcardBindError)
    expect(() => assertConcreteHost('')).toThrow(WildcardBindError)
  })

  it('accepts a concrete address, including loopback (the safe default)', () => {
    expect(() => assertConcreteHost('127.0.0.1')).not.toThrow()
    expect(() => assertConcreteHost('192.0.2.10')).not.toThrow()
  })
})

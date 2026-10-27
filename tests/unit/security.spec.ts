/**
 * Unit tests for `src/security/index.ts`.
 *
 * Scope: pure functions only — no Cordis, no HTTP, no composition. The module
 * under test imports `node:crypto` and `src/constants.ts` only (layering rule
 * ADR-008), which is exactly what makes these tests runnable without booting
 * a harness.
 *
 * ⚠️ 状态：本机**未安装 `node_modules`**，`vitest` 不可用，本文件**未运行**。
 *    环境具备后请执行 `pnpm install && pnpm test -- tests/unit/security.spec.ts`，
 *    并确认全绿后再接入 CI 门禁（ADR-008: lint → typecheck → build → test）。
 *
 * 每条用例都对应 `docs/threat-model.md` 的一个具体结论；改动断言前先读那里的
 * T-01 / T-06 / T-08，不要"为了让测试过"而削弱语义。
 */
import { describe, expect, it } from 'vitest'

import {
  RateLimiter,
  constantTimeEqual,
  identifyPeer,
  redactSecrets,
  wellFormed,
} from '../../src/security/index.js'

// Tokens are shaped like the real thing: 32 random bytes rendered as 64 hex
// chars. Fixed literals keep the assertions readable; they are not secrets.
const ALICE = 'a'.repeat(64)
const BOB = 'b'.repeat(64)
const CAROL = 'c'.repeat(64)
const DAVE = 'd'.repeat(64)

const peers = (...entries: Array<[string, string]>): ReadonlyMap<string, string> =>
  new Map<string, string>(entries)

// ── constantTimeEqual ──────────────────────────────────────────────────────

describe('constantTimeEqual', () => {
  it('returns true for equal strings', () => {
    expect(constantTimeEqual(ALICE, ALICE)).toBe(true)
  })

  it('returns false for different strings of the same length', () => {
    // Same length on purpose: this is the branch where `timingSafeEqual`
    // actually compares bytes (not the length-mismatch short circuit).
    expect(constantTimeEqual(ALICE, BOB)).toBe(false)
    expect(constantTimeEqual(ALICE, `${'a'.repeat(63)}b`)).toBe(false)
  })

  it('returns false — and does not throw — when lengths differ', () => {
    // `timingSafeEqual` throws on unequal buffer lengths. The wrapper must
    // swallow that by burning a self-comparison first, otherwise an attacker
    // learns the token length from a crash/500 instead of a 401.
    expect(() => constantTimeEqual(ALICE, ALICE.slice(0, 32))).not.toThrow()
    expect(constantTimeEqual(ALICE, ALICE.slice(0, 32))).toBe(false)
    expect(() => constantTimeEqual('', ALICE)).not.toThrow()
    expect(constantTimeEqual('', ALICE)).toBe(false)
    expect(constantTimeEqual('', '')).toBe(true)
  })

  it('compares utf8 bytes, not utf16 code units', () => {
    // Two different astral characters can share a utf16 length; only the
    // utf8 buffer comparison distinguishes them.
    expect(constantTimeEqual('😀', '😁')).toBe(false)
    expect(constantTimeEqual('议', '议')).toBe(true)
  })
})

// ── identifyPeer ───────────────────────────────────────────────────────────

describe('identifyPeer', () => {
  it('resolves the presented token to the matching peer', () => {
    const credentials = peers(['alice', ALICE], ['bob', BOB])
    expect(identifyPeer(ALICE, credentials)).toBe('alice')
    expect(identifyPeer(BOB, credentials)).toBe('bob')
  })

  it('returns undefined when no peer matches', () => {
    const credentials = peers(['alice', ALICE], ['bob', BOB])
    expect(identifyPeer(CAROL, credentials)).toBeUndefined()
  })

  it('returns undefined for an empty or absent token', () => {
    const credentials = peers(['alice', ALICE])
    expect(identifyPeer('', credentials)).toBeUndefined()
    expect(identifyPeer(undefined, credentials)).toBeUndefined()
  })

  it('returns undefined when no peers are declared', () => {
    expect(identifyPeer(ALICE, peers())).toBeUndefined()
  })

  it('matches every peer in a multi-peer table (guards against an early break)', () => {
    // Threat model T-08: `identifyPeer` compares EVERY candidate even after a
    // match, so response time reveals neither which peer matched nor (beyond
    // the linear cost) how many are declared. If someone "optimises" the loop
    // with a `break`/`return`, a later peer would still match — but the timing
    // signal would come back. This assertion pins the observable behaviour:
    // each peer, including the last declared one and the first one, is found.
    const credentials = peers(
      ['alice', ALICE],
      ['bob', BOB],
      ['carol', CAROL],
      ['dave', DAVE],
    )

    expect(identifyPeer(ALICE, credentials)).toBe('alice')
    expect(identifyPeer(BOB, credentials)).toBe('bob')
    expect(identifyPeer(CAROL, credentials)).toBe('carol')
    expect(identifyPeer(DAVE, credentials)).toBe('dave')

    // Reverse declaration order as well: order must not affect the result.
    const reversed = peers(
      ['dave', DAVE],
      ['carol', CAROL],
      ['bob', BOB],
      ['alice', ALICE],
    )
    expect(identifyPeer(ALICE, reversed)).toBe('alice')
    expect(identifyPeer(DAVE, reversed)).toBe('dave')
  })

  it('resolves duplicate secrets to the first declared peer', () => {
    // Deliberate semantics: `matched` is assigned once (`matched === undefined`
    // in the loop guard). Two peers sharing a secret is a config smell, but the
    // outcome must be deterministic rather than "whatever iterated last".
    const credentials = peers(['alice', ALICE], ['bob', ALICE])
    expect(identifyPeer(ALICE, credentials)).toBe('alice')
  })

  it('never matches on a prefix or a truncated token', () => {
    const credentials = peers(['alice', ALICE])
    expect(identifyPeer(ALICE.slice(0, 63), credentials)).toBeUndefined()
    expect(identifyPeer(`${ALICE}a`, credentials)).toBeUndefined()
  })
})

// ── RateLimiter ────────────────────────────────────────────────────────────

describe('RateLimiter', () => {
  it('rejects request N+1 inside the window', () => {
    const limiter = new RateLimiter(3, () => 1_000_000)

    expect(limiter.allow('alice')).toBe(true)
    expect(limiter.allow('alice')).toBe(true)
    expect(limiter.allow('alice')).toBe(true)
    // Fourth hit in the same 60s window.
    expect(limiter.allow('alice')).toBe(false)
    // Still rejected on the next attempt: a rejection must not reset the window.
    expect(limiter.allow('alice')).toBe(false)
  })

  it('recovers after the injected clock advances past the window', () => {
    let now = 1_000_000
    const limiter = new RateLimiter(2, () => now)

    expect(limiter.allow('alice')).toBe(true)
    expect(limiter.allow('alice')).toBe(true)
    expect(limiter.allow('alice')).toBe(false)

    // Advance one millisecond past the 60_000 ms window. No sleeping: the
    // clock is injected precisely so this test stays deterministic.
    now += 60_001
    expect(limiter.allow('alice')).toBe(true)
    expect(limiter.allow('alice')).toBe(true)
    expect(limiter.allow('alice')).toBe(false)
  })

  it('counts each identity independently', () => {
    const limiter = new RateLimiter(1, () => 1_000_000)

    expect(limiter.allow('alice')).toBe(true)
    expect(limiter.allow('alice')).toBe(false)
    // A different peer must not inherit alice's exhausted budget.
    expect(limiter.allow('bob')).toBe(true)
    expect(limiter.allow('bob')).toBe(false)
  })

  it('treats a zero limit as reject-all rather than allow-all', () => {
    // Fail-closed: `rateLimitPerMinute: 0` is a misconfiguration, and the
    // safer reading is "no requests" — not "unlimited".
    const limiter = new RateLimiter(0, () => 1_000_000)
    expect(limiter.allow('alice')).toBe(false)
  })

  it('does not leak state across a sweep and keeps enforcing limits', () => {
    let now = 1_000_000
    const limiter = new RateLimiter(1, () => now)

    expect(limiter.allow('alice')).toBe(true)
    expect(limiter.allow('alice')).toBe(false)

    now += 60_001
    limiter.sweep() // quiet identities are dropped; must not corrupt the map
    expect(limiter.allow('alice')).toBe(true)
    expect(limiter.allow('alice')).toBe(false)
  })
})

// ── redactSecrets ──────────────────────────────────────────────────────────

describe('redactSecrets', () => {
  it('redacts an sk- style key', () => {
    const text = `key is sk-${'a'.repeat(20)} ok`
    expect(redactSecrets(text)).toBe('key is [redacted] ok')
  })

  it('redacts an sk-ant- style key', () => {
    const text = `sk-ant-${'b'.repeat(20)}`
    expect(redactSecrets(text)).toBe('[redacted]')
  })

  it('redacts a ghp_ style GitHub token', () => {
    const text = `token: ghp_${'c'.repeat(20)}`
    expect(redactSecrets(text)).toBe('token: [redacted]')
  })

  it('redacts an AKIA access key id', () => {
    const text = 'creds AKIAABCDEFGHIJKLMNOP here'
    expect(redactSecrets(text)).toBe('creds [redacted] here')
  })

  it('redacts a Bearer credential while keeping the scheme readable', () => {
    // The replacement keeps `Bearer ` so the peer still knows a credential was
    // there (and that it was stripped), which is what the log/diagnostic
    // readers downstream look for.
    expect(redactSecrets(`authorization: Bearer ${'d'.repeat(24)}`)).toBe(
      'authorization: Bearer [redacted]',
    )
  })

  it('redacts every occurrence in one pass, not just the first', () => {
    const text = `sk-${'a'.repeat(20)} and ghp_${'c'.repeat(20)} and AKIAABCDEFGHIJKLMNOP`
    expect(redactSecrets(text)).toBe('[redacted] and [redacted] and [redacted]')
  })

  it('leaves ordinary text — including a UUID — untouched', () => {
    // False positives are their own incident: over-redaction silently destroys
    // peer-visible content. A UUID must survive (it is also why the future
    // 64-hex heuristic needs an allow-list; see threat model T-05).
    const text = 'task 3f9a1c22-8b7d-4c4e-9f2a-0b1c2d3e4f50 completed in 12ms; see docs/threat-model.md'
    expect(redactSecrets(text)).toBe(text)
  })

  it('does not redact a short Bearer value below the length floor', () => {
    // Documented gap (threat model T-05 item 6): tokens shorter than 16 chars
    // are deliberately not matched, to avoid mangling prose.
    expect(redactSecrets('Bearer short')).toBe('Bearer short')
  })
})

// ── wellFormed ─────────────────────────────────────────────────────────────

describe('wellFormed', () => {
  it('repairs a lone surrogate to U+FFFD and does not throw', () => {
    // Reproduces the upstream defect: DSH's streaming decoder is not
    // chunk-safe, so CJK/emoji can be split mid-codepoint. `JSON.stringify`
    // then emits syntactically valid JSON carrying a lone surrogate, which a
    // Go/Rust/Python peer cannot re-encode.
    expect(() => wellFormed('\uDCAE')).not.toThrow()
    expect(wellFormed('\uDCAE')).toBe('\uFFFD')
  })

  it('repairs a lone surrogate embedded in otherwise valid text', () => {
    // The exact shape from the upstream memory note: 议 (U+8BAE) split into
    // 议's high byte plus a lone low surrogate.
    expect(wellFormed('ab\uDCAEcd')).toBe('ab\uFFFDcd')
    expect(wellFormed('会\uD800议')).toBe('会\uFFFD议')
  })

  it('preserves valid surrogate pairs (emoji must not be mangled)', () => {
    expect(wellFormed('😀')).toBe('😀')
    expect(wellFormed('好的 😀 收到')).toBe('好的 😀 收到')
  })

  it('is idempotent on already well-formed text', () => {
    const text = 'plain ascii, 中文, 😀, \uFFFD'
    expect(wellFormed(text)).toBe(text)
    expect(wellFormed(wellFormed(text))).toBe(text)
  })

  it('handles the empty string', () => {
    expect(wellFormed('')).toBe('')
  })
})

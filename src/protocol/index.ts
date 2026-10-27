/**
 * Protocol layer — the zero-dependency vocabulary every other layer speaks.
 *
 * THIS IS THE ONE BARREL FILE other layers import. Nothing here may import
 * Cordis, the webserver, or any inbound/outbound/session module. That
 * isolation is what keeps the protocol layer unit-testable without booting a
 * composition or opening a socket (ADR-008 layering rule).
 *
 * Authoritative source for everything exported: `specification/a2a.proto`.
 */

export * from './wire.js'
export * from './jsonrpc.js'
export * from './parse.js'
export * from './card.js'
export * from './sse.js'

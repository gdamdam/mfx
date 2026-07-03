import { describe, it, expect } from 'vitest'
import { createLinkBridge, sanitizeLinkMessage } from './linkBridge.ts'
import type { LinkState } from './linkBridge.ts'

const DEFAULT: LinkState = {
  tempo: 120,
  beat: 0,
  phase: 0,
  playing: false,
  peers: 0,
  clients: 0,
  connected: false,
}

// ---------------------------------------------------------------------------
// sanitizeLinkMessage — the trust boundary against malformed bridge messages.
// ---------------------------------------------------------------------------

describe('sanitizeLinkMessage', () => {
  // connected:true is the baseline; the sanitizer always marks connected.
  const base: LinkState = { ...DEFAULT, connected: true }

  it('passes valid in-range values through and marks connected', () => {
    const out = sanitizeLinkMessage(
      { tempo: 128, beat: 12.5, phase: 2.5, playing: true, peers: 3, clients: 2 },
      base,
    )
    expect(out).toEqual({
      tempo: 128,
      beat: 12.5,
      phase: 2.5,
      playing: true,
      peers: 3,
      clients: 2,
      connected: true,
    })
  })

  it('clamps tempo to 20..999', () => {
    expect(sanitizeLinkMessage({ tempo: 5 }, base).tempo).toBe(20)
    expect(sanitizeLinkMessage({ tempo: 5000 }, base).tempo).toBe(999)
  })

  it('clamps beat to 0..1e9 and phase to 0..16', () => {
    expect(sanitizeLinkMessage({ beat: -10 }, base).beat).toBe(0)
    expect(sanitizeLinkMessage({ beat: 1e12 }, base).beat).toBe(1e9)
    expect(sanitizeLinkMessage({ phase: -3 }, base).phase).toBe(0)
    expect(sanitizeLinkMessage({ phase: 99 }, base).phase).toBe(16)
  })

  it('floors peers/clients to non-negative ints', () => {
    const out = sanitizeLinkMessage({ peers: 3.9, clients: -2 }, base)
    expect(out.peers).toBe(3)
    expect(out.clients).toBe(0) // negative floored to 0
  })

  it('rejects NaN/Infinity per field, retaining previous values', () => {
    const prev: LinkState = { ...base, tempo: 130, beat: 4, phase: 1 }
    const out = sanitizeLinkMessage({ tempo: NaN, beat: Infinity, phase: -Infinity }, prev)
    expect(out.tempo).toBe(130)
    expect(out.beat).toBe(4)
    expect(out.phase).toBe(1)
  })

  it('rejects wrong-typed values, retaining previous values', () => {
    const prev: LinkState = { ...base, tempo: 100, peers: 5 }
    const out = sanitizeLinkMessage({ tempo: '200', peers: null }, prev)
    expect(out.tempo).toBe(100)
    expect(out.peers).toBe(5)
  })

  it('coerces playing: non-boolean falls back to prev, boolean passes through', () => {
    expect(sanitizeLinkMessage({ playing: 'yes' }, { ...base, playing: true }).playing).toBe(true)
    expect(sanitizeLinkMessage({ playing: false }, { ...base, playing: true }).playing).toBe(false)
  })

  it('treats a non-object message as empty, keeping prev per field', () => {
    const prev: LinkState = { ...base, tempo: 111 }
    expect(sanitizeLinkMessage(null, prev).tempo).toBe(111)
    expect(sanitizeLinkMessage('garbage', prev).tempo).toBe(111)
  })
})

// ---------------------------------------------------------------------------
// createLinkBridge in node — WebSocket is undefined here, so the bridge must
// stay at DEFAULT_STATE and connect() must never throw (bridge simply absent).
// ---------------------------------------------------------------------------

describe('createLinkBridge without a WebSocket global', () => {
  it('starts at the default disconnected state', () => {
    const bridge = createLinkBridge()
    expect(bridge.getState()).toEqual(DEFAULT)
  })

  it('connect() does not throw and leaves the state disconnected', () => {
    const bridge = createLinkBridge()
    expect(() => bridge.connect()).not.toThrow()
    expect(bridge.getState()).toEqual(DEFAULT)
  })

  it('connect() with autoRetry does not throw when the bridge is absent', () => {
    const bridge = createLinkBridge(true)
    expect(() => bridge.connect()).not.toThrow()
    expect(bridge.getState().connected).toBe(false)
    bridge.disconnect() // cancel the pending retry timer so the test exits clean
  })

  it('subscribe/unsubscribe and disconnect are safe no-ops when disconnected', () => {
    const bridge = createLinkBridge()
    const unsub = bridge.subscribe(() => {})
    expect(() => unsub()).not.toThrow()
    expect(() => bridge.disconnect()).not.toThrow()
  })
})

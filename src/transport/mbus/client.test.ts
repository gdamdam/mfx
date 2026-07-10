import { describe, it, expect, vi } from 'vitest'
import { createMbusClient } from './client.ts'
import type { PeerConnectionLike, WebSocketLike } from './client.ts'

// ---------------------------------------------------------------------------
// Deterministic, browser-free harness. WebSocket and RTCPeerConnection are
// injected as controllable fakes; setRemoteDescription is gated on an explicit
// deferred so tests can interleave ICE relative to the SDP handshake.
// ---------------------------------------------------------------------------

const WS_OPEN = 1

function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const wait = (ms = 0) => new Promise((r) => setTimeout(r, ms))

class FakeWs implements WebSocketLike {
  readyState = WS_OPEN
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.readyState = 3
  }
  /** Deliver a bridge → client frame. */
  emit(msg: object): void {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
  /** Types of the messages this socket sent, e.g. 'mbus/request'. */
  sentTypes(): string[] {
    return this.sent.map((s) => JSON.parse(s).type as string)
  }
}

class FakePc implements PeerConnectionLike {
  connectionState = 'new'
  onicecandidate: PeerConnectionLike['onicecandidate'] = null
  ontrack: PeerConnectionLike['ontrack'] = null
  onconnectionstatechange: (() => void) | null = null
  addedIce: Array<RTCIceCandidateInit | undefined> = []
  addedTracks: unknown[] = []
  localDesc: RTCSessionDescriptionInit | null = null
  remoteDesc: RTCSessionDescriptionInit | null = null
  closed = false
  /** setRemoteDescription blocks on this until the test resolves/rejects it. */
  srd = deferred()
  addTrack(track: MediaStreamTrack): unknown {
    this.addedTracks.push(track)
    return {}
  }
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'OFFER_SDP' }
  }
  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'ANSWER_SDP' }
  }
  async setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.localDesc = desc
  }
  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDesc = desc
    await this.srd.promise // resolve to succeed, reject to simulate an SDP error
  }
  async addIceCandidate(candidate?: RTCIceCandidateInit): Promise<void> {
    if (this.closed) throw new Error('closed')
    this.addedIce.push(candidate)
  }
  close(): void {
    this.closed = true
    this.connectionState = 'closed'
  }
  fireState(s: string): void {
    this.connectionState = s
    this.onconnectionstatechange?.()
  }
  fireTrack(track: unknown, streams: unknown[]): void {
    this.ontrack?.({ track: track as MediaStreamTrack, streams: streams as MediaStream[] })
  }
  emitIce(candidate: { toJSON(): RTCIceCandidateInit } | null): void {
    this.onicecandidate?.({ candidate })
  }
}

function makeHarness(over: Record<string, unknown> = {}) {
  const sockets: FakeWs[] = []
  const pcs: FakePc[] = []
  const client = createMbusClient({
    urls: ['ws://test'],
    autoRetry: true,
    retryMs: 1,
    webSocketFactory: () => {
      const s = new FakeWs()
      sockets.push(s)
      return s
    },
    peerConnectionFactory: () => {
      const p = new FakePc()
      pcs.push(p)
      return p
    },
    ...over,
  })
  return { client, sockets, pcs }
}

/** Bring a harness to 'connected' on its latest socket and return that socket. */
function connect(
  h: ReturnType<typeof makeHarness>,
  opts: { clientId?: string; sources?: object[] } = {},
): FakeWs {
  const ws = h.sockets[h.sockets.length - 1]!
  ws.onopen?.()
  ws.emit({
    type: 'mbus/welcome',
    clientId: opts.clientId ?? 'me',
    mbus: 1,
    sources: opts.sources ?? [],
  })
  return ws
}

/** Minimal AudioContext with instrumented gain + media-source nodes. */
function fakeCtx() {
  const gain = { connect: vi.fn(), disconnect: vi.fn() }
  const sources: Array<{ connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = []
  const ctx = {
    createGain: () => gain,
    createMediaStreamSource: () => {
      const s = { connect: vi.fn(), disconnect: vi.fn() }
      sources.push(s)
      return s
    },
  } as unknown as AudioContext
  return { ctx, gain, sources }
}

/** A publishable node whose context fans out to a single audio track. */
function fakePublishNode() {
  const track = { kind: 'audio' } as unknown as MediaStreamTrack
  const dest = { stream: { getAudioTracks: () => [track] } }
  const ctx = { createMediaStreamDestination: () => dest }
  const node = { context: ctx, connect: vi.fn(), disconnect: vi.fn() } as unknown as AudioNode
  return { node, track, dest }
}

const ice = (id: string) => ({ candidate: id } as unknown as RTCIceCandidateInit)
const sig = (from: string, payload: object) => ({ type: 'mbus/signal', from, payload })

// ===========================================================================
// ISSUE 1 — ICE ordering (subscriber side)
// ===========================================================================

describe('ICE candidate ordering — subscriber', () => {
  it('buffers ICE arriving before setRemoteDescription, flushes in arrival order (incl. end-of-candidates)', async () => {
    const h = makeHarness()
    h.client.connect()
    const ws = connect(h)
    h.client.subscribe('srcX', fakeCtx().ctx)

    // Offer arrives; setRemoteDescription is left pending.
    ws.emit(sig('pub1', { kind: 'offer', sourceId: 'srcX', sdp: 'OFFER' }))
    await wait(0)
    const pc = h.pcs[0]!
    expect(pc.addedIce).toEqual([]) // nothing applied while remote desc pending

    // Several candidates + end-of-candidates queue up.
    ws.emit(sig('pub1', { kind: 'ice', sourceId: 'srcX', candidate: ice('a') }))
    ws.emit(sig('pub1', { kind: 'ice', sourceId: 'srcX', candidate: ice('b') }))
    ws.emit(sig('pub1', { kind: 'ice', sourceId: 'srcX', candidate: null }))
    await wait(0)
    expect(pc.addedIce).toEqual([]) // still buffered — remote desc not set

    // Remote description resolves → flush in exact arrival order.
    pc.srd.resolve()
    await wait(0)
    expect(pc.addedIce).toEqual([ice('a'), ice('b'), undefined])
  })

  it('applies ICE immediately once remoteDescription is set', async () => {
    const h = makeHarness()
    h.client.connect()
    const ws = connect(h)
    h.client.subscribe('srcX', fakeCtx().ctx)
    ws.emit(sig('pub1', { kind: 'offer', sourceId: 'srcX', sdp: 'OFFER' }))
    await wait(0)
    const pc = h.pcs[0]!
    pc.srd.resolve()
    await wait(0)

    ws.emit(sig('pub1', { kind: 'ice', sourceId: 'srcX', candidate: ice('late') }))
    await wait(0)
    expect(pc.addedIce).toEqual([ice('late')])
  })

  it('drops buffered ICE and goes terminal failed when setRemoteDescription rejects', async () => {
    const h = makeHarness()
    h.client.connect()
    const ws = connect(h)
    const { ctx } = fakeCtx()
    const sub = h.client.subscribe('srcX', ctx)
    const states: string[] = []
    sub.onState((s) => states.push(s))

    ws.emit(sig('pub1', { kind: 'offer', sourceId: 'srcX', sdp: 'OFFER' }))
    await wait(0)
    ws.emit(sig('pub1', { kind: 'ice', sourceId: 'srcX', candidate: ice('a') }))
    await wait(0)
    const pc = h.pcs[0]!

    pc.srd.reject(new Error('bad sdp'))
    await wait(0)
    expect(sub.getState()).toBe('failed')
    expect(states).toContain('failed')
    expect(pc.addedIce).toEqual([]) // buffered candidate never applied
    // intent removed → re-subscribe is allowed
    expect(() => h.client.subscribe('srcX', ctx)).not.toThrow()
  })

  it('teardown with queued ICE clears buffers without throwing', async () => {
    const h = makeHarness()
    h.client.connect()
    const ws = connect(h)
    const sub = h.client.subscribe('srcX', fakeCtx().ctx)
    ws.emit(sig('pub1', { kind: 'offer', sourceId: 'srcX', sdp: 'OFFER' }))
    await wait(0)
    ws.emit(sig('pub1', { kind: 'ice', sourceId: 'srcX', candidate: ice('a') }))
    ws.emit(sig('pub1', { kind: 'ice', sourceId: 'srcX', candidate: ice('b') }))
    await wait(0)
    const pc = h.pcs[0]!

    expect(() => sub.close()).not.toThrow()
    // Resolving the SDP after close must not flush anything (pc superseded).
    pc.srd.resolve()
    await wait(0)
    expect(pc.addedIce).toEqual([])
    expect(sub.getState()).toBe('closed')
  })
})

// ===========================================================================
// ISSUE 1 — ICE ordering (publisher side)
// ===========================================================================

/** Announce a publication and drive it to 'announced' with the given id. */
function publishAndAnnounce(h: ReturnType<typeof makeHarness>, ws: FakeWs, sourceId: string) {
  const { node } = fakePublishNode()
  const pub = h.client.publishOutput(node, 'out')
  ws.emit({ type: 'mbus/announced', sourceId, name: 'out' })
  return pub
}

describe('ICE candidate ordering — publisher', () => {
  it('buffers ICE arriving before the answer, flushes in order after setRemoteDescription', async () => {
    const h = makeHarness()
    h.client.connect()
    const ws = connect(h)
    publishAndAnnounce(h, ws, 'srcP')

    ws.emit({ type: 'mbus/request', sourceId: 'srcP', from: 'subA' })
    await wait(0)
    const pc = h.pcs[0]!
    expect(ws.sentTypes()).toContain('mbus/signal') // offer sent

    // Candidates arrive before the answer's remote description.
    ws.emit(sig('subA', { kind: 'ice', sourceId: 'srcP', candidate: ice('p1') }))
    ws.emit(sig('subA', { kind: 'ice', sourceId: 'srcP', candidate: null }))
    await wait(0)
    expect(pc.addedIce).toEqual([])

    ws.emit(sig('subA', { kind: 'answer', sourceId: 'srcP', sdp: 'ANS' }))
    await wait(0)
    pc.srd.resolve()
    await wait(0)
    expect(pc.addedIce).toEqual([ice('p1'), undefined])
  })

  it('drops candidates buffered on a superseded pc after a re-request', async () => {
    const h = makeHarness()
    h.client.connect()
    const ws = connect(h)
    const pub = publishAndAnnounce(h, ws, 'srcP')

    ws.emit({ type: 'mbus/request', sourceId: 'srcP', from: 'subA' })
    await wait(0)
    const pc0 = h.pcs[0]!
    ws.emit(sig('subA', { kind: 'ice', sourceId: 'srcP', candidate: ice('stale') }))
    await wait(0) // buffered on pc0

    // Re-request from the same subscriber replaces the connection.
    ws.emit({ type: 'mbus/request', sourceId: 'srcP', from: 'subA' })
    await wait(0)
    const pc1 = h.pcs[1]!
    expect(pc0.closed).toBe(true)
    expect(pub.subscriberCount()).toBe(1)

    // Answer for the new pc → its (empty) buffer flushes; stale never appears.
    ws.emit(sig('subA', { kind: 'answer', sourceId: 'srcP', sdp: 'ANS' }))
    await wait(0)
    pc1.srd.resolve()
    await wait(0)
    expect(pc0.addedIce).toEqual([])
    expect(pc1.addedIce).toEqual([])
  })
})

// ===========================================================================
// ISSUE 2 — stale publisher connection callbacks
// ===========================================================================

describe('stale publisher callbacks', () => {
  it('a failed/closed callback on an old pc never deletes its replacement', async () => {
    const h = makeHarness()
    h.client.connect()
    const ws = connect(h)
    const pub = publishAndAnnounce(h, ws, 'srcP')

    ws.emit({ type: 'mbus/request', sourceId: 'srcP', from: 'subA' })
    await wait(0)
    const pc0 = h.pcs[0]!

    ws.emit({ type: 'mbus/request', sourceId: 'srcP', from: 'subA' })
    await wait(0)
    const pc1 = h.pcs[1]!
    expect(pub.subscriberCount()).toBe(1)

    // The OLD pc fires failed/closed late — must not evict the new record.
    pc0.fireState('failed')
    pc0.fireState('closed')
    expect(pub.subscriberCount()).toBe(1)
    expect(pc1.closed).toBe(false)

    // The current pc's own failure still evicts it.
    pc1.fireState('failed')
    expect(pub.subscriberCount()).toBe(0)
  })
})

// ===========================================================================
// ISSUE 3 / 8 — subscription recovery + lifecycle
// ===========================================================================

/** Drive a subscription to 'live' on the given socket; returns its FakePc. */
async function bringSubLive(
  h: ReturnType<typeof makeHarness>,
  ws: FakeWs,
  sourceId: string,
  from: string,
): Promise<FakePc> {
  ws.emit(sig(from, { kind: 'offer', sourceId, sdp: 'OFFER' }))
  await wait(0)
  const pc = h.pcs[h.pcs.length - 1]!
  pc.srd.resolve()
  await wait(0)
  pc.fireTrack({ kind: 'audio' }, [{}])
  pc.fireState('connected')
  return pc
}

describe('subscription recovery across a WS drop', () => {
  it('preserves intent and re-wires into the same node on reconnect', async () => {
    const h = makeHarness()
    h.client.connect()
    const ws0 = connect(h, { sources: [{ sourceId: 'srcX', name: 'n', clientId: 'pub1' }] })
    const fc = fakeCtx()
    const sub = h.client.subscribe('srcX', fc.ctx)
    const node0 = sub.node
    const pc0 = await bringSubLive(h, ws0, 'srcX', 'pub1')
    expect(sub.getState()).toBe('live')
    expect(fc.sources[0]!.connect).toHaveBeenCalledWith(fc.gain)

    const states: string[] = []
    sub.onState((s) => states.push(s))

    // WS drops.
    ws0.onclose?.()
    expect(sub.getState()).toBe('connecting') // intent kept, reset
    expect(pc0.closed).toBe(true)
    expect(fc.sources[0]!.disconnect).toHaveBeenCalled() // media node released once

    // Retry reconnects; welcome re-lists the source and the loop re-requests.
    await wait(20)
    const ws1 = connect(h, { sources: [{ sourceId: 'srcX', name: 'n', clientId: 'pub2' }] })
    expect(ws1.sentTypes()).toContain('mbus/request')

    // New publisher (new clientId) offers again → re-wired into the SAME node.
    await bringSubLive(h, ws1, 'srcX', 'pub2')
    expect(sub.getState()).toBe('live')
    expect(sub.node).toBe(node0)
    expect(states).toEqual(['connecting', 'live'])
    expect(fc.sources[1]!.connect).toHaveBeenCalledWith(fc.gain)
  })

  it('a manually closed subscription is never resurrected on reconnect', async () => {
    const h = makeHarness()
    h.client.connect()
    const ws0 = connect(h, { sources: [{ sourceId: 'srcX', name: 'n', clientId: 'pub1' }] })
    const sub = h.client.subscribe('srcX', fakeCtx().ctx)
    await bringSubLive(h, ws0, 'srcX', 'pub1')

    ws0.onclose?.()
    sub.close()
    expect(sub.getState()).toBe('closed')

    await wait(20)
    const ws1 = connect(h, { sources: [{ sourceId: 'srcX', name: 'n', clientId: 'pub2' }] })
    expect(ws1.sentTypes()).not.toContain('mbus/request')
    expect(sub.getState()).toBe('closed')
  })

  it('terminal RTC failure tears down, deletes intent and notifies', async () => {
    const h = makeHarness()
    h.client.connect()
    const ws = connect(h, { sources: [{ sourceId: 'srcX', name: 'n', clientId: 'pub1' }] })
    const fc = fakeCtx()
    const sub = h.client.subscribe('srcX', fc.ctx)
    const states: string[] = []
    sub.onState((s) => states.push(s))
    await bringSubLive(h, ws, 'srcX', 'pub1')
    const pc = h.pcs[0]!

    pc.fireState('failed')
    expect(sub.getState()).toBe('failed')
    expect(states).toContain('failed')
    expect(fc.sources[0]!.disconnect).toHaveBeenCalled()
    // intent gone → a fresh subscribe is possible
    expect(() => h.client.subscribe('srcX', fc.ctx)).not.toThrow()
  })

  it('a source vanishing from a live directory fails the subscription', async () => {
    const h = makeHarness()
    h.client.connect()
    const ws = connect(h, { sources: [{ sourceId: 'srcX', name: 'n', clientId: 'pub1' }] })
    const sub = h.client.subscribe('srcX', fakeCtx().ctx)
    await bringSubLive(h, ws, 'srcX', 'pub1')

    ws.emit({ type: 'mbus/sources', sources: [] }) // publisher gone while connected
    expect(sub.getState()).toBe('failed')
  })
})

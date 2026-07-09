import { describe, it, expect, afterEach } from 'vitest'
import { DEFAULT_PATCH } from '../audio/contracts.ts'
import {
  applyWelcome,
  createNativeCompanion,
  sanitizeStatusMessage,
  type NativeStatus,
} from './nativeCompanion.ts'

const BASE: NativeStatus = {
  connected: false,
  running: false,
  sampleRate: 48000,
  bufferFrames: 128,
  estimatedLatencyMs: 0,
  xruns: 0,
  bypass: false,
  version: '',
  capabilities: [],
  inputs: [],
  outputs: [],
  lastError: null,
}

describe('sanitizeStatusMessage', () => {
  it('folds a valid status', () => {
    const s = sanitizeStatusMessage(
      { type: 'status', running: true, sampleRate: 44100, bufferFrames: 256, estimatedLatencyMs: 8.4, xruns: 3, bypass: true },
      BASE,
    )
    expect(s.running).toBe(true)
    expect(s.sampleRate).toBe(44100)
    expect(s.bufferFrames).toBe(256)
    expect(s.estimatedLatencyMs).toBeCloseTo(8.4, 3)
    expect(s.xruns).toBe(3)
    expect(s.bypass).toBe(true)
  })

  it('rejects non-finite / wrong-typed fields, keeping previous values', () => {
    const prev = { ...BASE, sampleRate: 48000, xruns: 5 }
    const s = sanitizeStatusMessage(
      { sampleRate: Number.NaN, xruns: 'lots', estimatedLatencyMs: Infinity },
      prev,
    )
    expect(s.sampleRate).toBe(48000)
    expect(s.xruns).toBe(5)
    expect(s.estimatedLatencyMs).toBe(0)
  })

  it('clamps out-of-range numbers', () => {
    const s = sanitizeStatusMessage({ sampleRate: 999999, bufferFrames: 0 }, BASE)
    expect(s.sampleRate).toBe(192000)
    expect(s.bufferFrames).toBe(1)
  })
})

describe('applyWelcome', () => {
  it('marks connected and records version + capabilities', () => {
    const s = applyWelcome(
      { type: 'welcome', protocol: 1, version: '0.1.0', capabilities: ['native-audio', 42] },
      BASE,
    )
    expect(s.connected).toBe(true)
    expect(s.version).toBe('0.1.0')
    expect(s.capabilities).toEqual(['native-audio']) // non-strings filtered
  })
})

describe('createNativeCompanion without a WebSocket global', () => {
  it('stays disconnected and never throws when the companion is absent', () => {
    // In node there is no global WebSocket; connect() must be a graceful no-op.
    const c = createNativeCompanion()
    expect(() => c.connect()).not.toThrow()
    expect(c.getState().connected).toBe(false)
    // Sends are dropped silently with no socket.
    expect(() => c.sendPatch(DEFAULT_PATCH)).not.toThrow()
    c.disconnect()
  })
})

// ---- Fake WebSocket lifecycle -------------------------------------------------

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  url: string
  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.readyState = 3
    this.onclose?.()
  }
  fireOpen() {
    this.readyState = 1
    this.onopen?.()
  }
  fireMessage(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) })
  }
}

describe('createNativeCompanion with a fake WebSocket', () => {
  afterEach(() => {
    FakeWebSocket.instances = []
    // Remove the global we installed so other tests see node's default (none).
    delete (globalThis as unknown as { WebSocket?: unknown }).WebSocket
  })

  function install() {
    ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket
  }

  it('handshakes, applies status, and streams the patch subset', () => {
    install()
    const c = createNativeCompanion()
    const seen: NativeStatus[] = []
    c.subscribe((s) => seen.push(s))
    c.connect()

    const sock = FakeWebSocket.instances[0]
    expect(sock).toBeTruthy()
    sock.fireOpen()

    // On open the client sends hello + listDevices.
    const openMsgs = sock.sent.map((s) => JSON.parse(s).type)
    expect(openMsgs).toContain('hello')
    expect(openMsgs).toContain('listDevices')

    // Not connected until welcome arrives.
    expect(c.getState().connected).toBe(false)
    sock.fireMessage({ type: 'welcome', protocol: 1, version: '0.1.0', capabilities: ['native-audio'] })
    expect(c.getState().connected).toBe(true)
    expect(c.getState().version).toBe('0.1.0')

    sock.fireMessage({ type: 'devices', inputs: [{ id: 'in', name: 'Mic' }], outputs: [{ id: 'out', name: 'Speakers' }] })
    expect(c.getState().inputs).toEqual([{ id: 'in', name: 'Mic' }])

    sock.fireMessage({ type: 'status', running: true, sampleRate: 48000, bufferFrames: 128, estimatedLatencyMs: 5.3, xruns: 0, bypass: false })
    expect(c.getState().running).toBe(true)
    expect(c.getState().estimatedLatencyMs).toBeCloseTo(5.3, 3)

    // sendPatch serializes the native subset over the wire.
    sock.sent.length = 0
    c.sendPatch(DEFAULT_PATCH)
    const patchMsg = JSON.parse(sock.sent[0])
    expect(patchMsg.type).toBe('setPatch')
    expect(patchMsg.patch.slots.map((s: { id: string }) => s.id)).toEqual(['drive', 'filter', 'delay', 'reverb'])

    // A status change never throws and is delivered to subscribers.
    expect(seen.length).toBeGreaterThan(0)
  })

  it('surfaces an error frame and clears it on a running status', () => {
    install()
    const c = createNativeCompanion()
    c.connect()
    const sock = FakeWebSocket.instances[0]
    sock.fireOpen()
    sock.fireMessage({ type: 'welcome', protocol: 1, version: '0.1.0', capabilities: [] })
    expect(c.getState().lastError).toBeNull()

    // Companion couldn't open the device: error frame + a stopped status.
    sock.fireMessage({ type: 'error', message: 'could not start audio: device busy\n' })
    sock.fireMessage({ type: 'status', running: false })
    expect(c.getState().lastError).toBe('could not start audio: device busy')

    // A live stream clears the error.
    sock.fireMessage({ type: 'status', running: true })
    expect(c.getState().lastError).toBeNull()
  })

  it('resets to disconnected on socket close', () => {
    install()
    const c = createNativeCompanion()
    c.connect()
    const sock = FakeWebSocket.instances[0]
    sock.fireOpen()
    sock.fireMessage({ type: 'welcome', protocol: 1, version: '0.1.0', capabilities: [] })
    expect(c.getState().connected).toBe(true)
    sock.close()
    expect(c.getState().connected).toBe(false)
    expect(c.getState().running).toBe(false)
  })
})

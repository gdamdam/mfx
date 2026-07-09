/**
 * nativeCompanion — client for the mfx native companion (a local, low-latency
 * audio I/O engine controlled over localhost). See `native-companion/` for the
 * server. mfx is fully usable with NO companion running: when absent, the state
 * stays { connected: false } and nothing throws — exactly like the Link bridge.
 *
 * Mirrors the suite's `linkBridge.ts` client (AGPL-3.0): the WS_URLS fallback
 * order, the per-field sanitizer, and the connect/retry/onclose lifecycle. All
 * traffic stays on loopback. Timing is delegated to setTimeout for the optional
 * auto-retry only, so the message sanitizers stay pure and testable.
 */

import type { Patch } from '../audio/contracts.ts'
import { toNativePatch } from './patchSubset.ts'

export interface NativeDevice {
  id: string
  name: string
}

export interface NativeStatus {
  connected: boolean // handshake completed with a companion
  running: boolean // an audio stream is live
  sampleRate: number
  bufferFrames: number
  estimatedLatencyMs: number
  xruns: number
  bypass: boolean
  version: string // companion semver from `welcome`
  capabilities: string[]
  inputs: NativeDevice[]
  outputs: NativeDevice[]
  lastError: string | null // last `error` frame from the companion (e.g. device failed to open)
}

/** Protocol version this client speaks. */
export const CLIENT_PROTOCOL = 1

/** Loopback addresses tried in order; Safari blocks some from HTTPS pages. */
const WS_URLS = ['ws://127.0.0.1:8730', 'ws://[::1]:8730', 'ws://localhost:8730'] as const
const RETRY_MS = 5000

const DEFAULT_STATUS: NativeStatus = {
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

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

/** Coerce an untrusted `error` message into a short, control-char-free string. */
function sanitizeErrorMessage(v: unknown): string {
  const s = typeof v === 'string' ? v : 'native companion reported an error'
  // eslint-disable-next-line no-control-regex
  const clean = s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200)
  return clean || 'native companion reported an error'
}

function clampFinite(value: unknown, prev: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : prev
}

function asDevices(v: unknown): NativeDevice[] {
  if (!Array.isArray(v)) return []
  const out: NativeDevice[] = []
  for (const d of v) {
    const rec = asRecord(d)
    if (typeof rec.id === 'string' && typeof rec.name === 'string') {
      out.push({ id: rec.id, name: rec.name })
    }
  }
  return out
}

/**
 * Fold an untrusted `status` message into the previous status. Exported for
 * unit testing; this is the trust boundary for companion traffic.
 */
export function sanitizeStatusMessage(msg: unknown, prev: NativeStatus): NativeStatus {
  const rec = asRecord(msg)
  const running = typeof rec.running === 'boolean' ? rec.running : prev.running
  return {
    ...prev,
    running,
    sampleRate: Math.floor(clampFinite(rec.sampleRate, prev.sampleRate, 8000, 192000)),
    bufferFrames: Math.floor(clampFinite(rec.bufferFrames, prev.bufferFrames, 1, 8192)),
    estimatedLatencyMs: clampFinite(rec.estimatedLatencyMs, prev.estimatedLatencyMs, 0, 10000),
    xruns: Math.floor(clampFinite(rec.xruns, prev.xruns, 0, Number.MAX_SAFE_INTEGER)),
    bypass: typeof rec.bypass === 'boolean' ? rec.bypass : prev.bypass,
    // A live stream clears any prior error; a stopped stream keeps it (the
    // companion emits the `error` frame, then a status{running:false}).
    lastError: running ? null : prev.lastError,
  }
}

/** Fold a `welcome` message into the status (records the handshake). */
export function applyWelcome(msg: unknown, prev: NativeStatus): NativeStatus {
  const rec = asRecord(msg)
  return {
    ...prev,
    connected: true,
    lastError: null, // a fresh handshake clears any stale error
    version: typeof rec.version === 'string' ? rec.version : prev.version,
    capabilities: Array.isArray(rec.capabilities)
      ? rec.capabilities.filter((c): c is string => typeof c === 'string')
      : prev.capabilities,
  }
}

export interface SetAudioOpts {
  inputDeviceId?: string
  outputDeviceId?: string
  sampleRate?: number
  bufferFrames?: number
}

export interface NativeCompanion {
  connect(): void
  disconnect(): void
  getState(): NativeStatus
  subscribe(cb: (s: NativeStatus) => void): () => void
  listDevices(): void
  setAudio(opts: SetAudioOpts): void
  sendPatch(patch: Patch): void
  setBypass(bypass: boolean): void
  panic(): void
}

/**
 * Create a native companion client.
 * @param autoRetry When true, retry every 5 s until connected and reconnect on
 *   drop. When false (default), try the address list once and give up quietly if
 *   the companion isn't running.
 */
export function createNativeCompanion(autoRetry = false): NativeCompanion {
  let ws: WebSocket | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let listeners: Array<(s: NativeStatus) => void> = []
  let state: NativeStatus = { ...DEFAULT_STATUS }
  let enabled = false
  let urlIdx = 0
  let attempted = 0

  function notify(): void {
    for (const fn of listeners) fn(state)
  }

  function send(obj: unknown): void {
    // Only send once the socket is open; silently drop otherwise.
    if (ws && ws.readyState === 1) {
      try {
        ws.send(JSON.stringify(obj))
      } catch {
        /* socket closing */
      }
    }
  }

  function scheduleRetry(): void {
    if (!autoRetry) return
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = setTimeout(open, RETRY_MS)
  }

  function tryNextUrl(): void {
    attempted++
    urlIdx = (urlIdx + 1) % WS_URLS.length
    if (attempted < WS_URLS.length) {
      open()
    } else {
      attempted = 0
      scheduleRetry()
    }
  }

  function open(): void {
    if (ws) return
    if (typeof WebSocket === 'undefined') {
      scheduleRetry()
      return
    }
    let socket: WebSocket
    try {
      socket = new WebSocket(WS_URLS[urlIdx])
    } catch {
      tryNextUrl()
      return
    }
    ws = socket
    let welcomed = false

    socket.onopen = () => {
      if (socket !== ws) return // a stale socket from a prior connect cycle
      attempted = 0
      // Begin the handshake; `connected` flips only once we get `welcome`.
      send({ type: 'hello', client: 'mfx', protocol: CLIENT_PROTOCOL })
      send({ type: 'listDevices' })
    }

    socket.onmessage = (e: MessageEvent) => {
      if (socket !== ws) return // ignore events from a superseded socket
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(String(e.data)) as Record<string, unknown>
      } catch {
        return // ignore malformed JSON
      }
      switch (msg.type) {
        case 'welcome':
          welcomed = true
          state = applyWelcome(msg, state)
          notify()
          break
        case 'devices':
          state = { ...state, inputs: asDevices(msg.inputs), outputs: asDevices(msg.outputs) }
          notify()
          break
        case 'status':
          state = sanitizeStatusMessage(msg, state)
          notify()
          break
        case 'error':
          // The companion couldn't honour a request (e.g. the audio device
          // failed to open). Surface it so the UI stops showing "starting…".
          state = { ...state, lastError: sanitizeErrorMessage(msg.message) }
          notify()
          break
        default:
          break // unknown message types dropped (forward-compat)
      }
    }

    socket.onclose = () => {
      // A superseded socket closing must not clobber the live `ws` or schedule
      // a duplicate reconnect — bail before touching any shared state.
      if (socket !== ws) return
      ws = null
      if (state.connected || state.running) {
        state = { ...DEFAULT_STATUS }
        notify()
      }
      if (!enabled) return
      if (welcomed) scheduleRetry()
      else tryNextUrl()
    }

    socket.onerror = () => {
      try {
        socket.close()
      } catch {
        /* may not be open yet */
      }
    }
  }

  return {
    connect(): void {
      enabled = true
      attempted = 0
      urlIdx = 0
      open()
    },
    disconnect(): void {
      enabled = false
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      if (ws) {
        try {
          ws.close()
        } catch {
          /* already closing */
        }
        ws = null
      }
      if (state.connected || state.running) {
        state = { ...DEFAULT_STATUS }
        notify()
      }
    },
    getState(): NativeStatus {
      return state
    },
    subscribe(cb: (s: NativeStatus) => void): () => void {
      listeners.push(cb)
      return () => {
        listeners = listeners.filter((l) => l !== cb)
      }
    },
    listDevices(): void {
      send({ type: 'listDevices' })
    },
    setAudio(opts: SetAudioOpts): void {
      // Only send sampleRate/bufferFrames when the caller actually provided
      // them; omitted fields let the companion keep the device/server default
      // (its set_audio_params treats both as Option). Forcing 48000/128 here
      // would override whatever the device negotiates.
      const msg: Record<string, unknown> = {
        type: 'setAudio',
        inputDeviceId: opts.inputDeviceId ?? null,
        outputDeviceId: opts.outputDeviceId ?? null,
      }
      if (opts.sampleRate !== undefined) msg.sampleRate = opts.sampleRate
      if (opts.bufferFrames !== undefined) msg.bufferFrames = opts.bufferFrames
      send(msg)
    },
    sendPatch(patch: Patch): void {
      send({ type: 'setPatch', patch: toNativePatch(patch) })
    },
    setBypass(bypass: boolean): void {
      send({ type: 'setBypass', bypass })
    },
    panic(): void {
      send({ type: 'panic' })
    },
  }
}

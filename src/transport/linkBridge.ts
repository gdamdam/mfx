/**
 * linkBridge — client for the Ableton Link companion bridge.
 *
 * Browsers can't speak Ableton Link directly (no UDP / multicast), so a small
 * companion app runs a WebSocket server on localhost:19876 that bridges Link to
 * the browser. mfx is fully usable with NO bridge running: when absent, the
 * state simply stays { tempo: 120, …, connected: false } and nothing throws.
 *
 * Adapted from mspectr's transport client (mspectr/src/transport/linkBridge.ts,
 * AGPL-3.0, github.com/gdamdam/mspectr): the WS_URLS fallback order, the
 * per-field sanitizer (clampFinite + sanitizeLinkMessage), and the
 * connect/retry/onclose lifecycle are derived from there.
 *
 * No internet connections are made — all traffic stays on localhost, read-only.
 * No Date.now / Math.random; timing is delegated to setTimeout for the optional
 * 5 s auto-retry only, so sanitizeLinkMessage stays pure and testable.
 */

export interface LinkState {
  tempo: number // BPM from the Link session
  beat: number // current beat position
  phase: number // phase within a bar
  playing: boolean // whether the Link session is playing
  peers: number // other Link peers (Ableton Live, Bitwig, …)
  clients: number // browser clients connected to the bridge
  connected: boolean // whether we're connected to the bridge
}

/** Loopback addresses tried in order; Safari blocks some from HTTPS pages. */
const WS_URLS = ['ws://127.0.0.1:19876', 'ws://[::1]:19876', 'ws://localhost:19876'] as const
const RETRY_MS = 5000

const DEFAULT_STATE: LinkState = {
  tempo: 120,
  beat: 0,
  phase: 0,
  playing: false,
  peers: 0,
  clients: 0,
  connected: false,
}

/** Coerce an unknown value into a plain record for per-field reads. */
function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

/** Keep a numeric field only if finite, clamped to [min, max]; else fall back
 *  to prev. Rejects NaN/Infinity/strings — defence against a hostile or buggy
 *  local process feeding garbage into tempo-driven math. */
function clampFinite(value: unknown, prev: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : prev
}

/**
 * Build the next LinkState from an untrusted "link" message + previous state.
 * Exported for unit testing; this is the trust boundary for bridge traffic.
 *  - tempo  clamped 20..999
 *  - beat   clamped 0..1e9
 *  - phase  clamped 0..16
 *  - peers/clients floored ints >= 0
 *  - playing  boolean (else prev)
 *  - NaN / Infinity / wrong-type → rejected (prev retained per field)
 */
export function sanitizeLinkMessage(msg: unknown, prev: LinkState): LinkState {
  const rec = asRecord(msg)
  return {
    tempo: clampFinite(rec.tempo, prev.tempo, 20, 999),
    beat: clampFinite(rec.beat, prev.beat, 0, 1e9),
    phase: clampFinite(rec.phase, prev.phase, 0, 16),
    playing: typeof rec.playing === 'boolean' ? rec.playing : prev.playing,
    peers: Math.floor(clampFinite(rec.peers, prev.peers, 0, 9999)),
    clients: Math.floor(clampFinite(rec.clients, prev.clients, 0, 9999)),
    connected: true,
  }
}

export interface LinkBridge {
  connect(): void
  disconnect(): void
  getState(): LinkState
  subscribe(cb: (s: LinkState) => void): () => void
}

/**
 * Create a Link bridge client.
 * @param autoRetry  When true, retry every 5 s until connected and reconnect on
 *   drop. When false (default), try the address list once and silently give up
 *   if the bridge isn't running.
 */
export function createLinkBridge(autoRetry = false): LinkBridge {
  let ws: WebSocket | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let listeners: Array<(s: LinkState) => void> = []
  let state: LinkState = { ...DEFAULT_STATE }
  let enabled = false
  let urlIdx = 0
  let attempted = 0

  function notify(): void {
    for (const fn of listeners) fn(state)
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
    // Absent/unsupported WebSocket (node/tests, or a constructor that throws):
    // tolerate silently, leave state disconnected, and retry later if configured.
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
    let opened = false

    socket.onopen = () => {
      opened = true
      attempted = 0
      state = { ...state, connected: true }
      notify()
    }

    socket.onmessage = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(String(e.data)) as Record<string, unknown>
        if (msg && msg.type === 'link') {
          state = sanitizeLinkMessage(msg, state)
          notify()
        }
      } catch {
        /* ignore malformed JSON */
      }
    }

    socket.onclose = () => {
      ws = null
      // A dropped bridge means no peers; reflect that so tempo-synced UI stops.
      if (state.connected) {
        state = { ...state, connected: false, peers: 0 }
        notify()
      }
      if (!enabled) return
      if (opened) scheduleRetry()
      else tryNextUrl()
    }

    socket.onerror = () => {
      // Let onclose advance through the fallback list exactly once per cycle.
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
      if (state.connected) {
        state = { ...state, connected: false, peers: 0 }
        notify()
      }
    },
    getState(): LinkState {
      return state
    },
    subscribe(cb: (s: LinkState) => void): () => void {
      listeners.push(cb)
      return () => {
        listeners = listeners.filter((l) => l !== cb)
      }
    },
  }
}

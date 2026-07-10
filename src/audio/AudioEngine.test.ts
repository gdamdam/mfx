import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { AudioEngine } from './AudioEngine.ts'
import type { MbusClient } from '../transport/mbus/index.ts'

// ---------------------------------------------------------------------------
// Minimal Web Audio mocks. The engine references AudioContext / AudioWorkletNode
// and navigator.mediaDevices as globals at call time, so we stub them per test.
// ---------------------------------------------------------------------------

class FakeParam {
  value = 0
  setTargetAtTime(): void {}
}

class FakeNode {
  connections: FakeNode[] = []
  disconnected = false
  disconnectCount = 0
  connect(target: FakeNode): FakeNode {
    this.connections.push(target)
    return target
  }
  disconnect(): void {
    this.disconnected = true
    this.disconnectCount++
    this.connections = []
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam()
}

class FakeCompressor extends FakeNode {
  threshold = new FakeParam()
  knee = new FakeParam()
  ratio = new FakeParam()
  attack = new FakeParam()
  release = new FakeParam()
  reduction = 0
}

const bufferSources: FakeBufferSource[] = []
class FakeBufferSource extends FakeNode {
  buffer: unknown = null
  loop = false
  started = false
  stopped = false
  constructor() {
    super()
    bufferSources.push(this)
  }
  start(): void {
    this.started = true
  }
  stop(): void {
    if (this.stopped) throw new Error('already stopped')
    this.stopped = true
  }
}

const mediaStreamSources: FakeMediaStreamSource[] = []
class FakeMediaStreamSource extends FakeNode {
  stream: unknown = null
  constructor() {
    super()
    mediaStreamSources.push(this)
  }
}

class FakeBuffer {
  private data: Float32Array[]
  constructor(ch: number, len: number) {
    this.data = Array.from({ length: ch }, () => new Float32Array(len))
  }
  getChannelData(i: number): Float32Array {
    return this.data[i]
  }
}

const workletNodes: FakeAudioWorkletNode[] = []
class FakeAudioWorkletNode extends FakeNode {
  name: string
  posted: unknown[] = []
  port = {
    onmessage: null as ((e: { data: unknown }) => void) | null,
    postMessage: (...args: unknown[]) => {
      this.posted.push(args)
    },
  }
  constructor(_ctx: unknown, name: string) {
    super()
    this.name = name
    workletNodes.push(this)
  }
}

let addModuleImpl: (url: string) => Promise<void>
let ctxSampleRate = 48000
let lastCtx: FakeAudioContext | null = null

class FakeAudioContext {
  state = 'running'
  sampleRate = ctxSampleRate
  currentTime = 0
  baseLatency = 0
  outputLatency = 0
  destination = new FakeNode()
  closed = false
  audioWorklet = { addModule: (url: string) => addModuleImpl(url) }
  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- test needs a handle to the last-created ctx
    lastCtx = this
  }
  async resume(): Promise<void> {
    this.state = 'running'
  }
  async close(): Promise<void> {
    this.closed = true
    this.state = 'closed'
  }
  createGain(): FakeGain {
    return new FakeGain()
  }
  createDynamicsCompressor(): FakeCompressor {
    return new FakeCompressor()
  }
  createBufferSource(): FakeBufferSource {
    return new FakeBufferSource()
  }
  createBuffer(ch: number, len: number): FakeBuffer {
    return new FakeBuffer(ch, len)
  }
  createMediaStreamSource(stream: unknown): FakeMediaStreamSource {
    const n = new FakeMediaStreamSource()
    n.stream = stream
    return n
  }
}

interface FakeTrack {
  stop: () => void
  stopped: boolean
  stopCount: number
  kind: string
  /** Number of currently-registered 'ended' listeners (0 after removal). */
  listenerCount: number
  /** Test helper: simulate the track ending (Chrome "Stop sharing", unplug). */
  end: () => void
  addEventListener: (type: string, cb: () => void, opts?: unknown) => void
  removeEventListener: (type: string, cb: () => void) => void
}
function makeStream(kinds: string[]): { tracks: FakeTrack[]; stream: unknown } {
  const tracks: FakeTrack[] = kinds.map((kind) => {
    let endedCb: (() => void) | null = null
    const t: FakeTrack = {
      kind,
      stopped: false,
      stopCount: 0,
      listenerCount: 0,
      stop() {
        t.stopped = true
        t.stopCount++
      },
      addEventListener(type, cb) {
        if (type === 'ended') {
          endedCb = cb
          t.listenerCount++
        }
      },
      removeEventListener(type, cb) {
        if (type === 'ended' && endedCb === cb) {
          endedCb = null
          t.listenerCount--
        }
      },
      end() {
        endedCb?.()
      },
    }
    return t
  })
  const stream = {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
  }
  return { tracks, stream }
}

const recorder = () => workletNodes.find((n) => n.name === 'mfx-recorder')!
const chunk = (n: number) => ({
  data: { type: 'chunk', left: new Float32Array(n), right: new Float32Array(n) },
})
const flushed = () => ({ data: { type: 'flushed' } })

// ---------------------------------------------------------------------------
// Fake mbus client + subscription. Implements only the surface AudioEngine uses
// (onSources / getState / connect / disconnect / subscribe). Test helpers let a
// test emit directory snapshots, flip bridge state, and drive sub state.
// ---------------------------------------------------------------------------
interface FakeSub {
  sourceId: string
  node: FakeGain
  closed: boolean
  closeCount: number
  getState(): string
  onState(cb: (s: string) => void): () => void
  close(): void
  /** Test helper: push a subscription state (e.g. 'failed'). */
  emitState(s: string): void
}
class FakeMbus {
  state = 'connected'
  private sourcesCb: ((s: unknown[]) => void) | null = null
  connectCount = 0
  disconnectCount = 0
  subs: FakeSub[] = []
  subscribeCalls = 0
  connect(): void {
    this.connectCount++
  }
  disconnect(): void {
    this.disconnectCount++
  }
  getState(): string {
    return this.state
  }
  getClientId(): string | null {
    return 'fake'
  }
  getSources(): unknown[] {
    return []
  }
  onState(): () => void {
    return () => {}
  }
  onSources(cb: (s: unknown[]) => void): () => void {
    this.sourcesCb = cb
    return () => {}
  }
  publishOutput(): unknown {
    throw new Error('not used')
  }
  subscribe(sourceId: string, ctx: { createGain: () => FakeGain }): FakeSub {
    if (this.subs.some((s) => !s.closed && s.sourceId === sourceId)) {
      throw new Error(`already subscribed to ${sourceId}`)
    }
    this.subscribeCalls++
    let st = 'connecting'
    const listeners: Array<(s: string) => void> = []
    const sub: FakeSub = {
      sourceId,
      node: ctx.createGain(),
      closed: false,
      closeCount: 0,
      getState: () => st,
      onState(cb) {
        listeners.push(cb)
        return () => {
          const i = listeners.indexOf(cb)
          if (i >= 0) listeners.splice(i, 1)
        }
      },
      close() {
        sub.closed = true
        sub.closeCount++
      },
      emitState(s) {
        st = s
        for (const cb of [...listeners]) cb(s)
      },
    }
    this.subs.push(sub)
    return sub
  }
  /** Test helper: emit a directory snapshot to the engine. */
  emitSources(ids: string[]): void {
    this.sourcesCb?.(
      ids.map((id) => ({ sourceId: id, name: id, clientId: 'c' })),
    )
  }
  /** The most recent live (unclosed) subscription, if any. */
  liveSub(): FakeSub | undefined {
    return [...this.subs].reverse().find((s) => !s.closed)
  }
}

beforeEach(() => {
  workletNodes.length = 0
  bufferSources.length = 0
  mediaStreamSources.length = 0
  ctxSampleRate = 48000
  lastCtx = null
  addModuleImpl = async () => {}
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode)
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: async () => makeStream(['audio']).stream,
      getDisplayMedia: async () => makeStream(['audio', 'video']).stream,
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AudioEngine.start (H3)', () => {
  it('tears down the context on a failed boot and can retry', async () => {
    addModuleImpl = async () => {
      throw new Error('addModule boom')
    }
    const eng = new AudioEngine()
    await expect(eng.start()).rejects.toThrow('addModule boom')
    // No lingering "running but silent" ctx.
    expect(eng.isRunning).toBe(false)

    // A later start() must be free to build a fresh graph.
    addModuleImpl = async () => {}
    await eng.start()
    expect(eng.isRunning).toBe(true)
  })

  it('shares one in-flight boot between concurrent start() calls', async () => {
    let addModuleCalls = 0
    addModuleImpl = async () => {
      addModuleCalls++
    }
    const eng = new AudioEngine()
    await Promise.all([eng.start(), eng.start(), eng.start()])
    // rack + recorder modules loaded exactly once, not once per call.
    expect(addModuleCalls).toBe(2)
  })
})

describe('AudioEngine recorder graph (H1)', () => {
  it('routes the recorder output through a zero-gain sink to the destination', async () => {
    const eng = new AudioEngine()
    await eng.start()
    const rec = recorder()
    expect(rec.connections.length).toBe(1)
    const sink = rec.connections[0] as FakeGain
    expect(sink).toBeInstanceOf(FakeGain)
    expect(sink.gain.value).toBe(0)
    expect(sink.connections[0]).toBe(lastCtx!.destination)
  })
})

describe('AudioEngine recording finalize ack (M4 / issue 9)', () => {
  it('accepts the final chunk delivered after stop but before the flush ack', async () => {
    const eng = new AudioEngine()
    await eng.start()

    // Baseline: one chunk while recording, then stop + flush ack.
    eng.startRecording()
    recorder().port.onmessage!(chunk(128))
    const bp = eng.stopRecording()
    recorder().port.onmessage!(flushed())
    const baseline = await bp

    // A tail chunk arrives after recording=false but before the 'flushed' ack:
    // it must still land in the WAV (the ack, not a timer, closes the window).
    eng.startRecording()
    recorder().port.onmessage!(chunk(128))
    const p = eng.stopRecording()
    recorder().port.onmessage!(chunk(128)) // late tail, before ack
    recorder().port.onmessage!(flushed()) // worklet finished flushing
    const withTail = await p

    const b1 = (await baseline.arrayBuffer()).byteLength
    const b2 = (await withTail.arrayBuffer()).byteLength
    // 128 extra stereo frames * 2ch * 3 bytes (24-bit) = 768 bytes of PCM.
    expect(b2 - b1).toBe(768)
  })

  it('posts stop then resolves on the worklet flush ack', async () => {
    const eng = new AudioEngine()
    await eng.start()
    eng.startRecording()
    recorder().port.onmessage!(chunk(64))
    const p = eng.stopRecording()
    // stop was posted to the worklet.
    const posted = recorder().posted.map((a) => (a as [{ type: string }])[0].type)
    expect(posted).toContain('stop')
    recorder().port.onmessage!(flushed())
    const blob = await p
    // header (44) + 64 frames * 2ch * 3 bytes = 44 + 384.
    expect((await blob.arrayBuffer()).byteLength).toBe(68 + 384)
  })

  it('produces a valid empty WAV for an empty recording', async () => {
    const eng = new AudioEngine()
    await eng.start()
    eng.startRecording()
    const p = eng.stopRecording()
    recorder().port.onmessage!(flushed()) // no chunks, just the ack
    const blob = await p
    // Just the 68-byte header (RIFF + ISFT 'mfx' chunk), no PCM payload.
    expect((await blob.arrayBuffer()).byteLength).toBe(68)
  })

  it('is idempotent under repeated Stop', async () => {
    const eng = new AudioEngine()
    await eng.start()
    eng.startRecording()
    recorder().port.onmessage!(chunk(32))
    const p1 = eng.stopRecording()
    // A second Stop before the first finalizes is a no-op (empty WAV), not a
    // second finalize of the same take.
    const p2 = eng.stopRecording()
    recorder().port.onmessage!(flushed())
    const [b1, b2] = await Promise.all([p1, p2])
    expect((await b1.arrayBuffer()).byteLength).toBe(68 + 32 * 2 * 3)
    expect((await b2.arrayBuffer()).byteLength).toBe(0)
    expect(eng.isRecording).toBe(false)
  })

  it('assembles received audio when the flush ack times out (no silent truncation)', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const eng = new AudioEngine()
      await eng.start()
      eng.startRecording()
      recorder().port.onmessage!(chunk(100))
      const p = eng.stopRecording()
      // No 'flushed' ack ever arrives; the bounded fallback must fire.
      await vi.advanceTimersByTimeAsync(600)
      const blob = await p
      // The 100 frames received before the timeout are still in the WAV.
      expect((await blob.arrayBuffer()).byteLength).toBe(68 + 100 * 2 * 3)
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })
})

describe('AudioEngine concurrent setInput (M5)', () => {
  it('discards a superseded pending mic and keeps a single live source', async () => {
    let resolveMic!: () => void
    const mic = makeStream(['audio'])
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: () =>
          new Promise((res) => {
            resolveMic = () => res(mic.stream)
          }),
      },
    })

    const eng = new AudioEngine()
    await eng.start() // starts on the test source

    const micPromise = eng.setInput('mic') // pending on getUserMedia
    await eng.setInput('test') // supersedes the mic request
    resolveMic()
    await micPromise

    expect(eng.currentInput).toBe('test')
    // The orphaned mic stream must have been stopped, not left live.
    expect(mic.tracks.every((t) => t.stopped)).toBe(true)
  })
})

describe('AudioEngine disconnectSource (M6)', () => {
  it('stops the previous looping buffer source on input switch', async () => {
    const eng = new AudioEngine()
    await eng.start() // creates test buffer source A
    const srcA = bufferSources[0]
    expect(srcA.started).toBe(true)

    await eng.setInput('test') // switch -> A must be stopped
    expect(srcA.stopped).toBe(true)
  })
})

describe('AudioEngine input-ended (M-media-lifecycle)', () => {
  it('drops to silence and notifies when the mic stream ends', async () => {
    const mic = makeStream(['audio'])
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: async () => mic.stream },
    })
    const eng = new AudioEngine()
    await eng.start()

    let endedKind: string | null = null
    eng.subscribeInputEnded((k) => {
      endedKind = k
    })
    await eng.setInput('mic')
    expect(eng.currentInput).toBe('mic')

    mic.tracks[0].end()
    expect(endedKind).toBe('mic')
    // The dead source is torn down (its track stopped), not left hanging.
    expect(mic.tracks[0].stopped).toBe(true)
  })

  it('notifies with "tab" when the shared tab capture ends', async () => {
    const tab = makeStream(['audio', 'video'])
    vi.stubGlobal('navigator', {
      mediaDevices: { getDisplayMedia: async () => tab.stream },
    })
    const eng = new AudioEngine()
    await eng.start()

    let endedKind: string | null = null
    eng.subscribeInputEnded((k) => {
      endedKind = k
    })
    await eng.setInput('tab')

    tab.tracks.find((t) => t.kind === 'audio')!.end()
    expect(endedKind).toBe('tab')
  })

  it('ignores an ended event from a stream that is no longer the input', async () => {
    const mic = makeStream(['audio'])
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: async () => mic.stream },
    })
    const eng = new AudioEngine()
    await eng.start()

    let calls = 0
    eng.subscribeInputEnded(() => {
      calls++
    })
    await eng.setInput('mic')
    await eng.setInput('test') // switch away; the mic stream is retired
    mic.tracks[0].end() // a stale, late event

    expect(calls).toBe(0)
  })
})

describe('AudioEngine.setTestTone (L10)', () => {
  it('does not throw or leak a rejection when the engine is not started', () => {
    const eng = new AudioEngine()
    expect(() => eng.setTestTone('sine')).not.toThrow()
  })
})

describe('AudioEngine recording cap (L14)', () => {
  it('auto-stops and reports the take when the duration cap is exceeded', async () => {
    ctxSampleRate = 1 // maxFrames = 30*60*1 = 1800
    const eng = new AudioEngine()
    await eng.start()

    let limitBlob: Blob | null = null
    eng.subscribeRecordingLimit((b) => {
      limitBlob = b
    })
    eng.startRecording()
    recorder().port.onmessage!(chunk(30 * 60)) // reaches the cap in one chunk
    recorder().port.onmessage!(flushed()) // worklet acks the auto-stop flush
    await new Promise((r) => setTimeout(r, 80))

    expect(eng.isRecording).toBe(false)
    expect(limitBlob).not.toBeNull()
  })
})

describe('AudioEngine node lifecycle (issue 8)', () => {
  it('tears down a replaced mic source exactly once (node, tracks, listeners)', async () => {
    const mic = makeStream(['audio'])
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: async () => mic.stream },
    })
    const eng = new AudioEngine()
    await eng.start()
    await eng.setInput('mic')
    const micNode = mediaStreamSources[mediaStreamSources.length - 1]

    await eng.setInput('test') // input replacement retires the mic

    expect(micNode.disconnectCount).toBe(1)
    expect(mic.tracks.every((t) => t.stopCount === 1)).toBe(true)
    // The 'ended' listener the engine added was removed, not leaked.
    expect(mic.tracks.every((t) => t.listenerCount === 0)).toBe(true)
  })

  it('does not double-stop a mic that already ended before disposal', async () => {
    const mic = makeStream(['audio'])
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: async () => mic.stream },
    })
    const eng = new AudioEngine(() => new FakeMbus() as unknown as MbusClient)
    await eng.start()
    await eng.setInput('mic')
    const micNode = mediaStreamSources[mediaStreamSources.length - 1]

    mic.tracks[0].end() // stream dies out from under us (disconnectSource runs)
    await eng.close() // disposal must not tear the same source down again

    expect(mic.tracks[0].stopCount).toBe(1)
    expect(micNode.disconnectCount).toBe(1)
    expect(mic.tracks[0].listenerCount).toBe(0)
  })

  it('close() tears down every engine graph node exactly once', async () => {
    const fake = new FakeMbus()
    const eng = new AudioEngine(() => fake as unknown as MbusClient)
    await eng.start()
    const rack = workletNodes.find((n) => n.name === 'mfx-rack')!
    const rec = recorder()
    const sink = rec.connections[0] as FakeGain

    await eng.close()
    await eng.close() // idempotent: a second close must not re-disconnect

    expect(rack.disconnectCount).toBe(1)
    expect(rec.disconnectCount).toBe(1)
    expect(sink.disconnectCount).toBe(1)
    expect(fake.disconnectCount).toBe(1)
    expect(lastCtx!.closed).toBe(true)
  })
})

describe('AudioEngine mbus recovery (issue 3)', () => {
  const startMbus = async (fake: FakeMbus) => {
    const eng = new AudioEngine(() => fake as unknown as MbusClient)
    await eng.start()
    return eng
  }

  it('re-subscribes when the source reappears on a connected snapshot after reconnect', async () => {
    const fake = new FakeMbus()
    const eng = await startMbus(fake)
    fake.emitSources(['A'])
    await eng.setInput('mic').catch(() => {})
    await eng.setInput('test')
    // choose + subscribe to A
    fake.emitSources(['A'])
    await eng.setInput('mbus')
    expect(eng.mbusSelectedSourceId).toBe('A')
    expect(fake.subscribeCalls).toBe(1)
    const firstSub = fake.liveSub()!

    // Terminal failure drops the live sub to silence (issue 3 failure path).
    firstSub.emitState('failed')
    expect(fake.liveSub()).toBeUndefined()
    // Intent is preserved for recovery.
    expect(eng.mbusSelectedSourceId).toBe('A')

    // A fresh connected snapshot still listing A → re-subscribe (no double-sub).
    fake.emitSources(['A'])
    expect(fake.subscribeCalls).toBe(2)
    expect(fake.liveSub()).toBeDefined()
  })

  it('does NOT tear down the sub when the directory empties during a transient drop', async () => {
    const fake = new FakeMbus()
    const eng = await startMbus(fake)
    fake.emitSources(['A'])
    await eng.setInput('mbus')
    const sub = fake.liveSub()!
    expect(sub).toBeDefined()

    // Bridge drops: state no longer 'connected' and the directory momentarily
    // empties. The engine must NOT close the sub (client rewires on reconnect).
    fake.state = 'disconnected'
    fake.emitSources([])
    expect(sub.closed).toBe(false)
    expect(eng.mbusSelectedSourceId).toBe('A')

    // Reconnect: same sub still live, no duplicate subscription.
    fake.state = 'connected'
    fake.emitSources(['A'])
    expect(sub.closed).toBe(false)
    expect(fake.subscribeCalls).toBe(1)
  })

  it('drops to silence on genuine disappearance but keeps intent for recovery', async () => {
    const fake = new FakeMbus()
    const eng = await startMbus(fake)
    fake.emitSources(['A'])
    await eng.setInput('mbus')
    const sub = fake.liveSub()!

    // Bridge connected + source no longer advertised = genuine disappearance.
    fake.emitSources([])
    expect(sub.closed).toBe(true)
    expect(fake.liveSub()).toBeUndefined()
    expect(eng.mbusSelectedSourceId).toBe('A') // intent preserved

    // Reappears → re-subscribe.
    fake.emitSources(['A'])
    expect(fake.subscribeCalls).toBe(2)
    expect(fake.liveSub()).toBeDefined()
  })

  it('does not resurrect an mbus sub after a manual switch away', async () => {
    const fake = new FakeMbus()
    const eng = await startMbus(fake)
    fake.emitSources(['A'])
    await eng.setInput('mbus')
    expect(fake.subscribeCalls).toBe(1)

    await eng.setInput('test') // manual switch away closes the sub
    expect(fake.liveSub()).toBeUndefined()

    // Later snapshots must NOT resurrect the mbus subscription.
    fake.emitSources(['A'])
    fake.emitSources(['A'])
    expect(fake.subscribeCalls).toBe(1)
    expect(eng.currentInput).toBe('test')
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { AudioEngine } from './AudioEngine.ts'

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
  connect(target: FakeNode): FakeNode {
    this.connections.push(target)
    return target
  }
  disconnect(): void {
    this.disconnected = true
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

class FakeMediaStreamSource extends FakeNode {
  stream: unknown = null
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
  kind: string
  /** Test helper: simulate the track ending (Chrome "Stop sharing", unplug). */
  end: () => void
  addEventListener: (type: string, cb: () => void, opts?: unknown) => void
}
function makeStream(kinds: string[]): { tracks: FakeTrack[]; stream: unknown } {
  const tracks: FakeTrack[] = kinds.map((kind) => {
    let endedCb: (() => void) | null = null
    const t: FakeTrack = {
      kind,
      stopped: false,
      stop() {
        t.stopped = true
      },
      addEventListener(type, cb) {
        if (type === 'ended') endedCb = cb
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

beforeEach(() => {
  workletNodes.length = 0
  bufferSources.length = 0
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

describe('AudioEngine recording flush window (M4)', () => {
  it('accepts chunks that arrive after stop but before the flush closes', async () => {
    const eng = new AudioEngine()
    await eng.start()

    // Baseline: only a chunk delivered while recording.
    eng.startRecording()
    recorder().port.onmessage!(chunk(128))
    const baseline = await eng.stopRecording()

    // With a tail chunk delivered during the 60 ms flush window.
    eng.startRecording()
    recorder().port.onmessage!(chunk(128))
    const p = eng.stopRecording()
    recorder().port.onmessage!(chunk(128)) // arrives after recording=false
    const withTail = await p

    const b1 = (await baseline.arrayBuffer()).byteLength
    const b2 = (await withTail.arrayBuffer()).byteLength
    // 128 extra stereo frames * 2ch * 3 bytes (24-bit) = 768 bytes of PCM.
    expect(b2 - b1).toBe(768)
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
    await new Promise((r) => setTimeout(r, 80))

    expect(eng.isRecording).toBe(false)
    expect(limitBlob).not.toBeNull()
  })
})

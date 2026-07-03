/**
 * AudioEngine.ts — the main-thread Web Audio graph and worklet lifecycle.
 *
 * Signal path:
 *   source → rack (AudioWorklet) → limiter (DynamicsCompressor, always last)
 *          → monitor gain → destination
 *                          ↘ recorder (AudioWorklet tap; output unconnected)
 *
 * Feedback safety: audio only starts on a user gesture; when the input is the
 * microphone the monitor defaults to muted so a mic → speaker loop can't build.
 * The recorder taps *before* the monitor gain, so a muted monitor still records.
 */
import type { RackState, WorkletToMainMessage } from './contracts.ts'
import { fillDrumLoop, fillNoise, fillSine, type TestTone } from './testSource.ts'
import { encodeWavStereo } from '../recording/wav.ts'

// Bundled worklet module URLs (Vite bundles imports into a single module).
import rackWorkletUrl from './rack.worklet.ts?worker&url'
import recorderWorkletUrl from './recorder.worklet.ts?worker&url'

export type InputKind = 'test' | 'mic' | 'tab' | 'file'

export interface EngineMeters {
  inPeak: number
  outPeak: number
  reduction: number
}

interface RecorderChunkMessage {
  type: 'chunk'
  left: Float32Array
  right: Float32Array
}

const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out`)), ms),
    ),
  ])

export class AudioEngine {
  private ctx: AudioContext | null = null
  private rackNode: AudioWorkletNode | null = null
  private recorderNode: AudioWorkletNode | null = null
  private limiter: DynamicsCompressorNode | null = null
  private monitorGain: GainNode | null = null

  private sourceNode: AudioNode | null = null
  private mediaStream: MediaStream | null = null
  private fileBuffer: AudioBuffer | null = null
  private testTone: TestTone = 'drums'

  private input: InputKind = 'test'
  private monitorMuted = false

  private meters: EngineMeters = { inPeak: 0, outPeak: 0, reduction: 0 }
  private meterSubs = new Set<(m: EngineMeters) => void>()

  private recording = false
  private recLeft: Float32Array[] = []
  private recRight: Float32Array[] = []
  private recFrames = 0

  get isRunning(): boolean {
    return this.ctx !== null && this.ctx.state !== 'closed'
  }

  get currentInput(): InputKind {
    return this.input
  }

  get isMonitorMuted(): boolean {
    return this.monitorMuted
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000
  }

  /** Estimated one-way + output latency in ms (a performance figure, not zero). */
  get latencyMs(): number {
    if (!this.ctx) return 0
    const base = this.ctx.baseLatency ?? 0
    const out = this.ctx.outputLatency ?? 0
    return Math.round((base + out) * 1000)
  }

  get isRecording(): boolean {
    return this.recording
  }

  get recordingSeconds(): number {
    return this.recFrames / this.sampleRate
  }

  subscribeMeters(cb: (m: EngineMeters) => void): () => void {
    this.meterSubs.add(cb)
    return () => this.meterSubs.delete(cb)
  }

  /** Create the context (on a user gesture), load worklets, build the graph. */
  async start(): Promise<void> {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume()
      return
    }
    const ctx = new AudioContext({ latencyHint: 'interactive' })
    this.ctx = ctx

    await withTimeout(ctx.audioWorklet.addModule(rackWorkletUrl), 5000, 'rack worklet')
    await withTimeout(
      ctx.audioWorklet.addModule(recorderWorkletUrl),
      5000,
      'recorder worklet',
    )

    const rack = new AudioWorkletNode(ctx, 'mfx-rack', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
    })
    rack.port.onmessage = (event: MessageEvent<WorkletToMainMessage>) => {
      const msg = event.data
      if (msg.type === 'meter') {
        this.meters = {
          inPeak: msg.inPeak,
          outPeak: msg.outPeak,
          reduction: this.limiter ? -this.limiter.reduction : 0,
        }
        for (const cb of this.meterSubs) cb(this.meters)
      }
    }
    this.rackNode = rack

    const limiter = ctx.createDynamicsCompressor()
    limiter.threshold.value = -1
    limiter.knee.value = 0
    limiter.ratio.value = 20
    limiter.attack.value = 0.002
    limiter.release.value = 0.12
    this.limiter = limiter

    const monitor = ctx.createGain()
    monitor.gain.value = 1
    this.monitorGain = monitor

    const recorder = new AudioWorkletNode(ctx, 'mfx-recorder', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
    })
    recorder.port.onmessage = (event: MessageEvent<RecorderChunkMessage>) => {
      if (!this.recording || event.data.type !== 'chunk') return
      this.recLeft.push(event.data.left)
      this.recRight.push(event.data.right)
      this.recFrames += event.data.left.length
    }
    this.recorderNode = recorder

    rack.connect(limiter)
    limiter.connect(monitor)
    monitor.connect(ctx.destination)
    limiter.connect(recorder) // tap; recorder output left unconnected

    // Default to the test source so there is immediate sound-making capability.
    await this.setInput('test')
  }

  private disconnectSource(): void {
    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect()
      } catch {
        // already disconnected
      }
      this.sourceNode = null
    }
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) track.stop()
      this.mediaStream = null
    }
  }

  private makeBufferSource(buffer: AudioBuffer): AudioBufferSourceNode {
    const ctx = this.ctx!
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.loop = true
    src.start()
    return src
  }

  private buildTestBuffer(): AudioBuffer {
    const ctx = this.ctx!
    const sr = ctx.sampleRate
    const seconds = this.testTone === 'drums' ? 4 : 1
    const buffer = ctx.createBuffer(2, Math.floor(sr * seconds), sr)
    const l = buffer.getChannelData(0)
    const r = buffer.getChannelData(1)
    if (this.testTone === 'sine') {
      fillSine(l, sr)
      r.set(l)
    } else if (this.testTone === 'noise') {
      fillNoise(l, 1)
      fillNoise(r, 2)
    } else {
      fillDrumLoop(l, r, sr, 120)
    }
    return buffer
  }

  setTestTone(tone: TestTone): void {
    this.testTone = tone
    if (this.input === 'test') void this.setInput('test')
  }

  async loadFile(file: File): Promise<void> {
    if (!this.ctx) throw new Error('engine not started')
    const data = await file.arrayBuffer()
    this.fileBuffer = await this.ctx.decodeAudioData(data)
    await this.setInput('file')
  }

  /**
   * Switch the input source. Mic/tab request permission here and may throw;
   * callers surface the error to the UI. Mic defaults the monitor to muted.
   */
  async setInput(kind: InputKind): Promise<void> {
    if (!this.ctx || !this.rackNode) throw new Error('engine not started')
    this.disconnectSource()

    if (kind === 'test') {
      this.sourceNode = this.makeBufferSource(this.buildTestBuffer())
      this.setMonitorMuted(false)
    } else if (kind === 'file') {
      if (!this.fileBuffer) throw new Error('no file loaded')
      this.sourceNode = this.makeBufferSource(this.fileBuffer)
      this.setMonitorMuted(false)
    } else if (kind === 'mic') {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          autoGainControl: false,
          noiseSuppression: false,
        },
        video: false,
      })
      this.mediaStream = stream
      this.sourceNode = this.ctx.createMediaStreamSource(stream)
      // Feedback safety: never monitor a mic to the speakers by default.
      this.setMonitorMuted(true)
    } else {
      // tab capture — Chromium desktop only
      const md = navigator.mediaDevices as MediaDevices & {
        getDisplayMedia(c: DisplayMediaStreamOptions): Promise<MediaStream>
      }
      const stream = await md.getDisplayMedia({ audio: true, video: true })
      const audioTracks = stream.getAudioTracks()
      if (audioTracks.length === 0) {
        for (const t of stream.getTracks()) t.stop()
        throw new Error('No tab audio was shared. In the dialog pick a tab and enable "Share tab audio".')
      }
      for (const v of stream.getVideoTracks()) v.stop()
      this.mediaStream = stream
      this.sourceNode = this.ctx.createMediaStreamSource(stream)
      this.setMonitorMuted(false)
    }

    this.sourceNode.connect(this.rackNode)
    this.input = kind
  }

  setMonitorMuted(muted: boolean): void {
    this.monitorMuted = muted
    if (this.monitorGain && this.ctx) {
      this.monitorGain.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.01)
    }
  }

  /** Push resolved rack state to the worklet. */
  setRack(state: RackState): void {
    this.rackNode?.port.postMessage({ type: 'rack', state })
  }

  startRecording(): void {
    if (!this.recorderNode || this.recording) return
    this.recLeft = []
    this.recRight = []
    this.recFrames = 0
    this.recording = true
    this.recorderNode.port.postMessage({ type: 'start' })
  }

  /** Stop and encode the captured audio to a 24-bit WAV Blob. */
  async stopRecording(): Promise<Blob> {
    if (!this.recorderNode || !this.recording) {
      return new Blob([], { type: 'audio/wav' })
    }
    this.recording = false
    this.recorderNode.port.postMessage({ type: 'stop' })
    // Let any in-flight chunk messages arrive.
    await new Promise((r) => setTimeout(r, 60))

    const left = flatten(this.recLeft, this.recFrames)
    const right = flatten(this.recRight, this.recFrames)
    this.recLeft = []
    this.recRight = []
    const wav = encodeWavStereo([left, right], this.sampleRate, 24, {
      software: 'mfx',
    })
    return new Blob([wav], { type: 'audio/wav' })
  }

  async close(): Promise<void> {
    this.disconnectSource()
    if (this.ctx) {
      await this.ctx.close()
      this.ctx = null
    }
  }
}

function flatten(chunks: Float32Array[], total: number): Float32Array {
  const out = new Float32Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

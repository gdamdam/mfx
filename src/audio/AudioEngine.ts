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
import { encodePcmInterleaved, wavHeader } from '../recording/wav.ts'
import {
  createMbusClient,
  type MbusClient,
  type SourceInfo,
  type Subscription,
} from '../transport/mbus/index.ts'

// Bundled worklet module URLs (Vite bundles imports into a single module).
import rackWorkletUrl from './rack.worklet.ts?worker&url'
import recorderWorkletUrl from './recorder.worklet.ts?worker&url'

export type InputKind = 'test' | 'mic' | 'tab' | 'file' | 'mbus'

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
  // Hard cap so a forgotten recording can't grow unbounded (~1.4 GB/hour).
  private static readonly MAX_RECORDING_SECONDS = 30 * 60
  // Stereo 24-bit PCM: 6 bytes/frame. The recorder always taps 2 channels.
  private static readonly REC_BIT_DEPTH = 24
  private static readonly REC_CHANNELS = 2

  private ctx: AudioContext | null = null
  private rackNode: AudioWorkletNode | null = null
  private recorderNode: AudioWorkletNode | null = null
  private limiter: DynamicsCompressorNode | null = null
  private monitorGain: GainNode | null = null

  private sourceNode: AudioNode | null = null
  private mediaStream: MediaStream | null = null
  private fileBuffer: AudioBuffer | null = null
  private testTone: TestTone = 'drums'

  // mbus input: receive another tab's live audio over the link-bridge (see
  // src/transport/mbus). The client is optional companion gear — absent bridge
  // means an empty source list and a silent 'mbus' input, nothing more.
  private mbus: MbusClient | null = null
  private mbusSub: Subscription | null = null
  private mbusSources: SourceInfo[] = []
  private mbusSourceId: string | null = null
  private mbusSourceSubs = new Set<(s: SourceInfo[]) => void>()

  private input: InputKind = 'test'
  private monitorMuted = false
  // Master output volume on the monitor path. A live monitoring setting, not
  // part of the saved patch, so it never touches the patch/preset format.
  private masterVolume = 1

  private meters: EngineMeters = { inPeak: 0, outPeak: 0, reduction: 0 }
  private meterSubs = new Set<(m: EngineMeters) => void>()

  private recording = false
  // Chunks are accepted while `accepting` is set, which outlives `recording`
  // across the stop-flush window so the recording tail isn't dropped.
  private accepting = false
  // Encoded 24-bit interleaved PCM, one entry per batch. The raw Float32 frames
  // are converted on arrival and discarded, so a long take never accumulates as
  // Float32 in RAM (nor gets flattened+re-encoded into a ~2x peak at stop).
  private recPcm: Uint8Array<ArrayBuffer>[] = []
  private recFrames = 0
  /** Fires with the finished take when recording auto-stops at the duration cap. */
  onRecordingLimit: ((blob: Blob) => void) | null = null

  // Cached in-flight boot so concurrent start() calls await the same graph.
  private startPromise: Promise<void> | null = null
  // Bumped on every setInput; a stale generation after an await means a newer
  // call has superseded this one, so it must not connect its source.
  private inputGen = 0

  get isRunning(): boolean {
    return this.ctx !== null && this.ctx.state !== 'closed'
  }

  get currentInput(): InputKind {
    return this.input
  }

  get isMonitorMuted(): boolean {
    return this.monitorMuted
  }

  get masterVolumeLevel(): number {
    return this.masterVolume
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
    // Concurrent callers await the same boot rather than racing a half-built graph.
    if (this.startPromise) return this.startPromise
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume()
      return
    }
    this.startPromise = this.boot()
    try {
      await this.startPromise
    } finally {
      // Clear either way: a failed boot has torn itself down, so a later
      // start() must be free to retry from scratch.
      this.startPromise = null
    }
  }

  private async boot(): Promise<void> {
    const ctx = new AudioContext({ latencyHint: 'interactive' })
    this.ctx = ctx

    try {
      await this.buildGraph(ctx)
    } catch (err) {
      // A failed boot must not leave a live ctx behind, or the `if (this.ctx)`
      // fast-path above would report success for a graph that never existed.
      this.disconnectSource()
      this.rackNode = null
      this.recorderNode = null
      this.limiter = null
      this.monitorGain = null
      this.ctx = null
      try {
        await ctx.close()
      } catch {
        // best effort
      }
      throw err
    }
  }

  private async buildGraph(ctx: AudioContext): Promise<void> {
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
      if (!this.accepting || event.data.type !== 'chunk') return
      const { left, right } = event.data
      // Encode now and drop the Float32 buffers; only compact PCM is retained.
      this.recPcm.push(encodePcmInterleaved([left, right], AudioEngine.REC_BIT_DEPTH))
      this.recFrames += left.length
      // Auto-stop at the duration cap so buffers can't grow without bound.
      const maxFrames = AudioEngine.MAX_RECORDING_SECONDS * this.sampleRate
      if (this.recording && this.recFrames >= maxFrames) {
        void this.finishRecording().then((blob) => this.onRecordingLimit?.(blob))
      }
    }
    this.recorderNode = recorder

    // Zero-gain sink that keeps the recorder tap on the pull-based render graph
    // (an unconnected worklet never has process() called) without leaking audio.
    const recSink = ctx.createGain()
    recSink.gain.value = 0

    rack.connect(limiter)
    limiter.connect(monitor)
    monitor.connect(ctx.destination)
    // Tap post-limiter into the recorder, then route the recorder's (silent)
    // output through a zero-gain sink to the destination. Rendering is
    // pull-based: without a path to the destination process() never runs.
    limiter.connect(recorder)
    recorder.connect(recSink)
    recSink.connect(ctx.destination)

    this.initMbus()

    // Default to the test source so there is immediate sound-making capability.
    await this.setInput('test')
  }

  /** Lazily create + connect the mbus client (idempotent). Silent if the
   *  link-bridge is absent — it retries in the background and simply reports no
   *  sources, so the 'mbus' input is available but empty. */
  private initMbus(): void {
    if (this.mbus) return
    const client = createMbusClient()
    this.mbus = client
    client.onSources((sources) => {
      this.mbusSources = sources
      // If the source we're monitoring vanished, drop to silence rather than
      // holding a dead peer connection.
      if (this.input === 'mbus' && this.mbusSourceId) {
        const gone = !sources.some((s) => s.sourceId === this.mbusSourceId)
        if (gone) {
          this.disconnectSource()
          this.mbusSourceId = null
        }
      }
      for (const cb of this.mbusSourceSubs) cb(sources)
    })
    client.connect()
  }

  private disconnectSource(): void {
    if (this.sourceNode) {
      // Looping buffer sources are GC-protected while playing; disconnect alone
      // leaves the node (and its buffer) running forever, so stop it first.
      const node = this.sourceNode as AudioNode & { stop?: () => void }
      if (typeof node.stop === 'function') {
        try {
          node.stop()
        } catch {
          // already stopped / never started
        }
      }
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
    if (this.mbusSub) {
      // Close the WebRTC subscription (its GainNode was our sourceNode, already
      // disconnected above); the mbus client itself stays connected for discovery.
      this.mbusSub.close()
      this.mbusSub = null
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
    if (this.input === 'test') void this.setInput('test').catch(() => {})
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
    // Each call claims a generation; if another setInput starts while we await
    // permission, ours is stale and must abandon its (now orphan) stream.
    const gen = ++this.inputGen
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
      if (gen !== this.inputGen) {
        for (const t of stream.getTracks()) t.stop()
        return
      }
      // A newer setInput may have connected a source during the await.
      this.disconnectSource()
      this.mediaStream = stream
      this.sourceNode = this.ctx.createMediaStreamSource(stream)
      // Feedback safety: never monitor a mic to the speakers by default.
      this.setMonitorMuted(true)
    } else if (kind === 'tab') {
      // tab capture — Chromium desktop only
      const md = navigator.mediaDevices as MediaDevices & {
        getDisplayMedia(c: DisplayMediaStreamOptions): Promise<MediaStream>
      }
      const stream = await md.getDisplayMedia({ audio: true, video: true })
      if (gen !== this.inputGen) {
        for (const t of stream.getTracks()) t.stop()
        return
      }
      const audioTracks = stream.getAudioTracks()
      if (audioTracks.length === 0) {
        for (const t of stream.getTracks()) t.stop()
        throw new Error('No tab audio was shared. In the dialog pick a tab and enable "Share tab audio".')
      }
      for (const v of stream.getVideoTracks()) v.stop()
      // A newer setInput may have connected a source during the await.
      this.disconnectSource()
      this.mediaStream = stream
      this.sourceNode = this.ctx.createMediaStreamSource(stream)
      this.setMonitorMuted(false)
    } else {
      // mbus — subscribe to a peer tab's published output over the bridge. The
      // subscription's node is a stable GainNode in our context; remote audio is
      // wired into it once the WebRTC connection goes live. No permission prompt
      // and no await, so no generation race. With no bridge / no chosen source,
      // sourceNode stays null and the input is simply silent.
      const sourceId = this.mbusSourceId ?? this.mbusSources[0]?.sourceId ?? null
      if (this.mbus && sourceId) {
        this.mbusSub = this.mbus.subscribe(sourceId, this.ctx)
        this.mbusSourceId = sourceId
        this.sourceNode = this.mbusSub.node
      }
      this.setMonitorMuted(false)
    }

    // sourceNode is null only for an mbus input with no available source; every
    // other branch has set it (or thrown/returned). Guard so that case is silent.
    this.sourceNode?.connect(this.rackNode)
    this.input = kind
  }

  /** Sources currently advertised on the bridge (for the mbus input picker). */
  getMbusSources(): SourceInfo[] {
    return this.mbusSources
  }

  get mbusSelectedSourceId(): string | null {
    return this.mbusSourceId
  }

  /** Notify on directory changes; returns an unsubscribe fn. */
  subscribeMbusSources(cb: (s: SourceInfo[]) => void): () => void {
    this.mbusSourceSubs.add(cb)
    return () => this.mbusSourceSubs.delete(cb)
  }

  /** Choose which mbus source feeds the input; re-subscribes live if selected. */
  setMbusSource(sourceId: string): void {
    this.mbusSourceId = sourceId
    if (this.input === 'mbus') void this.setInput('mbus').catch(() => {})
  }

  setMonitorMuted(muted: boolean): void {
    this.monitorMuted = muted
    this.applyMonitorGain()
  }

  /** Master output volume (0..1) on the monitor path; muting still wins. */
  setMasterVolume(v: number): void {
    this.masterVolume = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : this.masterVolume
    this.applyMonitorGain()
  }

  private applyMonitorGain(): void {
    if (this.monitorGain && this.ctx) {
      const target = this.monitorMuted ? 0 : this.masterVolume
      this.monitorGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.01)
    }
  }

  /** Push resolved rack state to the worklet. */
  setRack(state: RackState): void {
    this.rackNode?.port.postMessage({ type: 'rack', state })
  }

  startRecording(): void {
    if (!this.recorderNode || this.recording) return
    this.recPcm = []
    this.recFrames = 0
    this.recording = true
    this.accepting = true
    this.recorderNode.port.postMessage({ type: 'start' })
  }

  /** Stop and encode the captured audio to a 24-bit WAV Blob. */
  async stopRecording(): Promise<Blob> {
    if (!this.recorderNode || !this.recording) {
      return new Blob([], { type: 'audio/wav' })
    }
    return this.finishRecording()
  }

  private async finishRecording(): Promise<Blob> {
    this.recording = false
    this.recorderNode?.port.postMessage({ type: 'stop' })
    // Keep accepting chunks across the flush window so the tail isn't dropped,
    // then close the window before assembling the file.
    await new Promise((r) => setTimeout(r, 60))
    this.accepting = false

    // The PCM batches are already encoded; prepend the header and let the Blob
    // gather the parts (the browser may back it by disk) — no giant contiguous
    // buffer or re-encode pass.
    const blockAlign =
      AudioEngine.REC_CHANNELS * (AudioEngine.REC_BIT_DEPTH === 24 ? 3 : 2)
    const header = wavHeader(
      AudioEngine.REC_CHANNELS,
      this.sampleRate,
      AudioEngine.REC_BIT_DEPTH,
      this.recFrames * blockAlign,
      { software: 'mfx' },
    )
    const blob = new Blob([header, ...this.recPcm], { type: 'audio/wav' })
    this.recPcm = []
    return blob
  }

  async close(): Promise<void> {
    this.disconnectSource()
    if (this.mbus) {
      this.mbus.disconnect()
      this.mbus = null
    }
    if (this.ctx) {
      await this.ctx.close()
      this.ctx = null
    }
  }
}

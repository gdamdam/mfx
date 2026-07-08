/**
 * Fracture — tempo-aware micro-slicing. Audio is recorded into a rolling
 * buffer; at every slice boundary (a tempo division) a seeded random decision
 * either passes the live input through or replays buffer material: the last
 * slice again (repeat), the last slice backwards (reverse), or an earlier
 * slice (shuffle).
 *
 * Two read streams are always alive — the incoming one fades in over a
 * raised-cosine crossfade while the outgoing one fades out — so every edit is
 * a smooth splice, never a cut. With chance at zero the crossfade blends two
 * identical direct streams, i.e. the effect is exactly transparent.
 */
import { clamp, lerp, Smoother, Rng } from './util.ts'

export interface FractureParams {
  div: number // 0..3 index: 1/4, 1/8, 1/16, 1/32
  chance: number // 0..1 probability a boundary triggers an edit
  repeat: number // 0..1 weight of the repeat action
  reverse: number // 0..1 weight of the reverse action
  shuffle: number // 0..1 weight of the shuffle action
  smooth: number // 0..1 crossfade length (2ms .. 40% of slice)
  mix: number // 0..1 dry/wet
}

const DIV_BEATS = [1, 0.5, 0.25, 0.125] as const
const BUFFER_SEC = 4

/** One playback stream: either the live input or a fixed buffer trajectory. */
const DIRECT = -1

export class Fracture {
  private readonly sampleRate: number
  private readonly scratch = new Float64Array(2)
  private readonly bufL: Float64Array
  private readonly bufR: Float64Array
  private readonly bufLen: number
  private rng = new Rng(0x66726163) // 'frac'

  private writeAbs = 0
  private sliceStartAbs = 0
  private sliceLen = 4800
  private sampleInSlice = 0

  // Stream A = incoming, Stream B = outgoing. base=DIRECT means live input.
  private aBase = DIRECT
  private aDir = 1
  private aT = 0
  private bBase = DIRECT
  private bDir = 1
  private bT = 0
  private xfadeT = 0
  private xfadeLen = 96

  private readonly mixS: Smoother

  private tDiv = 2
  private tChance = 0.6
  private tRepeat = 0.5
  private tReverse = 0.3
  private tShuffle = 0.3
  private tSmooth = 0.5
  private tMix = 1
  private bpm = 120

  constructor(sampleRate: number) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100
    this.bufLen = Math.ceil(BUFFER_SEC * this.sampleRate)
    this.bufL = new Float64Array(this.bufLen)
    this.bufR = new Float64Array(this.bufLen)
    this.mixS = new Smoother(this.sampleRate, 0.02, 1)
    this.sliceLen = this.computeSliceLen()
  }

  setParams({ div, chance, repeat, reverse, shuffle, smooth, mix }: FractureParams): void {
    this.tDiv = Math.round(clamp(div, 0, 3))
    this.tChance = clamp(chance, 0, 1)
    this.tRepeat = clamp(repeat, 0, 1)
    this.tReverse = clamp(reverse, 0, 1)
    this.tShuffle = clamp(shuffle, 0, 1)
    this.tSmooth = clamp(smooth, 0, 1)
    this.tMix = clamp(mix, 0, 1)
  }

  setTempo(bpm: number): void {
    this.bpm = clamp(bpm, 20, 300)
  }

  private computeSliceLen(): number {
    const beatSec = 60 / this.bpm
    const sec = clamp(beatSec * DIV_BEATS[this.tDiv], 0.02, 2)
    return Math.max(64, Math.floor(sec * this.sampleRate))
  }

  /** Absolute position -> buffer sample (guarded against stale/future reads). */
  private readAbs(buf: Float64Array, pos: number): number {
    if (pos < 0 || pos >= this.writeAbs || this.writeAbs - pos >= this.bufLen) return 0
    let i = pos % this.bufLen
    if (i < 0) i += this.bufLen
    return buf[i | 0]
  }

  /** Decide the incoming stream at a slice boundary. */
  private decide(): void {
    // Fixed rng consumption (3 draws) so decisions can't desync determinism.
    const rGate = this.rng.next()
    const rPick = this.rng.next()
    const rSlice = this.rng.next()

    // Outgoing stream inherits the old incoming stream and keeps playing.
    this.bBase = this.aBase
    this.bDir = this.aDir
    this.bT = this.aT
    this.xfadeT = 0
    this.xfadeLen = Math.max(
      32,
      Math.floor(lerp(0.002 * this.sampleRate, this.sliceLen * 0.4, this.tSmooth)),
    )

    const completedStart = this.sliceStartAbs - this.sliceLen
    const haveHistory = completedStart >= 0 && this.writeAbs > this.sliceLen * 2

    const wRepeat = this.tRepeat
    const wReverse = this.tReverse
    const wShuffle = this.tShuffle
    const wSum = wRepeat + wReverse + wShuffle

    if (!haveHistory || wSum <= 0 || rGate >= this.tChance) {
      this.aBase = DIRECT
      this.aDir = 1
      this.aT = 0
      return
    }

    const pick = rPick * wSum
    if (pick < wRepeat) {
      // Replay the slice that just finished.
      this.aBase = completedStart
      this.aDir = 1
    } else if (pick < wRepeat + wReverse) {
      // Play the finished slice backwards.
      this.aBase = completedStart + this.sliceLen - 1
      this.aDir = -1
    } else {
      // Grab an earlier slice from the last few bars.
      const maxBack = Math.max(
        1,
        Math.min(7, Math.floor((this.bufLen - this.sliceLen * 2 - 64) / this.sliceLen)),
      )
      const k = 1 + Math.floor(rSlice * maxBack)
      const base = Math.max(0, completedStart - k * this.sliceLen)
      this.aBase = base
      this.aDir = 1
    }
    this.aT = 0
  }

  private streamSample(buf: Float64Array, base: number, dir: number, t: number, live: number): number {
    if (base === DIRECT) return live
    return this.readAbs(buf, base + dir * t)
  }

  processInto(left: number, right: number, out: Float64Array): void {
    const l = Number.isFinite(left) ? left : 0
    const r = Number.isFinite(right) ? right : 0
    const mix = this.mixS.process(this.tMix)

    // --- record --------------------------------------------------------------
    let wi = this.writeAbs % this.bufLen
    if (wi < 0) wi += this.bufLen
    this.bufL[wi | 0] = l
    this.bufR[wi | 0] = r
    this.writeAbs++

    // --- slice clock ---------------------------------------------------------
    if (this.sampleInSlice <= 0) {
      this.sliceLen = this.computeSliceLen()
      this.sliceStartAbs = this.writeAbs - 1
      this.decide()
      this.sampleInSlice = this.sliceLen
    }
    this.sampleInSlice--

    // --- two-stream playback with raised-cosine splice ------------------------
    const aL = this.streamSample(this.bufL, this.aBase, this.aDir, this.aT, l)
    const aR = this.streamSample(this.bufR, this.aBase, this.aDir, this.aT, r)
    let wetL = aL
    let wetR = aR
    if (this.xfadeT < this.xfadeLen) {
      const g = 0.5 - 0.5 * Math.cos((Math.PI * this.xfadeT) / this.xfadeLen)
      const bL = this.streamSample(this.bufL, this.bBase, this.bDir, this.bT, l)
      const bR = this.streamSample(this.bufR, this.bBase, this.bDir, this.bT, r)
      wetL = aL * g + bL * (1 - g)
      wetR = aR * g + bR * (1 - g)
      this.xfadeT++
      this.bT++
    }
    this.aT++

    out[0] = l * (1 - mix) + wetL * mix
    out[1] = r * (1 - mix) + wetR * mix
  }

  process(left: number, right: number): [number, number] {
    this.processInto(left, right, this.scratch)
    return [this.scratch[0], this.scratch[1]]
  }

  reset(): void {
    this.bufL.fill(0)
    this.bufR.fill(0)
    this.writeAbs = 0
    this.sliceStartAbs = 0
    this.sampleInSlice = 0
    this.aBase = DIRECT
    this.aDir = 1
    this.aT = 0
    this.bBase = DIRECT
    this.bDir = 1
    this.bT = 0
    this.xfadeT = 1
    this.xfadeLen = 1
    this.mixS.reset(this.tMix)
    // Reseed so a reset render is reproducible from the top (reset is not a
    // hot path; this is the only allocation outside the constructor).
    this.rng = new Rng(0x66726163)
  }
}

/**
 * Mosaic — granular texture engine over a rolling stereo buffer.
 *
 * A fixed pool of 16 grain voices reads Hann-windowed, optionally reversed
 * and repitched slices from the recent past; overlap-add of the pool is the
 * wet signal. Everything is preallocated (voice state lives in flat typed
 * arrays) and all randomness comes from a seeded Rng, so rendering is fully
 * deterministic — with chaos and reverse at zero no random value ever reaches
 * the audio path.
 *
 * Freeze stops all buffer writes (input and feedback) while grains keep
 * reading, turning the captured window into an endless texture.
 */
import { clamp, lerp, Smoother, Rng, semitoneRatio, fastTanh } from './util.ts'

export interface MosaicParams {
  size: number // 0.03..0.4 s grain length
  density: number // 0..1 overlap
  pitch: number // -12..12 semitones
  reverse: number // 0..1 probability a grain plays backward
  spread: number // 0..1 stereo scatter
  feedback: number // 0..0.9 wet re-injection
  chaos: number // 0..1 randomises position/pitch/size/pan
  freeze: number // 0..1 (>=0.5 => hold buffer)
  mix: number // 0..1 dry/wet
}

const VOICES = 16
const BUFFER_SEC = 3
const WINDOW_N = 4096

export class Mosaic {
  private readonly sampleRate: number
  private readonly scratch = new Float64Array(2)
  private readonly bufL: Float64Array
  private readonly bufR: Float64Array
  private readonly bufLen: number
  private writePos = 0

  private readonly window = new Float64Array(WINDOW_N)
  private readonly rng = new Rng(0x6d6f7a61) // 'moza'

  // Flat voice state — no per-grain objects, ever.
  private readonly vActive = new Uint8Array(VOICES)
  private readonly vSrc = new Float64Array(VOICES) // absolute fractional read start
  private readonly vStep = new Float64Array(VOICES) // signed read increment/sample
  private readonly vAge = new Float64Array(VOICES) // output samples elapsed
  private readonly vLen = new Float64Array(VOICES) // output samples total
  private readonly vPanL = new Float64Array(VOICES)
  private readonly vPanR = new Float64Array(VOICES)

  private spawnCountdown = 0
  private spawnIndex = 0

  private readonly mixS: Smoother
  private readonly fbS: Smoother
  private readonly writeS: Smoother

  private tSize = 0.12
  private tDensity = 0.5
  private tPitch = 0
  private tReverse = 0.2
  private tSpread = 0.5
  private tFeedback = 0.2
  private tChaos = 0.3
  private tFreeze = 0
  private tMix = 0.5

  constructor(sampleRate: number) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100
    this.bufLen = Math.ceil(BUFFER_SEC * this.sampleRate)
    this.bufL = new Float64Array(this.bufLen)
    this.bufR = new Float64Array(this.bufLen)
    for (let i = 0; i < WINDOW_N; i++) {
      this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WINDOW_N)
    }
    this.mixS = new Smoother(this.sampleRate, 0.02, 0.5)
    this.fbS = new Smoother(this.sampleRate, 0.03, 0.2)
    this.writeS = new Smoother(this.sampleRate, 0.03, 1)
  }

  setParams({
    size,
    density,
    pitch,
    reverse,
    spread,
    feedback,
    chaos,
    freeze,
    mix,
  }: MosaicParams): void {
    this.tSize = clamp(size, 0.03, 0.4)
    this.tDensity = clamp(density, 0, 1)
    this.tPitch = clamp(pitch, -12, 12)
    this.tReverse = clamp(reverse, 0, 1)
    this.tSpread = clamp(spread, 0, 1)
    this.tFeedback = clamp(feedback, 0, 0.9)
    this.tChaos = clamp(chaos, 0, 1)
    this.tFreeze = clamp(freeze, 0, 1) >= 0.5 ? 1 : 0
    this.tMix = clamp(mix, 0, 1)
  }

  /** Read the ring buffer at an absolute fractional index (wraps, interpolates). */
  private readBuf(buf: Float64Array, pos: number): number {
    const n = this.bufLen
    let p = pos % n
    if (p < 0) p += n
    const i0 = Math.floor(p)
    const i1 = i0 + 1 === n ? 0 : i0 + 1
    const frac = p - i0
    return buf[i0] * (1 - frac) + buf[i1] * frac
  }

  private spawn(): void {
    // Find a free voice; if the pool is saturated we simply skip this onset.
    let v = -1
    for (let i = 0; i < VOICES; i++) {
      if (this.vActive[i] === 0) {
        v = i
        break
      }
    }
    // Always consume the same number of rng draws per spawn attempt so voice
    // availability can't desynchronise the random sequence between instances.
    const r1 = this.rng.next()
    const r2 = this.rng.next()
    const r3 = this.rng.next()
    const r4 = this.rng.next()
    const r5 = this.rng.next()
    if (v < 0) return

    const sr = this.sampleRate
    const chaos = this.tChaos
    const lenScale = 1 + (r2 * 2 - 1) * 0.5 * chaos
    const lenOut = clamp(this.tSize * lenScale, 0.02, 0.5) * sr
    const pitchJit = (r3 * 2 - 1) * 7 * chaos
    const ratio = semitoneRatio(this.tPitch + pitchJit)
    const reversed = r1 < this.tReverse

    // How far behind the write head the grain starts. Forward grains reading
    // faster than realtime need extra headroom so they never catch the head.
    const aheadNeed = ratio > 1 ? lenOut * (ratio - 1) + 256 : 256
    const baseBack = lenOut * 1.25 + aheadNeed
    const jitterBack = r4 * chaos * (this.bufLen - baseBack - lenOut * ratio - 512)
    const back = clamp(baseBack + Math.max(0, jitterBack), baseBack, this.bufLen - 512)

    let src = this.writePos - back
    let step = ratio
    if (reversed) {
      // Start at the far end of the slice and read backwards.
      src += lenOut * ratio
      step = -ratio
    }

    // Pan: alternating ± when calm, random when chaotic; scaled by spread.
    const alt = this.spawnIndex % 2 === 0 ? 1 : -1
    const panPos = lerp(alt * 0.7, r5 * 2 - 1, chaos) * this.tSpread
    const angle = ((panPos + 1) / 2) * (Math.PI / 2)
    this.vPanL[v] = Math.cos(angle)
    this.vPanR[v] = Math.sin(angle)

    this.vActive[v] = 1
    this.vSrc[v] = src
    this.vStep[v] = step
    this.vAge[v] = 0
    this.vLen[v] = lenOut
    this.spawnIndex++
  }

  processInto(left: number, right: number, out: Float64Array): void {
    const l = Number.isFinite(left) ? left : 0
    const r = Number.isFinite(right) ? right : 0
    const sr = this.sampleRate

    const mix = this.mixS.process(this.tMix)
    const fb = this.fbS.process(this.tFeedback)
    const write = this.writeS.process(1 - this.tFreeze)

    // --- scheduler --------------------------------------------------------
    if (--this.spawnCountdown <= 0) {
      this.spawn()
      const grainLen = this.tSize * sr
      const overlap = 1 + this.tDensity * 7
      this.spawnCountdown = Math.max(48, Math.floor(grainLen / overlap))
    }

    // --- overlap-add the voice pool ----------------------------------------
    let wetL = 0
    let wetR = 0
    for (let v = 0; v < VOICES; v++) {
      if (this.vActive[v] === 0) continue
      const age = this.vAge[v]
      const len = this.vLen[v]
      if (age >= len) {
        this.vActive[v] = 0
        continue
      }
      const wIdx = Math.floor((age / len) * (WINDOW_N - 1))
      const w = this.window[wIdx]
      const pos = this.vSrc[v] + age * this.vStep[v]
      const s = this.readBuf(this.bufL, pos) * w
      const s2 = this.readBuf(this.bufR, pos) * w
      wetL += s * this.vPanL[v] + s2 * (1 - this.vPanR[v]) * 0.3
      wetR += s2 * this.vPanR[v] + s * (1 - this.vPanL[v]) * 0.3
      this.vAge[v] = age + 1
    }
    // Gentle normalisation for dense overlaps.
    const overlapComp = 1 / Math.sqrt(1 + this.tDensity * 3)
    wetL *= overlapComp
    wetR *= overlapComp

    // --- record (input + feedback), frozen writes fade to nothing ----------
    const wp = this.writePos
    const inL = (l + fastTanh(wetL * fb)) * write
    const inR = (r + fastTanh(wetR * fb)) * write
    // Crossfade the write so a freeze edge never leaves a step in the buffer.
    this.bufL[wp] = this.bufL[wp] * (1 - write) + inL
    this.bufR[wp] = this.bufR[wp] * (1 - write) + inR
    this.writePos = wp + 1 === this.bufLen ? 0 : wp + 1

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
    this.writePos = 0
    this.vActive.fill(0)
    this.spawnCountdown = 0
    this.spawnIndex = 0
    this.mixS.reset(this.tMix)
    this.fbS.reset(this.tFeedback)
    this.writeS.reset(1 - this.tFreeze)
  }
}

/**
 * RingMod — multiply the signal by a carrier for metallic / inharmonic tones.
 * Pure, deterministic, allocation-free hot path (mirrors drive.ts).
 *
 * WHY one shared phase accumulator: the carrier phase must advance continuously
 * across blocks (never reset per call) or the sine would glitch at block seams.
 * We wrap the phase against TAU each sample to keep it from growing unbounded
 * and losing floating-point precision over long runs. Frequency changes only
 * alter the per-sample increment, so the phase stays continuous through them.
 *
 * Modes: Free uses the knob directly; Note snaps the knob to the nearest
 * equal-tempered semitone (A440 reference); Track estimates the input's pitch
 * with a cheap lowpassed zero-crossing period detector on the mono sum.
 * The carrier target is always smoothed in the log domain (musical glides).
 */
import { clamp, fastTanh, OnePoleLP, Smoother, TAU } from './util.ts'

export interface RingModParams {
  freq: number // 20..4000 Hz carrier
  mix: number // 0..1 dry/wet
  mode?: number // 0..2 [Free, Note, Track]; omitted => 0 (legacy Free)
  shape?: number // 0..1 sine -> tanh-shaped near-square carrier; omitted => 0
}

const MODE_NOTE = 1
const MODE_TRACK = 2
// Track detector accepts periods for ~50..1500 Hz; outside that (thumps,
// hiss-driven multi-crossings) the previous stable estimate is held.
const TRACK_MIN_HZ = 50
const TRACK_MAX_HZ = 1500
const TRACK_ENV_GATE = 1e-3

export class RingMod {
  private readonly sampleRate: number
  private readonly scratch = new Float64Array(2)
  private readonly mixS: Smoother
  private readonly shapeS: Smoother
  // Carrier frequency is smoothed as log2(Hz) so sweeps glide in pitch, not Hz.
  private readonly freqLogS: Smoother
  private tFreq = 220
  private tMix = 0.5
  private tMode = 0
  private tShape = 0
  private tNoteFreq = 220
  private phase = 0
  // --- Track mode state ---
  // Detection lowpass strips harmonics so one period => one rising crossing.
  private readonly detLp = new OnePoleLP()
  // Heavy smoothing of the raw crossing estimate so the carrier never warbles.
  private readonly trackS: Smoother
  private prevDet = 0
  private sinceCross = 0
  private trackHz = 220 // last stable estimate — held through silence
  private env = 0
  private readonly envDecay: number
  private readonly minPeriod: number
  private readonly maxPeriod: number

  constructor(sampleRate: number) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100
    this.mixS = new Smoother(this.sampleRate, 0.02, 0.5)
    this.shapeS = new Smoother(this.sampleRate, 0.02, 0)
    this.freqLogS = new Smoother(this.sampleRate, 0.02, Math.log2(220))
    this.trackS = new Smoother(this.sampleRate, 0.12, 220)
    this.detLp.setCutoff(this.sampleRate, 1000)
    this.envDecay = Math.exp(-1 / (0.05 * this.sampleRate))
    this.minPeriod = Math.floor(this.sampleRate / TRACK_MAX_HZ)
    this.maxPeriod = Math.ceil(this.sampleRate / TRACK_MIN_HZ)
  }

  setParams({ freq, mix, mode = 0, shape = 0 }: RingModParams): void {
    this.tFreq = clamp(freq, 20, 4000)
    this.tMix = clamp(mix, 0, 1)
    this.tMode = Math.round(clamp(mode, 0, 2))
    this.tShape = clamp(shape, 0, 1)
    // Note mode: snap to the nearest equal-tempered semitone, A440 reference.
    const st = Math.round(12 * Math.log2(this.tFreq / 440))
    this.tNoteFreq = clamp(440 * Math.pow(2, st / 12), 20, 4000)
  }

  processInto(left: number, right: number, out: Float64Array): void {
    const l = Number.isFinite(left) ? left : 0
    const r = Number.isFinite(right) ? right : 0
    const mix = this.mixS.process(this.tMix)
    const shape = this.shapeS.process(this.tShape)

    let target = this.tFreq
    if (this.tMode === MODE_NOTE) {
      target = this.tNoteFreq
    } else if (this.tMode === MODE_TRACK) {
      // Cheap pitch estimate: rising zero crossings of the lowpassed mono sum.
      const det = this.detLp.process(0.5 * (l + r))
      const mag = det < 0 ? -det : det
      const decayed = this.env * this.envDecay
      this.env = mag > decayed ? mag : decayed
      if (this.env < 1e-20) this.env = 0
      if (this.sinceCross < 0x7fffffff) this.sinceCross++
      if (this.prevDet <= 0 && det > 0) {
        const p = this.sinceCross
        this.sinceCross = 0
        // Only accept plausible periods while the input is audible; otherwise
        // trackHz holds the last stable estimate (e.g. through silence).
        if (this.env > TRACK_ENV_GATE && p >= this.minPeriod && p <= this.maxPeriod) {
          this.trackHz = this.sampleRate / p
        }
      }
      this.prevDet = det
      // Track mapping: the freq knob acts as a ratio around its 220 Hz default
      // — at 220 the carrier follows the input pitch 1:1, 440 rides an octave
      // above, 110 an octave below. Musical, and the default is transparent.
      target = clamp(this.trackS.process(this.trackHz) * (this.tFreq / 220), 20, 4000)
    }

    const freq = Math.pow(2, this.freqLogS.process(Math.log2(target)))

    this.phase += (TAU * freq) / this.sampleRate
    if (this.phase >= TAU) this.phase -= TAU
    const s = Math.sin(this.phase)
    // shape: blend the pure sine toward a tanh-squashed near-square. Shaping
    // the sine (instead of generating a naive square) keeps the edges rounded
    // and the carrier band-limited-ish; fastTanh is strictly bounded to +-1.
    const carrier = shape > 0 ? s + (fastTanh(s * 6) - s) * shape : s

    // mix=0 is bit-exact dry; mix=1 is fully ring-modulated.
    out[0] = l * (1 - mix) + l * carrier * mix
    out[1] = r * (1 - mix) + r * carrier * mix
  }

  process(left: number, right: number): [number, number] {
    this.processInto(left, right, this.scratch)
    return [this.scratch[0], this.scratch[1]]
  }

  reset(): void {
    this.phase = 0
    this.mixS.reset(this.tMix)
    this.shapeS.reset(this.tShape)
    this.freqLogS.reset(Math.log2(this.tFreq))
    this.detLp.reset(0)
    this.trackS.reset(this.trackHz)
    this.prevDet = 0
    this.sinceCross = 0
    this.env = 0
  }
}

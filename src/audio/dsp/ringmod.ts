/**
 * RingMod — multiply the signal by a sine carrier for metallic / inharmonic
 * tones. Pure, deterministic, allocation-free hot path (mirrors drive.ts).
 *
 * WHY one shared phase accumulator: the carrier phase must advance continuously
 * across blocks (never reset per call) or the sine would glitch at block seams.
 * We wrap the phase against TAU each sample to keep it from growing unbounded
 * and losing floating-point precision over long runs.
 */
import { clamp, Smoother, TAU } from './util.ts'

export interface RingModParams {
  freq: number // 20..4000 Hz carrier
  mix: number // 0..1 dry/wet
}

export class RingMod {
  private readonly sampleRate: number
  private readonly scratch = new Float64Array(2)
  private readonly freqS: Smoother
  private readonly mixS: Smoother
  private tFreq = 220
  private tMix = 0.5
  private phase = 0

  constructor(sampleRate: number) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100
    this.freqS = new Smoother(this.sampleRate, 0.02, 220)
    this.mixS = new Smoother(this.sampleRate, 0.02, 0.5)
  }

  setParams({ freq, mix }: RingModParams): void {
    this.tFreq = clamp(freq, 20, 4000)
    this.tMix = clamp(mix, 0, 1)
  }

  processInto(left: number, right: number, out: Float64Array): void {
    const l = Number.isFinite(left) ? left : 0
    const r = Number.isFinite(right) ? right : 0
    const freq = this.freqS.process(this.tFreq)
    const mix = this.mixS.process(this.tMix)

    this.phase += (TAU * freq) / this.sampleRate
    if (this.phase >= TAU) this.phase -= TAU
    const carrier = Math.sin(this.phase)

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
    this.freqS.reset(this.tFreq)
    this.mixS.reset(this.tMix)
  }
}

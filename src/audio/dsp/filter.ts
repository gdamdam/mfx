/**
 * Filter — TPT (topology-preserving transform / zero-delay-feedback) state-
 * variable filter (low / band / high pass) with independent state per channel.
 * Pure, deterministic, allocation-free hot path.
 *
 * WHY TPT rather than Chamberlin: the classic Chamberlin SVF is only stable for
 * cutoffs well below Nyquist, which forced a ~0.18*fs cap and left the top half
 * of the freq knob dead. The trapezoidal TPT form (Zavalishin / Cytomic) is
 * unconditionally stable up to Nyquist, so the full 30..18000Hz range works and
 * no divergence guard is needed.
 *
 * Follows the reference core shape (see drive.ts).
 */
import { clamp, lerp, Smoother } from './util.ts'

export interface FilterParams {
  freq: number // 30..18000 Hz
  reso: number // 0..1  -> Q (damping 1..0.05)
  type: number // 0..2  rounds to 0=LP, 1=BP, 2=HP
}

export class Filter {
  private readonly sampleRate: number
  private readonly maxFreq: number
  private readonly scratch = new Float64Array(2)
  private readonly freqS: Smoother
  // raw targets; freq smooths per sample (audible sweeps), reso/type at block rate
  private tFreq = 1200
  private tReso = 0.2
  private tType = 0
  // TPT integrator state (ic1eq/ic2eq), one pair per channel.
  private ic1L = 0
  private ic2L = 0
  private ic1R = 0
  private ic2R = 0

  constructor(sampleRate: number) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100
    // TPT is stable to Nyquist; only keep the param-contract ceiling and a small
    // margin below Nyquist for exotic (low) sample rates.
    this.maxFreq = Math.min(18000, this.sampleRate * 0.49)
    this.freqS = new Smoother(this.sampleRate, 0.02, 1200)
  }

  setParams({ freq, reso, type }: FilterParams): void {
    this.tFreq = clamp(freq, 30, 18000)
    this.tReso = clamp(reso, 0, 1)
    // type is a discrete index; round then clamp to the valid range
    this.tType = Math.round(clamp(type, 0, 2))
  }

  processInto(left: number, right: number, out: Float64Array): void {
    const freq = this.freqS.process(this.tFreq)
    const l = Number.isFinite(left) ? left : 0
    const r = Number.isFinite(right) ? right : 0

    const fc = clamp(freq, 30, this.maxFreq)
    // TPT prewarped integrator gain and 1/Q damping. reso -> low damping k
    // (sharper resonant peak); a1/a2/a3 solve the zero-delay feedback.
    const g = Math.tan((Math.PI * fc) / this.sampleRate)
    const k = lerp(1, 0.05, this.tReso)
    const a1 = 1 / (1 + g * (g + k))
    const a2 = g * a1
    const a3 = g * a2

    // Left channel.
    const v3L = l - this.ic2L
    const v1L = a1 * this.ic1L + a2 * v3L
    const v2L = this.ic2L + a2 * this.ic1L + a3 * v3L
    this.ic1L = 2 * v1L - this.ic1L
    this.ic2L = 2 * v2L - this.ic2L
    const lowL = v2L
    const bandL = v1L
    const highL = l - k * v1L - v2L

    // Right channel.
    const v3R = r - this.ic2R
    const v1R = a1 * this.ic1R + a2 * v3R
    const v2R = this.ic2R + a2 * this.ic1R + a3 * v3R
    this.ic1R = 2 * v1R - this.ic1R
    this.ic2R = 2 * v2R - this.ic2R
    const lowR = v2R
    const bandR = v1R
    const highR = r - k * v1R - v2R

    if (this.tType === 0) {
      out[0] = lowL
      out[1] = lowR
    } else if (this.tType === 1) {
      out[0] = bandL
      out[1] = bandR
    } else {
      out[0] = highL
      out[1] = highR
    }
  }

  process(left: number, right: number): [number, number] {
    this.processInto(left, right, this.scratch)
    return [this.scratch[0], this.scratch[1]]
  }

  reset(): void {
    this.ic1L = 0
    this.ic2L = 0
    this.ic1R = 0
    this.ic2R = 0
    this.freqS.reset(this.tFreq)
  }
}

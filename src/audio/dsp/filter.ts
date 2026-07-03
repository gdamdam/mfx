/**
 * Filter — Chamberlin state-variable filter (low / band / high pass) with
 * independent state per channel. Pure, deterministic, allocation-free hot path.
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
  // Chamberlin integrator state, one pair per channel
  private lowL = 0
  private bandL = 0
  private lowR = 0
  private bandR = 0

  constructor(sampleRate: number) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100
    // Chamberlin is only stable well below Nyquist; cap the cutoff so the
    // tuning coefficient f = 2*sin(pi*fc/sr) stays comfortably under 2.
    this.maxFreq = Math.min(18000, this.sampleRate * 0.245)
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
    const f = 2 * Math.sin((Math.PI * fc) / this.sampleRate)
    // reso -> damping: high reso means low damping (sharper resonant peak).
    const q = lerp(1, 0.05, this.tReso)

    // Left channel integrators.
    this.lowL += f * this.bandL
    const highL = l - this.lowL - q * this.bandL
    this.bandL += f * highL

    // Right channel integrators.
    this.lowR += f * this.bandR
    const highR = r - this.lowR - q * this.bandR
    this.bandR += f * highR

    if (this.tType === 0) {
      out[0] = this.lowL
      out[1] = this.lowR
    } else if (this.tType === 1) {
      out[0] = this.bandL
      out[1] = this.bandR
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
    this.lowL = 0
    this.bandL = 0
    this.lowR = 0
    this.bandR = 0
    this.freqS.reset(this.tFreq)
  }
}

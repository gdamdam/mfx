/**
 * Bitcrusher — bit-depth quantization plus sample-rate reduction (sample &
 * hold). Pure, deterministic, allocation-free hot path (mirrors drive.ts).
 *
 * WHY a phase accumulator for downsampling: to decimate by a non-integer factor
 * we advance a phase by 1/holdFactor each sample and only latch a new held
 * value when it wraps past 1. That yields smooth control over the effective
 * rate (a knob, not stepped integers) while staying allocation-free, and it
 * captures on the first sample so there's no startup silence.
 */
import { clamp, Smoother } from './util.ts'

export interface BitcrusherParams {
  bits: number // 1..16 (may be fractional; floored for level count)
  downsample: number // 0..1 (0 = no reduction, 1 = heavy decimation)
  mix: number // 0..1 dry/wet
}

const MAX_HOLD = 64

export class Bitcrusher {
  private readonly sampleRate: number
  private readonly scratch = new Float64Array(2)
  private readonly bitsS: Smoother
  private readonly downS: Smoother
  private readonly mixS: Smoother
  private tBits = 8
  private tDown = 0.3
  private tMix = 0.7
  // Sample-and-hold state (shared phase, per-channel held values).
  private phase = 1 // >=1 so the very first sample latches a fresh value
  private heldL = 0
  private heldR = 0

  constructor(sampleRate: number) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100
    this.bitsS = new Smoother(this.sampleRate, 0.02, 8)
    this.downS = new Smoother(this.sampleRate, 0.02, 0.3)
    this.mixS = new Smoother(this.sampleRate, 0.02, 0.7)
  }

  setParams({ bits, downsample, mix }: BitcrusherParams): void {
    this.tBits = clamp(bits, 1, 16)
    this.tDown = clamp(downsample, 0, 1)
    this.tMix = clamp(mix, 0, 1)
  }

  /** Quantize x in [-1,1] to `levels` steps. Floor bits for a hard step count. */
  private quantize(x: number, half: number): number {
    const c = clamp(x, -1, 1)
    return Math.round(c * half) / half
  }

  processInto(left: number, right: number, out: Float64Array): void {
    const l = Number.isFinite(left) ? left : 0
    const r = Number.isFinite(right) ? right : 0
    const bits = this.bitsS.process(this.tBits)
    const down = this.downS.process(this.tDown)
    const mix = this.mixS.process(this.tMix)

    // 2^bits levels over [-1,1] => half = levels/2 is the round() scale.
    const half = Math.max(1, Math.pow(2, Math.floor(bits)) / 2)
    // holdFactor 1..MAX_HOLD; 1 = capture every sample (no rate reduction).
    const holdFactor = 1 + down * (MAX_HOLD - 1)

    this.phase += 1 / holdFactor
    if (this.phase >= 1) {
      this.phase -= 1
      this.heldL = this.quantize(l, half)
      this.heldR = this.quantize(r, half)
    }

    out[0] = l * (1 - mix) + this.heldL * mix
    out[1] = r * (1 - mix) + this.heldR * mix
  }

  process(left: number, right: number): [number, number] {
    this.processInto(left, right, this.scratch)
    return [this.scratch[0], this.scratch[1]]
  }

  reset(): void {
    this.phase = 1
    this.heldL = 0
    this.heldR = 0
    this.bitsS.reset(this.tBits)
    this.downS.reset(this.tDown)
    this.mixS.reset(this.tMix)
  }
}

/**
 * Compressor — feed-forward peak compressor with stereo-linked detection and
 * makeup gain. Pure, deterministic, allocation-free hot path.
 *
 * Follows the reference core shape (see drive.ts): params interface, clamping
 * setParams, allocation-free processInto, a process() test convenience, reset.
 */
import { clamp, Smoother, dbToGain } from './util.ts'

export interface CompParams {
  amount: number // 0..1  more = lower threshold + higher ratio
  attack: number // 0..1  ~1ms -> 100ms
  release: number // 0..1  ~20ms -> 800ms
  makeup: number // 0..1  0 -> +18dB output trim
}

export class Comp {
  private readonly sampleRate: number
  private readonly scratch = new Float64Array(2)
  private readonly amountS: Smoother
  private readonly makeupS: Smoother
  // raw targets; amount/makeup smooth per sample, attack/release are time
  // constants so they resolve to coefficients at block rate (no zipper risk).
  private tAmount = 0.4
  private tMakeup = 0.5
  private attackCoeff = 0
  private releaseCoeff = 0
  // stereo-linked peak envelope follower state
  private env = 0

  constructor(sampleRate: number) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100
    this.amountS = new Smoother(this.sampleRate, 0.02, 0.4)
    this.makeupS = new Smoother(this.sampleRate, 0.02, 0.5)
    // seed coefficients so a core used before setParams still behaves sanely
    this.setTimes(0.2, 0.45)
  }

  private setTimes(attack: number, release: number): void {
    // Map the normalized knobs onto musically useful time constants.
    const attackSec = 0.001 + attack * 0.099 // 1ms -> 100ms
    const releaseSec = 0.02 + release * 0.78 // 20ms -> 800ms
    this.attackCoeff = Math.exp(-1 / (attackSec * this.sampleRate))
    this.releaseCoeff = Math.exp(-1 / (releaseSec * this.sampleRate))
  }

  setParams({ amount, attack, release, makeup }: CompParams): void {
    this.tAmount = clamp(amount, 0, 1)
    this.tMakeup = clamp(makeup, 0, 1)
    this.setTimes(clamp(attack, 0, 1), clamp(release, 0, 1))
  }

  processInto(left: number, right: number, out: Float64Array): void {
    const amount = this.amountS.process(this.tAmount)
    const makeup = this.makeupS.process(this.tMakeup)
    const l = Number.isFinite(left) ? left : 0
    const r = Number.isFinite(right) ? right : 0

    // Stereo-linked detection: drive one detector from the louder channel so
    // gain is applied identically to both and the stereo image stays stable.
    const detect = Math.max(Math.abs(l), Math.abs(r))
    // Peak follower: fast attack when rising, slow release when falling.
    const coeff = detect > this.env ? this.attackCoeff : this.releaseCoeff
    this.env = detect + (this.env - detect) * coeff

    // amount maps to a harsher curve: threshold falls, ratio climbs.
    const thDb = -6 + amount * -34 // -6dB -> -40dB
    const ratio = 1.5 + amount * 10.5 // 1.5:1 -> 12:1
    const envDb = 20 * Math.log10(this.env + 1e-9)
    // Only reduce above threshold; below it the compressor is transparent.
    const overDb = envDb - thDb
    const redDb = overDb > 0 ? overDb * (1 - 1 / ratio) : 0

    const gain = dbToGain(makeup * 18 - redDb)
    out[0] = l * gain
    out[1] = r * gain
  }

  process(left: number, right: number): [number, number] {
    this.processInto(left, right, this.scratch)
    return [this.scratch[0], this.scratch[1]]
  }

  reset(): void {
    this.env = 0
    this.amountS.reset(this.tAmount)
    this.makeupS.reset(this.tMakeup)
  }
}

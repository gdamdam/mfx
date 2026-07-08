/**
 * Bitcrusher — bit-depth quantization plus sample-rate reduction (sample &
 * hold), with optional step smoothing and anti-alias taming. Pure,
 * deterministic, allocation-free hot path (mirrors drive.ts).
 *
 * WHY a phase accumulator for downsampling: to decimate by a non-integer factor
 * we advance a phase by 1/holdFactor each sample and only latch a new held
 * value when it wraps past 1. That yields smooth control over the effective
 * rate (a knob, not stepped integers) while staying allocation-free, and it
 * captures on the first sample so there's no startup silence.
 *
 * `smooth` blends the hard sample-and-hold steps toward a linear interpolation
 * between the two most recent held values (the phase doubles as the interp
 * ramp, at the cost of one hold period of latency on the wet path). `alias`
 * blends in a one-pole pre-lowpass before decimation plus a post-lowpass, both
 * tracking ~0.4x the effective decimated rate. Both default to 0 == the exact
 * legacy signal path.
 */
import { clamp, Smoother, TAU } from './util.ts'

export interface BitcrusherParams {
  bits: number // 1..16 (may be fractional; floored for level count)
  downsample: number // 0..1 (0 = no reduction, 1 = heavy decimation)
  mix: number // 0..1 dry/wet
  smooth?: number // 0..1 hard steps -> linear interp between held samples
  alias?: number // 0..1 raw -> pre/post lowpassed ("Tame")
}

const MAX_HOLD = 64
// Below this input envelope the held codes are bled to zero so a decaying
// signal reaches true digital silence instead of parking on a mid-riser LSB.
const SILENCE_ENV = 1e-4
const HELD_BLEED = 0.995

export class Bitcrusher {
  private readonly sampleRate: number
  private readonly scratch = new Float64Array(2)
  private readonly bitsS: Smoother
  private readonly downS: Smoother
  private readonly mixS: Smoother
  private readonly smoothS: Smoother
  private readonly aliasS: Smoother
  private tBits = 8
  private tDown = 0.3
  private tMix = 0.7
  private tSmooth = 0
  private tAlias = 0
  // Sample-and-hold state (shared phase, per-channel held values). prevHeld is
  // the previously latched code — the start point of the `smooth` interp ramp.
  private phase = 1 // >=1 so the very first sample latches a fresh value
  private heldL = 0
  private heldR = 0
  private prevHeldL = 0
  private prevHeldR = 0
  // Peak-tracking input envelope gating the silence bleed (~50ms release).
  private env = 0
  private readonly envDecay: number
  // One-pole states for the `alias` pre/post filters (shared coefficient).
  private preL = 0
  private preR = 0
  private postL = 0
  private postR = 0

  constructor(sampleRate: number) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100
    this.bitsS = new Smoother(this.sampleRate, 0.02, 8)
    this.downS = new Smoother(this.sampleRate, 0.02, 0.3)
    this.mixS = new Smoother(this.sampleRate, 0.02, 0.7)
    this.smoothS = new Smoother(this.sampleRate, 0.02, 0)
    this.aliasS = new Smoother(this.sampleRate, 0.02, 0)
    this.envDecay = Math.exp(-1 / (0.05 * this.sampleRate))
  }

  setParams({ bits, downsample, mix, smooth = 0, alias = 0 }: BitcrusherParams): void {
    this.tBits = clamp(bits, 1, 16)
    this.tDown = clamp(downsample, 0, 1)
    this.tMix = clamp(mix, 0, 1)
    this.tSmooth = clamp(smooth, 0, 1)
    this.tAlias = clamp(alias, 0, 1)
  }

  /**
   * Quantize x in [-1,1] to `levels` steps with a mid-riser quantizer (no code
   * sits at exactly 0), so bits=1 gives a true 2-level {-0.5,+0.5} split rather
   * than the mid-tread {-1,0,1} the round()/half form produced.
   */
  private quantize(x: number, levels: number): number {
    const c = clamp(x, -1, 1)
    let idx = Math.floor((c * 0.5 + 0.5) * levels)
    if (idx >= levels) idx = levels - 1
    if (idx < 0) idx = 0
    return ((idx + 0.5) / levels) * 2 - 1
  }

  processInto(left: number, right: number, out: Float64Array): void {
    const l = Number.isFinite(left) ? left : 0
    const r = Number.isFinite(right) ? right : 0
    const bits = this.bitsS.process(this.tBits)
    const down = this.downS.process(this.tDown)
    const mix = this.mixS.process(this.tMix)
    const smooth = this.smoothS.process(this.tSmooth)
    const alias = this.aliasS.process(this.tAlias)

    // 2^bits levels over [-1,1] (bits>=1 => at least 2 levels).
    const levels = Math.max(2, Math.pow(2, Math.floor(bits)))
    // holdFactor 1..MAX_HOLD; 1 = capture every sample (no rate reduction).
    const holdFactor = 1 + down * (MAX_HOLD - 1)

    // Anti-alias filters track the effective decimated rate (fc ~ 0.4x it).
    // Always processed so blending by `alias` stays click-free; one shared
    // exp() per sample keeps the cost of the tracking cutoff negligible.
    const fc = (0.4 * this.sampleRate) / holdFactor
    const a = 1 - Math.exp((-TAU * fc) / this.sampleRate)
    this.preL += a * (l - this.preL)
    this.preR += a * (r - this.preR)
    if (this.preL < 1e-20 && this.preL > -1e-20) this.preL = 0
    if (this.preR < 1e-20 && this.preR > -1e-20) this.preR = 0
    const qInL = l + (this.preL - l) * alias
    const qInR = r + (this.preR - r) * alias

    // Input envelope for the silence bleed (per-block peak with slow release).
    const magL = l < 0 ? -l : l
    const magR = r < 0 ? -r : r
    const mag = magL > magR ? magL : magR
    const decayed = this.env * this.envDecay
    this.env = mag > decayed ? mag : decayed
    if (this.env < 1e-20) this.env = 0

    const silent = this.env < SILENCE_ENV
    this.phase += 1 / holdFactor
    if (this.phase >= 1) {
      this.phase -= 1
      this.prevHeldL = this.heldL
      this.prevHeldR = this.heldR
      // While silent, stop latching fresh codes (the mid-riser would keep
      // re-injecting a +LSB/2 for zero input) and let the bleed below drain.
      if (!silent) {
        this.heldL = this.quantize(qInL, levels)
        this.heldR = this.quantize(qInR, levels)
      }
    }
    if (silent) {
      // Decaying input has gone quiet: bleed the held codes to true zero so a
      // mid-riser LSB never buzzes/leans DC forever on silence.
      this.heldL *= HELD_BLEED
      this.heldR *= HELD_BLEED
      this.prevHeldL *= HELD_BLEED
      this.prevHeldR *= HELD_BLEED
      if (this.heldL < 1e-20 && this.heldL > -1e-20) this.heldL = 0
      if (this.heldR < 1e-20 && this.heldR > -1e-20) this.heldR = 0
      if (this.prevHeldL < 1e-20 && this.prevHeldL > -1e-20) this.prevHeldL = 0
      if (this.prevHeldR < 1e-20 && this.prevHeldR > -1e-20) this.prevHeldR = 0
    }

    // smooth: ramp from the previous held code to the current one as the phase
    // sweeps 0..1, blended against the raw stepped hold.
    let wetL = this.heldL + (this.prevHeldL + (this.heldL - this.prevHeldL) * this.phase - this.heldL) * smooth
    let wetR = this.heldR + (this.prevHeldR + (this.heldR - this.prevHeldR) * this.phase - this.heldR) * smooth

    this.postL += a * (wetL - this.postL)
    this.postR += a * (wetR - this.postR)
    if (this.postL < 1e-20 && this.postL > -1e-20) this.postL = 0
    if (this.postR < 1e-20 && this.postR > -1e-20) this.postR = 0
    wetL += (this.postL - wetL) * alias
    wetR += (this.postR - wetR) * alias

    out[0] = l * (1 - mix) + wetL * mix
    out[1] = r * (1 - mix) + wetR * mix
  }

  process(left: number, right: number): [number, number] {
    this.processInto(left, right, this.scratch)
    return [this.scratch[0], this.scratch[1]]
  }

  reset(): void {
    this.phase = 1
    this.heldL = 0
    this.heldR = 0
    this.prevHeldL = 0
    this.prevHeldR = 0
    this.env = 0
    this.preL = 0
    this.preR = 0
    this.postL = 0
    this.postR = 0
    this.bitsS.reset(this.tBits)
    this.downS.reset(this.tDown)
    this.mixS.reset(this.tMix)
    this.smoothS.reset(this.tSmooth)
    this.aliasS.reset(this.tAlias)
  }
}

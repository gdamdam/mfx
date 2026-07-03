/**
 * Flanger — short swept delay (0.5..8ms) fed back into itself to form a moving
 * comb filter. DelayLine per channel with a slight LFO phase offset for width.
 * Allocation-free hot path.
 *
 * Follows the reference core shape (see drive.ts).
 */
import { clamp, Smoother, DelayLine, TAU } from './util.ts'

export interface FlangerParams {
  rate: number // 0.05..6 Hz  sweep speed
  depth: number // 0..1  sweep amount
  feedback: number // 0..0.95  comb resonance
  mix: number // 0..1  dry -> wet
}

export class Flanger {
  private readonly sampleRate: number
  private readonly scratch = new Float64Array(2)
  private readonly dlL: DelayLine
  private readonly dlR: DelayLine
  private readonly depthS: Smoother
  private readonly fbS: Smoother
  private readonly mixS: Smoother
  private readonly minSamples: number
  private readonly rangeSamples: number
  // raw targets; depth/feedback/mix smooth per sample, rate drives the phase
  private tRate = 0.3
  private tDepth = 0.6
  private tFeedback = 0.5
  private tMix = 0.5
  private phase = 0

  constructor(sampleRate: number) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100
    this.minSamples = (0.5 / 1000) * this.sampleRate
    this.rangeSamples = (7.5 / 1000) * this.sampleRate // reaches 8ms at full depth
    const size = Math.ceil((9 / 1000) * this.sampleRate) + 4
    this.dlL = new DelayLine(size)
    this.dlR = new DelayLine(size)
    this.depthS = new Smoother(this.sampleRate, 0.02, 0.6)
    this.fbS = new Smoother(this.sampleRate, 0.02, 0.5)
    this.mixS = new Smoother(this.sampleRate, 0.02, 0.5)
  }

  setParams({ rate, depth, feedback, mix }: FlangerParams): void {
    this.tRate = clamp(rate, 0.05, 6)
    this.tDepth = clamp(depth, 0, 1)
    this.tFeedback = clamp(feedback, 0, 0.95)
    this.tMix = clamp(mix, 0, 1)
  }

  processInto(left: number, right: number, out: Float64Array): void {
    const depth = this.depthS.process(this.tDepth)
    const fb = this.fbS.process(this.tFeedback)
    const mix = this.mixS.process(this.tMix)
    const l = Number.isFinite(left) ? left : 0
    const r = Number.isFinite(right) ? right : 0

    this.phase += this.tRate / this.sampleRate
    if (this.phase >= 1) this.phase -= 1
    // Unipolar LFOs (0..1) so the delay never crosses below the safe minimum;
    // a quarter-cycle offset between channels widens the sweep.
    const lfoL = 0.5 + 0.5 * Math.sin(TAU * this.phase)
    const lfoR = 0.5 + 0.5 * Math.sin(TAU * (this.phase + 0.25))
    const dL = this.minSamples + depth * lfoL * this.rangeSamples
    const dR = this.minSamples + depth * lfoR * this.rangeSamples

    // Read the delayed tap first, then write input plus feedback of that tap
    // so the comb notches resonate.
    const wetL = this.dlL.read(dL)
    this.dlL.write(l + wetL * fb)
    const wetR = this.dlR.read(dR)
    this.dlR.write(r + wetR * fb)

    out[0] = l * (1 - mix) + wetL * mix
    out[1] = r * (1 - mix) + wetR * mix
  }

  process(left: number, right: number): [number, number] {
    this.processInto(left, right, this.scratch)
    return [this.scratch[0], this.scratch[1]]
  }

  reset(): void {
    this.dlL.reset()
    this.dlR.reset()
    this.phase = 0
    this.depthS.reset(this.tDepth)
    this.fbS.reset(this.tFeedback)
    this.mixS.reset(this.tMix)
  }
}

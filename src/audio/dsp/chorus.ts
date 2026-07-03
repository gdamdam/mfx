/**
 * Chorus — dual-voice pitch-modulated delay for width and thickness. Two LFO
 * voices at offset phases feed decorrelated delay reads on each channel, so the
 * wet signal spreads across the stereo field. Allocation-free hot path.
 *
 * Follows the reference core shape (see drive.ts).
 */
import { clamp, Smoother, DelayLine, TAU } from './util.ts'

export interface ChorusParams {
  rate: number // 0.05..8 Hz  LFO speed
  depth: number // 0..1  modulation depth
  mix: number // 0..1  dry -> wet
}

export class Chorus {
  private readonly sampleRate: number
  private readonly scratch = new Float64Array(2)
  private readonly dlL: DelayLine
  private readonly dlR: DelayLine
  private readonly depthS: Smoother
  private readonly mixS: Smoother
  // base delay ~16ms, swept +/-9ms => 7..25ms, converted to samples once
  private readonly baseSamples: number
  private readonly swingSamples: number
  // raw targets; depth+mix smooth per sample, rate drives the phase accumulator
  private tRate = 0.8
  private tDepth = 0.5
  private tMix = 0.5
  private phase = 0

  constructor(sampleRate: number) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100
    this.baseSamples = (16 / 1000) * this.sampleRate
    this.swingSamples = (9 / 1000) * this.sampleRate
    // Size the line for the deepest sweep plus interpolation headroom.
    const size = Math.ceil((26 / 1000) * this.sampleRate) + 4
    this.dlL = new DelayLine(size)
    this.dlR = new DelayLine(size)
    this.depthS = new Smoother(this.sampleRate, 0.02, 0.5)
    this.mixS = new Smoother(this.sampleRate, 0.02, 0.5)
  }

  setParams({ rate, depth, mix }: ChorusParams): void {
    this.tRate = clamp(rate, 0.05, 8)
    this.tDepth = clamp(depth, 0, 1)
    this.tMix = clamp(mix, 0, 1)
  }

  processInto(left: number, right: number, out: Float64Array): void {
    const depth = this.depthS.process(this.tDepth)
    const mix = this.mixS.process(this.tMix)
    const l = Number.isFinite(left) ? left : 0
    const r = Number.isFinite(right) ? right : 0

    this.dlL.write(l)
    this.dlR.write(r)

    this.phase += this.tRate / this.sampleRate
    if (this.phase >= 1) this.phase -= 1
    // Two voices a half-cycle apart give the classic detuned shimmer; sending
    // one to each channel decorrelates L/R for stereo width.
    const swing = depth * this.swingSamples
    const dA = this.baseSamples + swing * Math.sin(TAU * this.phase)
    const dB = this.baseSamples + swing * Math.sin(TAU * (this.phase + 0.5))
    const wetL = this.dlL.read(dA)
    const wetR = this.dlR.read(dB)

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
    this.mixS.reset(this.tMix)
  }
}

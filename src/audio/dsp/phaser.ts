/**
 * Phaser — four cascaded first-order all-pass stages per channel whose
 * coefficient is swept by an LFO, with feedback from the last stage to the
 * first. Summing dry + phase-shifted signal produces the sweeping notches.
 * Allocation-free hot path.
 *
 * Follows the reference core shape (see drive.ts).
 */
import { clamp, Smoother, TAU } from './util.ts'

const STAGES = 4

export interface PhaserParams {
  rate: number // 0.05..6 Hz  sweep speed
  depth: number // 0..1  sweep range
  feedback: number // 0..0.9  regeneration
  mix: number // 0..1  dry -> wet
}

export class Phaser {
  private readonly sampleRate: number
  private readonly scratch = new Float64Array(2)
  private readonly depthS: Smoother
  private readonly fbS: Smoother
  private readonly mixS: Smoother
  // per-stage all-pass memory (previous input / output) for each channel
  private readonly xL = new Float64Array(STAGES)
  private readonly yL = new Float64Array(STAGES)
  private readonly xR = new Float64Array(STAGES)
  private readonly yR = new Float64Array(STAGES)
  // last-stage output kept for the feedback path
  private lastL = 0
  private lastR = 0
  // raw targets; depth/feedback/mix smooth per sample, rate drives the phase
  private tRate = 0.4
  private tDepth = 0.7
  private tFeedback = 0.4
  private tMix = 0.5
  private phase = 0

  constructor(sampleRate: number) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100
    this.depthS = new Smoother(this.sampleRate, 0.02, 0.7)
    this.fbS = new Smoother(this.sampleRate, 0.02, 0.4)
    this.mixS = new Smoother(this.sampleRate, 0.02, 0.5)
  }

  setParams({ rate, depth, feedback, mix }: PhaserParams): void {
    this.tRate = clamp(rate, 0.05, 6)
    this.tDepth = clamp(depth, 0, 1)
    this.tFeedback = clamp(feedback, 0, 0.9)
    this.tMix = clamp(mix, 0, 1)
  }

  /** Run one channel's cascade; xs/ys hold that channel's per-stage memory. */
  private cascade(input: number, a: number, xs: Float64Array, ys: Float64Array): number {
    let x = input
    for (let i = 0; i < STAGES; i++) {
      // First-order all-pass: y = a*x + x[n-1] - a*y[n-1].
      const y = a * x + xs[i] - a * ys[i]
      xs[i] = x
      ys[i] = y
      x = y
    }
    return x
  }

  processInto(left: number, right: number, out: Float64Array): void {
    const depth = this.depthS.process(this.tDepth)
    const fb = this.fbS.process(this.tFeedback)
    const mix = this.mixS.process(this.tMix)
    const l = Number.isFinite(left) ? left : 0
    const r = Number.isFinite(right) ? right : 0

    this.phase += this.tRate / this.sampleRate
    if (this.phase >= 1) this.phase -= 1
    // Sweep centre frequency 200Hz -> up to 2kHz, scaled by depth.
    const lfo = 0.5 + 0.5 * Math.sin(TAU * this.phase)
    const fc = 200 + lfo * depth * 1800
    const t = Math.tan((Math.PI * fc) / this.sampleRate)
    // Bilinear all-pass coefficient in (-1, 1).
    const a = (t - 1) / (t + 1)

    const yL = this.cascade(l + this.lastL * fb, a, this.xL, this.yL)
    const yR = this.cascade(r + this.lastR * fb, a, this.xR, this.yR)
    this.lastL = yL
    this.lastR = yR

    out[0] = l * (1 - mix) + yL * mix
    out[1] = r * (1 - mix) + yR * mix
  }

  process(left: number, right: number): [number, number] {
    this.processInto(left, right, this.scratch)
    return [this.scratch[0], this.scratch[1]]
  }

  reset(): void {
    this.xL.fill(0)
    this.yL.fill(0)
    this.xR.fill(0)
    this.yR.fill(0)
    this.lastL = 0
    this.lastR = 0
    this.phase = 0
    this.depthS.reset(this.tDepth)
    this.fbS.reset(this.tFeedback)
    this.mixS.reset(this.tMix)
  }
}

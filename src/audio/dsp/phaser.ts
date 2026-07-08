/**
 * Phaser — cascaded first-order all-pass stages per channel whose coefficient
 * is swept by an LFO, with feedback from the tapped output to the first stage.
 * Summing dry + phase-shifted signal produces the sweeping notches. The
 * cascade always runs 12 stages; the output is taken from taps after stage
 * 4/8/12 and the tap index is smoothed, so switching stage counts crossfades
 * (~15ms) instead of clicking. Spread offsets the R channel's LFO phase
 * (0..90 degrees) for stereo swirl. Allocation-free hot path.
 *
 * Follows the reference core shape (see drive.ts).
 */
import { clamp, Smoother, TAU } from './util.ts'

const MAX_STAGES = 12
// Tap the cascade after stages 4, 8 and 12 (stage indices 3, 7, 11).
const TAP_A = 3
const TAP_B = 7
const TAP_C = 11

export interface PhaserParams {
  rate: number // 0.05..6 Hz  sweep speed
  depth: number // 0..1  sweep range
  feedback: number // 0..0.9  regeneration
  mix: number // 0..1  dry -> wet
  stages?: number // 0..2  option index into [4, 8, 12] stages
  spread?: number // 0..1 => 0..90 degrees L/R LFO phase offset
}

export class Phaser {
  private readonly sampleRate: number
  private readonly scratch = new Float64Array(2)
  private readonly depthS: Smoother
  private readonly fbS: Smoother
  private readonly mixS: Smoother
  private readonly spreadS: Smoother
  // Smoothed stage-tap index 0..2 — a fractional value blends adjacent taps,
  // which is what makes the stage-count switch click-free.
  private readonly stageS: Smoother
  // per-stage all-pass memory (previous input / output) for each channel
  private readonly xL = new Float64Array(MAX_STAGES)
  private readonly yL = new Float64Array(MAX_STAGES)
  private readonly xR = new Float64Array(MAX_STAGES)
  private readonly yR = new Float64Array(MAX_STAGES)
  // per-sample tap captures (after stage 4/8/12) for each channel
  private readonly tapsL = new Float64Array(3)
  private readonly tapsR = new Float64Array(3)
  // tapped output kept for the feedback path
  private lastL = 0
  private lastR = 0
  // raw targets; depth/feedback/mix/spread smooth per sample, rate drives the phase
  private tRate = 0.4
  private tDepth = 0.7
  private tFeedback = 0.4
  private tMix = 0.5
  private tStages = 0
  private tSpread = 0.5
  private phase = 0

  constructor(sampleRate: number) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100
    this.depthS = new Smoother(this.sampleRate, 0.02, 0.7)
    this.fbS = new Smoother(this.sampleRate, 0.02, 0.4)
    this.mixS = new Smoother(this.sampleRate, 0.02, 0.5)
    this.spreadS = new Smoother(this.sampleRate, 0.02, 0.5)
    this.stageS = new Smoother(this.sampleRate, 0.015, 0)
  }

  setParams({ rate, depth, feedback, mix, stages, spread }: PhaserParams): void {
    this.tRate = clamp(rate, 0.05, 6)
    this.tDepth = clamp(depth, 0, 1)
    this.tFeedback = clamp(feedback, 0, 0.9)
    this.tMix = clamp(mix, 0, 1)
    this.tStages = Math.round(clamp(stages ?? 0, 0, 2))
    this.tSpread = clamp(spread ?? 0.5, 0, 1)
  }

  /**
   * Run one channel's full 12-stage cascade, capturing the 4/8/12-stage taps.
   * xs/ys hold that channel's per-stage memory.
   */
  private cascade(
    input: number,
    a: number,
    xs: Float64Array,
    ys: Float64Array,
    taps: Float64Array,
  ): void {
    let x = input
    for (let i = 0; i < MAX_STAGES; i++) {
      // First-order all-pass: y = a*x + x[n-1] - a*y[n-1].
      let y = a * x + xs[i] - a * ys[i]
      // Flush denormals so a decaying tail can't stall the CPU.
      if (y < 1e-20 && y > -1e-20) y = 0
      xs[i] = x
      ys[i] = y
      x = y
      if (i === TAP_A) taps[0] = x
      else if (i === TAP_B) taps[1] = x
      else if (i === TAP_C) taps[2] = x
    }
  }

  processInto(left: number, right: number, out: Float64Array): void {
    const depth = this.depthS.process(this.tDepth)
    const fb = this.fbS.process(this.tFeedback)
    const mix = this.mixS.process(this.tMix)
    const spread = this.spreadS.process(this.tSpread)
    const st = this.stageS.process(this.tStages)
    const l = Number.isFinite(left) ? left : 0
    const r = Number.isFinite(right) ? right : 0

    this.phase += this.tRate / this.sampleRate
    if (this.phase >= 1) this.phase -= 1
    // Sweep centre frequency 200Hz -> up to 2kHz, scaled by depth. The LFO is
    // phase-continuous and depth/spread are smoothed, so the per-sample
    // coefficient evolves without zipper. spread maps 0..1 to a 0..90 degree
    // phase offset on the right channel.
    const lfoL = 0.5 + 0.5 * Math.sin(TAU * this.phase)
    const lfoR = 0.5 + 0.5 * Math.sin(TAU * (this.phase + spread * 0.25))
    const fcL = 200 + lfoL * depth * 1800
    const fcR = 200 + lfoR * depth * 1800
    // Bilinear all-pass coefficient in (-1, 1), per channel.
    const tL = Math.tan((Math.PI * fcL) / this.sampleRate)
    const aL = (tL - 1) / (tL + 1)
    const tR = Math.tan((Math.PI * fcR) / this.sampleRate)
    const aR = (tR - 1) / (tR + 1)

    this.cascade(l + this.lastL * fb, aL, this.xL, this.yL, this.tapsL)
    this.cascade(r + this.lastR * fb, aR, this.xR, this.yR, this.tapsR)

    // Blend adjacent taps by the smoothed stage index (0..2).
    const i0 = st >= 1 ? 1 : 0
    const frac = clamp(st - i0, 0, 1)
    const yL = this.tapsL[i0] * (1 - frac) + this.tapsL[i0 + 1] * frac
    const yR = this.tapsR[i0] * (1 - frac) + this.tapsR[i0 + 1] * frac
    this.lastL = yL < 1e-20 && yL > -1e-20 ? 0 : yL
    this.lastR = yR < 1e-20 && yR > -1e-20 ? 0 : yR

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
    this.tapsL.fill(0)
    this.tapsR.fill(0)
    this.lastL = 0
    this.lastR = 0
    this.phase = 0
    this.depthS.reset(this.tDepth)
    this.fbS.reset(this.tFeedback)
    this.mixS.reset(this.tMix)
    this.spreadS.reset(this.tSpread)
    this.stageS.reset(this.tStages)
  }
}

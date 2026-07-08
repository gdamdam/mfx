/**
 * Flanger — short swept delay (0.5..8ms) fed back into itself to form a moving
 * comb filter. Classic mode mixes the swept tap against the undelayed dry;
 * Zero mode (through-zero) delays the dry path to the sweep centre and inverts
 * the wet, so when the modulated line crosses the dry's delay the comb cancels
 * dramatically (tape-flange flavour). Spread sets the L/R LFO phase offset
 * (0..90 degrees). Mode blending is a smoothed scalar, so switching never
 * clicks. Allocation-free hot path.
 *
 * Follows the reference core shape (see drive.ts).
 */
import { clamp, Smoother, DelayLine, fastTanh, TAU } from './util.ts'

export interface FlangerParams {
  rate: number // 0.05..6 Hz  sweep speed
  depth: number // 0..1  sweep amount
  feedback: number // 0..0.95  comb resonance
  mix: number // 0..1  dry -> wet
  mode?: number // 0..1  Classic | Zero (through-zero)
  spread?: number // 0..1 => 0..90 degrees L/R LFO phase offset
}

export class Flanger {
  private readonly sampleRate: number
  private readonly scratch = new Float64Array(2)
  private readonly dlL: DelayLine
  private readonly dlR: DelayLine
  // Undelayed input history for the through-zero dry path. Always written so
  // a mode switch crossfades into a warm line instead of a silent one.
  private readonly dryL: DelayLine
  private readonly dryR: DelayLine
  private readonly depthS: Smoother
  private readonly fbS: Smoother
  private readonly mixS: Smoother
  private readonly spreadS: Smoother
  // 0 = Classic, 1 = Zero; smoothed so mode switches crossfade (~15ms).
  private readonly modeS: Smoother
  private readonly minSamples: number
  private readonly rangeSamples: number
  private readonly centerSamples: number
  // raw targets; depth/feedback/mix/spread smooth per sample, rate drives the phase
  private tRate = 0.3
  private tDepth = 0.6
  private tFeedback = 0.5
  private tMix = 0.5
  private tMode = 0
  private tSpread = 0.4
  private phase = 0

  constructor(sampleRate: number) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100
    this.minSamples = (0.5 / 1000) * this.sampleRate
    this.rangeSamples = (7.5 / 1000) * this.sampleRate // reaches 8ms at full depth
    // Sweep centre — the Zero-mode dry path sits here so the modulated line
    // crosses it once per half LFO cycle regardless of depth.
    this.centerSamples = this.minSamples + 0.5 * this.rangeSamples
    const size = Math.ceil((9 / 1000) * this.sampleRate) + 4
    this.dlL = new DelayLine(size)
    this.dlR = new DelayLine(size)
    this.dryL = new DelayLine(size)
    this.dryR = new DelayLine(size)
    this.depthS = new Smoother(this.sampleRate, 0.02, 0.6)
    this.fbS = new Smoother(this.sampleRate, 0.02, 0.5)
    this.mixS = new Smoother(this.sampleRate, 0.02, 0.5)
    this.spreadS = new Smoother(this.sampleRate, 0.02, 0.4)
    this.modeS = new Smoother(this.sampleRate, 0.015, 0)
  }

  setParams({ rate, depth, feedback, mix, mode, spread }: FlangerParams): void {
    this.tRate = clamp(rate, 0.05, 6)
    this.tDepth = clamp(depth, 0, 1)
    this.tFeedback = clamp(feedback, 0, 0.95)
    this.tMix = clamp(mix, 0, 1)
    this.tMode = Math.round(clamp(mode ?? 0, 0, 1))
    this.tSpread = clamp(spread ?? 0.4, 0, 1)
  }

  processInto(left: number, right: number, out: Float64Array): void {
    const depth = this.depthS.process(this.tDepth)
    const fb = this.fbS.process(this.tFeedback)
    const mix = this.mixS.process(this.tMix)
    const spread = this.spreadS.process(this.tSpread)
    const m = this.modeS.process(this.tMode)
    const l = Number.isFinite(left) ? left : 0
    const r = Number.isFinite(right) ? right : 0

    this.phase += this.tRate / this.sampleRate
    if (this.phase >= 1) this.phase -= 1
    // spread maps 0..1 to 0..90 degrees (0..0.25 cycle) between the channels.
    const sinL = Math.sin(TAU * this.phase)
    const sinR = Math.sin(TAU * (this.phase + spread * 0.25))
    // Classic: unipolar sweep so the delay never crosses the safe minimum.
    const dCL = this.minSamples + depth * (0.5 + 0.5 * sinL) * this.rangeSamples
    const dCR = this.minSamples + depth * (0.5 + 0.5 * sinR) * this.rangeSamples
    // Zero: bipolar sweep around the centre — crosses the dry's delay so the
    // inverted sum nulls at the crossing.
    const half = 0.5 * this.rangeSamples
    const dZL = this.centerSamples + depth * half * sinL
    const dZR = this.centerSamples + depth * half * sinR

    // Read the delayed taps first, then write input plus feedback so the comb
    // notches resonate. Zero-mode feedback is soft-limited: the through-zero
    // resonance rings harder near the crossing, and fastTanh keeps the loop
    // bounded at feedback 0.95 without colouring low-level signals.
    const wetCL = this.dlL.read(dCL)
    const wetZL = this.dlL.read(dZL)
    const wetCR = this.dlR.read(dCR)
    const wetZR = this.dlR.read(dZR)
    let fbL = (1 - m) * (wetCL * fb) + m * fastTanh(wetZL * fb)
    let fbR = (1 - m) * (wetCR * fb) + m * fastTanh(wetZR * fb)
    // Flush denormals so a decaying feedback tail can't stall the CPU.
    if (fbL < 1e-20 && fbL > -1e-20) fbL = 0
    if (fbR < 1e-20 && fbR > -1e-20) fbR = 0
    this.dlL.write(l + fbL)
    this.dlR.write(r + fbR)

    const dryTapL = this.dryL.read(this.centerSamples)
    const dryTapR = this.dryR.read(this.centerSamples)
    this.dryL.write(l)
    this.dryR.write(r)

    // Classic mixes against the live dry; Zero mixes the centre-delayed dry
    // against the inverted wet (full cancellation at the crossing when mix=0.5).
    const outCL = l * (1 - mix) + wetCL * mix
    const outCR = r * (1 - mix) + wetCR * mix
    const outZL = dryTapL * (1 - mix) - wetZL * mix
    const outZR = dryTapR * (1 - mix) - wetZR * mix
    out[0] = (1 - m) * outCL + m * outZL
    out[1] = (1 - m) * outCR + m * outZR
  }

  process(left: number, right: number): [number, number] {
    this.processInto(left, right, this.scratch)
    return [this.scratch[0], this.scratch[1]]
  }

  reset(): void {
    this.dlL.reset()
    this.dlR.reset()
    this.dryL.reset()
    this.dryR.reset()
    this.phase = 0
    this.depthS.reset(this.tDepth)
    this.fbS.reset(this.tFeedback)
    this.mixS.reset(this.tMix)
    this.spreadS.reset(this.tSpread)
    this.modeS.reset(this.tMode)
  }
}

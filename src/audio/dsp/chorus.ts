/**
 * Chorus — pitch-modulated delay voices for width and thickness. Three modes:
 * Classic (dual-voice, the original sound), Dimension (shallow sweep with the
 * right wet inverted against the left for calm, mono-cancelling widening) and
 * Ensemble (three detuned voices at 0/120/240 degrees for a string-machine
 * wash). Mode switches crossfade through per-mode gain smoothers so they never
 * click; width pans the wet pair from mono (0) to full spread (1).
 * Allocation-free hot path.
 *
 * Follows the reference core shape (see drive.ts).
 */
import { clamp, Smoother, DelayLine, TAU } from './util.ts'

export interface ChorusParams {
  rate: number // 0.05..8 Hz  LFO speed
  depth: number // 0..1  modulation depth
  mix: number // 0..1  dry -> wet
  mode?: number // 0..2  Classic | Dimension | Ensemble
  width?: number // 0..1  stereo spread of the wet voices
}

// Dimension keeps the sweep very shallow so the widening stays calm (minimal
// pitch warble) even at full depth.
const DIMENSION_DEPTH_SCALE = 0.2
// Ensemble voices run at slightly different rates so the wash never repeats.
const ENSEMBLE_RATE_2 = 1.13
const ENSEMBLE_RATE_3 = 0.87

export class Chorus {
  private readonly sampleRate: number
  private readonly scratch = new Float64Array(2)
  private readonly dlL: DelayLine
  private readonly dlR: DelayLine
  private readonly depthS: Smoother
  private readonly mixS: Smoother
  private readonly widthS: Smoother
  // Per-mode wet gains. Targets are 0/1 indicators and all three share one
  // time constant, so the gains always sum to 1 — a click-free equal-gain
  // crossfade whenever the mode switches.
  private readonly mode0S: Smoother
  private readonly mode1S: Smoother
  private readonly mode2S: Smoother
  // base delay ~16ms, swept +/-9ms => 7..25ms, converted to samples once
  private readonly baseSamples: number
  private readonly swingSamples: number
  // raw targets; depth+mix+width smooth per sample, rate drives the phases
  private tRate = 0.8
  private tDepth = 0.5
  private tMix = 0.5
  private tMode = 0
  private tWidth = 0.7
  private phase = 0
  // Extra accumulators for the detuned ensemble voices. Always advanced so a
  // mode switch lands on a continuous LFO instead of a phase jump.
  private phase2 = 0
  private phase3 = 0

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
    this.widthS = new Smoother(this.sampleRate, 0.02, 0.7)
    this.mode0S = new Smoother(this.sampleRate, 0.015, 1)
    this.mode1S = new Smoother(this.sampleRate, 0.015, 0)
    this.mode2S = new Smoother(this.sampleRate, 0.015, 0)
  }

  setParams({ rate, depth, mix, mode, width }: ChorusParams): void {
    this.tRate = clamp(rate, 0.05, 8)
    this.tDepth = clamp(depth, 0, 1)
    this.tMix = clamp(mix, 0, 1)
    this.tMode = Math.round(clamp(mode ?? 0, 0, 2))
    this.tWidth = clamp(width ?? 0.7, 0, 1)
  }

  processInto(left: number, right: number, out: Float64Array): void {
    const depth = this.depthS.process(this.tDepth)
    const mix = this.mixS.process(this.tMix)
    const width = this.widthS.process(this.tWidth)
    const g0 = this.mode0S.process(this.tMode === 0 ? 1 : 0)
    const g1 = this.mode1S.process(this.tMode === 1 ? 1 : 0)
    const g2 = this.mode2S.process(this.tMode === 2 ? 1 : 0)
    const l = Number.isFinite(left) ? left : 0
    const r = Number.isFinite(right) ? right : 0

    this.dlL.write(l)
    this.dlR.write(r)

    const inc = this.tRate / this.sampleRate
    this.phase += inc
    if (this.phase >= 1) this.phase -= 1
    this.phase2 += inc * ENSEMBLE_RATE_2
    if (this.phase2 >= 1) this.phase2 -= 1
    this.phase3 += inc * ENSEMBLE_RATE_3
    if (this.phase3 >= 1) this.phase3 -= 1

    const swing = depth * this.swingSamples
    let wetL = 0
    let wetR = 0
    if (g0 > 1e-4) {
      // Classic: two voices a half-cycle apart give the detuned shimmer; one
      // voice per channel decorrelates L/R.
      const dA = this.baseSamples + swing * Math.sin(TAU * this.phase)
      const dB = this.baseSamples + swing * Math.sin(TAU * (this.phase + 0.5))
      wetL += g0 * this.dlL.read(dA)
      wetR += g0 * this.dlR.read(dB)
    }
    if (g1 > 1e-4) {
      // Dimension: very shallow sweep, right wet polarity-inverted against
      // the left, so the wet lives in the side channel — wide and calm even
      // at high depth, and it folds away cleanly in mono.
      const dimSwing = swing * DIMENSION_DEPTH_SCALE
      const dL = this.baseSamples + dimSwing * Math.sin(TAU * this.phase)
      const dR = this.baseSamples + dimSwing * Math.sin(TAU * (this.phase + 0.5))
      wetL += g1 * this.dlL.read(dL)
      wetR -= g1 * this.dlR.read(dR)
    }
    if (g2 > 1e-4) {
      // Ensemble: three voices at 0/120/240 degrees on detuned rates; outer
      // voices feed the sides, the third is shared in the centre. The 0.8
      // factor keeps the three-voice sum near unity level.
      const d1 = this.baseSamples + swing * Math.sin(TAU * this.phase)
      const d2 = this.baseSamples + swing * Math.sin(TAU * (this.phase2 + 1 / 3))
      const d3 = this.baseSamples + swing * Math.sin(TAU * (this.phase3 + 2 / 3))
      wetL += g2 * 0.8 * (this.dlL.read(d1) + 0.5 * this.dlL.read(d3))
      wetR += g2 * 0.8 * (this.dlR.read(d2) + 0.5 * this.dlR.read(d3))
    }

    // Width as mid/side on the wet pair: 0 collapses the wet to mono (L==R),
    // 1 keeps the full voice spread.
    const midW = 0.5 * (wetL + wetR)
    const sideW = 0.5 * (wetL - wetR)
    const wl = midW + width * sideW
    const wr = midW - width * sideW

    out[0] = l * (1 - mix) + wl * mix
    out[1] = r * (1 - mix) + wr * mix
  }

  process(left: number, right: number): [number, number] {
    this.processInto(left, right, this.scratch)
    return [this.scratch[0], this.scratch[1]]
  }

  reset(): void {
    this.dlL.reset()
    this.dlR.reset()
    this.phase = 0
    this.phase2 = 0
    this.phase3 = 0
    this.depthS.reset(this.tDepth)
    this.mixS.reset(this.tMix)
    this.widthS.reset(this.tWidth)
    this.mode0S.reset(this.tMode === 0 ? 1 : 0)
    this.mode1S.reset(this.tMode === 1 ? 1 : 0)
    this.mode2S.reset(this.tMode === 2 ? 1 : 0)
  }
}

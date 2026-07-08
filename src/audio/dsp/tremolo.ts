/**
 * Tremolo — amplitude modulation by an LFO whose shape morphs from sine to
 * square. Three modes: Classic (both channels share one gain — pure amplitude
 * movement), Harmonic (low/high bands modulated in antiphase, the brownface
 * shimmer) and Pan (equal-power auto-pan). Allocation-free hot path.
 *
 * Follows the reference core shape (see drive.ts).
 */
import { clamp, Smoother, OnePoleLP, TAU } from './util.ts'

// Pre-normalised so the softened square peaks at unity like the raw sine.
// tanh of a sine has finite edge slope, so the square is inherently
// slew-limited — no clicks even at 16 Hz / shape 1.
const SQUARE_DRIVE = 6
const SQUARE_NORM = 1 / Math.tanh(SQUARE_DRIVE)
// Harmonic-mode crossover. One-pole split (low = lp(x), high = x - low) is
// exactly complementary, so the bands sum back to unity at depth 0.
const XOVER_HZ = 800
const HALF_PI = Math.PI / 2
const SQRT2 = Math.SQRT2

export interface TremoloParams {
  rate: number // 0.1..16 Hz  LFO speed
  depth: number // 0..1  0 = no effect, 1 = full modulation
  shape: number // 0..1  sine -> square
  mode?: number // 0..2  Classic / Harmonic / Pan
}

export class Tremolo {
  private readonly sampleRate: number
  private readonly scratch = new Float64Array(2)
  private readonly depthS: Smoother
  private readonly shapeS: Smoother
  // Short equal-length crossfade between the previous and current mode output
  // so a mode switch never clicks.
  private readonly xfS: Smoother
  private readonly lpL = new OnePoleLP()
  private readonly lpR = new OnePoleLP()
  // raw targets; depth+shape smooth per sample, rate drives the phase accumulator
  private tRate = 5
  private tDepth = 0.6
  private tShape = 0
  private phase = 0
  private modeCur = 0
  private modePrev = 0
  // per-sample mode output, written by applyMode (fields, not an array, so the
  // hot path stays allocation-free)
  private mOutL = 0
  private mOutR = 0

  constructor(sampleRate: number) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100
    this.depthS = new Smoother(this.sampleRate, 0.02, 0.6)
    this.shapeS = new Smoother(this.sampleRate, 0.02, 0)
    this.xfS = new Smoother(this.sampleRate, 0.008, 1)
    this.lpL.setCutoff(this.sampleRate, XOVER_HZ)
    this.lpR.setCutoff(this.sampleRate, XOVER_HZ)
  }

  setParams({ rate, depth, shape, mode }: TremoloParams): void {
    this.tRate = clamp(rate, 0.1, 16)
    this.tDepth = clamp(depth, 0, 1)
    this.tShape = clamp(shape, 0, 1)
    const m = typeof mode === 'number' && Number.isFinite(mode) ? Math.round(clamp(mode, 0, 2)) : 0
    if (m !== this.modeCur) {
      this.modePrev = this.modeCur
      this.modeCur = m
      this.xfS.reset(0)
    }
  }

  /** Compute one mode's stereo output into mOutL/mOutR (no allocation). */
  private applyMode(
    mode: number,
    l: number,
    r: number,
    lowL: number,
    lowR: number,
    lfo: number,
    depth: number,
  ): void {
    if (mode === 1) {
      // Harmonic: low band dips while the high band swells (antiphase LFOs).
      const gLow = 1 - depth * (0.5 - 0.5 * lfo)
      const gHigh = 1 - depth * (0.5 + 0.5 * lfo)
      this.mOutL = lowL * gLow + (l - lowL) * gHigh
      this.mOutR = lowR * gLow + (r - lowR) * gHigh
    } else if (mode === 2) {
      // Pan: equal-power law, gL²+gR² constant. sqrt(2) restores unity at
      // center so depth 0 is a true passthrough.
      const p = 0.5 + 0.5 * lfo * depth
      this.mOutL = l * (SQRT2 * Math.cos(p * HALF_PI))
      this.mOutR = r * (SQRT2 * Math.sin(p * HALF_PI))
    } else {
      // Classic: shared gain window, depth 1 dips fully to silence.
      const g = 1 - depth * (0.5 - 0.5 * lfo)
      this.mOutL = l * g
      this.mOutR = r * g
    }
  }

  processInto(left: number, right: number, out: Float64Array): void {
    const depth = this.depthS.process(this.tDepth)
    const shape = this.shapeS.process(this.tShape)
    const l = Number.isFinite(left) ? left : 0
    const r = Number.isFinite(right) ? right : 0

    this.phase += this.tRate / this.sampleRate
    if (this.phase >= 1) this.phase -= 1

    const sine = Math.sin(TAU * this.phase)
    // tanh drive rounds a sine toward a square; blend by shape.
    const square = Math.tanh(sine * SQUARE_DRIVE) * SQUARE_NORM
    const lfo = sine * (1 - shape) + square * shape

    // The crossover filters run every sample regardless of mode so switching
    // into Harmonic starts from warm state instead of a click.
    const lowL = this.lpL.process(l)
    const lowR = this.lpR.process(r)

    if (this.modePrev !== this.modeCur) {
      const xf = this.xfS.process(1)
      this.applyMode(this.modePrev, l, r, lowL, lowR, lfo, depth)
      const pL = this.mOutL
      const pR = this.mOutR
      this.applyMode(this.modeCur, l, r, lowL, lowR, lfo, depth)
      out[0] = pL + (this.mOutL - pL) * xf
      out[1] = pR + (this.mOutR - pR) * xf
      if (xf > 0.9995) this.modePrev = this.modeCur
    } else {
      this.applyMode(this.modeCur, l, r, lowL, lowR, lfo, depth)
      out[0] = this.mOutL
      out[1] = this.mOutR
    }
  }

  process(left: number, right: number): [number, number] {
    this.processInto(left, right, this.scratch)
    return [this.scratch[0], this.scratch[1]]
  }

  reset(): void {
    this.phase = 0
    this.depthS.reset(this.tDepth)
    this.shapeS.reset(this.tShape)
    this.lpL.reset(0)
    this.lpR.reset(0)
    this.modePrev = this.modeCur
    this.xfS.reset(1)
  }
}

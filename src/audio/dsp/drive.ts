/**
 * Drive — soft-clip overdrive blending into hard distortion, with a tilt tone
 * control and output level. Pure, deterministic, allocation-free hot path.
 *
 * This is the reference core: every effect follows this shape — a params
 * interface, a `setParams` that clamps, a `processInto(l, r, out)` with no
 * allocation, a `process` test convenience, and `reset`.
 */
import { clamp, Smoother } from './util.ts'

// Slope-matched normalization reference: dividing by tanh(g/2) alone gave ~2.16x
// small-signal gain at drive=0; scaling by tanh(1/2) restores unity there.
const NORM_REF = Math.tanh(0.5)

export interface DriveParams {
  drive: number // 0..1
  tone: number // 0..1  (dark -> bright tilt)
  level: number // 0..1  output trim
}

export class Drive {
  private readonly sampleRate: number
  private readonly scratch = new Float64Array(2)
  private readonly driveS: Smoother
  private readonly toneS: Smoother
  private readonly levelS: Smoother
  // raw targets, set per block; smoothers converge per sample in processInto
  private tDrive = 0.4
  private tTone = 0.55
  private tLevel = 0.85
  // one-pole low-pass state per channel for the tone tilt
  private lpL = 0
  private lpR = 0

  constructor(sampleRate: number) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100
    this.driveS = new Smoother(this.sampleRate, 0.02, 0.4)
    this.toneS = new Smoother(this.sampleRate, 0.02, 0.55)
    this.levelS = new Smoother(this.sampleRate, 0.02, 0.85)
  }

  setParams({ drive, tone, level }: DriveParams): void {
    this.tDrive = clamp(drive, 0, 1)
    this.tTone = clamp(tone, 0, 1)
    this.tLevel = clamp(level, 0, 1)
  }

  private shape(x: number, gain: number): number {
    // tanh-style soft clip; gain scales pre-distortion drive 1..~40
    const g = 1 + gain * 39
    const y = Math.tanh(x * g)
    // normalize so the small-signal gain is 1 at drive=0 (g=1): the extra
    // NORM_REF factor cancels the built-in makeup gain the old form introduced.
    return (y * NORM_REF) / Math.tanh(g * 0.5 + 1e-6)
  }

  processInto(left: number, right: number, out: Float64Array): void {
    const drive = this.driveS.process(this.tDrive)
    const tone = this.toneS.process(this.tTone)
    const level = this.levelS.process(this.tLevel)

    // tone: interpolate one-pole LP cutoff coefficient by brightness
    const cutoff = 400 + tone * 12000
    const coeff = Math.exp((-2 * Math.PI * cutoff) / this.sampleRate)

    // Guard non-finite input: a single NaN sample would latch the lp state
    // forever (feedback never clears), silencing the whole rack until reset().
    const inL = Number.isFinite(left) ? left : 0
    const inR = Number.isFinite(right) ? right : 0

    let l = this.shape(inL, drive)
    let r = this.shape(inR, drive)

    this.lpL = l * (1 - coeff) + this.lpL * coeff
    this.lpR = r * (1 - coeff) + this.lpR * coeff
    // Flush denormals (no FTZ in JS) to avoid CPU spikes as the lp state decays.
    if (this.lpL < 1e-20 && this.lpL > -1e-20) this.lpL = 0
    if (this.lpR < 1e-20 && this.lpR > -1e-20) this.lpR = 0
    // blend darkened (lp) with bright (raw) by tone
    l = this.lpL * (1 - tone) + l * tone
    r = this.lpR * (1 - tone) + r * tone

    out[0] = l * level
    out[1] = r * level
  }

  process(left: number, right: number): [number, number] {
    this.processInto(left, right, this.scratch)
    return [this.scratch[0], this.scratch[1]]
  }

  reset(): void {
    this.lpL = 0
    this.lpR = 0
  }
}

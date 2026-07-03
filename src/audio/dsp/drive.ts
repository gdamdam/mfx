/**
 * Drive — soft-clip overdrive blending into hard distortion, with a tilt tone
 * control and output level. Pure, deterministic, allocation-free hot path.
 *
 * This is the reference core: every effect follows this shape — a params
 * interface, a `setParams` that clamps, a `processInto(l, r, out)` with no
 * allocation, a `process` test convenience, and `reset`.
 */
import { clamp, Smoother } from './util.ts'

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
    // normalize so low drive stays near unity
    return y / Math.tanh(g * 0.5 + 1e-6)
  }

  processInto(left: number, right: number, out: Float64Array): void {
    const drive = this.driveS.process(this.tDrive)
    const tone = this.toneS.process(this.tTone)
    const level = this.levelS.process(this.tLevel)

    // tone: interpolate one-pole LP cutoff coefficient by brightness
    const cutoff = 400 + tone * 12000
    const coeff = Math.exp((-2 * Math.PI * cutoff) / this.sampleRate)

    let l = this.shape(left, drive)
    let r = this.shape(right, drive)

    this.lpL = l * (1 - coeff) + this.lpL * coeff
    this.lpR = r * (1 - coeff) + this.lpR * coeff
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

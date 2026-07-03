/**
 * Delay — stereo feedback delay with optional tempo sync. Pure, deterministic,
 * allocation-free hot path (mirrors drive.ts shape).
 *
 * WHY the delay time is slewed: writing to a fractional-delay line while the
 * read distance jumps causes an audible pitch glide / zipper. A one-pole slew
 * on the *time in seconds* keeps sweeps smooth and click-free, so we smooth the
 * effective time (free or beat-derived) rather than snapping it per block.
 */
import { clamp, Smoother, DelayLine } from './util.ts'

export interface DelayParams {
  time: number // 0.02..1.5 seconds (free-run time)
  feedback: number // 0..0.95
  mix: number // 0..1 dry/wet
  sync: number // 0..1 (>=0.5 => tempo-synced)
  division: number // 0..4 index into note divisions
}

// Factor of a quarter note per division index. Kept in sync with contracts:
// ['1/4', '1/8', '1/8.', '1/16', '1/8T'].
const DIVISION_FACTORS = [1, 0.5, 0.75, 0.25, 1 / 3] as const

export class Delay {
  private readonly sampleRate: number
  private readonly scratch = new Float64Array(2)
  private readonly lineL: DelayLine
  private readonly lineR: DelayLine
  private readonly maxSamples: number
  // Slewed delay time in seconds; slower time (0.05s) so pitch artifacts on a
  // knob move stay gentle rather than chirpy.
  private readonly timeS: Smoother
  private readonly fbS: Smoother
  private readonly mixS: Smoother
  // raw targets set per block
  private tTime = 0.3
  private tFeedback = 0.4
  private tMix = 0.35
  private tSync = 0
  private tDivision = 1
  private bpm = 120

  constructor(sampleRate: number) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100
    // Max buffer covers the full 1.5s range plus interpolation headroom.
    this.maxSamples = Math.ceil(1.5 * this.sampleRate) + 4
    this.lineL = new DelayLine(this.maxSamples)
    this.lineR = new DelayLine(this.maxSamples)
    this.timeS = new Smoother(this.sampleRate, 0.05, 0.3)
    this.fbS = new Smoother(this.sampleRate, 0.02, 0.4)
    this.mixS = new Smoother(this.sampleRate, 0.02, 0.35)
  }

  setParams({ time, feedback, mix, sync, division }: DelayParams): void {
    this.tTime = clamp(time, 0.02, 1.5)
    this.tFeedback = clamp(feedback, 0, 0.95)
    this.tMix = clamp(mix, 0, 1)
    this.tSync = clamp(sync, 0, 1)
    this.tDivision = clamp(division, 0, 4)
  }

  /** Store the current tempo (clamped) for beat-synced delay times. */
  setTempo(bpm: number): void {
    this.bpm = clamp(bpm, 20, 300)
  }

  /**
   * Effective target delay in seconds. When synced, derive it from tempo and
   * the note division; otherwise use the free-run time. Result is clamped to
   * the valid time range so a fast tempo can't demand a sub-minimum delay.
   */
  private effectiveTimeSec(): number {
    if (this.tSync >= 0.5) {
      const beatSec = 60 / this.bpm
      const idx = Math.round(clamp(this.tDivision, 0, 4))
      return clamp(beatSec * DIVISION_FACTORS[idx], 0.02, 1.5)
    }
    return this.tTime
  }

  processInto(left: number, right: number, out: Float64Array): void {
    const l = Number.isFinite(left) ? left : 0
    const r = Number.isFinite(right) ? right : 0
    const timeSec = this.timeS.process(this.effectiveTimeSec())
    const fb = this.fbS.process(this.tFeedback)
    const mix = this.mixS.process(this.tMix)

    // Convert to samples; keep >=1 so the read never lands on the write head.
    const ds = clamp(timeSec * this.sampleRate, 1, this.maxSamples - 1)
    const wetL = this.lineL.read(ds)
    const wetR = this.lineR.read(ds)

    // Feed input + attenuated feedback back into the line (fb<1 => stable).
    this.lineL.write(l + wetL * fb)
    this.lineR.write(r + wetR * fb)

    out[0] = l * (1 - mix) + wetL * mix
    out[1] = r * (1 - mix) + wetR * mix
  }

  process(left: number, right: number): [number, number] {
    this.processInto(left, right, this.scratch)
    return [this.scratch[0], this.scratch[1]]
  }

  reset(): void {
    this.lineL.reset()
    this.lineR.reset()
    this.timeS.reset(this.effectiveTimeSec())
    this.fbS.reset(this.tFeedback)
    this.mixS.reset(this.tMix)
  }
}

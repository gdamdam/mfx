/**
 * TapeDelay — saturated stereo tape echo with wow/flutter, tape age tone loss,
 * a second playback head, and optional tempo sync. Pure, deterministic,
 * allocation-free hot path (mirrors delay.ts shape).
 *
 * WHY the loop is shaped this way: real tape loops never explode — the medium
 * saturates. We map feedback 0..1 to a loop gain of 0..~1.05 *into* fastTanh,
 * so past ~0.95 the loop self-oscillates musically while tanh keeps it bounded.
 * Drive into the saturator rises gently with feedback so hot loops bloom into
 * compression instead of clipping abruptly. Age filtering (HF rolloff + low
 * cut) sits inside the loop so every repeat gets progressively darker, like
 * worn tape.
 */
import {
  clamp,
  lerp,
  Smoother,
  DelayLine,
  OnePoleLP,
  OnePoleHP,
  fastTanh,
  TAU,
} from './util.ts'

export interface TapeDelayParams {
  time: number // 0.03..1.5 seconds (free-run time)
  feedback: number // 0..1 (maps to loop gain 0..~1.05 into the saturator)
  mix: number // 0..1 dry/wet
  wow: number // 0..1 wow+flutter depth
  age: number // 0..1 tape wear (darker + low cut as it rises)
  spread: number // 0..1 second head ('Heads') level + stereo pan
  sync: number // 0..1 (>=0.5 => tempo-synced)
  division: number // 0..4 index into note divisions
}

// Factor of a quarter note per division index. Kept in sync with contracts:
// ['1/4', '1/8', '1/8.', '1/16', '1/8T'].
const DIVISION_FACTORS = [1, 0.5, 0.75, 0.25, 1 / 3] as const

const WOW_HZ = 0.4
const FLUTTER_HZ = 5.7
const WOW_DEPTH_SEC = 0.006 // up to ~6 ms of slow drift
const FLUTTER_DEPTH_SEC = 0.001 // up to ~1 ms of fast shimmer
const HEAD_RATIO = 0.62 // second head reads at 0.62x the main time
// Initial LFO phases (in cycles) — slightly different per channel so the wow
// decorrelates L/R without any randomness. reset() restores them.
const WOW_PHASE_L = 0
const WOW_PHASE_R = 0.31
const FLUTTER_PHASE_L = 0.12
const FLUTTER_PHASE_R = 0.57

export class TapeDelay {
  private readonly sampleRate: number
  private readonly scratch = new Float64Array(2)
  private readonly lineL: DelayLine
  private readonly lineR: DelayLine
  private readonly maxSamples: number
  // Slewed delay time in seconds; slower than delay.ts (~80 ms) so knob moves
  // give tape-style pitch bends rather than chirps.
  private readonly timeS: Smoother
  private readonly fbS: Smoother
  private readonly mixS: Smoother
  private readonly wowS: Smoother
  private readonly spreadS: Smoother
  // Age tone shaping lives inside the feedback loop (one pair per channel).
  private readonly lpL = new OnePoleLP()
  private readonly lpR = new OnePoleLP()
  private readonly hpL = new OnePoleHP()
  private readonly hpR = new OnePoleHP()
  // LFO phases in cycles [0, 1)
  private wowPhL = WOW_PHASE_L
  private wowPhR = WOW_PHASE_R
  private flPhL = FLUTTER_PHASE_L
  private flPhR = FLUTTER_PHASE_R
  // raw targets set per block
  private tTime = 0.35
  private tFeedback = 0.45
  private tMix = 0.35
  private tWow = 0.3
  private tSpread = 0.5
  private tSync = 0
  private tDivision = 1
  private bpm = 120

  constructor(sampleRate: number) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100
    // Max buffer covers the full 1.5s range plus wow excursion + interp headroom.
    this.maxSamples = Math.ceil((1.5 + WOW_DEPTH_SEC + FLUTTER_DEPTH_SEC) * this.sampleRate) + 4
    this.lineL = new DelayLine(this.maxSamples)
    this.lineR = new DelayLine(this.maxSamples)
    this.timeS = new Smoother(this.sampleRate, 0.08, 0.35)
    this.fbS = new Smoother(this.sampleRate, 0.02, 0.45)
    this.mixS = new Smoother(this.sampleRate, 0.02, 0.35)
    this.wowS = new Smoother(this.sampleRate, 0.02, 0.3)
    this.spreadS = new Smoother(this.sampleRate, 0.02, 0.5)
    this.applyAge(0.4)
  }

  /** Cutoffs derive from age; recomputed at block rate (setParams) only. */
  private applyAge(age: number): void {
    const lpHz = lerp(8000, 2500, age) // fresh tape rolls off gently, worn tape is dark
    const hpHz = lerp(5, 150, age) // worn tape also loses lows
    this.lpL.setCutoff(this.sampleRate, lpHz)
    this.lpR.setCutoff(this.sampleRate, lpHz)
    this.hpL.setCutoff(this.sampleRate, hpHz)
    this.hpR.setCutoff(this.sampleRate, hpHz)
  }

  setParams({ time, feedback, mix, wow, age, spread, sync, division }: TapeDelayParams): void {
    this.tTime = clamp(time, 0.03, 1.5)
    this.tFeedback = clamp(feedback, 0, 1)
    this.tMix = clamp(mix, 0, 1)
    this.tWow = clamp(wow, 0, 1)
    this.tSpread = clamp(spread, 0, 1)
    this.tSync = clamp(sync, 0, 1)
    this.tDivision = clamp(division, 0, 4)
    this.applyAge(clamp(age, 0, 1))
  }

  /** Store the current tempo (clamped) for beat-synced delay times. */
  setTempo(bpm: number): void {
    this.bpm = clamp(bpm, 20, 300)
  }

  /**
   * Effective target delay in seconds. When synced, derive it from tempo and
   * the note division; otherwise use the free-run time (mirrors delay.ts).
   */
  private effectiveTimeSec(): number {
    if (this.tSync >= 0.5) {
      const beatSec = 60 / this.bpm
      const idx = Math.round(clamp(this.tDivision, 0, 4))
      return clamp(beatSec * DIVISION_FACTORS[idx], 0.03, 1.5)
    }
    return this.tTime
  }

  processInto(left: number, right: number, out: Float64Array): void {
    const l = Number.isFinite(left) ? left : 0
    const r = Number.isFinite(right) ? right : 0
    const timeSec = this.timeS.process(this.effectiveTimeSec())
    const fb = this.fbS.process(this.tFeedback)
    const mix = this.mixS.process(this.tMix)
    const wow = this.wowS.process(this.tWow)
    const spread = this.spreadS.process(this.tSpread)

    // Deterministic wow + flutter LFOs; the slewed base time plus sinusoidal
    // modulation means the read distance never jumps (no zipper).
    this.wowPhL += WOW_HZ / this.sampleRate
    this.wowPhR += WOW_HZ / this.sampleRate
    this.flPhL += FLUTTER_HZ / this.sampleRate
    this.flPhR += FLUTTER_HZ / this.sampleRate
    if (this.wowPhL >= 1) this.wowPhL -= 1
    if (this.wowPhR >= 1) this.wowPhR -= 1
    if (this.flPhL >= 1) this.flPhL -= 1
    if (this.flPhR >= 1) this.flPhR -= 1
    const modL =
      wow * (WOW_DEPTH_SEC * Math.sin(TAU * this.wowPhL) + FLUTTER_DEPTH_SEC * Math.sin(TAU * this.flPhL))
    const modR =
      wow * (WOW_DEPTH_SEC * Math.sin(TAU * this.wowPhR) + FLUTTER_DEPTH_SEC * Math.sin(TAU * this.flPhR))

    const dsL = clamp((timeSec + modL) * this.sampleRate, 1, this.maxSamples - 1)
    const dsR = clamp((timeSec + modR) * this.sampleRate, 1, this.maxSamples - 1)
    const mainL = this.lineL.read(dsL)
    const mainR = this.lineR.read(dsR)
    const headL = this.lineL.read(dsL * HEAD_RATIO)
    const headR = this.lineR.read(dsR * HEAD_RATIO)

    // Feedback path: age tone filters -> gentle drive -> tanh, per repeat.
    // Normalizing by drive keeps small-signal loop gain equal to loopGain, so
    // drive only sets how soon the loop compresses ("blooms"), not its level.
    const loopGain = fb * 1.05
    const drive = 1 + fb * 1.6
    const fbL = fastTanh(this.lpL.process(this.hpL.process(mainL)) * loopGain * drive) / drive
    const fbR = fastTanh(this.lpR.process(this.hpR.process(mainR)) * loopGain * drive) / drive
    this.lineL.write(l + fbL)
    this.lineR.write(r + fbR)

    // Heads: main head pans left by `spread`, second head opposite, both
    // equal-power. Gains normalized so spread=0 leaves the main head at unity.
    const thMain = ((1 - spread) * Math.PI) / 4
    const thHead = ((1 + spread) * Math.PI) / 4
    const headLvl = spread // second head fades in with spread
    const wetL = (mainL * Math.cos(thMain) + headL * headLvl * Math.cos(thHead)) * Math.SQRT2
    const wetR = (mainR * Math.sin(thMain) + headR * headLvl * Math.sin(thHead)) * Math.SQRT2

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
    this.lpL.reset()
    this.lpR.reset()
    this.hpL.reset()
    this.hpR.reset()
    this.wowPhL = WOW_PHASE_L
    this.wowPhR = WOW_PHASE_R
    this.flPhL = FLUTTER_PHASE_L
    this.flPhR = FLUTTER_PHASE_R
    this.timeS.reset(this.effectiveTimeSec())
    this.fbS.reset(this.tFeedback)
    this.mixS.reset(this.tMix)
    this.wowS.reset(this.tWow)
    this.spreadS.reset(this.tSpread)
  }
}

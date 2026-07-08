/**
 * Delay — stereo feedback delay with optional tempo sync, three routing modes
 * (Stereo / Pong / Reverse), a feedback-loop tone filter, input-driven wet
 * ducking and subtle tape-ish time modulation. Pure, deterministic,
 * allocation-free hot path (mirrors drive.ts shape).
 *
 * WHY the delay time is slewed: writing to a fractional-delay line while the
 * read distance jumps causes an audible pitch glide / zipper. A one-pole slew
 * on the *time in seconds* keeps sweeps smooth and click-free, so we smooth the
 * effective time (free or beat-derived) rather than snapping it per block.
 */
import { clamp, Smoother, DelayLine, OnePoleLP, OnePoleHP, TAU } from './util.ts'

export interface DelayParams {
  time: number // 0.02..1.5 seconds (free-run time)
  feedback: number // 0..0.95
  mix: number // 0..1 dry/wet
  sync: number // 0..1 (>=0.5 => tempo-synced)
  division: number // 0..4 index into note divisions
  mode?: number // 0..2 Stereo / Pong / Reverse
  tone?: number // 0..1 feedback tone: 0 dark (LP), 0.5 flat, 1 thin (HP)
  duck?: number // 0..1 input-envelope wet attenuation
  mod?: number // 0..1 tape-ish delay-time LFO depth
}

// Factor of a quarter note per division index. Kept in sync with contracts:
// ['1/4', '1/8', '1/8.', '1/16', '1/8T'].
const DIVISION_FACTORS = [1, 0.5, 0.75, 0.25, 1 / 3] as const
// Around tone 0.5 the filters are hard-bypassed so "neutral" is truly flat.
const TONE_EPS = 1e-3
const MOD_RATE_HZ = 0.4
const MOD_DEPTH_SEC = 0.004

/** Optional/NaN param -> spec default, so old callers keep today's sound. */
function finiteOr(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

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
  // Wet gain ramp used for click-free mode switching: dip to zero, swap the
  // routing, ramp back up.
  private readonly rampS: Smoother
  private readonly duckGS: Smoother
  private readonly modAmtS: Smoother
  // Feedback-loop tone filters. Both run every sample (even when bypassed) so
  // engaging the tone control starts from warm state.
  private readonly lpL = new OnePoleLP()
  private readonly lpR = new OnePoleLP()
  private readonly hpL = new OnePoleHP()
  private readonly hpR = new OnePoleHP()
  private readonly envAtk: number
  private readonly envRel: number
  // raw targets set per block
  private tTime = 0.3
  private tFeedback = 0.4
  private tMix = 0.35
  private tSync = 0
  private tDivision = 1
  private tMode = 0
  private tDuck = 0
  private tModDepth = 0
  private toneMode = 0 // -1 lowpass, 0 bypass-flat, +1 highpass
  private modeCur = 0
  private env = 0
  private modPhase = 0
  private revPhase = 0
  private bpm = 120

  constructor(sampleRate: number) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100
    // Reverse mode reads up to 2x the delay time behind the write head, so the
    // buffer covers twice the 1.5s range plus interpolation headroom.
    this.maxSamples = Math.ceil(3 * this.sampleRate) + 8
    this.lineL = new DelayLine(this.maxSamples)
    this.lineR = new DelayLine(this.maxSamples)
    this.timeS = new Smoother(this.sampleRate, 0.05, 0.3)
    this.fbS = new Smoother(this.sampleRate, 0.02, 0.4)
    this.mixS = new Smoother(this.sampleRate, 0.02, 0.35)
    this.rampS = new Smoother(this.sampleRate, 0.002, 1)
    this.duckGS = new Smoother(this.sampleRate, 0.02, 1)
    this.modAmtS = new Smoother(this.sampleRate, 0.05, 0)
    // Ducking envelope: fast attack tracks hits, slow release recovers
    // smoothly (no pumping at moderate settings).
    this.envAtk = 1 - Math.exp(-1 / (0.005 * this.sampleRate))
    this.envRel = 1 - Math.exp(-1 / (0.2 * this.sampleRate))
  }

  setParams({ time, feedback, mix, sync, division, mode, tone, duck, mod }: DelayParams): void {
    this.tTime = clamp(time, 0.02, 1.5)
    this.tFeedback = clamp(feedback, 0, 0.95)
    this.tMix = clamp(mix, 0, 1)
    this.tSync = clamp(sync, 0, 1)
    this.tDivision = clamp(division, 0, 4)
    this.tMode = Math.round(clamp(finiteOr(mode, 0), 0, 2))
    this.tDuck = clamp(finiteOr(duck, 0), 0, 1)
    this.tModDepth = clamp(finiteOr(mod, 0), 0, 1)
    const t = clamp(finiteOr(tone, 0.5), 0, 1)
    if (t < 0.5 - TONE_EPS) {
      // Log sweep: barely-audible LP just under neutral down to ~800 Hz at 0.
      this.toneMode = -1
      const cut = 800 * Math.pow(18000 / 800, t * 2)
      this.lpL.setCutoff(this.sampleRate, cut)
      this.lpR.setCutoff(this.sampleRate, cut)
    } else if (t > 0.5 + TONE_EPS) {
      // Log sweep: near-DC HP just over neutral up to ~2 kHz at 1.
      this.toneMode = 1
      const cut = 20 * Math.pow(2000 / 20, (t - 0.5) * 2)
      this.hpL.setCutoff(this.sampleRate, cut)
      this.hpR.setCutoff(this.sampleRate, cut)
    } else {
      this.toneMode = 0
    }
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

  /** Tone filter, left channel. Runs both filters to keep state warm. */
  private filterL(x: number): number {
    const lp = this.lpL.process(x)
    const hp = this.hpL.process(x)
    return this.toneMode < 0 ? lp : this.toneMode > 0 ? hp : x
  }

  private filterR(x: number): number {
    const lp = this.lpR.process(x)
    const hp = this.hpR.process(x)
    return this.toneMode < 0 ? lp : this.toneMode > 0 ? hp : x
  }

  processInto(left: number, right: number, out: Float64Array): void {
    const l = Number.isFinite(left) ? left : 0
    const r = Number.isFinite(right) ? right : 0
    const timeSec = this.timeS.process(this.effectiveTimeSec())
    const fb = this.fbS.process(this.tFeedback)
    const mix = this.mixS.process(this.tMix)

    // Tape-ish movement: slow sine LFO on the read distance. Depth is smoothed
    // so engaging/disengaging never zippers; at 0 the offset is exactly 0.
    const modAmt = this.modAmtS.process(this.tModDepth)
    this.modPhase += MOD_RATE_HZ / this.sampleRate
    if (this.modPhase >= 1) this.modPhase -= 1
    const modOffset = modAmt * MOD_DEPTH_SEC * Math.sin(TAU * this.modPhase)

    // Convert to samples; keep >=1 so the read never lands on the write head.
    const ds = clamp((timeSec + modOffset) * this.sampleRate, 1, this.maxSamples - 1)

    // Ducking: one-pole envelope on the input peak drives the wet gain down.
    const inMag = Math.abs(l) > Math.abs(r) ? Math.abs(l) : Math.abs(r)
    this.env += (inMag > this.env ? this.envAtk : this.envRel) * (inMag - this.env)
    if (this.env < 1e-20) this.env = 0
    const envNorm = this.env * 1.6 > 1 ? 1 : this.env * 1.6
    const duckG = this.duckGS.process(1 - this.tDuck * envNorm)

    // Click-free mode switch: dip the wet gain, swap routing at the bottom.
    let ramp: number
    if (this.modeCur !== this.tMode) {
      ramp = this.rampS.process(0)
      if (ramp < 0.01) {
        this.modeCur = this.tMode
        this.revPhase = 0
      }
    } else {
      ramp = this.rampS.process(1)
    }

    let wetL: number
    let wetR: number
    if (this.modeCur === 2) {
      // Reverse: two read heads half a chunk apart sweep backward over the
      // recent buffer (read distance grows at 2 samples/sample => reversed
      // playback), each windowed with a sin ramp for an equal-power splice.
      const n = ds > 64 ? ds : 64
      this.revPhase += 1 / n
      if (this.revPhase >= 1) this.revPhase -= 1
      const p1 = this.revPhase
      const p2 = p1 + 0.5 - Math.floor(p1 + 0.5)
      const g1 = Math.sin(Math.PI * p1)
      const g2 = Math.sin(Math.PI * p2)
      const d1 = 2 * n * p1
      const d2 = 2 * n * p2
      wetL = this.lineL.read(d1) * g1 + this.lineL.read(d2) * g2
      wetR = this.lineR.read(d1) * g1 + this.lineR.read(d2) * g2
      this.lineL.write(l + this.filterL(wetL) * fb)
      this.lineR.write(r + this.filterR(wetR) * fb)
    } else if (this.modeCur === 1) {
      // Pong: mono input feeds L; L feeds R; R feeds back to L.
      const m = (l + r) * 0.5
      wetL = this.lineL.read(ds)
      wetR = this.lineR.read(ds)
      const fL = this.filterL(wetL)
      const fR = this.filterR(wetR)
      this.lineL.write(m + fR * fb)
      this.lineR.write(fL * fb)
    } else {
      // Stereo: independent per-channel feedback (today's default behavior).
      wetL = this.lineL.read(ds)
      wetR = this.lineR.read(ds)
      this.lineL.write(l + this.filterL(wetL) * fb)
      this.lineR.write(r + this.filterR(wetR) * fb)
    }

    // At defaults duckG and ramp are pinned at exactly 1, so the wet gain
    // reduces to plain `mix` and the output matches the legacy path bit-exact.
    const wetG = mix * duckG * ramp
    out[0] = l * (1 - mix) + wetL * wetG
    out[1] = r * (1 - mix) + wetR * wetG
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
    this.rampS.reset(1)
    this.duckGS.reset(1)
    this.modAmtS.reset(this.tModDepth)
    this.lpL.reset(0)
    this.lpR.reset(0)
    this.hpL.reset()
    this.hpR.reset()
    this.modeCur = this.tMode
    this.env = 0
    this.modPhase = 0
    this.revPhase = 0
  }
}

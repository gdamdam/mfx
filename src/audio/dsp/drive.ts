/**
 * Drive — soft-clip overdrive blending into hard distortion, with a tilt tone
 * control, output level and selectable clipping character (voice). Pure,
 * deterministic, allocation-free hot path.
 *
 * This is the reference core: every effect follows this shape — a params
 * interface, a `setParams` that clamps, a `processInto(l, r, out)` with no
 * allocation, a `process` test convenience, and `reset`.
 *
 * WHY 2x oversampling around the shaper only: hard-edged curves (Hard, Fold)
 * fold their upper harmonics back below Nyquist. Upsampling by linear interp,
 * shaping both subsamples and decimating with a [1,2,1]/4 halfband kills the
 * worst of that aliasing while the (linear) tone/level stages stay at 1x.
 */
import { clamp, DcBlocker, OnePoleLP, Smoother } from './util.ts'

// Slope-matched normalization reference: dividing by tanh(g/2) alone gave ~2.16x
// small-signal gain at drive=0; scaling by tanh(1/2) restores unity there.
const NORM_REF = Math.tanh(0.5)

// Static bias offsets for the asymmetric voices, subtracted so silence maps to
// exactly 0 (signal-dependent DC is handled by the per-channel DcBlocker).
const TUBE_BIAS = 0.22
const TUBE_OFFSET = Math.tanh(TUBE_BIAS)
const GERM_BIAS = 0.25
const GERM_OFFSET = Math.tanh(GERM_BIAS)

const CHAR_MAX = 6 // [Soft, Hard, Tube, Tape, Germ, Si, Fold]
const CHAR_TAPE = 3

export interface DriveParams {
  drive: number // 0..1
  tone: number // 0..1  (dark -> bright tilt)
  level: number // 0..1  output trim
  character?: number // 0..6 voice index; omitted => 0 (Soft, legacy curve)
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
  // Character crossfade: ~10ms equal-gain fade between the outgoing and
  // incoming voice so automation never clicks. fade==1 means settled on charTo.
  private charFrom = 0
  private charTo = 0
  private charFade = 1
  private readonly fadeStep: number
  // 2x oversampling state: previous input (for the interpolated midpoint
  // subsample) and previous shaped subsample (halfband decimator history).
  private prevInL = 0
  private prevInR = 0
  private osL = 0
  private osR = 0
  // Tape voice HF rolloff; always processed so a crossfade lands on warm state.
  private readonly tapeLpL = new OnePoleLP()
  private readonly tapeLpR = new OnePoleLP()
  // Asymmetric voices (Tube, Germ) rectify — block the resulting DC.
  private readonly dcL = new DcBlocker()
  private readonly dcR = new DcBlocker()

  constructor(sampleRate: number) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100
    this.driveS = new Smoother(this.sampleRate, 0.02, 0.4)
    this.toneS = new Smoother(this.sampleRate, 0.02, 0.55)
    this.levelS = new Smoother(this.sampleRate, 0.02, 0.85)
    this.fadeStep = 1 / (0.01 * this.sampleRate)
    this.tapeLpL.setCutoff(this.sampleRate, 6000)
    this.tapeLpR.setCutoff(this.sampleRate, 6000)
  }

  setParams({ drive, tone, level, character = 0 }: DriveParams): void {
    this.tDrive = clamp(drive, 0, 1)
    this.tTone = clamp(tone, 0, 1)
    this.tLevel = clamp(level, 0, 1)
    const c = Math.round(clamp(character, 0, CHAR_MAX))
    if (c !== this.charTo) {
      if (this.charFade < 1 && c === this.charFrom) {
        // reverse an in-flight fade in place — no jump at all
        this.charFrom = this.charTo
        this.charFade = 1 - this.charFade
      } else {
        // retarget: the (possibly partial) old destination becomes the source
        this.charFrom = this.charTo
        this.charFade = 0
      }
      this.charTo = c
    }
  }

  /** Memoryless base curves; u is the pre-gained input, output roughly [-1,1]. */
  private shapeChar(c: number, u: number): number {
    switch (c) {
      case 1: // Hard — brick clip edge
        return u < -1 ? -1 : u > 1 ? 1 : u
      case 2: // Tube — gentle asymmetric bias => even harmonics
        return Math.tanh(u + TUBE_BIAS) - TUBE_OFFSET
      case 3: // Tape — compressive knee (HF rolloff is blended in post)
        return u / (1 + Math.abs(u))
      case 4: // Germ — saggy asymmetric fuzz knee (generic germanium flavour)
        return Math.tanh(u * (u >= 0 ? 0.8 : 1.3) + GERM_BIAS) - GERM_OFFSET
      case 5: {
        // Si — tighter symmetric fuzz clip
        const v = u * 1.5
        return v / Math.sqrt(1 + v * v)
      }
      case 6: {
        // Fold — reflect peaks back down (triangle fold, identity on [-1,1])
        let t = (u + 1) * 0.25
        t -= Math.floor(t)
        return 1 - Math.abs(4 * t - 2)
      }
      default: // Soft — the legacy tanh curve, bit-compatible at character=0
        return Math.tanh(u)
    }
  }

  /** Crossfaded shaper (both voices evaluated only while a fade is running). */
  private shapeXf(u: number): number {
    const f = this.charFade
    const b = this.shapeChar(this.charTo, u)
    if (f >= 1) return b
    return this.shapeChar(this.charFrom, u) * (1 - f) + b * f
  }

  processInto(left: number, right: number, out: Float64Array): void {
    const drive = this.driveS.process(this.tDrive)
    const tone = this.toneS.process(this.tTone)
    const level = this.levelS.process(this.tLevel)

    // advance the ~10ms character crossfade
    let fade = this.charFade
    if (fade < 1) {
      fade += this.fadeStep
      if (fade >= 1) {
        fade = 1
        this.charFrom = this.charTo
      }
      this.charFade = fade
    }

    // gain scales pre-distortion drive 1..~40; normalize so the small-signal
    // gain is 1 at drive=0 (g=1): the extra NORM_REF factor cancels the
    // built-in makeup gain the old form introduced. The same post-scale also
    // level-compensates the hotter voices (Fold especially).
    const g = 1 + drive * 39
    const k = NORM_REF / Math.tanh(g * 0.5 + 1e-6)

    // tone: interpolate one-pole LP cutoff coefficient by brightness
    const cutoff = 400 + tone * 12000
    const coeff = Math.exp((-2 * Math.PI * cutoff) / this.sampleRate)

    // Guard non-finite input: a single NaN sample would latch the lp state
    // forever (feedback never clears), silencing the whole rack until reset().
    const inL = Number.isFinite(left) ? left : 0
    const inR = Number.isFinite(right) ? right : 0

    // 2x oversampled shaping: subsample A is the linear-interp midpoint of the
    // previous and current input, subsample B is the current input. Decimate
    // with a causal [1,2,1]/4 halfband (previous B, A, B).
    const sAL = k * this.shapeXf(0.5 * (this.prevInL + inL) * g)
    const sBL = k * this.shapeXf(inL * g)
    const sAR = k * this.shapeXf(0.5 * (this.prevInR + inR) * g)
    const sBR = k * this.shapeXf(inR * g)
    let l = 0.25 * this.osL + 0.5 * sAL + 0.25 * sBL
    let r = 0.25 * this.osR + 0.5 * sAR + 0.25 * sBR
    this.osL = sBL
    this.osR = sBR
    this.prevInL = inL
    this.prevInR = inR

    // Tape voice: mild HF rolloff that deepens with drive. Blending filtered
    // against raw keeps every other voice bit-transparent while the filters
    // stay warm for a click-free crossfade into Tape.
    const tapeLpOutL = this.tapeLpL.process(l)
    const tapeLpOutR = this.tapeLpR.process(r)
    const wTape =
      (this.charFrom === CHAR_TAPE ? 1 - fade : 0) + (this.charTo === CHAR_TAPE ? fade : 0)
    if (wTape > 0) {
      const amt = wTape * (0.25 + 0.75 * drive)
      l += (tapeLpOutL - l) * amt
      r += (tapeLpOutR - r) * amt
    }

    // DC-compensate the asymmetric voices (transparent ~5 Hz corner otherwise).
    l = this.dcL.process(l)
    r = this.dcR.process(r)

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
    this.prevInL = 0
    this.prevInR = 0
    this.osL = 0
    this.osR = 0
    this.charFrom = this.charTo
    this.charFade = 1
    this.tapeLpL.reset(0)
    this.tapeLpR.reset(0)
    this.dcL.reset()
    this.dcR.reset()
  }
}

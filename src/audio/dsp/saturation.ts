/**
 * Saturation — multi-voice harmonic coloration (Tape / Tube / Xfmr / Console /
 * Clip). Pure, deterministic, allocation-free hot path (mirrors drive.ts shape).
 *
 * All voicings share one normalized core, y = fastTanh(k*x) / k, whose
 * small-signal gain is exactly 1 for any k — so amount=0 (k -> ~0) is
 * near-transparent by construction instead of by compensation tables. Each
 * voice differs in how hard k rises with amount, its pre/post filtering, and
 * its bias:
 *   Tape    — compressive knee plus amount-blended HF loss (one-pole LP).
 *   Tube    — biased (asymmetric) transfer for even harmonics; the static
 *             operating point fastTanh(k*b) is subtracted and a DcBlocker
 *             removes the remaining signal-dependent DC.
 *   Xfmr    — low-shelf pre-emphasis drives the lows into the shaper harder,
 *             with the matching inverse shelf after, so the *harmonics* thicken
 *             while the frequency balance stays roughly flat.
 *   Console — very low drive gain: subtle odd-harmonic bus glue.
 *   Clip    — clean symmetric fastTanh soft clip.
 *
 * WHY 2x oversampling: the biased/hard voices have sharp transfer curvature,
 * and their upper harmonics fold at the base rate. Linear-interp upsampling +
 * a 2-tap average down keeps the worst aliases ~nulled at Nyquist for a few
 * multiplies — enough for one-pole-grade duty here.
 *
 * Type switches crossfade over ~30ms (both voices run during the fade) so a
 * discrete option change never clicks. Level maps 0..1 -> 0..1.25x gain, so
 * the 0.8 default sits at exactly unity with headroom above (drive.ts-style
 * trim, but with the default-unity anchor the transparency contract needs).
 *
 * WHY a decaying continuity correction on type change: only ONE outgoing voice
 * (prevType) is retained during a fade, so a SECOND switch before the fade
 * finishes would snap prevType to the new "from" voice and jump the audible
 * output (the current blend) to that single voice — a click. Instead, at the
 * instant a fade (re)starts we capture the jump between the last emitted wet
 * sample and this sample's fade origin as a per-channel offset (corrL/corrR)
 * and add it back scaled by (1 - xfade), so it decays to zero exactly as the
 * new fade completes. Output is thus continuous through arbitrarily rapid
 * switches with no extra voice, no state accumulation, and no allocation. For
 * a switch from steady state the correction is ~0, so transparency is intact.
 */
import { clamp, Smoother, OnePoleLP, DcBlocker, fastTanh, TAU } from './util.ts'

export interface SaturationParams {
  amount: number // 0..1
  type: number // 0..4 [Tape, Tube, Xfmr, Console, Clip]
  tone: number // 0..1 tilt (0 dark, 0.5 flat, 1 bright)
  mix: number // 0..1 dry/wet
  level: number // 0..1 output trim (0.8 = unity, 1 = +1.9dB)
}

// Floor for the drive coefficient: keeps the /k normalization finite while
// making fastTanh(k*x)/k indistinguishable from identity at amount=0.
const K_EPS = 1e-3
// level knob 0..1 -> 0..1.25 gain: default 0.8 lands exactly on unity.
const LEVEL_MAX = 1.25
const NUM_TYPES = 5

export class Saturation {
  private readonly sampleRate: number
  private readonly scratch = new Float64Array(2)
  private readonly amountS: Smoother
  private readonly toneS: Smoother
  private readonly mixS: Smoother
  private readonly levelS: Smoother
  // raw targets, set per block; smoothers converge per sample in processInto
  private tAmount = 0.35
  private tTone = 0.5
  private tMix = 1
  private tLevel = 0.8
  // discrete voice selection with short crossfade on change
  private curType = 0
  private prevType = 0
  private xfade = 1 // 0..1; <1 means a type crossfade is in progress
  private readonly xfadeStep: number
  // Continuity correction for mid-fade re-triggers (see header). Captured when
  // a fade restarts, added scaled by (1-xfade) so it decays over the fade.
  private fadeRestart = false
  private corrL = 0
  private corrR = 0
  // Last emitted wet-blend sample per channel (the fade-origin reference).
  private lastWetL = 0
  private lastWetR = 0
  // previous shaper-input sample per voice per channel (for 2x linear upsample)
  private readonly prevInL = new Float64Array(NUM_TYPES)
  private readonly prevInR = new Float64Array(NUM_TYPES)
  // per-voice filter state
  private readonly tapeLpL = new OnePoleLP()
  private readonly tapeLpR = new OnePoleLP()
  private readonly tubeDcL = new DcBlocker()
  private readonly tubeDcR = new DcBlocker()
  private readonly xfmrPreL = new OnePoleLP()
  private readonly xfmrPreR = new OnePoleLP()
  private readonly xfmrPostL = new OnePoleLP()
  private readonly xfmrPostR = new OnePoleLP()
  // tone tilt: one-pole LP pivot per channel
  private readonly toneCoeffA: number
  private toneLpL = 0
  private toneLpR = 0
  // voiceInto writes here (no tuple allocation in the hot path)
  private vL = 0
  private vR = 0

  constructor(sampleRate: number) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100
    this.amountS = new Smoother(this.sampleRate, 0.02, 0.35)
    this.toneS = new Smoother(this.sampleRate, 0.02, 0.5)
    this.mixS = new Smoother(this.sampleRate, 0.02, 1)
    this.levelS = new Smoother(this.sampleRate, 0.02, 0.8)
    this.xfadeStep = 1 / (0.03 * this.sampleRate)
    this.tapeLpL.setCutoff(this.sampleRate, 6500)
    this.tapeLpR.setCutoff(this.sampleRate, 6500)
    this.xfmrPreL.setCutoff(this.sampleRate, 150)
    this.xfmrPreR.setCutoff(this.sampleRate, 150)
    this.xfmrPostL.setCutoff(this.sampleRate, 150)
    this.xfmrPostR.setCutoff(this.sampleRate, 150)
    // tilt pivot ~1kHz
    this.toneCoeffA = 1 - Math.exp((-TAU * 1000) / this.sampleRate)
  }

  setParams({ amount, type, tone, mix, level }: SaturationParams): void {
    this.tAmount = clamp(amount, 0, 1)
    this.tTone = clamp(tone, 0, 1)
    this.tMix = clamp(mix, 0, 1)
    this.tLevel = clamp(level, 0, 1)
    const t = Math.round(clamp(type, 0, NUM_TYPES - 1))
    if (t !== this.curType) {
      // start a short crossfade from the old voice to the new one
      this.prevType = this.curType
      this.curType = t
      this.xfade = 0
      // Signal processInto to capture the continuity offset on the next sample
      // so a mid-fade switch resumes from the currently audible blend.
      this.fadeRestart = true
    }
  }

  /**
   * One voice, both channels: optional pre-filter, 2x-oversampled shaper
   * (linear-interp up, 2-tap average down), makeup gain, optional post-filter.
   * Writes to this.vL / this.vR.
   */
  private voiceInto(type: number, l: number, r: number, a: number): void {
    const pl = this.prevInL
    const pr = this.prevInR
    switch (type) {
      case 0: {
        // Tape: moderate compressive knee + amount-blended HF loss.
        const k = K_EPS + 5 * a
        const makeup = (1 + a) / k
        let yl = 0.5 * (fastTanh(k * 0.5 * (pl[0] + l)) + fastTanh(k * l)) * makeup
        let yr = 0.5 * (fastTanh(k * 0.5 * (pr[0] + r)) + fastTanh(k * r)) * makeup
        pl[0] = l
        pr[0] = r
        const hf = 0.6 * a
        yl += (this.tapeLpL.process(yl) - yl) * hf
        yr += (this.tapeLpR.process(yr) - yr) * hf
        this.vL = yl
        this.vR = yr
        return
      }
      case 1: {
        // Tube: bias into the knee for even harmonics; subtract the static
        // operating point, then DC-block the signal-dependent remainder.
        const k = K_EPS + 4 * a
        const b = 0.2 * a
        const dc = fastTanh(k * b)
        const makeup = (1 + a) / k
        const yl =
          0.5 * (fastTanh(k * (0.5 * (pl[1] + l) + b)) - dc + (fastTanh(k * (l + b)) - dc)) * makeup
        const yr =
          0.5 * (fastTanh(k * (0.5 * (pr[1] + r) + b)) - dc + (fastTanh(k * (r + b)) - dc)) * makeup
        pl[1] = l
        pr[1] = r
        this.vL = this.tubeDcL.process(yl)
        this.vR = this.tubeDcR.process(yr)
        return
      }
      case 2: {
        // Xfmr: low-shelf pre-emphasis (1 + B*LP) drives the lows into the
        // shaper harder; the inverse shelf (1 - B/(1+B)*LP) after restores a
        // ~flat response, leaving low-frequency harmonic thickening behind.
        const B = 1.2 * a
        const k = K_EPS + 4 * a
        const makeup = (1 + 0.8 * a) / k
        const xel = l + B * this.xfmrPreL.process(l)
        const xer = r + B * this.xfmrPreR.process(r)
        let yl = 0.5 * (fastTanh(k * 0.5 * (pl[2] + xel)) + fastTanh(k * xel)) * makeup
        let yr = 0.5 * (fastTanh(k * 0.5 * (pr[2] + xer)) + fastTanh(k * xer)) * makeup
        pl[2] = xel
        pr[2] = xer
        const inv = B / (1 + B)
        yl -= inv * this.xfmrPostL.process(yl)
        yr -= inv * this.xfmrPostR.process(yr)
        this.vL = yl
        this.vR = yr
        return
      }
      case 3: {
        // Console: very low drive — subtle odd-harmonic glue, slight makeup.
        const k = K_EPS + 1.2 * a
        const makeup = (1 + 0.2 * a) / k
        this.vL = 0.5 * (fastTanh(k * 0.5 * (pl[3] + l)) + fastTanh(k * l)) * makeup
        this.vR = 0.5 * (fastTanh(k * 0.5 * (pr[3] + r)) + fastTanh(k * r)) * makeup
        pl[3] = l
        pr[3] = r
        return
      }
      default: {
        // Clip: clean symmetric fastTanh soft clip, hardest drive range.
        const k = K_EPS + 9 * a
        const makeup = (1 + 2 * a) / k
        this.vL = 0.5 * (fastTanh(k * 0.5 * (pl[4] + l)) + fastTanh(k * l)) * makeup
        this.vR = 0.5 * (fastTanh(k * 0.5 * (pr[4] + r)) + fastTanh(k * r)) * makeup
        pl[4] = l
        pr[4] = r
      }
    }
  }

  processInto(left: number, right: number, out: Float64Array): void {
    const a = this.amountS.process(this.tAmount)
    const tone = this.toneS.process(this.tTone)
    const mix = this.mixS.process(this.tMix)
    const level = this.levelS.process(this.tLevel)

    // Guard non-finite input so a single bad sample cannot latch filter state.
    const l = Number.isFinite(left) ? left : 0
    const r = Number.isFinite(right) ? right : 0

    this.voiceInto(this.curType, l, r, a)
    let wetL = this.vL
    let wetR = this.vR
    if (this.xfade < 1) {
      // Type change in progress: run the outgoing voice too and crossfade.
      const xf = this.xfade
      this.voiceInto(this.prevType, l, r, a)
      wetL = this.vL + (wetL - this.vL) * xf
      wetR = this.vR + (wetR - this.vR) * xf
      // On a (re)start, capture the step between the last audible blend and this
      // sample's fade origin; adding it back below (scaled by 1-xf, so it is
      // full here at xf=0 and gone at xf=1) makes the switch continuous even if
      // a previous fade was still in progress.
      if (this.fadeRestart) {
        this.corrL = this.lastWetL - wetL
        this.corrR = this.lastWetR - wetR
        this.fadeRestart = false
      }
      wetL += this.corrL * (1 - xf)
      wetR += this.corrR * (1 - xf)
      this.xfade = Math.min(1, xf + this.xfadeStep)
    }
    this.lastWetL = wetL
    this.lastWetR = wetR

    // Tone tilt around ~1kHz: y = gLow*lp + gHigh*(y - lp). At tone=0.5 both
    // gains are exactly 1 so the stage reconstructs y verbatim (truly flat).
    const d = (tone - 0.5) * 2
    const gLow = 1 - 0.7 * d
    const gHigh = 1 + 0.7 * d
    this.toneLpL += this.toneCoeffA * (wetL - this.toneLpL)
    this.toneLpR += this.toneCoeffA * (wetR - this.toneLpR)
    // Flush denormals (no FTZ in JS) as the tilt LP state decays.
    if (this.toneLpL < 1e-20 && this.toneLpL > -1e-20) this.toneLpL = 0
    if (this.toneLpR < 1e-20 && this.toneLpR > -1e-20) this.toneLpR = 0
    wetL = this.toneLpL * gLow + (wetL - this.toneLpL) * gHigh
    wetR = this.toneLpR * gLow + (wetR - this.toneLpR) * gHigh

    const gain = level * LEVEL_MAX
    out[0] = (l * (1 - mix) + wetL * mix) * gain
    out[1] = (r * (1 - mix) + wetR * mix) * gain
  }

  process(left: number, right: number): [number, number] {
    this.processInto(left, right, this.scratch)
    return [this.scratch[0], this.scratch[1]]
  }

  reset(): void {
    this.amountS.reset(this.tAmount)
    this.toneS.reset(this.tTone)
    this.mixS.reset(this.tMix)
    this.levelS.reset(this.tLevel)
    this.prevInL.fill(0)
    this.prevInR.fill(0)
    this.xfade = 1
    this.fadeRestart = false
    this.corrL = 0
    this.corrR = 0
    this.lastWetL = 0
    this.lastWetR = 0
    this.tapeLpL.reset()
    this.tapeLpR.reset()
    this.tubeDcL.reset()
    this.tubeDcR.reset()
    this.xfmrPreL.reset()
    this.xfmrPreR.reset()
    this.xfmrPostL.reset()
    this.xfmrPostR.reset()
    this.toneLpL = 0
    this.toneLpR = 0
  }
}

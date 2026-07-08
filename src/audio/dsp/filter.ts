/**
 * Filter — four models behind one cutoff/reso/type interface:
 *   0 SVF    — TPT (zero-delay-feedback) state-variable filter. Unconditionally
 *              stable to Nyquist (see the original Chamberlin note below).
 *   1 Ladder — generic textbook 4-cascaded-one-pole lowpass with resonance
 *              feedback and a fastTanh nonlinearity in the loop. The tanh keeps
 *              the loop bounded so self-oscillation at max reso stays musical.
 *   2 Diode  — darker/creamier ladder variant: lowpassed feedback path plus
 *              inter-stage soft clipping and a lowered per-stage cutoff.
 *   3 Comb   — tuned feedback comb; freq maps to loop delay (sr/freq samples).
 *
 * WHY TPT rather than Chamberlin for the SVF: the classic Chamberlin SVF is
 * only stable for cutoffs well below Nyquist, which forced a ~0.18*fs cap and
 * left the top half of the freq knob dead. The trapezoidal TPT form
 * (Zavalishin / Cytomic) is unconditionally stable up to Nyquist.
 *
 * WHY cutoff smoothing runs in the log domain: a linear-Hz smoother sweeps
 * perceptually fast at the bottom and crawls at the top; smoothing ln(freq)
 * gives a constant-rate musical glide across the whole range.
 *
 * WHY model switches crossfade: each model keeps its own state, so a hard swap
 * steps the output. On a switch the incoming model starts from cleared state
 * and both models run for ~10ms while a linear fade hands over — click-free.
 *
 * Follows the reference core shape (see drive.ts).
 */
import { clamp, lerp, Smoother, DelayLine, fastTanh, TAU } from './util.ts'

export interface FilterParams {
  freq: number // 30..18000 Hz
  reso: number // 0..1  -> Q / feedback amount
  type: number // 0..3 rounds to 0=LP, 1=BP, 2=HP, 3=NT (notch)
  // Optional (spec defaults) so pre-existing 3-param callers keep compiling.
  model?: number // 0..3 rounds to 0=SVF, 1=Ladder, 2=Diode, 3=Comb
  drive?: number // 0..1 input saturation into the model nonlinearity
}

export class Filter {
  private readonly sampleRate: number
  private readonly maxFreq: number
  private readonly scratch = new Float64Array(2)
  // freq smooths per sample in the log domain; drive smooths linearly.
  private readonly freqS: Smoother
  private readonly driveS: Smoother
  // raw targets; reso/type/model resolve at block rate
  private tLnFreq = Math.log(1200)
  private tReso = 0.2
  private tType = 0
  private tDrive = 0
  // Model crossfade state: on a switch both models run for ~10ms.
  private curModel = 0
  private prevModel = 0
  private fadePos = 1
  private readonly fadeInc: number
  // Scratch outputs written by the per-model runners (no allocation).
  private moL = 0
  private moR = 0
  // --- SVF (TPT) integrator state, one pair per channel ---
  private ic1L = 0
  private ic2L = 0
  private ic1R = 0
  private ic2R = 0
  // --- Ladder one-pole cascade state ---
  private laL1 = 0
  private laL2 = 0
  private laL3 = 0
  private laL4 = 0
  private laR1 = 0
  private laR2 = 0
  private laR3 = 0
  private laR4 = 0
  // --- Diode cascade state + lowpassed feedback state ---
  private diL1 = 0
  private diL2 = 0
  private diL3 = 0
  private diL4 = 0
  private diR1 = 0
  private diR2 = 0
  private diR3 = 0
  private diR4 = 0
  private diFbL = 0
  private diFbR = 0
  // --- Comb delay lines + loop damping state ---
  private readonly combL: DelayLine
  private readonly combR: DelayLine
  private readonly combSize: number
  private combDampL = 0
  private combDampR = 0

  constructor(sampleRate: number) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100
    // TPT is stable to Nyquist; only keep the param-contract ceiling and a small
    // margin below Nyquist for exotic (low) sample rates.
    this.maxFreq = Math.min(18000, this.sampleRate * 0.49)
    this.freqS = new Smoother(this.sampleRate, 0.02, Math.log(1200))
    this.driveS = new Smoother(this.sampleRate, 0.02, 0)
    this.fadeInc = 1 / Math.max(1, 0.01 * this.sampleRate)
    // Comb loop covers the lowest cutoff (30Hz) plus interpolation headroom.
    this.combSize = Math.ceil(this.sampleRate / 30) + 4
    this.combL = new DelayLine(this.combSize)
    this.combR = new DelayLine(this.combSize)
  }

  setParams({ freq, reso, type, model = 0, drive = 0 }: FilterParams): void {
    this.tLnFreq = Math.log(clamp(freq, 30, 18000))
    this.tReso = clamp(reso, 0, 1)
    // type/model are discrete indices; round then clamp to the valid range
    this.tType = Math.round(clamp(type, 0, 3))
    this.tDrive = clamp(drive, 0, 1)
    const m = Math.round(clamp(model, 0, 3))
    if (m !== this.curModel) {
      // Hand over click-free: fade from the running model to the new one,
      // starting the new one from cleared state (stale state would replay
      // whatever it held the last time that model ran).
      this.prevModel = this.curModel
      this.curModel = m
      this.fadePos = 0
      this.resetModel(m)
    }
  }

  /** Clear one model's state (block rate only — never in the hot path). */
  private resetModel(m: number): void {
    if (m === 0) {
      this.ic1L = this.ic2L = this.ic1R = this.ic2R = 0
    } else if (m === 1) {
      this.laL1 = this.laL2 = this.laL3 = this.laL4 = 0
      this.laR1 = this.laR2 = this.laR3 = this.laR4 = 0
    } else if (m === 2) {
      this.diL1 = this.diL2 = this.diL3 = this.diL4 = 0
      this.diR1 = this.diR2 = this.diR3 = this.diR4 = 0
      this.diFbL = this.diFbR = 0
    } else {
      this.combL.reset()
      this.combR.reset()
      this.combDampL = this.combDampR = 0
    }
  }

  /** Drive stage: blend clean -> saturated so drive=0 is bit-transparent. */
  private sat(x: number, drive: number): number {
    if (drive <= 0) return x
    return x + drive * (fastTanh(x * (1 + 7 * drive)) - x)
  }

  private runSvf(l: number, r: number, fc: number, drive: number): void {
    const xl = this.sat(l, drive)
    const xr = this.sat(r, drive)
    // TPT prewarped integrator gain and 1/Q damping. reso -> low damping k
    // (sharper resonant peak); a1/a2/a3 solve the zero-delay feedback.
    const g = Math.tan((Math.PI * fc) / this.sampleRate)
    const k = lerp(1, 0.05, this.tReso)
    const a1 = 1 / (1 + g * (g + k))
    const a2 = g * a1
    const a3 = g * a2

    const v3L = xl - this.ic2L
    const v1L = a1 * this.ic1L + a2 * v3L
    const v2L = this.ic2L + a2 * this.ic1L + a3 * v3L
    this.ic1L = 2 * v1L - this.ic1L
    this.ic2L = 2 * v2L - this.ic2L

    const v3R = xr - this.ic2R
    const v1R = a1 * this.ic1R + a2 * v3R
    const v2R = this.ic2R + a2 * this.ic1R + a3 * v3R
    this.ic1R = 2 * v1R - this.ic1R
    this.ic2R = 2 * v2R - this.ic2R

    const t = this.tType
    if (t === 0) {
      this.moL = v2L
      this.moR = v2R
    } else if (t === 1) {
      this.moL = v1L
      this.moR = v1R
    } else if (t === 2) {
      this.moL = xl - k * v1L - v2L
      this.moR = xr - k * v1R - v2R
    } else {
      // Notch = low + high (input minus the resonant band).
      this.moL = xl - k * v1L
      this.moR = xr - k * v1R
    }
  }

  private runLadder(l: number, r: number, fc: number, drive: number): void {
    // Per-stage one-pole coefficient; k is the resonance feedback around the
    // whole cascade (k=4 reaches self-oscillation, bounded by the tanh).
    const a = 1 - Math.exp((-TAU * fc) / this.sampleRate)
    const k = this.tReso * 4
    const inGain = 1 + drive * 8
    // Full compensation of the resonance-induced passband loss: the DC loop
    // solves s4*(1+k)=x, so scaling the lowpass by (1+k) restores unity.
    const comp = 1 + k

    const uL = fastTanh(l * inGain - k * this.laL4)
    this.laL1 += a * (uL - this.laL1)
    this.laL2 += a * (this.laL1 - this.laL2)
    this.laL3 += a * (this.laL2 - this.laL3)
    this.laL4 += a * (this.laL3 - this.laL4)
    if (this.laL4 < 1e-20 && this.laL4 > -1e-20) this.laL4 = 0

    const uR = fastTanh(r * inGain - k * this.laR4)
    this.laR1 += a * (uR - this.laR1)
    this.laR2 += a * (this.laR1 - this.laR2)
    this.laR3 += a * (this.laR2 - this.laR3)
    this.laR4 += a * (this.laR3 - this.laR4)
    if (this.laR4 < 1e-20 && this.laR4 > -1e-20) this.laR4 = 0

    const t = this.tType
    if (t === 0) {
      this.moL = this.laL4 * comp
      this.moR = this.laR4 * comp
    } else if (t === 1) {
      // Band approximation: difference of stages (2-pole skirt each side).
      this.moL = (this.laL2 - this.laL4) * 3
      this.moR = (this.laR2 - this.laR4) * 3
    } else if (t === 2) {
      // High approximation: input minus the DC-compensated lowpass.
      this.moL = l - this.laL4 * comp
      this.moR = r - this.laR4 * comp
    } else {
      // Notch approximation: input minus the band.
      this.moL = l - (this.laL2 - this.laL4) * 3
      this.moR = r - (this.laR2 - this.laR4) * 3
    }
  }

  private runDiode(l: number, r: number, fc: number, drive: number): void {
    // Darker: stages tuned below the nominal cutoff. Creamier: the feedback is
    // lowpassed (diode-chain coupling loses highs) and every stage soft-clips.
    const a = 1 - Math.exp((-TAU * fc * 0.6) / this.sampleRate)
    const k = this.tReso * 3.5
    const inGain = 1 + drive * 8
    const comp = 1 + k

    this.diFbL += a * (this.diL4 - this.diFbL)
    if (this.diFbL < 1e-20 && this.diFbL > -1e-20) this.diFbL = 0
    const uL = fastTanh(l * inGain - k * this.diFbL)
    this.diL1 += a * (uL - this.diL1)
    this.diL2 += a * (fastTanh(1.2 * this.diL1) - this.diL2)
    this.diL3 += a * (fastTanh(1.2 * this.diL2) - this.diL3)
    this.diL4 += a * (fastTanh(1.2 * this.diL3) - this.diL4)
    if (this.diL4 < 1e-20 && this.diL4 > -1e-20) this.diL4 = 0

    this.diFbR += a * (this.diR4 - this.diFbR)
    if (this.diFbR < 1e-20 && this.diFbR > -1e-20) this.diFbR = 0
    const uR = fastTanh(r * inGain - k * this.diFbR)
    this.diR1 += a * (uR - this.diR1)
    this.diR2 += a * (fastTanh(1.2 * this.diR1) - this.diR2)
    this.diR3 += a * (fastTanh(1.2 * this.diR2) - this.diR3)
    this.diR4 += a * (fastTanh(1.2 * this.diR3) - this.diR4)
    if (this.diR4 < 1e-20 && this.diR4 > -1e-20) this.diR4 = 0

    const t = this.tType
    if (t === 0) {
      this.moL = this.diL4 * comp
      this.moR = this.diR4 * comp
    } else if (t === 1) {
      this.moL = (this.diL2 - this.diL4) * 3
      this.moR = (this.diR2 - this.diR4) * 3
    } else if (t === 2) {
      this.moL = l - this.diL4 * comp
      this.moR = r - this.diR4 * comp
    } else {
      this.moL = l - (this.diL2 - this.diL4) * 3
      this.moR = r - (this.diR2 - this.diR4) * 3
    }
  }

  private runComb(l: number, r: number, fc: number, drive: number): void {
    // Tuned comb: loop delay = sr/freq so the resonance sits at the cutoff.
    // Type selects the loop flavor:
    //   LP -> positive feedback with a damped (lowpassed) loop: warm, dark
    //   BP -> positive feedback, undamped: bright resonator at freq harmonics
    //   HP -> negative feedback: hollow odd-harmonic series, nulls DC
    //   NT -> feedforward notch (out = in - delayed) over a lightly damped loop
    const d = clamp(this.sampleRate / fc, 2, this.combSize - 2)
    const fb = this.tReso * 0.95
    const t = this.tType
    const xl = this.sat(l, drive)
    const xr = this.sat(r, drive)

    const dl = this.combL.read(d)
    const dr = this.combR.read(d)
    // One-pole damping in the loop (fixed coefficient — musical darkening).
    this.combDampL += 0.4 * (dl - this.combDampL)
    if (this.combDampL < 1e-20 && this.combDampL > -1e-20) this.combDampL = 0
    this.combDampR += 0.4 * (dr - this.combDampR)
    if (this.combDampR < 1e-20 && this.combDampR > -1e-20) this.combDampR = 0

    let wL: number
    let wR: number
    if (t === 0) {
      wL = xl + fb * this.combDampL
      wR = xr + fb * this.combDampR
      this.moL = wL
      this.moR = wR
    } else if (t === 1) {
      wL = xl + fb * dl
      wR = xr + fb * dr
      this.moL = wL
      this.moR = wR
    } else if (t === 2) {
      wL = xl - fb * dl
      wR = xr - fb * dr
      this.moL = wL
      this.moR = wR
    } else {
      wL = xl + fb * 0.5 * this.combDampL
      wR = xr + fb * 0.5 * this.combDampR
      this.moL = xl - dl
      this.moR = xr - dr
    }
    // Soft-limit the loop so max reso stays bounded whatever comes in.
    let sl = fastTanh(wL / 3) * 3
    let sr2 = fastTanh(wR / 3) * 3
    if (sl < 1e-20 && sl > -1e-20) sl = 0
    if (sr2 < 1e-20 && sr2 > -1e-20) sr2 = 0
    this.combL.write(sl)
    this.combR.write(sr2)
  }

  private runModel(m: number, l: number, r: number, fc: number, drive: number): void {
    if (m === 0) this.runSvf(l, r, fc, drive)
    else if (m === 1) this.runLadder(l, r, fc, drive)
    else if (m === 2) this.runDiode(l, r, fc, drive)
    else this.runComb(l, r, fc, drive)
  }

  processInto(left: number, right: number, out: Float64Array): void {
    const fc = clamp(Math.exp(this.freqS.process(this.tLnFreq)), 30, this.maxFreq)
    const drive = this.driveS.process(this.tDrive)
    const l = Number.isFinite(left) ? left : 0
    const r = Number.isFinite(right) ? right : 0

    if (this.fadePos < 1) {
      // Crossfading a model switch: run the outgoing model, stash it, then run
      // the incoming one and blend linearly (~10ms).
      this.runModel(this.prevModel, l, r, fc, drive)
      const pL = this.moL
      const pR = this.moR
      this.runModel(this.curModel, l, r, fc, drive)
      const a = this.fadePos
      out[0] = pL + (this.moL - pL) * a
      out[1] = pR + (this.moR - pR) * a
      this.fadePos = Math.min(1, this.fadePos + this.fadeInc)
    } else {
      this.runModel(this.curModel, l, r, fc, drive)
      out[0] = this.moL
      out[1] = this.moR
    }
  }

  process(left: number, right: number): [number, number] {
    this.processInto(left, right, this.scratch)
    return [this.scratch[0], this.scratch[1]]
  }

  reset(): void {
    this.resetModel(0)
    this.resetModel(1)
    this.resetModel(2)
    this.resetModel(3)
    this.prevModel = this.curModel
    this.fadePos = 1
    this.freqS.reset(this.tLnFreq)
    this.driveS.reset(this.tDrive)
  }
}

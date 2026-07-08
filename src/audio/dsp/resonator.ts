/**
 * Resonator — modal synthesis body resonator. A bank of six two-pole resonant
 * filters per channel is excited by the input; partial-ratio tables give four
 * generic physical flavors (string, bar, tube, metal). Pure, deterministic,
 * allocation-free hot path (mirrors delay.ts shape).
 *
 * WHY block-rate coefficient slew: snapping pole angle/radius mid-ring clicks.
 * Control values ease toward their targets once per setParams call (one audio
 * block) and the filter state (y1/y2) always carries over, so a tune move
 * re-aims the poles without re-exciting or truncating the ring-out.
 */
import { clamp, lerp, Smoother, DcBlocker, TAU } from './util.ts'

export interface ResonatorParams {
  freq: number // 40..2000 Hz fundamental ('Tune')
  model: number // 0..3 [String, Bar, Tube, Metal]
  damp: number // 0..1 (0 = ~4 s ring, 1 = ~50 ms)
  spread: number // 0..1 L/R mode detune width
  bright: number // 0..1 partial tilt (0 rolls off highs, 1 emphasizes)
  mix: number // 0..1 dry/wet
}

const MODE_COUNT = 6

// Partial ratio tables — generic physical flavors, one row per model.
const RATIOS: readonly (readonly number[])[] = [
  [1, 2, 3, 4, 5, 6], // String: harmonic series
  [1, 2.76, 5.4, 8.93, 13.34, 18.64], // Bar: free-bar modes
  [1, 3, 5, 7, 9, 11], // Tube: odd partials (closed pipe)
  [1, 1.83, 2.51, 3.46, 4.72, 6.27], // Metal: inharmonic bell-ish cluster
]

export class Resonator {
  private readonly sampleRate: number
  private readonly scratch = new Float64Array(2)
  // Per-mode two-pole coefficients (a2 holds -r^2) and states, per channel.
  private readonly a1L = new Float64Array(MODE_COUNT)
  private readonly a2L = new Float64Array(MODE_COUNT)
  private readonly gL = new Float64Array(MODE_COUNT)
  private readonly a1R = new Float64Array(MODE_COUNT)
  private readonly a2R = new Float64Array(MODE_COUNT)
  private readonly gR = new Float64Array(MODE_COUNT)
  private readonly y1L = new Float64Array(MODE_COUNT)
  private readonly y2L = new Float64Array(MODE_COUNT)
  private readonly y1R = new Float64Array(MODE_COUNT)
  private readonly y2R = new Float64Array(MODE_COUNT)
  private readonly amp = new Float64Array(MODE_COUNT)
  private readonly dcL = new DcBlocker()
  private readonly dcR = new DcBlocker()
  private readonly mixS: Smoother
  // raw targets set per block
  private tFreq = 220
  private tModel = 0
  private tDamp = 0.4
  private tSpread = 0.3
  private tBright = 0.5
  private tMix = 0.5
  // block-rate slewed control values feeding the coefficient computation
  private freqSm = 220
  private dampSm = 0.4
  private spreadSm = 0.3
  private brightSm = 0.5

  constructor(sampleRate: number) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100
    this.mixS = new Smoother(this.sampleRate, 0.02, 0.5)
    this.computeCoeffs()
  }

  setParams({ freq, model, damp, spread, bright, mix }: ResonatorParams): void {
    this.tFreq = clamp(freq, 40, 2000)
    this.tModel = Math.round(clamp(model, 0, 3))
    this.tDamp = clamp(damp, 0, 1)
    this.tSpread = clamp(spread, 0, 1)
    this.tBright = clamp(bright, 0, 1)
    this.tMix = clamp(mix, 0, 1)
    // Block-rate slew (~10 blocks ≈ 27 ms at 48k/128) keeps pole moves clickless.
    const k = 0.35
    this.freqSm += (this.tFreq - this.freqSm) * k
    this.dampSm += (this.tDamp - this.dampSm) * k
    this.spreadSm += (this.tSpread - this.spreadSm) * k
    this.brightSm += (this.tBright - this.brightSm) * k
    this.computeCoeffs()
  }

  private computeCoeffs(): void {
    const ratios = RATIOS[this.tModel]
    const fMax = 0.45 * this.sampleRate
    // Ring time: damp 0 -> ~4 s, damp 1 -> ~50 ms (exponential interpolation).
    const tau0 = 4 * Math.pow(0.0125, this.dampSm)
    // Brightness is a geometric tilt across partial index, normalized so the
    // mode amplitudes always sum to 1 — max bright/min damp cannot explode.
    const base = lerp(0.4, 1.35, this.brightSm)
    let sum = 0
    for (let m = 0; m < MODE_COUNT; m++) {
      this.amp[m] = Math.pow(base, m)
      sum += this.amp[m]
    }
    const norm = 1 / sum
    const cents = 12 * this.spreadSm
    for (let m = 0; m < MODE_COUNT; m++) {
      const ratio = ratios[m]
      const amp = this.amp[m] * norm
      // Higher partials decay faster, as in physical bodies.
      const tau = tau0 / Math.sqrt(ratio)
      // Alternate detune direction per mode; L and R move oppositely.
      const det = (m & 1) === 0 ? cents : -cents
      const f = this.freqSm * ratio
      this.setMode(this.a1L, this.a2L, this.gL, m, f * Math.pow(2, det / 1200), tau, amp, fMax)
      this.setMode(this.a1R, this.a2R, this.gR, m, f * Math.pow(2, -det / 1200), tau, amp, fMax)
    }
  }

  private setMode(
    a1: Float64Array,
    a2: Float64Array,
    g: Float64Array,
    m: number,
    f: number,
    tau: number,
    amp: number,
    fMax: number,
  ): void {
    if (!(f > 0) || f >= fMax) {
      // Mode above the stable band: silence it and let its state fall out.
      a1[m] = 0
      a2[m] = 0
      g[m] = 0
      return
    }
    const sr = this.sampleRate
    const r = Math.exp(-1 / (tau * sr))
    const w = (TAU * f) / sr
    a1[m] = 2 * r * Math.cos(w)
    a2[m] = -r * r
    // (1-r)·2·sin(w) normalizes the resonance peak to ~amp, so a sustained
    // input at a mode frequency comes out near amp, independent of damp/tune.
    g[m] = amp * (1 - r) * 2 * Math.sin(w)
  }

  processInto(left: number, right: number, out: Float64Array): void {
    const l = Number.isFinite(left) ? left : 0
    const r = Number.isFinite(right) ? right : 0
    const mix = this.mixS.process(this.tMix)

    let sl = 0
    let sr = 0
    for (let m = 0; m < MODE_COUNT; m++) {
      let yl = this.a1L[m] * this.y1L[m] + this.a2L[m] * this.y2L[m] + this.gL[m] * l
      if (yl < 1e-20 && yl > -1e-20) yl = 0
      this.y2L[m] = this.y1L[m]
      this.y1L[m] = yl
      sl += yl

      let yr = this.a1R[m] * this.y1R[m] + this.a2R[m] * this.y2R[m] + this.gR[m] * r
      if (yr < 1e-20 && yr > -1e-20) yr = 0
      this.y2R[m] = this.y1R[m]
      this.y1R[m] = yr
      sr += yr
    }
    // Coefficients are built from clamped values, so this only trips if state
    // was already poisoned — recover by clearing the bank.
    if (!Number.isFinite(sl)) {
      sl = 0
      this.y1L.fill(0)
      this.y2L.fill(0)
    }
    if (!Number.isFinite(sr)) {
      sr = 0
      this.y1R.fill(0)
      this.y2R.fill(0)
    }

    const wl = this.dcL.process(sl)
    const wr = this.dcR.process(sr)
    out[0] = l * (1 - mix) + wl * mix
    out[1] = r * (1 - mix) + wr * mix
  }

  process(left: number, right: number): [number, number] {
    this.processInto(left, right, this.scratch)
    return [this.scratch[0], this.scratch[1]]
  }

  reset(): void {
    this.freqSm = this.tFreq
    this.dampSm = this.tDamp
    this.spreadSm = this.tSpread
    this.brightSm = this.tBright
    this.computeCoeffs()
    this.y1L.fill(0)
    this.y2L.fill(0)
    this.y1R.fill(0)
    this.y2R.fill(0)
    this.dcL.reset()
    this.dcR.reset()
    this.mixS.reset(this.tMix)
  }
}

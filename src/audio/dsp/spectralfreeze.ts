/**
 * SpectralFreeze — STFT freeze with spectral smear, tilt and slow motion.
 * FFT 2048 / hop 512 (75% overlap), Hann analysis + synthesis windows.
 * Pure, deterministic, allocation-free hot path.
 *
 * Signal always runs through the STFT path (even with freeze off) so toggling
 * freeze is seamless. Exact engine latency is FFT_SIZE - 1 = 2047 samples:
 * every hop the frame covering inputs [n-N+1 .. n] is overlap-added into
 * output positions [n .. n+N-1], i.e. out[t] reconstructs in[t-(N-1)]. The dry
 * path is delayed by the same 2047 samples so mix blends coherently.
 *
 * Freeze holds captured per-bin magnitudes and advances captured phases by the
 * bin's natural hop increment plus a tiny fixed per-bin offset (seeded Rng) so
 * the hold shimmers instead of buzzing. Magnitudes never change while frozen,
 * so the hold has constant RMS forever.
 */
import { clamp, Smoother, Rng, DelayLine, TAU, dbToGain } from './util.ts'
import { Fft, hannWindow } from './fft.ts'

export interface SpectralFreezeParams {
  freeze: number // 0..1 (>=0.5 => Hold)
  smear: number // 0..1 per-bin magnitude lag across frames
  tilt: number // 0..1 spectral tilt (0 bass, 0.5 flat, 1 treble)
  motion: number // 0..1 slow undulation of frozen bins
  mix: number // 0..1 dry/wet
}

const FFT_SIZE = 2048
const HOP = 512
const HALF = FFT_SIZE / 2
const MASK = FFT_SIZE - 1
const LATENCY = FFT_SIZE - 1 // documented above; also exposed on the instance
// Four overlapping hann^2 windows at hop N/4 sum to exactly 1.5.
const OLA_NORM = 2 / 3
const BAND_COUNT = 16
const FREEZE_FADE = 0.5 // crossfade step per frame => ~2 frames on/off

/** Per-channel state; both channels share the Fft and scratch spectra. */
class Channel {
  readonly inRing = new Float64Array(FFT_SIZE)
  readonly outAcc = new Float64Array(FFT_SIZE)
  readonly smearMag = new Float64Array(HALF + 1)
  readonly frozenMag = new Float64Array(HALF + 1)
  readonly phase = new Float64Array(HALF + 1)
  readonly jitter = new Float64Array(HALF + 1)
  readonly lfoPhase0 = new Float64Array(BAND_COUNT)
  readonly lfoPhase = new Float64Array(BAND_COUNT)
  readonly dry = new DelayLine(LATENCY + 4)

  constructor(seed: number) {
    // Per-channel seeds decorrelate frozen phase drift => stereo width.
    const rng = new Rng(seed)
    for (let k = 0; k <= HALF; k++) this.jitter[k] = (rng.next() * 2 - 1) * 0.03
    for (let b = 0; b < BAND_COUNT; b++) this.lfoPhase0[b] = rng.next() * TAU
    this.lfoPhase.set(this.lfoPhase0)
  }

  reset(): void {
    this.inRing.fill(0)
    this.outAcc.fill(0)
    this.smearMag.fill(0)
    this.frozenMag.fill(0)
    this.phase.fill(0)
    this.lfoPhase.set(this.lfoPhase0)
    this.dry.reset()
  }
}

export class SpectralFreeze {
  readonly latencySamples = LATENCY
  private readonly scratch = new Float64Array(2)
  private readonly fft = new Fft(FFT_SIZE)
  private readonly win = hannWindow(FFT_SIZE)
  private readonly re = new Float64Array(FFT_SIZE)
  private readonly im = new Float64Array(FFT_SIZE)
  private readonly tiltGain = new Float64Array(HALF + 1)
  private readonly logRatio = new Float64Array(HALF + 1)
  private readonly binInc = new Float64Array(HALF + 1)
  private readonly bandOfBin = new Uint16Array(HALF + 1)
  private readonly bandRate = new Float64Array(BAND_COUNT)
  private readonly bandGain = new Float64Array(BAND_COUNT)
  private readonly chL: Channel
  private readonly chR: Channel
  private readonly mixS: Smoother
  private pos = 0
  private hopCount = 0
  private freezeMix = 0
  private captured = false
  private tiltValue = -1 // force initial tilt table build
  // raw targets set per block
  private tFreeze = 0
  private smearA = 1
  private tMotion = 0.2
  private tMix = 0.5

  constructor(sampleRate: number) {
    const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100
    this.mixS = new Smoother(sr, 0.02, 0.5)
    this.chL = new Channel(0x2f6e2b1)
    this.chR = new Channel(0x6d2b79f5)
    // Tilt pivots near 600 Hz so 0.5 is flat and the extremes tip around a
    // musically neutral center. logRatio is fixed; only the slope changes.
    const kRef = Math.max(1, Math.round((600 / sr) * FFT_SIZE))
    for (let k = 1; k <= HALF; k++) this.logRatio[k] = Math.log(k / kRef)
    // Natural per-hop phase advance of bin k, wrapped.
    for (let k = 0; k <= HALF; k++) this.binInc[k] = ((TAU * k * HOP) / FFT_SIZE) % TAU
    // ~16 log-spaced bands for the motion LFOs; rates from a fixed seed.
    const logSpan = Math.log2(1 + HALF)
    for (let k = 0; k <= HALF; k++) {
      this.bandOfBin[k] = Math.min(
        BAND_COUNT - 1,
        Math.floor((BAND_COUNT * Math.log2(1 + k)) / logSpan),
      )
    }
    const rng = new Rng(0x9e3779b9)
    // 0.02..0.1 rad/frame at full motion ~= 0.3..1.5 Hz undulation.
    for (let b = 0; b < BAND_COUNT; b++) this.bandRate[b] = 0.02 + 0.08 * rng.next()
    this.bandGain.fill(1)
    this.setTilt(0.5)
  }

  setParams({ freeze, smear, tilt, motion, mix }: SpectralFreezeParams): void {
    this.tFreeze = clamp(freeze, 0, 1)
    // smear 0 => a = 1 (exactly transparent); smear 1 => heavy spectral lag.
    this.smearA = 1 - 0.97 * Math.sqrt(clamp(smear, 0, 1))
    this.tMotion = clamp(motion, 0, 1)
    this.tMix = clamp(mix, 0, 1)
    const t = clamp(tilt, 0, 1)
    // Rebuild the per-bin gain table only on a material change.
    if (Math.abs(t - this.tiltValue) > 1e-3) this.setTilt(t)
  }

  private setTilt(t: number): void {
    this.tiltValue = t
    const slope = (t - 0.5) * 2 // +-6 dB/oct around the pivot
    this.tiltGain[0] = 0 // always drop DC — no DC buildup, ever
    for (let k = 1; k <= HALF; k++) {
      const g = Math.exp(slope * this.logRatio[k])
      this.tiltGain[k] = g < 0.0625 ? 0.0625 : g > 16 ? 16 : g
    }
  }

  /** One STFT hop for one channel. Shares this.re/this.im scratch. */
  private frame(ch: Channel, capture: boolean): void {
    const re = this.re
    const im = this.im
    const win = this.win
    const pos = this.pos
    // Newest input sits at pos (just written); oldest of the frame at pos+1.
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = ch.inRing[(pos + 1 + i) & MASK] * win[i]
      im[i] = 0
    }
    this.fft.transform(re, im, false)

    const fm = this.freezeMix
    const live = 1 - fm
    const a = this.smearA
    const tg = this.tiltGain
    const motion = this.tMotion
    // Advance band LFOs every frame (state must evolve identically whether or
    // not the frozen branch is audible, for determinism across toggles).
    for (let b = 0; b < BAND_COUNT; b++) {
      let p = ch.lfoPhase[b] + this.bandRate[b] * motion
      if (p > TAU) p -= TAU
      ch.lfoPhase[b] = p
      // depth <= 6 dB * motion; at motion 0 this is exactly 1 (rock-still).
      this.bandGain[b] = motion > 0 ? dbToGain(6 * motion * Math.sin(p)) : 1
    }

    for (let k = 0; k <= HALF; k++) {
      const rr = re[k]
      const ii = im[k]
      const mag = Math.sqrt(rr * rr + ii * ii)
      let sm = ch.smearMag[k] + a * (mag - ch.smearMag[k])
      if (sm < 1e-20) sm = 0
      ch.smearMag[k] = sm
      if (capture) {
        // Freeze grabs the (smeared) magnitudes and the live phases, so the
        // first frozen frame matches the live one — the crossfade is seamless.
        ch.frozenMag[k] = sm
        ch.phase[k] = Math.atan2(ii, rr)
      }
      // Live path keeps the live phase: scale re/im by the magnitude ratio.
      const ratio = (sm * tg[k] * live) / (mag + 1e-30)
      let or = rr * ratio
      let oi = ii * ratio
      if (fm > 0) {
        let ph = ch.phase[k]
        if (!capture) {
          ph += this.binInc[k] + ch.jitter[k]
          ph -= TAU * Math.floor(ph / TAU)
          ch.phase[k] = ph
        }
        const m = ch.frozenMag[k] * tg[k] * this.bandGain[this.bandOfBin[k]] * fm
        or += m * Math.cos(ph)
        oi += m * Math.sin(ph)
      }
      re[k] = or
      im[k] = oi
    }
    // Enforce a real time-domain result: conjugate symmetry, real DC/Nyquist.
    im[0] = 0
    im[HALF] = 0
    for (let k = 1; k < HALF; k++) {
      re[FFT_SIZE - k] = re[k]
      im[FFT_SIZE - k] = -im[k]
    }
    this.fft.transform(re, im, true)
    for (let i = 0; i < FFT_SIZE; i++) {
      ch.outAcc[(pos + i) & MASK] += re[i] * win[i] * OLA_NORM
    }
  }

  processInto(left: number, right: number, out: Float64Array): void {
    const l = Number.isFinite(left) ? left : 0
    const r = Number.isFinite(right) ? right : 0
    const mix = this.mixS.process(this.tMix)
    const pos = this.pos

    this.chL.inRing[pos] = l
    this.chR.inRing[pos] = r
    this.chL.dry.write(l)
    this.chR.dry.write(r)

    this.hopCount++
    if (this.hopCount >= HOP) {
      this.hopCount = 0
      const hold = this.tFreeze >= 0.5
      const capture = hold && !this.captured
      this.captured = hold
      const target = hold ? 1 : 0
      const step = target - this.freezeMix
      this.freezeMix += clamp(step, -FREEZE_FADE, FREEZE_FADE)
      this.frame(this.chL, capture)
      this.frame(this.chR, capture)
    }

    let wl = this.chL.outAcc[pos]
    let wr = this.chR.outAcc[pos]
    this.chL.outAcc[pos] = 0
    this.chR.outAcc[pos] = 0
    this.pos = (pos + 1) & MASK
    if (!Number.isFinite(wl)) wl = 0
    if (!Number.isFinite(wr)) wr = 0

    const dl = this.chL.dry.read(LATENCY)
    const dr = this.chR.dry.read(LATENCY)
    out[0] = dl * (1 - mix) + wl * mix
    out[1] = dr * (1 - mix) + wr * mix
  }

  process(left: number, right: number): [number, number] {
    this.processInto(left, right, this.scratch)
    return [this.scratch[0], this.scratch[1]]
  }

  reset(): void {
    this.chL.reset()
    this.chR.reset()
    this.pos = 0
    this.hopCount = 0
    this.freezeMix = 0
    this.captured = false
    this.mixS.reset(this.tMix)
  }
}

/**
 * Codec — spectral "data-compression" degradation. An STFT front-end (FFT 2048
 * / hop 512, 75% overlap, Hann analysis + synthesis windows) rebuilds the
 * signal each hop while mangling the spectrum the way a low-bitrate perceptual
 * codec does: masking (drop bins that sit far below the frame peak — the source
 * of the classic MP3 "spectral hole" warble), coarse magnitude quantization
 * (bit starvation), a bandwidth lowpass (codecs throw away highs first), a slow
 * per-band warble/swirl on the surviving high bins, and random momentary
 * dropouts. Pure, deterministic (seeded Rng), allocation-free hot path.
 *
 * WHY masking relative to the per-frame peak (not an absolute floor): a codec
 * spends its bits on the loudest partials and discards what they perceptually
 * mask, so the holes track the signal's own dynamics — quiet passages thin out,
 * loud ones stay full. An absolute floor would gate by level and sound like a
 * noise gate, not a codec.
 *
 * WHY dropouts crossfade over ~2 hops instead of cutting: overlapping OLA
 * windows already smear a single dropped frame into a short dip, but a hard
 * per-hop gate still steps the tail audibly; easing the frame gain toward its
 * target keeps the stutter glitchy without clicking.
 *
 * Signal always runs through the STFT path so the effect is seamless. Exact
 * engine latency is FFT_SIZE - 1 = 2047 samples and the dry path is delayed to
 * match. Every degradation bypasses exactly at its zero, so crush=0, warble=0,
 * drop=0, tone=1 reconstructs the input untouched (mix aside).
 */
import { clamp, Smoother, Rng, DelayLine, TAU, dbToGain } from './util.ts'
import { Fft, hannWindow } from './fft.ts'

export interface CodecParams {
  crush: number // 0..1 masking threshold + magnitude quantization coarseness
  warble: number // 0..1 slow swirl (gain + phase jitter) on surviving high bins
  drop: number // 0..1 probability of momentary spectral dropouts
  tone: number // 0..1 codec bandwidth (1 = full range, 0 = narrow/dark)
  mix: number // 0..1 dry/wet
}

const FFT_SIZE = 2048
const HOP = 512
const HALF = FFT_SIZE / 2
const MASK = FFT_SIZE - 1
const LATENCY = FFT_SIZE - 1
// Four overlapping hann^2 windows at hop N/4 sum to exactly 1.5.
const OLA_NORM = 2 / 3
const BAND_COUNT = 16
const DROP_FADE = 0.5 // frame-gain crossfade per hop => ~2 hops on/off
const DROP_FLOOR = 0.06 // how far a dropout ducks the frame

/** Per-channel state; both channels share the Fft and scratch spectra. */
class Channel {
  readonly inRing = new Float64Array(FFT_SIZE)
  readonly outAcc = new Float64Array(FFT_SIZE)
  readonly lfoPhase0 = new Float64Array(BAND_COUNT)
  readonly lfoPhase = new Float64Array(BAND_COUNT)
  readonly dry = new DelayLine(LATENCY + 4)

  constructor(seed: number) {
    // Per-channel warble phase offsets decorrelate the swirl => stereo width.
    const rng = new Rng(seed)
    for (let b = 0; b < BAND_COUNT; b++) this.lfoPhase0[b] = rng.next() * TAU
    this.lfoPhase.set(this.lfoPhase0)
  }

  reset(): void {
    this.inRing.fill(0)
    this.outAcc.fill(0)
    this.lfoPhase.set(this.lfoPhase0)
    this.dry.reset()
  }
}

export class Codec {
  readonly latencySamples = LATENCY
  private readonly scratch = new Float64Array(2)
  private readonly fft = new Fft(FFT_SIZE)
  private readonly win = hannWindow(FFT_SIZE)
  private readonly re = new Float64Array(FFT_SIZE)
  private readonly im = new Float64Array(FFT_SIZE)
  private readonly bandOfBin = new Uint16Array(HALF + 1)
  private readonly bandRate = new Float64Array(BAND_COUNT)
  private readonly bandGain = new Float64Array(BAND_COUNT)
  private readonly warbleProfile = new Float64Array(HALF + 1)
  private readonly phaseJit = new Float64Array(HALF + 1)
  private readonly chL: Channel
  private readonly chR: Channel
  private readonly mixS: Smoother
  // Dropout uses one engine-level Rng so both channels dip together (a mono
  // codec dropout), and one shared eased gain applied to both channels' frames.
  private readonly dropRng = new Rng(0x1b873593)
  private dropGain = 1
  private pos = 0
  private hopCount = 0
  // raw targets set per block
  private crush = 0
  private warble = 0
  private drop = 0
  private cutoffBin = HALF
  private tMix = 0.5

  constructor(sampleRate: number) {
    const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100
    this.mixS = new Smoother(sr, 0.02, 0.5)
    this.chL = new Channel(0x2f6e2b1)
    this.chR = new Channel(0x6d2b79f5)
    // ~16 log-spaced bands for the warble LFOs.
    const logSpan = Math.log2(1 + HALF)
    for (let k = 0; k <= HALF; k++) {
      this.bandOfBin[k] = Math.min(
        BAND_COUNT - 1,
        Math.floor((BAND_COUNT * Math.log2(1 + k)) / logSpan),
      )
      // Warble bites the highs hardest (that underwater codec swirl lives up
      // top); lows stay steady so the fundamental doesn't wobble.
      this.warbleProfile[k] = k / HALF
    }
    const rng = new Rng(0x9e3779b9)
    // 0.02..0.1 rad/frame at full warble ~= 0.3..1.5 Hz undulation.
    for (let b = 0; b < BAND_COUNT; b++) this.bandRate[b] = 0.02 + 0.08 * rng.next()
    // Small fixed per-bin phase perturbation base; scaled by warble at runtime.
    for (let k = 0; k <= HALF; k++) this.phaseJit[k] = (rng.next() * 2 - 1) * 0.6
    this.bandGain.fill(1)
  }

  setParams({ crush, warble, drop, tone, mix }: CodecParams): void {
    this.crush = clamp(crush, 0, 1)
    this.warble = clamp(warble, 0, 1)
    this.drop = clamp(drop, 0, 1)
    this.tMix = clamp(mix, 0, 1)
    // Bandwidth: tone 1 => full spectrum (cutoff at Nyquist, no bins zeroed);
    // tone^2 so the knob's lower half narrows aggressively like a low bitrate.
    const t = clamp(tone, 0, 1)
    const frac = 0.02 + 0.98 * t * t
    this.cutoffBin = Math.min(HALF, Math.round(HALF * frac))
  }

  /** One STFT hop for one channel. Shares this.re/this.im scratch. */
  private frame(ch: Channel): void {
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

    const crush = this.crush
    const warble = this.warble
    const cutoff = this.cutoffBin
    const dGain = this.dropGain

    // Advance the warble band LFOs every frame (state evolves regardless of
    // audibility, for determinism); depth <= 9 dB, exactly 1 at warble 0.
    for (let b = 0; b < BAND_COUNT; b++) {
      let p = ch.lfoPhase[b] + this.bandRate[b] * warble
      if (p > TAU) p -= TAU
      ch.lfoPhase[b] = p
      this.bandGain[b] = warble > 0 ? dbToGain(9 * warble * Math.sin(p)) : 1
    }

    // Per-frame peak magnitude drives the masking threshold: bins below a
    // crush-scaled fraction of the peak are perceptually masked and dropped.
    let peak = 1e-20
    for (let k = 0; k <= HALF; k++) {
      const m = re[k] * re[k] + im[k] * im[k]
      if (m > peak) peak = m
    }
    peak = Math.sqrt(peak)
    // crush^2 eases the onset; up to ~30% of peak so heavy crush leaves holes.
    const maskThresh = peak * crush * crush * 0.3
    // Coarse magnitude quantization in the log2 domain (bit starvation).
    const quantStep = crush * 1.5

    for (let k = 0; k <= HALF; k++) {
      const rr = re[k]
      const ii = im[k]
      // Bandwidth cut: kill everything above the codec's passband.
      if (k > cutoff) {
        re[k] = 0
        im[k] = 0
        continue
      }
      const mag = Math.sqrt(rr * rr + ii * ii)
      // Masking: drop bins that sit far below the frame's loudest partial.
      if (mag < maskThresh) {
        re[k] = 0
        im[k] = 0
        continue
      }
      let outMag = mag
      if (quantStep > 0 && mag > 1e-20) {
        const q = Math.round(Math.log2(mag) / quantStep) * quantStep
        outMag = Math.pow(2, q)
      }
      // Warble: slow per-band gain swirl weighted toward the highs.
      const g = this.bandGain[this.bandOfBin[k]]
      outMag *= 1 + (g - 1) * this.warbleProfile[k]
      // Momentary dropout ducks the whole frame.
      outMag *= dGain
      const scale = outMag / (mag + 1e-30)
      let or = rr * scale
      let oi = ii * scale
      // Warble also jitters phase (the swirl), rotating the surviving bin.
      if (warble > 0) {
        const g2 = this.bandGain[this.bandOfBin[k]]
        const dphi = warble * this.phaseJit[k] * this.warbleProfile[k] * (g2 - 1)
        if (dphi !== 0) {
          const cs = Math.cos(dphi)
          const sn = Math.sin(dphi)
          const nr = or * cs - oi * sn
          oi = or * sn + oi * cs
          or = nr
        }
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
      // Roll a dropout target once per hop (shared by both channels), then ease
      // the frame gain toward it so the stutter never clicks.
      const target = this.drop > 0 && this.dropRng.next() < this.drop * 0.5 ? DROP_FLOOR : 1
      const step = target - this.dropGain
      this.dropGain += clamp(step, -DROP_FADE, DROP_FADE)
      this.frame(this.chL)
      this.frame(this.chR)
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
    this.dropGain = 1
    this.mixS.reset(this.tMix)
  }
}

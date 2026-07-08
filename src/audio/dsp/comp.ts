/**
 * Compressor — feed-forward compressor with stereo-linked detection, soft knee,
 * peak/RMS detector modes, optional ~5ms lookahead and parallel (dry/wet) mix.
 * Pure, deterministic, allocation-free hot path.
 *
 * WHY the detector modes crossfade instead of switching: the peak and RMS
 * detectors disagree by several dB on program material, so a hard swap steps
 * the gain audibly. Both detectors always run (they are two multiplies) and a
 * short smoother blends their outputs, so Detect is click-free.
 *
 * WHY lookahead crossfades the *audio path*: the detector always sees the
 * undelayed input; turning lookahead on slides the audio 5ms behind it so the
 * envelope has already risen when a transient arrives. Blending the delayed and
 * undelayed paths over ~10ms avoids the click a hard 5ms jump would cause.
 *
 * Follows the reference core shape (see drive.ts): params interface, clamping
 * setParams, allocation-free processInto, a process() test convenience, reset.
 */
import { clamp, Smoother, dbToGain, DelayLine } from './util.ts'

export interface CompParams {
  amount: number // 0..1  more = lower threshold + higher ratio
  attack: number // 0..1  ~1ms -> 100ms
  release: number // 0..1  ~20ms -> 800ms
  makeup: number // 0..1  0 -> +18dB output trim
  // Optional (spec defaults) so pre-existing 4-param callers keep compiling.
  mix?: number // 0..1  parallel compression blend (1 = fully compressed)
  mode?: number // 0..1  rounds to 0=Peak, 1=RMS detector
  lookahead?: number // 0..1 rounds to 0=Off, 1=On (~5ms audio delay)
}

// Soft knee width in dB: the gain computer bends smoothly across
// threshold±KNEE/2 instead of hinging, which keeps program material from
// pumping as the envelope hovers around threshold. Quadratic interpolation of
// the two line segments keeps the curve monotonic.
const KNEE_DB = 6

export class Comp {
  private readonly sampleRate: number
  private readonly scratch = new Float64Array(2)
  private readonly amountS: Smoother
  private readonly makeupS: Smoother
  private readonly mixS: Smoother
  // Mode/lookahead are option switches; ~10ms smoothers turn the hard toggles
  // into click-free crossfades of detector value / audio path.
  private readonly modeS: Smoother
  private readonly lookS: Smoother
  private readonly lookL: DelayLine
  private readonly lookR: DelayLine
  private readonly lookSamples: number
  // raw targets; amount/makeup/mix smooth per sample, attack/release are time
  // constants so they resolve to coefficients at block rate (no zipper risk).
  private tAmount = 0.4
  private tMakeup = 0.5
  private tMix = 1
  private tMode = 0
  private tLook = 0
  private attackCoeff = 0
  private releaseCoeff = 0
  // stereo-linked peak envelope follower state
  private env = 0
  // ~10ms mean-square window state for the RMS detector
  private ms = 0
  private msCoeff = 0

  constructor(sampleRate: number) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100
    this.amountS = new Smoother(this.sampleRate, 0.02, 0.4)
    this.makeupS = new Smoother(this.sampleRate, 0.02, 0.5)
    this.mixS = new Smoother(this.sampleRate, 0.02, 1)
    this.modeS = new Smoother(this.sampleRate, 0.01, 0)
    this.lookS = new Smoother(this.sampleRate, 0.01, 0)
    this.lookSamples = Math.max(1, Math.round(0.005 * this.sampleRate))
    this.lookL = new DelayLine(this.lookSamples + 4)
    this.lookR = new DelayLine(this.lookSamples + 4)
    this.msCoeff = Math.exp(-1 / (0.01 * this.sampleRate))
    // seed coefficients so a core used before setParams still behaves sanely
    this.setTimes(0.2, 0.45)
  }

  private setTimes(attack: number, release: number): void {
    // Map the normalized knobs onto musically useful time constants.
    const attackSec = 0.001 + attack * 0.099 // 1ms -> 100ms
    const releaseSec = 0.02 + release * 0.78 // 20ms -> 800ms
    this.attackCoeff = Math.exp(-1 / (attackSec * this.sampleRate))
    this.releaseCoeff = Math.exp(-1 / (releaseSec * this.sampleRate))
  }

  setParams({ amount, attack, release, makeup, mix = 1, mode = 0, lookahead = 0 }: CompParams): void {
    this.tAmount = clamp(amount, 0, 1)
    this.tMakeup = clamp(makeup, 0, 1)
    this.tMix = clamp(mix, 0, 1)
    this.tMode = Math.round(clamp(mode, 0, 1))
    this.tLook = Math.round(clamp(lookahead, 0, 1))
    this.setTimes(clamp(attack, 0, 1), clamp(release, 0, 1))
  }

  processInto(left: number, right: number, out: Float64Array): void {
    const amount = this.amountS.process(this.tAmount)
    const makeup = this.makeupS.process(this.tMakeup)
    const mix = this.mixS.process(this.tMix)
    const modeMix = this.modeS.process(this.tMode)
    const look = this.lookS.process(this.tLook)
    const l = Number.isFinite(left) ? left : 0
    const r = Number.isFinite(right) ? right : 0

    // Lookahead lines record continuously so toggling On has valid history.
    this.lookL.write(l)
    this.lookR.write(r)
    const dl = this.lookL.read(this.lookSamples)
    const dr = this.lookR.read(this.lookSamples)
    // Audio path: crossfade dry/delayed; detector below always sees l/r (the
    // undelayed input), which is what makes the lookahead catch transients.
    const al = l + (dl - l) * look
    const ar = r + (dr - r) * look

    // Stereo-linked detection: drive one detector from the louder channel so
    // gain is applied identically to both and the stereo image stays stable.
    const detect = Math.max(Math.abs(l), Math.abs(r))
    // RMS detector: one-pole mean-square (~10ms window) for smoother program
    // compression; it always runs so mode changes can crossfade.
    this.ms = detect * detect + (this.ms - detect * detect) * this.msCoeff
    if (this.ms < 1e-30) this.ms = 0
    const det = detect + (Math.sqrt(this.ms) - detect) * modeMix
    // Envelope follower: fast attack when rising, slow release when falling.
    const coeff = det > this.env ? this.attackCoeff : this.releaseCoeff
    this.env = det + (this.env - det) * coeff
    if (this.env < 1e-20) this.env = 0

    // amount maps to a harsher curve: threshold falls, ratio climbs.
    const thDb = -6 + amount * -34 // -6dB -> -40dB
    const ratio = 1.5 + amount * 10.5 // 1.5:1 -> 12:1
    const envDb = 20 * Math.log10(this.env + 1e-9)
    // Soft-knee gain computer (monotonic): transparent below the knee, full
    // ratio above it, quadratic blend across threshold±KNEE/2.
    const over = envDb - thDb
    const slope = 1 - 1 / ratio
    let redDb = 0
    if (over >= KNEE_DB / 2) redDb = slope * over
    else if (over > -KNEE_DB / 2) {
      const t = over + KNEE_DB / 2
      redDb = (slope * t * t) / (2 * KNEE_DB)
    }

    // Parallel compression: blend the (time-aligned) uncompressed path with the
    // compressed+makeup path so mix<1 keeps transients under the squashed bed.
    const wetGain = dbToGain(makeup * 18 - redDb)
    const gain = 1 - mix + wetGain * mix
    out[0] = al * gain
    out[1] = ar * gain
  }

  process(left: number, right: number): [number, number] {
    this.processInto(left, right, this.scratch)
    return [this.scratch[0], this.scratch[1]]
  }

  reset(): void {
    this.env = 0
    this.ms = 0
    this.lookL.reset()
    this.lookR.reset()
    this.amountS.reset(this.tAmount)
    this.makeupS.reset(this.tMakeup)
    this.mixS.reset(this.tMix)
    this.modeS.reset(this.tMode)
    this.lookS.reset(this.tLook)
  }
}

/**
 * Reverb — Schroeder/Freeverb-style network: predelay and input allpass
 * diffusion into 4 parallel damped feedback comb filters, then 2 series
 * all-pass diffusers, per channel. Pure, deterministic, allocation-free hot
 * path (mirrors drive.ts shape).
 *
 * WHY damped combs: a plain feedback comb rings forever on one bright tone. A
 * one-pole low-pass inside each feedback path bleeds off highs each pass, which
 * is what makes a tail sound like a decaying room instead of a metallic drone,
 * and it keeps the loop gain below 1 so the network is unconditionally stable.
 * WHY the L/R comb-length offset: detuning the right channel by a few samples
 * decorrelates the two tails, widening the stereo image.
 * WHY input diffusers: discrete early echoes out of bare combs sound grainy;
 * a few series allpasses with mutually prime lengths (different per channel
 * for decorrelation) smear the input into a smooth wash before the combs.
 */
import { clamp, Smoother, DelayLine, AllpassDiffuser, TAU } from './util.ts'

export interface ReverbParams {
  size: number // 0..1 scales comb lengths
  decay: number // 0..1 scales feedback gain
  mix: number // 0..1 dry/wet
  mode: number // 0..5 Room/Hall/Plate/Spring/Diffuse/Ambient
  damp?: number // 0..1 HF damping in the feedback path (0.5 = mode default)
  predelay?: number // 0..0.2 s wet-input predelay
  width?: number // 0..1 stereo width of the wet signal (1 = full)
}

// Base comb lengths in samples at 44.1kHz, one row per mode; mutually prime
// within a row so the modal peaks never pile up (metallic ringing). Hall is
// long (big space), Spring short + close-spaced (tight, resonant), Diffuse
// medium, Ambient longest for a slow wash.
const COMB_BASE = [
  [1116, 1188, 1277, 1356], // Room
  [1557, 1617, 1691, 1782], // Hall
  [1422, 1491, 1557, 1617], // Plate
  [767, 831, 907, 983], // Spring
  [1201, 1327, 1459, 1567], // Diffuse
  [1733, 1861, 1979, 2113], // Ambient
] as const
// All-pass diffuser lengths (samples @44.1kHz).
const AP_BASE = [225, 556] as const
// Extra samples added to the right channel for stereo decorrelation.
const SPREAD = 23
// Per-mode extra feedback (resonance) — Spring rings the most.
const MODE_RES = [0, 0.03, 0.02, 0.06, 0.02, 0.05] as const
// Per-mode feedback damping at damp=0.5 (0 = bright, higher = darker tail).
// Spring bright, Ambient heavily damped for a dark wash.
const MODE_DAMP = [0.28, 0.5, 0.35, 0.12, 0.35, 0.62] as const
// Input diffuser gain per mode — Diffuse maximises density buildup, Spring
// keeps its boingy discreteness.
const MODE_DIFF_G = [0.55, 0.6, 0.62, 0.35, 0.75, 0.65] as const
// Input diffuser lengths (samples @44.1kHz): mutually prime, and different
// between channels so the early field decorrelates.
const DIFF_L = [113, 241, 379] as const
const DIFF_R = [127, 251, 397] as const
const AP_G = 0.5
const NUM_COMBS = 4
const NUM_AP = 2
const NUM_DIFF = 3
// Ambient tail modulation: slow deterministic LFO per comb (fixed phase
// offsets, extra offset on the right channel) breathes the line lengths a few
// samples so the tail never settles into static modes.
const MOD_RATE_HZ = 0.13
const MOD_DEPTH = 2.5 // samples @44.1kHz
const MOD_PHASE = [0, 0.25, 0.5, 0.75] as const
const MOD_PHASE_R = 0.37
const PREDELAY_MAX = 0.2

/** Optional/NaN param -> spec default, so old callers keep today's sound. */
function finiteOr(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

export class Reverb {
  private readonly sampleRate: number
  private readonly srScale: number
  private readonly scratch = new Float64Array(2)
  private readonly combL: DelayLine[] = []
  private readonly combR: DelayLine[] = []
  private readonly apL: DelayLine[] = []
  private readonly apR: DelayLine[] = []
  private readonly diffL: AllpassDiffuser[] = []
  private readonly diffR: AllpassDiffuser[] = []
  private readonly preL: DelayLine
  private readonly preR: DelayLine
  private readonly preMax: number
  // Low-pass state inside each comb's feedback path, per channel.
  private readonly combStoreL = new Float64Array(NUM_COMBS)
  private readonly combStoreR = new Float64Array(NUM_COMBS)
  private readonly decayS: Smoother
  private readonly sizeS: Smoother
  private readonly mixS: Smoother
  private readonly dampS: Smoother
  private readonly preS: Smoother
  private readonly widthS: Smoother
  private tSize = 0.5
  private tDecay = 0.5
  private tMix = 0.3
  private tMode = 1
  private tDamp = 0.5
  private tPre = 0.01
  private tWidth = 1
  private modPhase = 0
  // Last engaged mode; when it changes we flush the buffers (comb lengths and
  // feedback jump, so continuing to read the old tail garbles/clicks).
  private lastMode = 1

  constructor(sampleRate: number) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100
    this.srScale = this.sampleRate / 44100
    // Generous buffers: longest base * srScale * max size-scale + spread + mod.
    const maxComb = Math.ceil(0.12 * this.sampleRate) + SPREAD + 8
    const maxAp = Math.ceil(0.02 * this.sampleRate) + SPREAD + 8
    for (let i = 0; i < NUM_COMBS; i++) {
      this.combL.push(new DelayLine(maxComb))
      this.combR.push(new DelayLine(maxComb))
    }
    for (let i = 0; i < NUM_AP; i++) {
      this.apL.push(new DelayLine(maxAp))
      this.apR.push(new DelayLine(maxAp))
    }
    for (let i = 0; i < NUM_DIFF; i++) {
      this.diffL.push(new AllpassDiffuser(DIFF_L[i] * this.srScale, MODE_DIFF_G[1]))
      this.diffR.push(new AllpassDiffuser(DIFF_R[i] * this.srScale, MODE_DIFF_G[1]))
    }
    this.preMax = Math.ceil(PREDELAY_MAX * this.sampleRate) + 4
    this.preL = new DelayLine(this.preMax)
    this.preR = new DelayLine(this.preMax)
    this.decayS = new Smoother(this.sampleRate, 0.05, 0.5)
    this.sizeS = new Smoother(this.sampleRate, 0.05, 0.5)
    this.mixS = new Smoother(this.sampleRate, 0.02, 0.3)
    this.dampS = new Smoother(this.sampleRate, 0.05, 0.5)
    this.preS = new Smoother(this.sampleRate, 0.05, 0.01)
    this.widthS = new Smoother(this.sampleRate, 0.02, 1)
  }

  setParams({ size, decay, mix, mode, damp, predelay, width }: ReverbParams): void {
    this.tSize = clamp(size, 0, 1)
    this.tDecay = clamp(decay, 0, 1)
    this.tMix = clamp(mix, 0, 1)
    this.tMode = clamp(mode, 0, 5)
    this.tDamp = clamp(finiteOr(damp, 0.5), 0, 1)
    this.tPre = clamp(finiteOr(predelay, 0.01), 0, PREDELAY_MAX)
    this.tWidth = clamp(finiteOr(width, 1), 0, 1)
  }

  processInto(left: number, right: number, out: Float64Array): void {
    const inL = Number.isFinite(left) ? left : 0
    const inR = Number.isFinite(right) ? right : 0
    const mode = Math.round(this.tMode)
    // On mode switch the comb lengths and feedback change instantly; flush the
    // delay network so a mid-decay tail can't garble/click into the new mode.
    if (mode !== this.lastMode) {
      for (let i = 0; i < NUM_COMBS; i++) {
        this.combL[i].reset()
        this.combR[i].reset()
        this.combStoreL[i] = 0
        this.combStoreR[i] = 0
      }
      for (let i = 0; i < NUM_AP; i++) {
        this.apL[i].reset()
        this.apR[i].reset()
      }
      for (let i = 0; i < NUM_DIFF; i++) {
        this.diffL[i].reset()
        this.diffR[i].reset()
        this.diffL[i].setGain(MODE_DIFF_G[mode])
        this.diffR[i].setGain(MODE_DIFF_G[mode])
      }
      this.preL.reset()
      this.preR.reset()
      this.modPhase = 0
      this.lastMode = mode
    }
    const decay = this.decayS.process(this.tDecay)
    const size = this.sizeS.process(this.tSize)
    const mix = this.mixS.process(this.tMix)
    // damp maps the 0..1 knob around the mode's character: 0.5 keeps the
    // per-mode default tone, 0 removes all damping (bright), 1 pushes toward
    // 0.95 (very dark). The loop gain stays < 1 either way.
    const dampParam = this.dampS.process(this.tDamp)
    const dampBase = MODE_DAMP[mode]
    const damp =
      dampParam <= 0.5
        ? dampBase * dampParam * 2
        : dampBase + (0.95 - dampBase) * (dampParam - 0.5) * 2

    // Capped at 0.92 so even Spring at full decay stays comfortably stable.
    const fb = clamp(0.66 + decay * 0.22 + MODE_RES[mode], 0, 0.92)
    const sizeScale = 0.6 + size * 0.9 // 0.6..1.5

    // Predelay on the wet input path (dry is untouched), then input diffusion.
    const preSec = this.preS.process(this.tPre)
    const preDs = clamp(preSec * this.sampleRate, 0, this.preMax - 1)
    this.preL.write(inL)
    this.preR.write(inR)
    let feedL = this.preL.read(preDs)
    let feedR = this.preR.read(preDs)
    for (let i = 0; i < NUM_DIFF; i++) {
      feedL = this.diffL[i].process(feedL)
      feedR = this.diffR[i].process(feedR)
    }

    // Ambient breathes its comb lengths with a slow deterministic LFO.
    const ambient = mode === 5
    if (ambient) {
      this.modPhase += MOD_RATE_HZ / this.sampleRate
      if (this.modPhase >= 1) this.modPhase -= 1
    }

    let sumL = 0
    let sumR = 0
    for (let i = 0; i < NUM_COMBS; i++) {
      let lenL = COMB_BASE[mode][i] * this.srScale * sizeScale
      let lenR = lenL + SPREAD
      if (ambient) {
        const d = MOD_DEPTH * this.srScale
        lenL += d * Math.sin(TAU * (this.modPhase + MOD_PHASE[i]))
        lenR += d * Math.sin(TAU * (this.modPhase + MOD_PHASE[i] + MOD_PHASE_R))
      }
      const outL = this.combL[i].read(lenL)
      const outR = this.combR[i].read(lenR)
      // One-pole low-pass in the feedback loop (darkens each pass).
      this.combStoreL[i] = outL * (1 - damp) + this.combStoreL[i] * damp
      this.combStoreR[i] = outR * (1 - damp) + this.combStoreR[i] * damp
      // Flush denormals (no FTZ in JS): the lp state decaying to zero otherwise
      // drifts into the denormal range and can spike CPU.
      if (this.combStoreL[i] < 1e-20 && this.combStoreL[i] > -1e-20) this.combStoreL[i] = 0
      if (this.combStoreR[i] < 1e-20 && this.combStoreR[i] > -1e-20) this.combStoreR[i] = 0
      this.combL[i].write(feedL + this.combStoreL[i] * fb)
      this.combR[i].write(feedR + this.combStoreR[i] * fb)
      sumL += outL
      sumR += outR
    }
    // Average the parallel combs so the wet level is independent of count.
    let wetL = sumL * 0.25
    let wetR = sumR * 0.25

    // Series all-pass diffusion smears the echoes into a smooth tail.
    for (let i = 0; i < NUM_AP; i++) {
      const lenL = AP_BASE[i] * this.srScale
      const lenR = lenL + SPREAD * 0.5
      const bufL = this.apL[i].read(lenL)
      const yL = -wetL + bufL
      this.apL[i].write(wetL + bufL * AP_G)
      wetL = yL
      const bufR = this.apR[i].read(lenR)
      const yR = -wetR + bufR
      this.apR[i].write(wetR + bufR * AP_G)
      wetR = yR
    }

    // Width: equal-power blend between the decorrelated wet and its mono sum.
    const width = this.widthS.process(this.tWidth)
    const wSide = Math.sin(width * (Math.PI / 2))
    const wMono = Math.cos(width * (Math.PI / 2))
    const mono = (wetL + wetR) * 0.5
    const wl = wetL * wSide + mono * wMono
    const wr = wetR * wSide + mono * wMono

    out[0] = inL * (1 - mix) + wl * mix
    out[1] = inR * (1 - mix) + wr * mix
  }

  process(left: number, right: number): [number, number] {
    this.processInto(left, right, this.scratch)
    return [this.scratch[0], this.scratch[1]]
  }

  reset(): void {
    for (let i = 0; i < NUM_COMBS; i++) {
      this.combL[i].reset()
      this.combR[i].reset()
      this.combStoreL[i] = 0
      this.combStoreR[i] = 0
    }
    for (let i = 0; i < NUM_AP; i++) {
      this.apL[i].reset()
      this.apR[i].reset()
    }
    const mode = Math.round(this.tMode)
    for (let i = 0; i < NUM_DIFF; i++) {
      this.diffL[i].reset()
      this.diffR[i].reset()
      this.diffL[i].setGain(MODE_DIFF_G[mode])
      this.diffR[i].setGain(MODE_DIFF_G[mode])
    }
    this.preL.reset()
    this.preR.reset()
    this.decayS.reset(this.tDecay)
    this.sizeS.reset(this.tSize)
    this.mixS.reset(this.tMix)
    this.dampS.reset(this.tDamp)
    this.preS.reset(this.tPre)
    this.widthS.reset(this.tWidth)
    this.modPhase = 0
    this.lastMode = mode
  }
}

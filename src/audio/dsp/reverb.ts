/**
 * Reverb — Schroeder/Freeverb-style network: 4 parallel damped feedback comb
 * filters into 2 series all-pass diffusers, per channel. Pure, deterministic,
 * allocation-free hot path (mirrors drive.ts shape).
 *
 * WHY damped combs: a plain feedback comb rings forever on one bright tone. A
 * one-pole low-pass inside each feedback path bleeds off highs each pass, which
 * is what makes a tail sound like a decaying room instead of a metallic drone,
 * and it keeps the loop gain below 1 so the network is unconditionally stable.
 * WHY the L/R comb-length offset: detuning the right channel by a few samples
 * decorrelates the two tails, widening the stereo image.
 */
import { clamp, Smoother, DelayLine } from './util.ts'

export interface ReverbParams {
  size: number // 0..1 scales comb lengths
  decay: number // 0..1 scales feedback gain
  mix: number // 0..1 dry/wet
  mode: number // 0..3 Room/Hall/Plate/Spring
}

// Base comb lengths in samples at 44.1kHz, one row per mode. Hall is longest
// (biggest space), Spring is short + close-spaced (tight, resonant character).
const COMB_BASE = [
  [1116, 1188, 1277, 1356], // Room
  [1557, 1617, 1691, 1782], // Hall
  [1422, 1491, 1557, 1617], // Plate
  [767, 831, 907, 983], // Spring
] as const
// All-pass diffuser lengths (samples @44.1kHz).
const AP_BASE = [225, 556] as const
// Extra samples added to the right channel for stereo decorrelation.
const SPREAD = 23
// Per-mode extra feedback (resonance) — Spring rings the most.
const MODE_RES = [0, 0.03, 0.02, 0.06] as const
// Per-mode feedback damping (0 = bright, higher = darker tail). Spring bright.
const MODE_DAMP = [0.28, 0.5, 0.35, 0.12] as const
const AP_G = 0.5
const NUM_COMBS = 4
const NUM_AP = 2

export class Reverb {
  private readonly sampleRate: number
  private readonly srScale: number
  private readonly scratch = new Float64Array(2)
  private readonly combL: DelayLine[] = []
  private readonly combR: DelayLine[] = []
  private readonly apL: DelayLine[] = []
  private readonly apR: DelayLine[] = []
  // Low-pass state inside each comb's feedback path, per channel.
  private readonly combStoreL = new Float64Array(NUM_COMBS)
  private readonly combStoreR = new Float64Array(NUM_COMBS)
  private readonly decayS: Smoother
  private readonly sizeS: Smoother
  private readonly mixS: Smoother
  private readonly dampS: Smoother
  private tSize = 0.5
  private tDecay = 0.5
  private tMix = 0.3
  private tMode = 1

  constructor(sampleRate: number) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100
    this.srScale = this.sampleRate / 44100
    // Generous buffers: longest base * srScale * max size-scale + spread.
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
    this.decayS = new Smoother(this.sampleRate, 0.05, 0.5)
    this.sizeS = new Smoother(this.sampleRate, 0.05, 0.5)
    this.mixS = new Smoother(this.sampleRate, 0.02, 0.3)
    this.dampS = new Smoother(this.sampleRate, 0.05, MODE_DAMP[1])
  }

  setParams({ size, decay, mix, mode }: ReverbParams): void {
    this.tSize = clamp(size, 0, 1)
    this.tDecay = clamp(decay, 0, 1)
    this.tMix = clamp(mix, 0, 1)
    this.tMode = clamp(mode, 0, 3)
  }

  processInto(left: number, right: number, out: Float64Array): void {
    const inL = Number.isFinite(left) ? left : 0
    const inR = Number.isFinite(right) ? right : 0
    const mode = Math.round(this.tMode)
    const decay = this.decayS.process(this.tDecay)
    const size = this.sizeS.process(this.tSize)
    const mix = this.mixS.process(this.tMix)
    const damp = this.dampS.process(MODE_DAMP[mode])

    // Capped at 0.92 so even Spring at full decay stays comfortably stable.
    const fb = clamp(0.66 + decay * 0.22 + MODE_RES[mode], 0, 0.92)
    const sizeScale = 0.6 + size * 0.9 // 0.6..1.5

    let sumL = 0
    let sumR = 0
    for (let i = 0; i < NUM_COMBS; i++) {
      const lenL = COMB_BASE[mode][i] * this.srScale * sizeScale
      const lenR = lenL + SPREAD
      const outL = this.combL[i].read(lenL)
      const outR = this.combR[i].read(lenR)
      // One-pole low-pass in the feedback loop (darkens each pass).
      this.combStoreL[i] = outL * (1 - damp) + this.combStoreL[i] * damp
      this.combStoreR[i] = outR * (1 - damp) + this.combStoreR[i] * damp
      this.combL[i].write(inL + this.combStoreL[i] * fb)
      this.combR[i].write(inR + this.combStoreR[i] * fb)
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

    out[0] = inL * (1 - mix) + wetL * mix
    out[1] = inR * (1 - mix) + wetR * mix
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
    this.decayS.reset(this.tDecay)
    this.sizeS.reset(this.tSize)
    this.mixS.reset(this.tMix)
    this.dampS.reset(MODE_DAMP[Math.round(this.tMode)])
  }
}

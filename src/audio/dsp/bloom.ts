/**
 * Bloom — input-reactive ambience that charges up into an evolving pad.
 *
 * Not a reverb: incoming audio is diffused and injected into a six-line
 * recirculating loop whose gain sits just below unity, so energy accumulates
 * over seconds into a sustained wash rather than decaying as a tail. An
 * energy governor scales the injection as the pad approaches its target
 * level — the pad saturates smoothly instead of pumping or running away.
 *
 * evolve slowly rotates per-line gains and read points (incommensurate LFO
 * rates) so a held pad keeps shifting; rich blends octave-up shimmer into two
 * loop lines and opens the damping for harmonic sheen.
 */
import {
  clamp,
  lerp,
  Smoother,
  DelayLine,
  AllpassDiffuser,
  OnePoleLP,
  OnePoleHP,
  PitchShifter,
  fastTanh,
} from './util.ts'

export interface BloomParams {
  mix: number // 0..1 dry/wet
  grow: number // 0..1 how fast/strongly input charges the pad
  density: number // 0..1 cross-coupling + diffusion thickness
  space: number // 0..1 line lengths + width
  rich: number // 0..1 octave shimmer + brightness
  evolve: number // 0..1 slow morphing of the pad
}

const LINES = 6
const BASE_SEC = [0.181, 0.211, 0.239, 0.283, 0.331, 0.389] as const
const EVO_RATES = [0.043, 0.059, 0.071, 0.083, 0.097, 0.113] as const
const DIFF_L = [0.0071, 0.0113] as const
const DIFF_R = [0.0083, 0.0127] as const

export class Bloom {
  private readonly sampleRate: number
  private readonly scratch = new Float64Array(2)
  private readonly lines: DelayLine[] = []
  private readonly lineMax: number[] = []
  private readonly damps: OnePoleLP[] = []
  private readonly loCutL = new OnePoleHP()
  private readonly loCutR = new OnePoleHP()
  private readonly diffL: AllpassDiffuser[] = []
  private readonly diffR: AllpassDiffuser[] = []
  private readonly shimA: PitchShifter
  private readonly shimB: PitchShifter
  private readonly shimPre = new OnePoleLP()
  private readonly vec = new Float64Array(LINES)
  private readonly evoPhase = new Float64Array(LINES)

  private padMs = 0 // governor: smoothed pad mean-square

  private readonly mixS: Smoother
  private readonly spaceS: Smoother
  private readonly richS: Smoother
  private readonly densS: Smoother
  private readonly evoS: Smoother

  private tMix = 0.4
  private tGrow = 0.5
  private tDensity = 0.5
  private tSpace = 0.6
  private tRich = 0.4
  private tEvolve = 0.4

  constructor(sampleRate: number) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100
    const sr = this.sampleRate
    for (let i = 0; i < LINES; i++) {
      const max = Math.ceil(BASE_SEC[i] * 1.45 * sr) + 4
      this.lines.push(new DelayLine(max))
      this.lineMax.push(max)
      const lp = new OnePoleLP()
      lp.setCutoff(sr, 3800)
      this.damps.push(lp)
      this.evoPhase[i] = (i * 0.3819) % 1
    }
    this.loCutL.setCutoff(sr, 70)
    this.loCutR.setCutoff(sr, 70)
    for (let i = 0; i < DIFF_L.length; i++) {
      this.diffL.push(new AllpassDiffuser(DIFF_L[i] * sr, 0.62))
      this.diffR.push(new AllpassDiffuser(DIFF_R[i] * sr, 0.62))
    }
    this.shimA = new PitchShifter(sr, 0.1)
    this.shimB = new PitchShifter(sr, 0.12)
    this.shimA.setRatio(2)
    this.shimB.setRatio(2)
    this.shimPre.setCutoff(sr, 4200)

    this.mixS = new Smoother(sr, 0.02, 0.4)
    this.spaceS = new Smoother(sr, 0.3, 0.6)
    this.richS = new Smoother(sr, 0.05, 0.4)
    this.densS = new Smoother(sr, 0.05, 0.5)
    this.evoS = new Smoother(sr, 0.05, 0.4)
  }

  setParams({ mix, grow, density, space, rich, evolve }: BloomParams): void {
    this.tMix = clamp(mix, 0, 1)
    this.tGrow = clamp(grow, 0, 1)
    this.tDensity = clamp(density, 0, 1)
    this.tSpace = clamp(space, 0, 1)
    this.tRich = clamp(rich, 0, 1)
    this.tEvolve = clamp(evolve, 0, 1)
  }

  processInto(left: number, right: number, out: Float64Array): void {
    const l = Number.isFinite(left) ? left : 0
    const r = Number.isFinite(right) ? right : 0
    const sr = this.sampleRate

    const mix = this.mixS.process(this.tMix)
    const space = this.spaceS.process(this.tSpace)
    const rich = this.richS.process(this.tRich)
    const density = this.densS.process(this.tDensity)
    const evolve = this.evoS.process(this.tEvolve)

    // Brightness follows rich: dark wash -> harmonic sheen.
    // (Coefficient update per sample is avoided: OnePoleLP.setCutoff costs an
    // exp; only refresh when rich has drifted meaningfully.)
    // rich is smoothed slowly, so a small threshold keeps this rare.
    if (Math.abs(rich - this.lastRich) > 0.01) {
      const fc = 3000 + rich * 6000
      for (const d of this.damps) d.setCutoff(sr, fc)
      this.lastRich = rich
    }

    // --- diffuse input, warm it slightly -----------------------------------
    let dl = l
    let dr = r
    for (let i = 0; i < this.diffL.length; i++) {
      dl = this.diffL[i].process(dl)
      dr = this.diffR[i].process(dr)
    }
    dl = fastTanh(dl * 1.2) * 0.833
    dr = fastTanh(dr * 1.2) * 0.833
    // Keep DC/rumble out of the recirculating loop (it would accumulate).
    dl = this.loCutL.process(dl)
    dr = this.loCutR.process(dr)

    // --- energy governor: injection backs off as the pad fills up ----------
    const target = 0.35 + this.tGrow * 0.15
    const govern = (target * target) / (target * target + this.padMs)
    const injGain = this.tGrow * 0.28 * govern

    // --- read lines with evolve wobble --------------------------------------
    const vec = this.vec
    const sizeScale = 0.6 + space * 0.8
    for (let i = 0; i < LINES; i++) {
      this.evoPhase[i] += EVO_RATES[i] / sr
      if (this.evoPhase[i] >= 1) this.evoPhase[i] -= 1
      const wob = Math.sin(this.evoPhase[i] * 2 * Math.PI)
      const timeMod = wob * evolve * 0.0012 * sr
      const delay = clamp(BASE_SEC[i] * sizeScale * sr + timeMod, 1, this.lineMax[i] - 1)
      vec[i] = this.lines[i].read(delay)
    }

    // Wet taps.
    const wetLraw = vec[0] - vec[2] + vec[4]
    const wetRraw = vec[1] + vec[3] - vec[5]

    // --- pairwise rotations couple the lines (energy-preserving) -----------
    const theta = density * 0.7
    const ca = Math.cos(theta)
    const sa = Math.sin(theta)
    for (let i = 0; i < LINES; i += 2) {
      const a = vec[i]
      const b = vec[i + 1]
      vec[i] = a * ca + b * sa
      vec[i + 1] = -a * sa + b * ca
    }
    const ca2 = Math.cos(theta * 0.5)
    const sa2 = Math.sin(theta * 0.5)
    for (let i = 1; i < LINES; i += 2) {
      const j = (i + 1) % LINES
      const a = vec[i]
      const b = vec[j]
      vec[i] = a * ca2 + b * sa2
      vec[j] = -a * sa2 + b * ca2
    }

    // --- shimmer for rich (skipped entirely while rich is off) --------------
    let shimUpA = 0
    let shimUpB = 0
    if (rich > 1e-3) {
      const shimIn = this.shimPre.process((wetLraw + wetRraw) * 0.2)
      shimUpA = this.shimA.process(shimIn)
      shimUpB = this.shimB.process(shimIn)
    }

    // --- feedback with evolving per-line gain -------------------------------
    let padPow = 0
    for (let i = 0; i < LINES; i++) {
      // Base loop gain just under unity; evolve breathes it ±0.008.
      const wob = Math.sin((this.evoPhase[i] + 0.25) * 2 * Math.PI)
      let g = 0.99 + wob * evolve * 0.007
      if (g > 0.996) g = 0.996
      let fb = this.damps[i].process(vec[i] * g)
      if (i === 1) fb = lerp(fb, shimUpA, rich * 0.35)
      else if (i === 4) fb = lerp(fb, shimUpB, rich * 0.35)
      const inj = i % 2 === 0 ? dl : dr
      let w = fb + inj * injGain
      w = fastTanh(w * 0.6) * 1.6667 // soft ceiling, ~identity for |w|<0.5
      if (w < 1e-20 && w > -1e-20) w = 0
      this.lines[i].write(w)
      padPow += w * w
    }
    // Governor tracker (~0.6 s).
    const gCoeff = 1 - Math.exp(-1 / (0.6 * sr))
    this.padMs += gCoeff * (padPow / LINES - this.padMs)
    if (this.padMs < 1e-20) this.padMs = 0

    // --- output --------------------------------------------------------------
    const wetL = wetLraw * 0.5
    const wetR = wetRraw * 0.5
    const width = 0.4 + space * 0.6
    const mid = (wetL + wetR) * 0.5
    const side = (wetL - wetR) * 0.5 * width
    out[0] = l * (1 - mix) + (mid + side) * mix
    out[1] = r * (1 - mix) + (mid - side) * mix
  }

  private lastRich = -1

  process(left: number, right: number): [number, number] {
    this.processInto(left, right, this.scratch)
    return [this.scratch[0], this.scratch[1]]
  }

  reset(): void {
    for (const line of this.lines) line.reset()
    for (const d of this.damps) d.reset()
    for (const a of this.diffL) a.reset()
    for (const a of this.diffR) a.reset()
    this.loCutL.reset()
    this.loCutR.reset()
    this.shimA.reset()
    this.shimB.reset()
    this.shimPre.reset()
    this.vec.fill(0)
    this.padMs = 0
    for (let i = 0; i < LINES; i++) this.evoPhase[i] = (i * 0.3819) % 1
    this.mixS.reset(this.tMix)
    this.spaceS.reset(this.tSpace)
    this.richS.reset(this.tRich)
    this.densS.reset(this.tDensity)
    this.evoS.reset(this.tEvolve)
    this.lastRich = -1
  }
}

/**
 * Cloud — cinematic ambient reverb. An 8-line feedback delay network with
 * pre-diffusion, per-line damping, slow read-point modulation, optional
 * octave-up shimmer inside the loop, and a true unity-gain freeze.
 *
 * WHY an FDN and not stacked combs: the Hadamard feedback mix spreads every
 * line into every other line each sample, so energy densifies instead of
 * ringing at comb periods — that (plus mutually prime line lengths and gentle
 * read-point modulation) is what keeps the tail from turning metallic.
 *
 * Freeze: the loop crossfades to exactly unity feedback with damping and
 * input injection faded out. The limiter in the loop is identity below its
 * knee, so a held tail neither decays nor grows — indefinitely, click-free.
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
} from './util.ts'

export interface CloudParams {
  mix: number // 0..1 dry/wet
  size: number // 0..1 scales line lengths
  decay: number // 0..1 -> RT60 ~0.4s..22s
  bloom: number // 0..1 slow diffused swell of the injection
  mod: number // 0..1 read-point modulation depth ('Motion')
  width: number // 0..1 stereo width of the wet
  shimmer: number // 0..1 octave-up feedback blend
  freeze: number // 0..1 (>=0.5 => hold)
}

const LINES = 8
// Mutually prime base lengths (seconds) — spread over ~35..95 ms so the modal
// density is high before modulation even starts.
const BASE_SEC = [0.0353, 0.0411, 0.0491, 0.0567, 0.0641, 0.0729, 0.0821, 0.0937] as const
// Slow, phase-scattered LFOs; incommensurate rates so the pattern never loops.
const LFO_RATES = [0.11, 0.13, 0.17, 0.19, 0.23, 0.29, 0.31, 0.37] as const
// Pre-diffusion allpass lengths (seconds), mutually prime-ish, per channel.
const DIFF_SEC_L = [0.0047, 0.0071, 0.0101, 0.0143] as const
const DIFF_SEC_R = [0.0053, 0.0079, 0.0109, 0.0151] as const
// Long "bloom" diffusers that smear the injection into a swell.
const BLOOM_SEC_L = [0.0223, 0.0293] as const
const BLOOM_SEC_R = [0.0241, 0.0311] as const

/** Identity below the knee, soft above — keeps a frozen tail at exactly 1.0 gain. */
function kneeLimit(x: number): number {
  const t = 0.95
  const ax = Math.abs(x)
  if (ax <= t) return x
  const over = ax - t
  const soft = t + over / (1 + over * 4)
  return x > 0 ? soft : -soft
}

export class Cloud {
  private readonly sampleRate: number
  private readonly scratch = new Float64Array(2)

  private readonly lines: DelayLine[] = []
  private readonly lineMax: number[] = []
  private readonly damps: OnePoleLP[] = []
  private readonly loCuts: OnePoleHP[] = []
  private readonly diffL: AllpassDiffuser[] = []
  private readonly diffR: AllpassDiffuser[] = []
  private readonly bloomL: AllpassDiffuser[] = []
  private readonly bloomR: AllpassDiffuser[] = []
  private readonly shimmerL: PitchShifter
  private readonly shimmerR: PitchShifter
  private readonly shimmerPre = new OnePoleLP()

  // FDN working vector (preallocated — hot path must not allocate).
  private readonly vec = new Float64Array(LINES)
  private lfoPhase = new Float64Array(LINES)

  private readonly sizeS: Smoother
  private readonly mixS: Smoother
  private readonly widthS: Smoother
  private readonly modS: Smoother
  private readonly shimS: Smoother
  private readonly frzS: Smoother
  private readonly bloomGainS: Smoother
  // Slow attack / fast release envelope for the bloom swell.
  private bloomEnv = 0

  private tSize = 0.6
  private tDecay = 0.5
  private tBloom = 0.4
  private tMod = 0.3
  private tMix = 0.35
  private tWidth = 1
  private tShimmer = 0
  private tFreeze = 0

  constructor(sampleRate: number) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100
    const sr = this.sampleRate
    for (let i = 0; i < LINES; i++) {
      // 1.6x headroom over the largest size scaling (0.55 + 1.0).
      const max = Math.ceil(BASE_SEC[i] * 1.6 * sr) + 4
      this.lines.push(new DelayLine(max))
      this.lineMax.push(max)
      const lp = new OnePoleLP()
      lp.setCutoff(sr, 6500)
      this.damps.push(lp)
      const hp = new OnePoleHP()
      hp.setCutoff(sr, 110)
      this.loCuts.push(hp)
    }
    for (let i = 0; i < DIFF_SEC_L.length; i++) {
      this.diffL.push(new AllpassDiffuser(DIFF_SEC_L[i] * sr, 0.68))
      this.diffR.push(new AllpassDiffuser(DIFF_SEC_R[i] * sr, 0.68))
    }
    for (let i = 0; i < BLOOM_SEC_L.length; i++) {
      this.bloomL.push(new AllpassDiffuser(BLOOM_SEC_L[i] * sr, 0.55))
      this.bloomR.push(new AllpassDiffuser(BLOOM_SEC_R[i] * sr, 0.55))
    }
    this.shimmerL = new PitchShifter(sr, 0.09)
    this.shimmerR = new PitchShifter(sr, 0.11)
    this.shimmerL.setRatio(2)
    this.shimmerR.setRatio(2)
    this.shimmerPre.setCutoff(sr, 4800)

    this.sizeS = new Smoother(sr, 0.25, 0.6)
    this.mixS = new Smoother(sr, 0.02, 0.35)
    this.widthS = new Smoother(sr, 0.03, 1)
    this.modS = new Smoother(sr, 0.05, 0.3)
    this.shimS = new Smoother(sr, 0.05, 0)
    this.frzS = new Smoother(sr, 0.06, 0)
    this.bloomGainS = new Smoother(sr, 0.05, 0.4)
    // Scatter LFO phases deterministically so lines never move together.
    for (let i = 0; i < LINES; i++) this.lfoPhase[i] = (i * 0.61803) % 1
  }

  setParams({ mix, size, decay, bloom, mod, width, shimmer, freeze }: CloudParams): void {
    this.tMix = clamp(mix, 0, 1)
    this.tSize = clamp(size, 0, 1)
    this.tDecay = clamp(decay, 0, 1)
    this.tBloom = clamp(bloom, 0, 1)
    this.tMod = clamp(mod, 0, 1)
    this.tWidth = clamp(width, 0, 1)
    this.tShimmer = clamp(shimmer, 0, 1)
    this.tFreeze = clamp(freeze, 0, 1) >= 0.5 ? 1 : 0
  }

  processInto(left: number, right: number, out: Float64Array): void {
    const l = Number.isFinite(left) ? left : 0
    const r = Number.isFinite(right) ? right : 0
    const sr = this.sampleRate

    const size = this.sizeS.process(this.tSize)
    const mix = this.mixS.process(this.tMix)
    const width = this.widthS.process(this.tWidth)
    const mod = this.modS.process(this.tMod)
    const shim = this.shimS.process(this.tShimmer)
    const frz = this.frzS.process(this.tFreeze)
    const bloomAmt = this.bloomGainS.process(this.tBloom)

    // RT60 from decay (quadratic feel: most travel in the upper half).
    const rt60 = 0.4 + this.tDecay * this.tDecay * 21.6

    // --- input: pre-diffuse, then optionally smear/swell for bloom ----------
    let dl = l
    let dr = r
    for (let i = 0; i < this.diffL.length; i++) {
      dl = this.diffL[i].process(dl)
      dr = this.diffR[i].process(dr)
    }
    // Bloom path: extra long diffusion + slow-attack envelope on its gain so
    // energy leans into the space instead of arriving as a transient.
    let bl = dl
    let br = dr
    for (let i = 0; i < this.bloomL.length; i++) {
      bl = this.bloomL[i].process(bl)
      br = this.bloomR[i].process(br)
    }
    const inMag = Math.abs(dl) + Math.abs(dr)
    // Attack constant stretches with bloom (up to ~1.2 s); release is fast.
    const atk = 1 - Math.exp(-1 / ((0.05 + bloomAmt * 1.15) * sr))
    const rel = 1 - Math.exp(-1 / (0.08 * sr))
    this.bloomEnv += (inMag > this.bloomEnv ? atk : rel) * (inMag - this.bloomEnv)
    if (this.bloomEnv < 1e-20) this.bloomEnv = 0
    const swell = Math.min(1, this.bloomEnv * 2.5)
    const injL = lerp(dl, bl * swell, bloomAmt)
    const injR = lerp(dr, br * swell, bloomAmt)

    // --- read all lines (modulated), collect the FDN vector -----------------
    const vec = this.vec
    const sizeScale = 0.55 + size
    for (let i = 0; i < LINES; i++) {
      // Slow sine LFO per line; depth ≤ ~0.9 ms scaled by mod (and size so
      // small rooms don't warble).
      this.lfoPhase[i] += LFO_RATES[i] / sr
      if (this.lfoPhase[i] >= 1) this.lfoPhase[i] -= 1
      const wobble = Math.sin(this.lfoPhase[i] * 2 * Math.PI) * mod * 0.0009 * sr
      const delay = clamp(
        BASE_SEC[i] * sizeScale * sr + wobble,
        1,
        this.lineMax[i] - 1,
      )
      vec[i] = this.lines[i].read(delay)
    }

    // Wet taps (before feedback write): alternate lines to L/R with mixed
    // signs for decorrelation.
    const wetLraw = vec[0] + vec[2] - vec[4] + vec[6]
    const wetRraw = vec[1] - vec[3] + vec[5] + vec[7]

    // --- Hadamard mix (3-stage butterfly, in place) --------------------------
    for (let stage = 1; stage < LINES; stage <<= 1) {
      for (let i = 0; i < LINES; i += stage << 1) {
        for (let j = i; j < i + stage; j++) {
          const a = vec[j]
          const b = vec[j + stage]
          vec[j] = a + b
          vec[j + stage] = a - b
        }
      }
    }
    const norm = 0.35355339059327373 // 1/sqrt(8)

    // --- feedback: damping, decay gain, shimmer, freeze ---------------------
    // Per-line gain for the target RT60 at this line's nominal length.
    // Shifters are skipped entirely while shimmer is off (the smoother makes
    // the engage fade-in click-free even from empty shifter buffers).
    let shimL = 0
    let shimR = 0
    if (shim > 1e-3) {
      const shimIn = this.shimmerPre.process((wetLraw + wetRraw) * 0.25)
      shimL = this.shimmerL.process(shimIn)
      shimR = this.shimmerR.process(shimIn)
    }

    for (let i = 0; i < LINES; i++) {
      const lineSec = BASE_SEC[i] * sizeScale
      const g = Math.pow(10, (-3 * lineSec) / rt60)
      let fb = vec[i] * norm
      // Damping and low-cut fade out under freeze so the held tail keeps its
      // spectrum exactly (any in-loop filter at unity gain would decay it).
      const damped = this.damps[i].process(fb)
      fb = lerp(damped, fb, frz)
      const cut = this.loCuts[i].process(fb)
      fb = lerp(cut, fb, frz)
      // Shimmer replaces a slice of feedback on two lines with octave-up.
      if (i === 2) fb = lerp(fb, shimL, shim * 0.5)
      else if (i === 5) fb = lerp(fb, shimR, shim * 0.5)
      const gain = lerp(g, 1, frz)
      const inj = i % 2 === 0 ? injL : injR
      let w = fb * gain + inj * 0.4 * (1 - frz)
      w = kneeLimit(w)
      if (w < 1e-20 && w > -1e-20) w = 0
      this.lines[i].write(w)
    }

    // --- output: width, equal-power-ish mix ---------------------------------
    const wetL = wetLraw * 0.32
    const wetR = wetRraw * 0.32
    const mid = (wetL + wetR) * 0.5
    const side = (wetL - wetR) * 0.5 * width
    const wl = mid + side
    const wr = mid - side

    out[0] = l * (1 - mix) + wl * mix
    out[1] = r * (1 - mix) + wr * mix
  }

  process(left: number, right: number): [number, number] {
    this.processInto(left, right, this.scratch)
    return [this.scratch[0], this.scratch[1]]
  }

  reset(): void {
    for (const line of this.lines) line.reset()
    for (const d of this.damps) d.reset()
    for (const h of this.loCuts) h.reset()
    for (const a of this.diffL) a.reset()
    for (const a of this.diffR) a.reset()
    for (const a of this.bloomL) a.reset()
    for (const a of this.bloomR) a.reset()
    this.shimmerL.reset()
    this.shimmerR.reset()
    this.shimmerPre.reset()
    this.vec.fill(0)
    this.bloomEnv = 0
    for (let i = 0; i < LINES; i++) this.lfoPhase[i] = (i * 0.61803) % 1
    this.sizeS.reset(this.tSize)
    this.mixS.reset(this.tMix)
    this.widthS.reset(this.tWidth)
    this.modS.reset(this.tMod)
    this.shimS.reset(this.tShimmer)
    this.frzS.reset(this.tFreeze)
    this.bloomGainS.reset(this.tBloom)
  }
}

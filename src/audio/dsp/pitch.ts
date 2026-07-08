/**
 * Pitch — stereo pitch/interval shifter with three voicings. Pure,
 * deterministic, allocation-free hot path (mirrors delay.ts shape).
 *
 * WHY the semitone value (not the ratio) is smoothed: the audible artifact of
 * a pitch-knob move is a glissando in *pitch*, which is perceptually linear in
 * semitones. Smoothing semitones and deriving the ratio per sample gives an
 * even-sounding glide with no clicks; smoothing the ratio directly would warp
 * the glide and still step at knob quantization points.
 */
import { clamp, Smoother, PitchShifter, semitoneRatio } from './util.ts'

export interface PitchParams {
  pitch: number // -12..12 semitones
  fine: number // 0..1 -> -50..+50 cents (0.5 = 0)
  mode: number // 0..2: Single | Dual | Octaves
  spread: number // 0..1 stereo spread of the secondary voices
  mix: number // 0..1 dry/wet
}

const HALF_PI = Math.PI / 2
const QUARTER_PI = Math.PI / 4

export class Pitch {
  private readonly scratch = new Float64Array(2)
  // Two shifters per channel: A carries the primary voice in every mode,
  // B carries the mirrored detune (Dual) or the octave voices (Octaves).
  private readonly shLA: PitchShifter
  private readonly shRA: PitchShifter
  private readonly shLB: PitchShifter
  private readonly shRB: PitchShifter
  private readonly stAS: Smoother
  private readonly stBS: Smoother
  private readonly spreadS: Smoother
  private readonly mixS: Smoother
  // raw targets set per block (defaults mirror contracts.ts)
  private tStA = 0.08
  private tStB = -0.08
  private mode = 1
  private tSpread = 0.7
  private tMix = 0.5

  constructor(sampleRate: number) {
    const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100
    this.shLA = new PitchShifter(sr)
    this.shRA = new PitchShifter(sr)
    this.shLB = new PitchShifter(sr)
    this.shRB = new PitchShifter(sr)
    // ~30ms on the interval keeps knob turns glide-y but responsive.
    this.stAS = new Smoother(sr, 0.03, this.tStA)
    this.stBS = new Smoother(sr, 0.03, this.tStB)
    this.spreadS = new Smoother(sr, 0.02, this.tSpread)
    this.mixS = new Smoother(sr, 0.02, this.tMix)
  }

  setParams({ pitch, fine, mode, spread, mix }: PitchParams): void {
    const st = clamp(pitch, -12, 12)
    const cents = (clamp(fine, 0, 1) - 0.5) * 100
    // Voice A = interval + fine; voice B mirrors the detune, so with pitch 0
    // Dual is a classic +/-cents doubler.
    this.tStA = st + cents / 100
    this.tStB = st - cents / 100
    this.mode = Math.round(clamp(mode, 0, 2))
    this.tSpread = clamp(spread, 0, 1)
    this.tMix = clamp(mix, 0, 1)
  }

  processInto(left: number, right: number, out: Float64Array): void {
    const l = Number.isFinite(left) ? left : 0
    const r = Number.isFinite(right) ? right : 0
    const stA = this.stAS.process(this.tStA)
    const spread = this.spreadS.process(this.tSpread)
    const mix = this.mixS.process(this.tMix)
    const rA = semitoneRatio(stA)

    let wetL: number
    let wetR: number
    if (this.mode === 0) {
      // Single: one voice per channel, stereo preserved.
      this.shLA.setRatio(rA)
      this.shRA.setRatio(rA)
      wetL = this.shLA.process(l)
      wetR = this.shRA.process(r)
      // keep the B smoother tracking so a mode switch doesn't jump
      this.stBS.process(this.tStB)
    } else if (this.mode === 1) {
      // Dual: voice A (+cents) panned toward L, voice B (-cents) toward R.
      const rB = semitoneRatio(this.stBS.process(this.tStB))
      this.shLA.setRatio(rA)
      this.shRA.setRatio(rA)
      this.shLB.setRatio(rB)
      this.shRB.setRatio(rB)
      const aL = this.shLA.process(l)
      const aR = this.shRA.process(r)
      const bL = this.shLB.process(l)
      const bR = this.shRB.process(r)
      // Equal-power pan: spread 0 puts both voices centered (cos/sin at pi/4).
      const thA = (1 - spread) * QUARTER_PI
      const thB = (1 + spread) * QUARTER_PI
      wetL = aL * Math.cos(thA) + bL * Math.cos(thB)
      wetR = aR * Math.sin(thA) + bR * Math.sin(thB)
    } else {
      // Octaves: main stereo voice at pitch; octave-up/-down voices are fed
      // the mid signal (mono keeps it to one shifter each), sit ~-6dB under
      // the main voice, and get panned apart by spread.
      this.shLA.setRatio(rA)
      this.shRA.setRatio(rA)
      this.shLB.setRatio(rA * 2)
      this.shRB.setRatio(rA * 0.5)
      const mid = (l + r) * 0.5
      const mainL = this.shLA.process(l)
      const mainR = this.shRA.process(r)
      const up = this.shLB.process(mid)
      const down = this.shRB.process(mid)
      const thUp = (1 - spread) * QUARTER_PI
      const thDn = (1 + spread) * QUARTER_PI
      wetL = mainL + 0.5 * (up * Math.cos(thUp) + down * Math.cos(thDn))
      wetR = mainR + 0.5 * (up * Math.sin(thUp) + down * Math.sin(thDn))
      this.stBS.process(this.tStB)
    }

    // Equal-power dry/wet. mix 0 gives dry gain exactly 1 / wet gain exactly 0,
    // so the effect is bit-transparent when fully dry.
    const dryG = Math.cos(mix * HALF_PI)
    const wetG = Math.sin(mix * HALF_PI)
    out[0] = l * dryG + wetL * wetG
    out[1] = r * dryG + wetR * wetG
  }

  process(left: number, right: number): [number, number] {
    this.processInto(left, right, this.scratch)
    return [this.scratch[0], this.scratch[1]]
  }

  reset(): void {
    this.shLA.reset()
    this.shRA.reset()
    this.shLB.reset()
    this.shRB.reset()
    this.stAS.reset(this.tStA)
    this.stBS.reset(this.tStB)
    this.spreadS.reset(this.tSpread)
    this.mixS.reset(this.tMix)
  }
}

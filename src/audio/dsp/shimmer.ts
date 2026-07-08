/**
 * Shimmer — diffuse feedback reverb whose feedback path is partially pitch
 * shifted, so held notes bloom upward (or down) octave by octave. Pure,
 * deterministic, allocation-free hot path (mirrors delay.ts shape).
 *
 * WHY the 6kHz low-pass sits BEFORE the shifter: each loop pass shifts the
 * recirculating tail again, so highs stack toward the Nyquist and turn glassy.
 * Capping the shifter's input keeps repeated shifts silky; the tone filter
 * after the split then shapes the overall tail darkness independently.
 *
 * WHY the limiter is tanh(x*0.5)/0.5: near-unity slope below ~1 (quiet tails
 * pass uncolored) with a hard ceiling of 2, so even decay=1 + amount=1 is
 * strictly bounded — the loop gain never exceeds 0.97 and the state can't run
 * away.
 */
import {
  clamp,
  Smoother,
  DelayLine,
  OnePoleLP,
  DcBlocker,
  AllpassDiffuser,
  PitchShifter,
  fastTanh,
  semitoneRatio,
} from './util.ts'

export interface ShimmerParams {
  mix: number // 0..1 dry/wet
  amount: number // 0..1 how much of the feedback is pitch-shifted
  decay: number // 0..1 -> loop gain 0..0.97
  tone: number // 0..1 damping: 0 dark (~2kHz) .. 1 open (~12kHz)
  interval: number // 0..3: Oct+ | 5th+ | Oct- | Dual
}

// Semitone offsets per interval index; index 3 (Dual) runs +12 and -12 mixed.
const INTERVAL_ST = [12, 7, -12] as const
const MAX_LOOP_GAIN = 0.97
const CROSS = 0.15 // L/R feedback swap for a stable wide image

export class Shimmer {
  private readonly sampleRate: number
  private readonly scratch = new Float64Array(2)
  // Input diffusion: 3 allpasses per channel, mutually prime-ish lengths,
  // different L/R so the wash decorrelates.
  private readonly apL1: AllpassDiffuser
  private readonly apL2: AllpassDiffuser
  private readonly apL3: AllpassDiffuser
  private readonly apR1: AllpassDiffuser
  private readonly apR2: AllpassDiffuser
  private readonly apR3: AllpassDiffuser
  private readonly lineL: DelayLine
  private readonly lineR: DelayLine
  private readonly dsL: number
  private readonly dsR: number
  private readonly preL: OnePoleLP // fixed ~6kHz ahead of the shifters
  private readonly preR: OnePoleLP
  private readonly dampL: OnePoleLP // tone damping in the loop
  private readonly dampR: OnePoleLP
  private readonly dcL: DcBlocker
  private readonly dcR: DcBlocker
  // Two shifters per channel: A = primary interval, B = the -12 partner in Dual.
  private readonly shLA: PitchShifter
  private readonly shLB: PitchShifter
  private readonly shRA: PitchShifter
  private readonly shRB: PitchShifter
  private readonly amountS: Smoother
  private readonly decayS: Smoother
  private readonly mixS: Smoother
  private dual = false
  // raw targets set per block (defaults mirror contracts.ts)
  private tMix = 0.35
  private tAmount = 0.5
  private tDecay = 0.6

  constructor(sampleRate: number) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100
    const sr = this.sampleRate
    // Prime-ish millisecond lengths, deliberately different per channel.
    this.apL1 = new AllpassDiffuser(0.0043 * sr)
    this.apL2 = new AllpassDiffuser(0.0097 * sr)
    this.apL3 = new AllpassDiffuser(0.0151 * sr)
    this.apR1 = new AllpassDiffuser(0.0053 * sr)
    this.apR2 = new AllpassDiffuser(0.0113 * sr)
    this.apR3 = new AllpassDiffuser(0.0167 * sr)
    // Loop delays ~89/105ms, decorrelated L/R.
    this.dsL = Math.max(1, Math.round(0.0887 * sr))
    this.dsR = Math.max(1, Math.round(0.1049 * sr))
    this.lineL = new DelayLine(this.dsL + 4)
    this.lineR = new DelayLine(this.dsR + 4)
    this.preL = new OnePoleLP()
    this.preR = new OnePoleLP()
    this.preL.setCutoff(sr, 6000)
    this.preR.setCutoff(sr, 6000)
    this.dampL = new OnePoleLP()
    this.dampR = new OnePoleLP()
    this.dampL.setCutoff(sr, 4899) // tone 0.5 default
    this.dampR.setCutoff(sr, 4899)
    this.dcL = new DcBlocker()
    this.dcR = new DcBlocker()
    this.shLA = new PitchShifter(sr)
    this.shLB = new PitchShifter(sr)
    this.shRA = new PitchShifter(sr)
    this.shRB = new PitchShifter(sr)
    this.shLA.setRatio(2)
    this.shRA.setRatio(2)
    this.shLB.setRatio(0.5)
    this.shRB.setRatio(0.5)
    this.amountS = new Smoother(sr, 0.03, this.tAmount)
    this.decayS = new Smoother(sr, 0.05, this.tDecay)
    this.mixS = new Smoother(sr, 0.02, this.tMix)
  }

  setParams({ mix, amount, decay, tone, interval }: ShimmerParams): void {
    this.tMix = clamp(mix, 0, 1)
    this.tAmount = clamp(amount, 0, 1)
    this.tDecay = clamp(decay, 0, 1)
    // Log sweep 2kHz..12kHz — equal musical steps across the knob.
    const fc = 2000 * Math.pow(6, clamp(tone, 0, 1))
    this.dampL.setCutoff(this.sampleRate, fc)
    this.dampR.setCutoff(this.sampleRate, fc)
    const iv = Math.round(clamp(interval, 0, 3))
    this.dual = iv === 3
    if (this.dual) {
      this.shLA.setRatio(2)
      this.shRA.setRatio(2)
      this.shLB.setRatio(0.5)
      this.shRB.setRatio(0.5)
    } else {
      const r = semitoneRatio(INTERVAL_ST[iv])
      this.shLA.setRatio(r)
      this.shRA.setRatio(r)
    }
  }

  processInto(left: number, right: number, out: Float64Array): void {
    const l = Number.isFinite(left) ? left : 0
    const r = Number.isFinite(right) ? right : 0
    const amount = this.amountS.process(this.tAmount)
    const g = this.decayS.process(this.tDecay) * MAX_LOOP_GAIN
    const mix = this.mixS.process(this.tMix)

    // Diffuse the input into a wash before it enters the loop.
    const dinL = this.apL3.process(this.apL2.process(this.apL1.process(l)))
    const dinR = this.apR3.process(this.apR2.process(this.apR1.process(r)))

    // Loop tails (also the wet tap), then lightly cross-coupled feedback.
    const tL = this.lineL.read(this.dsL)
    const tR = this.lineR.read(this.dsR)
    const fbL = tL * (1 - CROSS) + tR * CROSS
    const fbR = tR * (1 - CROSS) + tL * CROSS

    // Shifted branch: pre-LP tames repeated up-shifts, then the shifter(s).
    const pL = this.preL.process(fbL)
    const pR = this.preR.process(fbR)
    let sL: number
    let sR: number
    if (this.dual) {
      sL = (this.shLA.process(pL) + this.shLB.process(pL)) * 0.5
      sR = (this.shRA.process(pR) + this.shRB.process(pR)) * 0.5
    } else {
      sL = this.shLA.process(pL)
      sR = this.shRA.process(pR)
    }

    // Blend plain/shifted feedback, damp, DC-block, scale by decay, soft-limit.
    let wL = this.dcL.process(this.dampL.process(fbL * (1 - amount) + sL * amount)) * g
    let wR = this.dcR.process(this.dampR.process(fbR * (1 - amount) + sR * amount)) * g
    wL = fastTanh(wL * 0.5) * 2
    wR = fastTanh(wR * 0.5) * 2
    if (wL < 1e-20 && wL > -1e-20) wL = 0
    if (wR < 1e-20 && wR > -1e-20) wR = 0
    this.lineL.write(dinL + wL)
    this.lineR.write(dinR + wR)

    out[0] = l * (1 - mix) + tL * mix
    out[1] = r * (1 - mix) + tR * mix
  }

  process(left: number, right: number): [number, number] {
    this.processInto(left, right, this.scratch)
    return [this.scratch[0], this.scratch[1]]
  }

  reset(): void {
    this.apL1.reset()
    this.apL2.reset()
    this.apL3.reset()
    this.apR1.reset()
    this.apR2.reset()
    this.apR3.reset()
    this.lineL.reset()
    this.lineR.reset()
    this.preL.reset()
    this.preR.reset()
    this.dampL.reset()
    this.dampR.reset()
    this.dcL.reset()
    this.dcR.reset()
    this.shLA.reset()
    this.shLB.reset()
    this.shRA.reset()
    this.shRB.reset()
    this.amountS.reset(this.tAmount)
    this.decayS.reset(this.tDecay)
    this.mixS.reset(this.tMix)
  }
}

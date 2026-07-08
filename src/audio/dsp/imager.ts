/**
 * Imager — Mid/Side stereo width, rotation, mono-safe bass and equal-power
 * balance. Pure, deterministic, allocation-free hot path (mirrors drive.ts
 * shape).
 *
 * At the contract defaults (width 1, rotate 0.5, bass 0, balance 0.5) every
 * stage degenerates to identity, so the effect is bit-near-transparent: the
 * smoothers are constructed *at* those defaults and the M/S round trip
 * m + s / m - s reconstructs L/R exactly (to rounding).
 *
 * WHY the bass stage is phase-safe: mono bass is achieved by removing the
 * low band of the *side* channel only (S_high = S - onePoleLP(S)). The mid
 * channel is never touched, so the mono fold-down (L+R)/2 == M is identical
 * with or without the filter — the one-pole's phase shift lives entirely
 * inside S and is never summed against an unshifted copy of itself, so no
 * comb filtering or cancellation can appear in the mono sum. The same
 * argument makes width changes mono-invariant: they only scale S.
 */
import { clamp, Smoother, TAU } from './util.ts'

export interface ImagerParams {
  width: number // 0..2 (1 = unity)
  rotate: number // 0..1 (0.5 = none; maps to -45..+45 degrees)
  bass: number // 0..300 Hz mono-below corner (0 = off)
  balance: number // 0..1 equal-power L/R balance (0.5 = center)
}

// Below this corner the side-low subtraction is faded out (inaudible anyway),
// which makes bass=0 exactly transparent while the LP state keeps leaking.
const BASS_FADE_HZ = 10

export class Imager {
  private readonly sampleRate: number
  private readonly scratch = new Float64Array(2)
  private readonly widthS: Smoother
  private readonly rotateS: Smoother
  private readonly bassS: Smoother
  private readonly balanceS: Smoother
  // raw targets, set per block; smoothers converge per sample in processInto
  private tWidth = 1
  private tRotate = 0.5
  private tBass = 0
  private tBalance = 0.5
  // one-pole low-pass state on the side channel (the mono-bass split)
  private sLow = 0

  constructor(sampleRate: number) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100
    this.widthS = new Smoother(this.sampleRate, 0.02, 1)
    this.rotateS = new Smoother(this.sampleRate, 0.02, 0.5)
    this.bassS = new Smoother(this.sampleRate, 0.02, 0)
    this.balanceS = new Smoother(this.sampleRate, 0.02, 0.5)
  }

  setParams({ width, rotate, bass, balance }: ImagerParams): void {
    this.tWidth = clamp(width, 0, 2)
    this.tRotate = clamp(rotate, 0, 1)
    this.tBass = clamp(bass, 0, 300)
    this.tBalance = clamp(balance, 0, 1)
  }

  processInto(left: number, right: number, out: Float64Array): void {
    const width = this.widthS.process(this.tWidth)
    const rotate = this.rotateS.process(this.tRotate)
    const bass = this.bassS.process(this.tBass)
    const balance = this.balanceS.process(this.tBalance)

    // Guard non-finite input so a single bad sample cannot latch the LP state.
    const l = Number.isFinite(left) ? left : 0
    const r = Number.isFinite(right) ? right : 0

    // M/S encode
    const m = 0.5 * (l + r)
    let s = 0.5 * (l - r)

    // Mono bass: track the side lows with a one-pole and subtract them (see
    // header for why this is phase-safe). The cutoff floor keeps the state
    // leaking (never frozen), and the subtraction fades to zero below
    // BASS_FADE_HZ so bass=0 is exactly transparent.
    const coeff = 1 - Math.exp((-TAU * clamp(bass, 0.1, 300)) / this.sampleRate)
    this.sLow += coeff * (s - this.sLow)
    if (this.sLow < 1e-20 && this.sLow > -1e-20) this.sLow = 0
    const monoAmt = bass >= BASS_FADE_HZ ? 1 : bass / BASS_FADE_HZ
    s -= this.sLow * monoAmt

    // Width scales the (remaining) side only — mono sum untouched.
    s *= width

    // M/S decode
    const l1 = m + s
    const r1 = m - s

    // Rotation: orthonormal matrix on (L, R); 0.5 -> 0 rad (exact identity),
    // extremes -> +/-45 degrees. Energy-preserving so output stays bounded.
    const theta = (rotate - 0.5) * (Math.PI / 2)
    const c = Math.cos(theta)
    const sn = Math.sin(theta)
    const l2 = l1 * c - r1 * sn
    const r2 = l1 * sn + r1 * c

    // Equal-power balance normalized to unity at center: sqrt(2)*cos/sin of
    // the pan angle gives gains (1, 1) at 0.5 and (sqrt(2), 0) at the ends —
    // balance 0 fully kills R while L keeps constant perceived power.
    const p = balance * (Math.PI / 2)
    out[0] = l2 * (Math.cos(p) * Math.SQRT2)
    out[1] = r2 * (Math.sin(p) * Math.SQRT2)
  }

  process(left: number, right: number): [number, number] {
    this.processInto(left, right, this.scratch)
    return [this.scratch[0], this.scratch[1]]
  }

  reset(): void {
    this.widthS.reset(this.tWidth)
    this.rotateS.reset(this.tRotate)
    this.bassS.reset(this.tBass)
    this.balanceS.reset(this.tBalance)
    this.sLow = 0
  }
}

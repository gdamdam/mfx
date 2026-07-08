/**
 * Freeze — capture a grain of recent audio and hold it forever as a pad. Pure,
 * deterministic, allocation-free hot path (mirrors drive.ts shape).
 *
 * WHY a continuous record ring + snapshot on engage: we always record the last
 * few hundred ms so that the instant Hold engages we can grab a grain that
 * already happened (no lookahead latency). The snapshot copies the *whole*
 * window (not just the current grain length) so Grain/Morph can be reshaped
 * while holding without touching stale data.
 *
 * WHY dual read heads: butting a grain's end against its start clicks once per
 * loop. Two heads scan the grain half a cycle apart under a constant-power
 * window (flat top, sin/cos equal-power edges), so each head is silent at its
 * own wrap point — the loop seam is inaudible at any grain size and the loop
 * gain is exactly 1 (the buffer is never rewritten), making infinite hold
 * drift-free. Morph widens the window's crossfaded edges: 0 = tight loop with
 * short fades, 1 = fully overlapped sin windows that smear the grain to a pad.
 *
 * WHY Width offsets the *phase* of the right channel's heads: a static phase
 * offset on the same loop reads the same material a few ms apart, which
 * decorrelates L/R into a wide image that cannot drift or beat (both channels
 * share one loop period). Every head latches new length/fade only at its own
 * zero-gain wrap, so Grain/Morph changes while holding are click-free.
 */
import { clamp, lerp, Smoother, DelayLine } from './util.ts'

export interface FreezeParams {
  hold: number // 0..1 (>=0.5 => freeze/loop)
  size: number // 0..1 grain length 50..400ms
  mix: number // 0..1 dry/wet (blend of frozen pad vs dry)
  // Optional (spec defaults) so pre-existing 3-param callers keep compiling.
  morph?: number // 0..1 loop crossfade proportion: tight loop -> smeared pad
  width?: number // 0..1 L/R decorrelation (0 = mono-ish, matches old behavior)
}

const HALF_PI = Math.PI / 2

export class Freeze {
  private readonly sampleRate: number
  private readonly scratch = new Float64Array(2)
  // Continuous record of recent input, one line per channel.
  private readonly recL: DelayLine
  private readonly recR: DelayLine
  // Snapshot grain buffers (preallocated to the max grain length).
  private readonly grainL: Float64Array
  private readonly grainR: Float64Array
  private readonly maxGrain: number
  private readonly mixS: Smoother
  // Width smooths so moving the knob slews the R offset instead of jumping it.
  private readonly widthS: Smoother
  // Per-sample increment for the ~20ms engage/release boundary ramp.
  private readonly rampInc: number
  private tHold = 0
  private tSize = 0.5
  private tMix = 1
  private tMorph = 0.5
  private tWidth = 0.3
  // Playback / state machine.
  private frozen = false
  private wasHolding = false
  // Master phase 0..1: head A sits at phase, head B half a cycle later. Each
  // head latches its own length/fade at its own zero-gain wrap.
  private phase = 0
  private lenAL = 4
  private lenBL = 4
  private lenAR = 4
  private lenBR = 4
  private fadeAL = 0.25
  private fadeBL = 0.25
  private fadeAR = 0.25
  private fadeBR = 0.25
  private bLatched = false
  // Previous right-head phases, for wrap detection under the width offset.
  private prevPRA = 0
  private prevPRB = 0
  // Boundary envelope 0..1: crossfades dry<->frozen so engage/release don't click.
  private env = 0

  constructor(sampleRate: number) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100
    // 400ms max grain; record line must hold at least that much history.
    this.maxGrain = Math.ceil(0.4 * this.sampleRate) + 8
    this.recL = new DelayLine(this.maxGrain + 8)
    this.recR = new DelayLine(this.maxGrain + 8)
    this.grainL = new Float64Array(this.maxGrain)
    this.grainR = new Float64Array(this.maxGrain)
    this.mixS = new Smoother(this.sampleRate, 0.02, 1)
    this.widthS = new Smoother(this.sampleRate, 0.05, 0.3)
    this.rampInc = 1 / Math.max(1, 0.02 * this.sampleRate)
  }

  setParams({ hold, size, mix, morph = 0.5, width = 0.3 }: FreezeParams): void {
    this.tHold = clamp(hold, 0, 1)
    this.tSize = clamp(size, 0, 1)
    this.tMix = clamp(mix, 0, 1)
    this.tMorph = clamp(morph, 0, 1)
    this.tWidth = clamp(width, 0, 1)
  }

  /** Grain length in samples for the current Size (50..400ms). */
  private targetLen(): number {
    const raw = Math.floor((0.05 + this.tSize * 0.35) * this.sampleRate)
    return Math.max(16, Math.min(this.maxGrain, raw))
  }

  /** Window fade fraction for the current Morph (tight 3% .. full 50%). */
  private targetFade(): number {
    return lerp(0.03, 0.5, this.tMorph)
  }

  /**
   * Constant-power head window over phase 0..1: sin rise over [0,f], flat 1
   * over [f,0.5], cos fall over [0.5,0.5+f], silent after. With heads half a
   * cycle apart, gA^2+gB^2 == 1 for any f, so loop loudness never pumps.
   */
  private win(p: number, f: number): number {
    if (p < f) return Math.sin(HALF_PI * (p / f))
    if (p <= 0.5) return 1
    if (p < 0.5 + f) return Math.cos(HALF_PI * ((p - 0.5) / f))
    return 0
  }

  /** Interpolated read of the newest `len` samples at loop phase `p` (0..1). */
  private readGrain(buf: Float64Array, len: number, p: number): number {
    const pos = this.maxGrain - len + p * (len - 1)
    const i0 = Math.floor(pos)
    const i1 = i0 + 1 < this.maxGrain ? i0 + 1 : this.maxGrain - 1
    const frac = pos - i0
    return buf[i0] * (1 - frac) + buf[i1] * frac
  }

  /** Snapshot the whole record window into the grain buffers. */
  private capture(): void {
    // read(maxGrain - i): i=0 => oldest of the window, i=maxGrain-1 => newest.
    for (let i = 0; i < this.maxGrain; i++) {
      this.grainL[i] = this.recL.read(this.maxGrain - i)
      this.grainR[i] = this.recR.read(this.maxGrain - i)
    }
    const len = this.targetLen()
    const fade = this.targetFade()
    this.lenAL = this.lenBL = this.lenAR = this.lenBR = len
    this.fadeAL = this.fadeBL = this.fadeAR = this.fadeBR = fade
    this.phase = 0
    this.bLatched = false
    this.prevPRA = 0
    this.prevPRB = 0
    // Snap width so a fresh engage starts at the requested image immediately
    // (and width=0 is exactly mono, matching the pre-width behavior).
    this.widthS.reset(this.tWidth)
    this.frozen = true
  }

  processInto(left: number, right: number, out: Float64Array): void {
    const l = Number.isFinite(left) ? left : 0
    const r = Number.isFinite(right) ? right : 0
    const mix = this.mixS.process(this.tMix)

    // Always keep recording so a grain is ready the moment Hold engages.
    this.recL.write(l)
    this.recR.write(r)

    const holding = this.tHold >= 0.5
    // Re-capture on each fresh engage (idle -> frozen transition).
    if (holding && !this.wasHolding) this.capture()
    this.wasHolding = holding

    // Ramp the boundary envelope toward frozen (1) or dry (0). Keep the grain
    // playing while it fades out so release returns to dry smoothly (no click).
    const target = holding ? 1 : 0
    if (this.env < target) this.env = Math.min(target, this.env + this.rampInc)
    else if (this.env > target) this.env = Math.max(target, this.env - this.rampInc)

    if (!this.frozen) {
      // No pad to blend — pass the dry signal straight through.
      out[0] = l
      out[1] = r
      return
    }

    // --- Advance the master phase; latch head params only at zero gain. ---
    this.phase += 1 / this.lenAL
    if (this.phase >= 1) {
      this.phase -= 1
      this.lenAL = this.targetLen()
      this.fadeAL = this.targetFade()
    }
    if (this.phase >= 0.5 && !this.bLatched) {
      this.lenBL = this.targetLen()
      this.fadeBL = this.targetFade()
      this.bLatched = true
    } else if (this.phase < 0.5) {
      this.bLatched = false
    }
    const pA = this.phase
    const pB = pA < 0.5 ? pA + 0.5 : pA - 0.5

    // Right-channel heads ride a static phase offset (up to ~12ms) for width.
    const w = this.widthS.process(this.tWidth)
    const off = Math.min(0.45, (w * 0.012 * this.sampleRate) / this.lenAL)
    let pRA = pA + off
    if (pRA >= 1) pRA -= 1
    let pRB = pB + off
    if (pRB >= 1) pRB -= 1
    if (pRA < this.prevPRA) {
      this.lenAR = this.targetLen()
      this.fadeAR = this.targetFade()
    }
    if (pRB < this.prevPRB) {
      this.lenBR = this.targetLen()
      this.fadeBR = this.targetFade()
    }
    this.prevPRA = pRA
    this.prevPRB = pRB

    // --- Constant-power dual-head playback. ---
    const gAL = this.win(pA, this.fadeAL)
    const gBL = this.win(pB, this.fadeBL)
    const gAR = this.win(pRA, this.fadeAR)
    const gBR = this.win(pRB, this.fadeBR)
    let padL = 0
    let padR = 0
    if (gAL > 0) padL += gAL * this.readGrain(this.grainL, this.lenAL, pA)
    if (gBL > 0) padL += gBL * this.readGrain(this.grainL, this.lenBL, pB)
    if (gAR > 0) padR += gAR * this.readGrain(this.grainR, this.lenAR, pRA)
    if (gBR > 0) padR += gBR * this.readGrain(this.grainR, this.lenBR, pRB)

    // env scales the wet blend: at env=0 the output is pure dry (matches the
    // dry sample), so both engage and release are click-free ramps.
    const wet = mix * this.env
    out[0] = l * (1 - wet) + padL * wet
    out[1] = r * (1 - wet) + padR * wet

    // Fully faded back to dry and no longer held: release the grain.
    if (!holding && this.env <= 0) this.frozen = false
  }

  process(left: number, right: number): [number, number] {
    this.processInto(left, right, this.scratch)
    return [this.scratch[0], this.scratch[1]]
  }

  reset(): void {
    this.recL.reset()
    this.recR.reset()
    this.grainL.fill(0)
    this.grainR.fill(0)
    this.frozen = false
    this.wasHolding = false
    this.phase = 0
    this.bLatched = false
    this.prevPRA = 0
    this.prevPRB = 0
    this.env = 0
    this.mixS.reset(this.tMix)
    this.widthS.reset(this.tWidth)
  }
}

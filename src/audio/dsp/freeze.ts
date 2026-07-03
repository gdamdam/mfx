/**
 * Freeze — capture a grain of recent audio and loop it forever as a pad. Pure,
 * deterministic, allocation-free hot path (mirrors drive.ts shape).
 *
 * WHY a continuous record ring + snapshot on engage: we always record the last
 * few hundred ms so that the instant Hold engages we can grab a grain that
 * already happened (no lookahead latency). WHY the equal-power crossfade at the
 * loop seam: the grain's end and start won't line up in phase, so butting them
 * together clicks once per loop. Overlapping the tail into the head with a
 * sqrt (constant-power) fade hides the seam and keeps loudness steady.
 */
import { clamp, Smoother, DelayLine } from './util.ts'

export interface FreezeParams {
  hold: number // 0..1 (>=0.5 => freeze/loop)
  size: number // 0..1 grain length 50..400ms
  mix: number // 0..1 dry/wet (blend of frozen pad vs dry)
}

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
  // Per-sample increment for the ~8ms engage/release boundary ramp.
  private readonly rampInc: number
  private tHold = 0
  private tSize = 0.5
  private tMix = 1
  // Playback / state machine.
  private frozen = false
  private wasHolding = false
  private grainLen = 0
  private xfade = 0
  private grainPos = 0
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
    this.rampInc = 1 / Math.max(1, 0.008 * this.sampleRate)
  }

  setParams({ hold, size, mix }: FreezeParams): void {
    this.tHold = clamp(hold, 0, 1)
    this.tSize = clamp(size, 0, 1)
    this.tMix = clamp(mix, 0, 1)
  }

  /** Snapshot the last `grainLen` samples out of the record ring into the grain. */
  private capture(): void {
    // 50..400ms, clamped to the preallocated buffer.
    const raw = Math.floor((0.05 + clamp(this.tSize, 0, 1) * 0.35) * this.sampleRate)
    const L = Math.max(4, Math.min(this.maxGrain, raw))
    // Crossfade region: quarter of the grain, capped at 30ms.
    let xf = Math.min(Math.floor(L * 0.25), Math.floor(0.03 * this.sampleRate))
    if (xf < 1) xf = 1
    // read(L - i): i=0 => oldest of the window, i=L-1 => newest.
    for (let i = 0; i < L; i++) {
      this.grainL[i] = this.recL.read(L - i)
      this.grainR[i] = this.recR.read(L - i)
    }
    this.grainLen = L
    this.xfade = xf
    this.grainPos = 0
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

    const L = this.grainLen
    const xf = this.xfade
    const loopLen = L - xf
    let pos = this.grainPos
    let gl = this.grainL[pos]
    let gr = this.grainR[pos]
    if (pos < xf) {
      // Blend the fading-in head against the fading-out tail (constant power).
      const t = pos / xf
      const gIn = Math.sqrt(t)
      const gOut = Math.sqrt(1 - t)
      const tail = pos + loopLen
      gl = gl * gIn + this.grainL[tail] * gOut
      gr = gr * gIn + this.grainR[tail] * gOut
    }
    pos++
    if (pos >= loopLen) pos = 0
    this.grainPos = pos

    // env scales the wet blend: at env=0 the output is pure dry (matches the
    // dry sample), so both engage and release are click-free ramps.
    const w = mix * this.env
    out[0] = l * (1 - w) + gl * w
    out[1] = r * (1 - w) + gr * w

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
    this.grainLen = 0
    this.xfade = 0
    this.grainPos = 0
    this.env = 0
    this.mixS.reset(this.tMix)
  }
}

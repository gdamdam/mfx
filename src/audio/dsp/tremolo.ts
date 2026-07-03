/**
 * Tremolo — amplitude modulation by an LFO whose shape morphs from sine to
 * square. Both channels share the same gain so it reads as pure amplitude
 * movement rather than panning. Allocation-free hot path.
 *
 * Follows the reference core shape (see drive.ts).
 */
import { clamp, Smoother, TAU } from './util.ts'

// Pre-normalised so the softened square peaks at unity like the raw sine.
const SQUARE_DRIVE = 6
const SQUARE_NORM = 1 / Math.tanh(SQUARE_DRIVE)

export interface TremoloParams {
  rate: number // 0.1..16 Hz  LFO speed
  depth: number // 0..1  0 = no effect, 1 = full modulation
  shape: number // 0..1  sine -> square
}

export class Tremolo {
  private readonly sampleRate: number
  private readonly scratch = new Float64Array(2)
  private readonly depthS: Smoother
  private readonly shapeS: Smoother
  // raw targets; depth+shape smooth per sample, rate drives the phase accumulator
  private tRate = 5
  private tDepth = 0.6
  private tShape = 0
  private phase = 0

  constructor(sampleRate: number) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100
    this.depthS = new Smoother(this.sampleRate, 0.02, 0.6)
    this.shapeS = new Smoother(this.sampleRate, 0.02, 0)
  }

  setParams({ rate, depth, shape }: TremoloParams): void {
    this.tRate = clamp(rate, 0.1, 16)
    this.tDepth = clamp(depth, 0, 1)
    this.tShape = clamp(shape, 0, 1)
  }

  processInto(left: number, right: number, out: Float64Array): void {
    const depth = this.depthS.process(this.tDepth)
    const shape = this.shapeS.process(this.tShape)
    const l = Number.isFinite(left) ? left : 0
    const r = Number.isFinite(right) ? right : 0

    this.phase += this.tRate / this.sampleRate
    if (this.phase >= 1) this.phase -= 1

    const sine = Math.sin(TAU * this.phase)
    // tanh drive rounds a sine toward a square; blend by shape.
    const square = Math.tanh(sine * SQUARE_DRIVE) * SQUARE_NORM
    const lfo = sine * (1 - shape) + square * shape
    // Map bipolar LFO to a 0..1 gain window scaled by depth: depth 0 leaves the
    // gain pinned at unity (no effect), depth 1 dips fully to silence.
    const unipolar = 0.5 + 0.5 * lfo
    const gain = 1 - depth * (1 - unipolar)

    out[0] = l * gain
    out[1] = r * gain
  }

  process(left: number, right: number): [number, number] {
    this.processInto(left, right, this.scratch)
    return [this.scratch[0], this.scratch[1]]
  }

  reset(): void {
    this.phase = 0
    this.depthS.reset(this.tDepth)
    this.shapeS.reset(this.tShape)
  }
}

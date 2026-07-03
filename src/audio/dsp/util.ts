/**
 * Shared DSP helpers for pure effect cores. Framework-free, deterministic,
 * allocation-free in the hot path. No Date.now / Math.random (seed the RNG).
 */

export const TAU = Math.PI * 2

/** Finite-safe clamp (mirrors contracts.clamp; kept local so cores stay DOM/framework-free). */
export function clamp(v: number, min: number, max: number): number {
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : min
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20)
}

/** Linear interpolation. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/**
 * One-pole parameter smoother — removes zipper noise when a control jumps.
 * `setTime` gives the ~63% convergence time in seconds at a sample rate.
 */
export class Smoother {
  private y = 0
  private coeff = 0

  constructor(sampleRate: number, timeSeconds = 0.02, initial = 0) {
    this.y = Number.isFinite(initial) ? initial : 0
    this.setTime(sampleRate, timeSeconds)
  }

  setTime(sampleRate: number, timeSeconds: number): void {
    const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100
    const t = Math.max(1e-4, timeSeconds)
    this.coeff = Math.exp(-1 / (t * sr))
  }

  /** Jump instantly to a value (use on reset / preset load). */
  reset(value: number): void {
    this.y = Number.isFinite(value) ? value : 0
  }

  process(target: number): number {
    const t = Number.isFinite(target) ? target : 0
    this.y = t + (this.y - t) * this.coeff
    // Flush denormals: JS has no FTZ, so a state decaying toward zero drifts into
    // the denormal range and can stall the CPU. Snap sub-audible values to 0.
    if (this.y < 1e-20 && this.y > -1e-20) this.y = 0
    return this.y
  }

  get value(): number {
    return this.y
  }
}

/** Deterministic XorShift32 PRNG — seedable so DSP tests are reproducible. */
export class Rng {
  private state: number

  constructor(seed = 0x9e3779b9) {
    this.state = seed >>> 0 || 0x9e3779b9
  }

  /** Uniform in [0, 1). */
  next(): number {
    let x = this.state
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    this.state = x >>> 0
    return this.state / 0x100000000
  }

  /** Bipolar noise in [-1, 1). */
  bipolar(): number {
    return this.next() * 2 - 1
  }
}

/**
 * Fractional-delay line with linear interpolation. Stereo-agnostic (one per
 * channel). Allocation happens once in the constructor; reads/writes are cheap.
 */
export class DelayLine {
  private readonly buffer: Float64Array
  private readonly size: number
  private writeIndex = 0

  constructor(maxSamples: number) {
    this.size = Math.max(2, Math.floor(maxSamples))
    this.buffer = new Float64Array(this.size)
  }

  reset(): void {
    this.buffer.fill(0)
    this.writeIndex = 0
  }

  write(sample: number): void {
    this.buffer[this.writeIndex] = Number.isFinite(sample) ? sample : 0
    this.writeIndex = (this.writeIndex + 1) % this.size
  }

  /** Read `delaySamples` in the past with linear interpolation. */
  read(delaySamples: number): number {
    const d = clamp(delaySamples, 0, this.size - 1)
    const readPos = this.writeIndex - 1 - d + this.size
    const i0 = Math.floor(readPos) % this.size
    const i1 = (i0 + 1) % this.size
    const frac = readPos - Math.floor(readPos)
    return this.buffer[i0] * (1 - frac) + this.buffer[i1] * frac
  }
}

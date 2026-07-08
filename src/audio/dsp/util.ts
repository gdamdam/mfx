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

/** 2^(st/12) — semitone interval to playback ratio. */
export function semitoneRatio(st: number): number {
  return Math.pow(2, clamp(st, -48, 48) / 12)
}

/**
 * Cheap tanh approximation (Padé 3/2), hard-clamped to ±1. Within ~0.02 of
 * Math.tanh over the audible range — inaudible for saturation duty — and
 * strictly bounded, so it is safe inside feedback loops where Math.tanh per
 * line per sample would dominate the budget.
 */
export function fastTanh(x: number): number {
  if (!Number.isFinite(x)) return 0
  if (x > 3) return 1
  if (x < -3) return -1
  const x2 = x * x
  const y = (x * (27 + x2)) / (27 + 9 * x2)
  return y > 1 ? 1 : y < -1 ? -1 : y
}

/** One-pole low-pass. `setCutoff` precomputes the coefficient outside hot loops. */
export class OnePoleLP {
  private y = 0
  private a = 1

  setCutoff(sampleRate: number, hz: number): void {
    const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100
    const fc = clamp(hz, 0.1, sr * 0.49)
    this.a = 1 - Math.exp((-TAU * fc) / sr)
  }

  reset(value = 0): void {
    this.y = Number.isFinite(value) ? value : 0
  }

  process(x: number): number {
    const v = Number.isFinite(x) ? x : 0
    this.y += this.a * (v - this.y)
    if (this.y < 1e-20 && this.y > -1e-20) this.y = 0
    return this.y
  }

  get value(): number {
    return this.y
  }
}

/** One-pole high-pass (input minus tracked low-pass). */
export class OnePoleHP {
  private readonly lp = new OnePoleLP()

  setCutoff(sampleRate: number, hz: number): void {
    this.lp.setCutoff(sampleRate, hz)
  }

  reset(): void {
    this.lp.reset(0)
  }

  process(x: number): number {
    const v = Number.isFinite(x) ? x : 0
    return v - this.lp.process(v)
  }
}

/** DC blocker — leaky differentiator, ~5 Hz corner at 48 kHz. */
export class DcBlocker {
  private x1 = 0
  private y1 = 0

  reset(): void {
    this.x1 = 0
    this.y1 = 0
  }

  process(x: number): number {
    const v = Number.isFinite(x) ? x : 0
    let y = v - this.x1 + 0.9995 * this.y1
    if (y < 1e-20 && y > -1e-20) y = 0
    this.x1 = v
    this.y1 = y
    return y
  }
}

/**
 * Schroeder allpass diffuser stage: y = -g*x + d + g*y where d is the delayed
 * input+feedback. Chains of these with mutually prime lengths turn discrete
 * echoes into a smooth wash without coloring the long-term spectrum.
 */
export class AllpassDiffuser {
  private readonly line: DelayLine
  private readonly delaySamples: number
  private g: number

  constructor(delaySamples: number, gain = 0.6) {
    this.delaySamples = Math.max(1, Math.floor(delaySamples))
    this.line = new DelayLine(this.delaySamples + 2)
    this.g = clamp(gain, -0.95, 0.95)
  }

  setGain(g: number): void {
    this.g = clamp(g, -0.95, 0.95)
  }

  reset(): void {
    this.line.reset()
  }

  process(x: number): number {
    const v = Number.isFinite(x) ? x : 0
    const d = this.line.read(this.delaySamples)
    const w = v + d * this.g
    this.line.write(w)
    return d - w * this.g
  }
}

/**
 * Delay-based dual-tap pitch shifter (granular "doppler" style). Two taps ride
 * a shared circular buffer half a window apart; each fades with a sin ramp as
 * its read pointer wraps, so the splice points are inaudible. Smooth and cheap
 * — the right trade for shimmer/harmonizer duty (an FFT vocoder would cost far
 * more for marginal gain on pads).
 */
export class PitchShifter {
  private readonly line: DelayLine
  private readonly winSamples: number
  private phase = 0
  private ratio = 1

  constructor(sampleRate: number, windowSeconds = 0.085) {
    const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100
    this.winSamples = Math.max(64, Math.floor(clamp(windowSeconds, 0.01, 0.3) * sr))
    this.line = new DelayLine(this.winSamples + 4)
  }

  /** Playback ratio: 2 = octave up, 0.5 = octave down. Caller smooths. */
  setRatio(ratio: number): void {
    this.ratio = clamp(ratio, 0.25, 4)
  }

  reset(): void {
    this.line.reset()
    this.phase = 0
  }

  process(x: number): number {
    this.line.write(Number.isFinite(x) ? x : 0)
    // phase walks 0..1; tap delay = phase * window. ratio>1 shortens the
    // effective read distance over time (pitch up), <1 lengthens it.
    this.phase += (1 - this.ratio) / this.winSamples
    this.phase -= Math.floor(this.phase)
    const p1 = this.phase
    const p2 = p1 + 0.5 - Math.floor(p1 + 0.5)
    const d1 = p1 * (this.winSamples - 2)
    const d2 = p2 * (this.winSamples - 2)
    // sin ramps sum to constant power across the crossfade.
    const g1 = Math.sin(Math.PI * p1)
    const g2 = Math.sin(Math.PI * p2)
    return this.line.read(d1) * g1 + this.line.read(d2) * g2
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

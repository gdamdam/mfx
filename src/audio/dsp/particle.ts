/**
 * Particle — granular echo engine. A stereo rolling record buffer is tapped by
 * a fixed pool of grains: each spawns on a deterministic scheduler, reads from
 * ~`time` seconds back (± scatter jitter), plays at a per-grain pitch ratio,
 * pans with equal power, and fades under a shared Hann window. Pure,
 * deterministic (seeded Rng), allocation-free hot path.
 *
 * WHY the spawn interval scales with grain size: at high density the interval
 * shrinks to well under half the grain duration, so Hann windows overlap into
 * a smooth wash instead of machine-gun clicks. Wet output re-enters the record
 * buffer through fastTanh, so feedback can smear forever but never run away.
 */
import {
  clamp,
  lerp,
  Smoother,
  DelayLine,
  Rng,
  fastTanh,
  semitoneRatio,
  TAU,
} from './util.ts'

export interface ParticleParams {
  time: number // 0.05..1.2 seconds back the grains read from
  density: number // 0..1 spawn rate (1 => overlapping wash)
  size: number // 0.02..0.3 seconds per grain
  pitch: number // -12..12 semitones (fixed per grain at spawn)
  scatter: number // 0..1 read-position jitter (up to ±time/2)
  spread: number // 0..1 random pan width
  feedback: number // 0..0.9 wet re-entry into the record buffer
  mix: number // 0..1 dry/wet
}

const SEED = 0x51ac7e1d
const MAX_GRAINS = 16
const HANN_SIZE = 2048
const BUFFER_SECONDS = 2.5

export class Particle {
  private readonly sampleRate: number
  private readonly scratch = new Float64Array(2)
  private readonly lineL: DelayLine
  private readonly lineR: DelayLine
  private readonly hann: Float64Array
  // Grain voice pool — parallel state arrays, allocated once here.
  private readonly gActive = new Uint8Array(MAX_GRAINS)
  private readonly gAge = new Float64Array(MAX_GRAINS) // output samples elapsed
  private readonly gDur = new Float64Array(MAX_GRAINS) // duration in samples
  private readonly gDelay = new Float64Array(MAX_GRAINS) // read delay at spawn, samples
  private readonly gRatio = new Float64Array(MAX_GRAINS) // playback ratio (pitch)
  private readonly gGainL = new Float64Array(MAX_GRAINS)
  private readonly gGainR = new Float64Array(MAX_GRAINS)
  private rng = new Rng(SEED)
  private spawnCountdown = 0
  private readonly fbS: Smoother
  private readonly mixS: Smoother
  // raw targets set per block
  private tTime = 0.3
  private tDensity = 0.5
  private tSize = 0.09
  private tPitch = 0
  private tScatter = 0.3
  private tSpread = 0.6
  private tFeedback = 0.35
  private tMix = 0.4

  constructor(sampleRate: number) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100
    this.lineL = new DelayLine(Math.ceil(BUFFER_SECONDS * this.sampleRate) + 4)
    this.lineR = new DelayLine(Math.ceil(BUFFER_SECONDS * this.sampleRate) + 4)
    // One shared Hann table; grains index into it (no per-grain allocation).
    this.hann = new Float64Array(HANN_SIZE)
    for (let i = 0; i < HANN_SIZE; i++) {
      this.hann[i] = 0.5 * (1 - Math.cos((TAU * i) / (HANN_SIZE - 1)))
    }
    this.fbS = new Smoother(this.sampleRate, 0.02, 0.35)
    this.mixS = new Smoother(this.sampleRate, 0.02, 0.4)
  }

  setParams({ time, density, size, pitch, scatter, spread, feedback, mix }: ParticleParams): void {
    this.tTime = clamp(time, 0.05, 1.2)
    this.tDensity = clamp(density, 0, 1)
    this.tSize = clamp(size, 0.02, 0.3)
    this.tPitch = clamp(pitch, -12, 12)
    this.tScatter = clamp(scatter, 0, 1)
    this.tSpread = clamp(spread, 0, 1)
    this.tFeedback = clamp(feedback, 0, 0.9)
    this.tMix = clamp(mix, 0, 1)
  }

  /** Spawn interval in seconds: sparse at density 0, <= size/2 at density 1. */
  private baseIntervalSec(): number {
    return lerp(this.tSize * 2.5 + 0.05, this.tSize * 0.35, this.tDensity)
  }

  /**
   * Attempt to spawn one grain. Called by the sample-rate scheduler; skips
   * (voice stealing = none) when the pool is full. Rng draw order is fixed so
   * two instances with identical inputs stay sample-identical.
   */
  private spawn(): void {
    let v = -1
    for (let i = 0; i < MAX_GRAINS; i++) {
      if (this.gActive[i] === 0) {
        v = i
        break
      }
    }
    if (v < 0) return

    const jitterSec = this.rng.bipolar() * this.tScatter * (this.tTime * 0.5)
    const pan = this.rng.bipolar() * this.tSpread

    const dur = Math.max(32, Math.floor(this.tSize * this.sampleRate))
    const ratio = semitoneRatio(this.tPitch)
    // Pitched-up grains consume the buffer faster than it fills, so the read
    // delay shrinks over the grain's life; clamp the start so it never crosses
    // the write head (and never falls off the buffer tail when pitched down).
    const maxDelay = this.lineSize() - dur * Math.max(0, 1 - ratio) - 2
    const minDelay = dur * Math.max(0, ratio - 1) + 2
    const delay = clamp((this.tTime + jitterSec) * this.sampleRate, minDelay, maxDelay)

    // Level compensation: keep the wash at roughly constant loudness as
    // overlap rises with density (sqrt because overlapping windows sum power).
    const overlap = (this.tSize / this.baseIntervalSec()) * 0.5
    const amp = 1 / Math.sqrt(Math.max(1, overlap))
    // Equal-power pan, normalized so a centered grain is unity per channel.
    const theta = ((pan + 1) * Math.PI) / 4

    this.gActive[v] = 1
    this.gAge[v] = 0
    this.gDur[v] = dur
    this.gDelay[v] = delay
    this.gRatio[v] = ratio
    this.gGainL[v] = Math.cos(theta) * Math.SQRT2 * amp
    this.gGainR[v] = Math.sin(theta) * Math.SQRT2 * amp
  }

  private lineSize(): number {
    return Math.ceil(BUFFER_SECONDS * this.sampleRate) + 4
  }

  processInto(left: number, right: number, out: Float64Array): void {
    const l = Number.isFinite(left) ? left : 0
    const r = Number.isFinite(right) ? right : 0
    const fb = this.fbS.process(this.tFeedback)
    const mix = this.mixS.process(this.tMix)

    // Deterministic scheduler: one interval draw per tick, whether or not a
    // voice was free, so the Rng stream depends only on params + sample count.
    this.spawnCountdown -= 1
    if (this.spawnCountdown <= 0) {
      const intervalSec = this.baseIntervalSec() * (1 + this.rng.bipolar() * 0.15)
      this.spawnCountdown = Math.max(16, Math.floor(intervalSec * this.sampleRate))
      this.spawn()
    }

    // Sum active grains. Read delay drifts by (1 - ratio) per output sample:
    // the write head advances 1 while the grain consumes `ratio` samples.
    let wetL = 0
    let wetR = 0
    for (let v = 0; v < MAX_GRAINS; v++) {
      if (this.gActive[v] === 0) continue
      const age = this.gAge[v]
      const dur = this.gDur[v]
      const d = this.gDelay[v] + age * (1 - this.gRatio[v])
      const w = this.hann[Math.floor((age / dur) * (HANN_SIZE - 1))]
      wetL += this.lineL.read(d) * this.gGainL[v] * w
      wetR += this.lineR.read(d) * this.gGainR[v] * w
      this.gAge[v] = age + 1
      if (this.gAge[v] >= dur) this.gActive[v] = 0
    }
    if (wetL < 1e-20 && wetL > -1e-20) wetL = 0
    if (wetR < 1e-20 && wetR > -1e-20) wetR = 0

    // Record input plus soft-limited wet feedback — tanh bounds the re-entry
    // at ±1 regardless of how many grains stack up, so runaway is impossible.
    this.lineL.write(l + fastTanh(wetL * fb))
    this.lineR.write(r + fastTanh(wetR * fb))

    out[0] = l * (1 - mix) + wetL * mix
    out[1] = r * (1 - mix) + wetR * mix
  }

  process(left: number, right: number): [number, number] {
    this.processInto(left, right, this.scratch)
    return [this.scratch[0], this.scratch[1]]
  }

  reset(): void {
    this.lineL.reset()
    this.lineR.reset()
    this.gActive.fill(0)
    this.gAge.fill(0)
    this.rng = new Rng(SEED)
    this.spawnCountdown = 0
    this.fbS.reset(this.tFeedback)
    this.mixS.reset(this.tMix)
  }
}

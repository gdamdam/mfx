/**
 * testSource.ts — deterministic built-in signal generators so the rack can be
 * auditioned with no gear plugged in. Pure buffer-fillers (write into channel
 * arrays borrowed from an AudioBuffer); no Web Audio, no Math.random.
 */
import { Rng, TAU, clamp } from './dsp/util.ts'

export type TestTone = 'sine' | 'noise' | 'drums'

/** A steady 220 Hz sine (loopable over an integer number of cycles). */
export function fillSine(buf: Float32Array, sampleRate: number, freq = 220): void {
  const sr = sampleRate > 0 ? sampleRate : 44100
  for (let i = 0; i < buf.length; i++) {
    buf[i] = 0.35 * Math.sin((TAU * freq * i) / sr)
  }
}

/** Seeded white noise, gentle level. */
export function fillNoise(buf: Float32Array, seed = 1): void {
  const rng = new Rng(seed >>> 0 || 1)
  for (let i = 0; i < buf.length; i++) {
    buf[i] = 0.25 * rng.bipolar()
  }
}

/**
 * A minimal synthesized two-bar drum loop (kick on the beat, closed hat on the
 * off-eighths, snare on 2 & 4). Deterministic — good enough to feel the rack.
 */
export function fillDrumLoop(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  bpm = 120,
): void {
  const sr = sampleRate > 0 ? sampleRate : 44100
  left.fill(0)
  right.fill(0)
  const beatSec = 60 / clamp(bpm, 40, 240)
  const stepSec = beatSec / 2 // eighth-note grid
  const steps = Math.floor(left.length / (stepSec * sr))
  const rng = new Rng(0xa5a5)

  const addKick = (start: number) => {
    for (let i = 0; i < sr * 0.18 && start + i < left.length; i++) {
      const t = i / sr
      const env = Math.exp(-t * 26)
      const f = 120 * Math.exp(-t * 30) + 45
      const s = Math.sin(TAU * f * t) * env * 0.9
      left[start + i] += s
      right[start + i] += s
    }
  }
  const addSnare = (start: number) => {
    for (let i = 0; i < sr * 0.16 && start + i < left.length; i++) {
      const t = i / sr
      const env = Math.exp(-t * 22)
      const tone = Math.sin(TAU * 190 * t) * 0.4
      const s = (rng.bipolar() * 0.6 + tone) * env * 0.7
      left[start + i] += s
      right[start + i] += s
    }
  }
  const addHat = (start: number) => {
    for (let i = 0; i < sr * 0.05 && start + i < left.length; i++) {
      const t = i / sr
      const env = Math.exp(-t * 120)
      const s = rng.bipolar() * env * 0.35
      left[start + i] += s
      right[start + i] += s
    }
  }

  for (let step = 0; step < steps; step++) {
    const start = Math.floor(step * stepSec * sr)
    const beatInBar = step % 8
    if (beatInBar % 4 === 0) addKick(start)
    if (beatInBar === 4) addSnare(start)
    if (beatInBar % 2 === 1) addHat(start)
  }
}

import { describe, it, expect } from 'vitest'
import { Codec, type CodecParams } from './codec.ts'
import { Rng } from './util.ts'

const SR = 48000
// Documented STFT engine latency: FFT_SIZE - 1 = 2047 samples.
const LATENCY = 2047

// Neutral: every degradation bypassed (crush/warble/drop 0, full bandwidth).
const DEFAULTS: CodecParams = { crush: 0, warble: 0, drop: 0, tone: 1, mix: 1 }

function make(over: Partial<CodecParams> = {}): Codec {
  const c = new Codec(SR)
  c.setParams({ ...DEFAULTS, ...over })
  c.reset()
  return c
}

function sine(i: number, hz = 220): number {
  return Math.sin((2 * Math.PI * hz * i) / SR)
}

function rms(buf: Float64Array, from: number, to: number): number {
  let sum = 0
  for (let i = from; i < to; i++) sum += buf[i] * buf[i]
  return Math.sqrt(sum / (to - from))
}

/** Render n samples of a decorrelated-ish stereo noise through the effect. */
function renderNoise(c: Codec, n: number): Float64Array {
  const rng = new Rng(1234)
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const x = rng.bipolar() * 0.5
    out[i] = c.process(x, x)[0]
  }
  return out
}

describe('Codec', () => {
  it('produces finite, bounded output across param extremes on a sine', () => {
    const c = make({ crush: 0.9, warble: 0.8, drop: 0.6, tone: 0.3, mix: 0.7 })
    let max = 0
    for (let i = 0; i < 24000; i++) {
      const [l, r] = c.process(sine(i), sine(i, 330))
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
      max = Math.max(max, Math.abs(l), Math.abs(r))
    }
    expect(max).toBeLessThan(50)
  })

  it('silence in (post-reset) means silence out, no DC', () => {
    const c = make({ crush: 1, warble: 1, drop: 1, tone: 0, mix: 1 })
    for (let i = 0; i < 8192; i++) {
      const [l, r] = c.process(0, 0)
      expect(Math.abs(l)).toBeLessThan(1e-12)
      expect(Math.abs(r)).toBeLessThan(1e-12)
    }
  })

  it('guards non-finite params and input, staying finite', () => {
    const c = new Codec(SR)
    c.setParams({ crush: NaN, warble: NaN, drop: NaN, tone: NaN, mix: NaN })
    for (let i = 0; i < 6000; i++) {
      const [l, r] = c.process(i === 0 ? NaN : sine(i), Infinity)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
    }
  })

  it('is deterministic: two fresh instances match over 12k samples', () => {
    const a = make({ crush: 0.6, warble: 0.5, drop: 0.4, tone: 0.5, mix: 0.8 })
    const b = make({ crush: 0.6, warble: 0.5, drop: 0.4, tone: 0.5, mix: 0.8 })
    const rngA = new Rng(77)
    const rngB = new Rng(77)
    for (let i = 0; i < 12500; i++) {
      const xA = rngA.bipolar()
      const xB = rngB.bipolar()
      const [la, ra] = a.process(xA, xA)
      const [lb, rb] = b.process(xB, xB)
      expect(la).toBe(lb)
      expect(ra).toBe(rb)
    }
  })

  it('passes through transparently at neutral params (crush 0, tone 1, mix 1)', () => {
    const c = make()
    const n = 40000
    const out = new Float64Array(n)
    for (let i = 0; i < n; i++) out[i] = c.process(sine(i), sine(i))[0]
    // After warmup, out[t] must reconstruct in[t - LATENCY].
    let diffSum = 0
    let refSum = 0
    for (let i = 8192; i < n; i++) {
      const ref = sine(i - LATENCY)
      const d = out[i] - ref
      diffSum += d * d
      refSum += ref * ref
    }
    expect(Math.sqrt(diffSum / refSum)).toBeLessThan(0.02)
  })

  it('audibly degrades: heavy crush + narrow bandwidth removes energy', () => {
    const neutral = renderNoise(make(), 40000)
    const crushed = renderNoise(make({ crush: 1, tone: 0.25 }), 40000)
    // Skip STFT warmup, then compare steady-state energy.
    const clean = rms(neutral, 8192, 40000)
    const lossy = rms(crushed, 8192, 40000)
    expect(clean).toBeGreaterThan(1e-3)
    expect(lossy).toBeLessThan(clean * 0.7)
  })
})

import { describe, it, expect } from 'vitest'
import { SpectralFreeze, type SpectralFreezeParams } from './spectralfreeze.ts'
import { Rng } from './util.ts'

const SR = 48000
// Documented STFT engine latency: FFT_SIZE - 1 = 2047 samples.
const LATENCY = 2047

const DEFAULTS: SpectralFreezeParams = { freeze: 0, smear: 0, tilt: 0.5, motion: 0, mix: 1 }

function make(over: Partial<SpectralFreezeParams> = {}): SpectralFreeze {
  const s = new SpectralFreeze(SR)
  s.setParams({ ...DEFAULTS, ...over })
  s.reset()
  return s
}

function sine(i: number, hz = 220): number {
  return Math.sin((2 * Math.PI * hz * i) / SR)
}

function rms(buf: Float64Array, from: number, to: number): number {
  let sum = 0
  for (let i = from; i < to; i++) sum += buf[i] * buf[i]
  return Math.sqrt(sum / (to - from))
}

/** Warm up on a sine (freeze off), then hold and record the frozen output. */
function frozenTail(s: SpectralFreeze, holdParams: Partial<SpectralFreezeParams>, n: number): Float64Array {
  for (let i = 0; i < 24000; i++) s.process(sine(i), sine(i))
  s.setParams({ ...DEFAULTS, freeze: 1, ...holdParams })
  const buf = new Float64Array(n)
  for (let i = 0; i < n; i++) buf[i] = s.process(0, 0)[0]
  return buf
}

/** Relative spread (max-min)/mean of 0.25 s window RMS values. */
function windowSpread(buf: Float64Array, from: number, windows: number): number {
  const W = 12000
  let min = Infinity
  let max = 0
  let mean = 0
  for (let w = 0; w < windows; w++) {
    const v = rms(buf, from + w * W, from + (w + 1) * W)
    min = Math.min(min, v)
    max = Math.max(max, v)
    mean += v / windows
  }
  return (max - min) / mean
}

describe('SpectralFreeze', () => {
  it('produces finite, bounded output for a 220Hz sine across freeze states', () => {
    const s = make({ smear: 0.5, tilt: 0.7, motion: 0.5, mix: 0.5 })
    let max = 0
    for (let i = 0; i < 12000; i++) {
      if (i === 6000) s.setParams({ ...DEFAULTS, smear: 0.5, tilt: 0.7, motion: 0.5, mix: 0.5, freeze: 1 })
      const [l, r] = s.process(sine(i), sine(i))
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
      max = Math.max(max, Math.abs(l), Math.abs(r))
    }
    expect(max).toBeLessThan(50)
  })

  it('silence in (post-reset) means silence out, no DC', () => {
    const s = make({ mix: 1 })
    for (let i = 0; i < 8192; i++) {
      const [l, r] = s.process(0, 0)
      expect(Math.abs(l)).toBeLessThan(1e-12)
      expect(Math.abs(r)).toBeLessThan(1e-12)
    }
  })

  it('guards non-finite params and input, staying finite', () => {
    const s = new SpectralFreeze(SR)
    s.setParams({ freeze: NaN, smear: NaN, tilt: NaN, motion: NaN, mix: NaN })
    for (let i = 0; i < 6000; i++) {
      const [l, r] = s.process(i === 0 ? NaN : sine(i), Infinity)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
    }
  })

  it('is deterministic: two fresh instances match over 12k samples', () => {
    const a = make({ smear: 0.4, tilt: 0.7, motion: 0.6, mix: 0.8 })
    const b = make({ smear: 0.4, tilt: 0.7, motion: 0.6, mix: 0.8 })
    const rngA = new Rng(77)
    const rngB = new Rng(77)
    for (let i = 0; i < 12500; i++) {
      if (i === 5000) {
        a.setParams({ ...DEFAULTS, smear: 0.4, tilt: 0.7, motion: 0.6, mix: 0.8, freeze: 1 })
        b.setParams({ ...DEFAULTS, smear: 0.4, tilt: 0.7, motion: 0.6, mix: 0.8, freeze: 1 })
      }
      const xA = rngA.bipolar()
      const xB = rngB.bipolar()
      const [la, ra] = a.process(xA, xA)
      const [lb, rb] = b.process(xB, xB)
      expect(la).toBe(lb)
      expect(ra).toBe(rb)
    }
  })

  it('passes through transparently at freeze off, smear 0, tilt 0.5, mix 1', () => {
    const s = make()
    const n = 40000
    const out = new Float64Array(n)
    for (let i = 0; i < n; i++) out[i] = s.process(sine(i), sine(i))[0]
    // After warmup, out[t] must match in[t - LATENCY] (dry path uses the same
    // compensation, so mix 1 wet alone is checked here).
    let diffSum = 0
    let refSum = 0
    for (let i = 8192; i < n; i++) {
      const ref = sine(i - LATENCY)
      const d = out[i] - ref
      diffSum += d * d
      refSum += ref * ref
    }
    expect(Math.sqrt(diffSum / refSum)).toBeLessThan(0.01)
  })

  it('holds a stable infinite freeze: window RMS within +-10% over 3 s', () => {
    const s = make()
    const tail = frozenTail(s, { motion: 0 }, 3 * SR)
    const skip = 24000 // let the crossfade and OLA settle
    const W = 12000 // 0.25 s windows
    const first = rms(tail, skip, skip + W)
    expect(first).toBeGreaterThan(1e-3)
    for (let w = 0; w < 9; w++) {
      const v = rms(tail, skip + w * W, skip + (w + 1) * W)
      expect(Number.isFinite(v)).toBe(true)
      expect(v).toBeGreaterThan(first * 0.9)
      expect(v).toBeLessThan(first * 1.1)
    }
  })

  it('toggles freeze mid-sine without clicks', () => {
    const s = make({ mix: 1 })
    let prev = 0
    let maxStep = 0
    for (let i = 0; i < 60000; i++) {
      if (i === 20000) s.setParams({ ...DEFAULTS, freeze: 1 })
      if (i === 40000) s.setParams({ ...DEFAULTS, freeze: 0 })
      const [l] = s.process(sine(i), sine(i))
      if (i > 4096) maxStep = Math.max(maxStep, Math.abs(l - prev))
      prev = l
    }
    expect(maxStep).toBeLessThan(0.5)
  })

  it('motion 0 hold is near-static while motion 1 undulates', () => {
    const still = windowSpread(frozenTail(make(), { motion: 0 }, 3 * SR), 24000, 9)
    const moving = windowSpread(frozenTail(make(), { motion: 1 }, 3 * SR), 24000, 9)
    expect(still).toBeLessThan(0.08)
    expect(moving).toBeGreaterThan(still * 3)
    expect(moving).toBeGreaterThan(0.1)
  })
})

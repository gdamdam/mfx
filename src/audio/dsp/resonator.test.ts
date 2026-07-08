import { describe, it, expect } from 'vitest'
import { Resonator, type ResonatorParams } from './resonator.ts'
import { Rng } from './util.ts'

const SR = 48000

const DEFAULTS: ResonatorParams = { freq: 220, model: 0, damp: 0.4, spread: 0, bright: 0.5, mix: 0.5 }

/** Build a resonator and snap the block-rate smoothing to the targets. */
function make(over: Partial<ResonatorParams> = {}): Resonator {
  const r = new Resonator(SR)
  r.setParams({ ...DEFAULTS, ...over })
  r.reset()
  return r
}

/** Excite with a unit impulse, then record `n` samples of the left tail. */
function ringDown(r: Resonator, n: number): Float64Array {
  const buf = new Float64Array(n)
  r.process(1, 1)
  for (let i = 0; i < n; i++) buf[i] = r.process(0, 0)[0]
  return buf
}

function rms(buf: Float64Array, from: number, to: number): number {
  let sum = 0
  for (let i = from; i < to; i++) sum += buf[i] * buf[i]
  return Math.sqrt(sum / (to - from))
}

describe('Resonator', () => {
  it('produces finite, bounded output for a 220Hz sine across all models', () => {
    for (let model = 0; model < 4; model++) {
      const r = make({ model, mix: 1 })
      let max = 0
      for (let i = 0; i < 4000; i++) {
        const x = Math.sin((2 * Math.PI * 220 * i) / SR)
        const [l, rr] = r.process(x, x)
        expect(Number.isFinite(l)).toBe(true)
        expect(Number.isFinite(rr)).toBe(true)
        max = Math.max(max, Math.abs(l))
      }
      expect(max).toBeLessThan(50)
    }
  })

  it('silence in (post-reset) means silence out', () => {
    const r = make({ mix: 1 })
    for (let i = 0; i < 4000; i++) {
      const [l, rr] = r.process(0, 0)
      expect(Math.abs(l)).toBeLessThan(1e-12)
      expect(Math.abs(rr)).toBeLessThan(1e-12)
    }
  })

  it('rings out to silence after excitation, with no DC buildup', () => {
    const r = make({ damp: 0.9, mix: 1 })
    const tail = ringDown(r, 2 * SR)
    // Late tail is essentially gone (tau ~ 63 ms at damp 0.9).
    expect(rms(tail, tail.length - 4800, tail.length)).toBeLessThan(1e-9)
    // No DC offset accumulates in the ring.
    let mean = 0
    for (let i = 0; i < tail.length; i++) mean += tail[i]
    expect(Math.abs(mean / tail.length)).toBeLessThan(1e-9)
  })

  it('guards non-finite params and input, staying finite', () => {
    const r = new Resonator(SR)
    r.setParams({ freq: NaN, model: NaN, damp: NaN, spread: NaN, bright: NaN, mix: NaN })
    for (let i = 0; i < 2000; i++) {
      const [l, rr] = r.process(i === 0 ? NaN : Math.sin(i), Infinity)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(rr)).toBe(true)
    }
  })

  it('is deterministic: two fresh instances match over 12k samples', () => {
    const a = make({ model: 3, damp: 0.2, spread: 0.7, bright: 0.8, mix: 0.8 })
    const b = make({ model: 3, damp: 0.2, spread: 0.7, bright: 0.8, mix: 0.8 })
    const rngA = new Rng(123)
    const rngB = new Rng(123)
    for (let i = 0; i < 12000; i++) {
      const xA = rngA.bipolar()
      const xB = rngB.bipolar()
      const [la, ra] = a.process(xA, xA)
      const [lb, rb] = b.process(xB, xB)
      expect(la).toBe(lb)
      expect(ra).toBe(rb)
    }
  })

  it('impulse-excited String model rings at ~220 Hz', () => {
    // bright 0 rolls off high partials, so the late tail is the fundamental.
    const r = make({ freq: 220, model: 0, damp: 0.5, bright: 0, mix: 1 })
    const tail = ringDown(r, 44000)
    const from = 28800 // 0.6 s — higher partials have decayed by here
    const to = 43200 // 0.9 s
    let crossings = 0
    for (let i = from + 1; i < to; i++) {
      if ((tail[i - 1] < 0 && tail[i] >= 0) || (tail[i - 1] >= 0 && tail[i] < 0)) crossings++
    }
    const freqEst = (crossings * SR) / (2 * (to - from))
    expect(Math.abs(freqEst - 220)).toBeLessThan(22)
  })

  it('damp 1 decays much faster than damp 0', () => {
    const slow = make({ damp: 0, bright: 0, mix: 1 })
    const fast = make({ damp: 1, bright: 0, mix: 1 })
    const tailSlow = ringDown(slow, 30000)
    const tailFast = ringDown(fast, 30000)
    // Compare a late window (0.5..0.6 s after the impulse).
    const a = rms(tailSlow, 24000, 28800)
    const b = rms(tailFast, 24000, 28800)
    expect(a).toBeGreaterThan(0)
    expect(b).toBeLessThan(a / 50)
  })

  it('Bar model differs from String model', () => {
    const s = make({ model: 0, mix: 1 })
    const b = make({ model: 1, mix: 1 })
    const tailS = ringDown(s, 8000)
    const tailB = ringDown(b, 8000)
    let maxDiff = 0
    for (let i = 0; i < 8000; i++) maxDiff = Math.max(maxDiff, Math.abs(tailS[i] - tailB[i]))
    expect(maxDiff).toBeGreaterThan(1e-9)
  })

  it('spread 1 decorrelates left and right', () => {
    const r = make({ spread: 1, mix: 1 })
    let maxDiff = 0
    for (let i = 0; i < 20000; i++) {
      const x = Math.sin((2 * Math.PI * 220 * i) / SR)
      const [l, rr] = r.process(x, x)
      maxDiff = Math.max(maxDiff, Math.abs(l - rr))
    }
    expect(maxDiff).toBeGreaterThan(1e-6)

    // With spread 0 and identical input, channels stay identical.
    const z = make({ spread: 0, mix: 1 })
    let zDiff = 0
    for (let i = 0; i < 8000; i++) {
      const x = Math.sin((2 * Math.PI * 220 * i) / SR)
      const [l, rr] = z.process(x, x)
      zDiff = Math.max(zDiff, Math.abs(l - rr))
    }
    expect(zDiff).toBeLessThan(1e-15)
  })

  it('stays bounded on noise input at extreme settings over 40k samples', () => {
    const r = make({ freq: 2000, model: 3, damp: 0, spread: 1, bright: 1, mix: 1 })
    const rng = new Rng(0xbeef)
    let max = 0
    for (let i = 0; i < 40000; i++) {
      const x = rng.bipolar()
      const [l, rr] = r.process(x, x)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(rr)).toBe(true)
      max = Math.max(max, Math.abs(l), Math.abs(rr))
    }
    expect(max).toBeLessThan(50)
  })
})

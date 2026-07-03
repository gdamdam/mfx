import { describe, it, expect } from 'vitest'
import { Delay } from './delay.ts'

const SR = 48000

/** Feed silence for `n` samples so the time smoother settles to its target. */
function warmup(d: Delay, n: number): void {
  for (let i = 0; i < n; i++) d.process(0, 0)
}

/** Feed an impulse, then find the sample index of the largest echo peak. */
function firstEchoIndex(d: Delay, searchLen: number): number {
  d.process(1, 1) // impulse at index 0 (this is the dry hit)
  let bestIdx = -1
  let bestMag = 0
  for (let i = 1; i < searchLen; i++) {
    const [l] = d.process(0, 0)
    if (Math.abs(l) > bestMag) {
      bestMag = Math.abs(l)
      bestIdx = i
    }
  }
  return bestIdx
}

describe('Delay', () => {
  it('produces finite, bounded output for a 220Hz sine', () => {
    const d = new Delay(SR)
    d.setParams({ time: 0.25, feedback: 0.5, mix: 0.5, sync: 0, division: 1 })
    let max = 0
    for (let i = 0; i < 4000; i++) {
      const [l, r] = d.process(Math.sin((2 * Math.PI * 220 * i) / SR), 0)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
      max = Math.max(max, Math.abs(l))
    }
    expect(max).toBeLessThan(50)
  })

  it('stays stable at high feedback over 20k samples', () => {
    const d = new Delay(SR)
    d.setParams({ time: 0.2, feedback: 0.9, mix: 0.5, sync: 0, division: 1 })
    let max = 0
    for (let i = 0; i < 20000; i++) {
      const [l] = d.process(Math.sin((2 * Math.PI * 220 * i) / SR), 0)
      expect(Number.isFinite(l)).toBe(true)
      max = Math.max(max, Math.abs(l))
    }
    expect(max).toBeLessThan(50)
  })

  it('produces a delayed echo at ~time seconds', () => {
    const d = new Delay(SR)
    d.setParams({ time: 0.1, feedback: 0.3, mix: 0.6, sync: 0, division: 1 })
    warmup(d, 20000) // let the slewed time reach 0.1s
    const idx = firstEchoIndex(d, 8000)
    const expected = 0.1 * SR // 4800 samples
    expect(Math.abs(idx - expected)).toBeLessThan(60)
  })

  it('sync mode derives delay time from tempo and division', () => {
    const beatSec = 60 / 120

    // Division 0 => 1/4 note (factor 1) => 0.5s
    const a = new Delay(SR)
    a.setTempo(120)
    a.setParams({ time: 0.3, feedback: 0.3, mix: 0.6, sync: 1, division: 0 })
    warmup(a, 40000)
    const idxA = firstEchoIndex(a, 30000)
    expect(Math.abs(idxA - beatSec * 1 * SR)).toBeLessThan(80)

    // Division 1 => 1/8 note (factor 0.5) => 0.25s
    const b = new Delay(SR)
    b.setTempo(120)
    b.setParams({ time: 0.3, feedback: 0.3, mix: 0.6, sync: 1, division: 1 })
    warmup(b, 40000)
    const idxB = firstEchoIndex(b, 30000)
    expect(Math.abs(idxB - beatSec * 0.5 * SR)).toBeLessThan(80)

    // The two divisions must yield audibly different delay times.
    expect(idxA).toBeGreaterThan(idxB + 5000)
  })

  it('guards non-finite params and input, staying finite', () => {
    const d = new Delay(SR)
    d.setParams({ time: NaN, feedback: NaN, mix: NaN, sync: NaN, division: NaN })
    d.setTempo(NaN)
    for (let i = 0; i < 1000; i++) {
      const [l, r] = d.process(i === 0 ? NaN : Math.sin(i), Infinity)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
    }
  })
})

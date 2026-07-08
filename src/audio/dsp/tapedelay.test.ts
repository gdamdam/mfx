import { describe, it, expect } from 'vitest'
import { TapeDelay, type TapeDelayParams } from './tapedelay.ts'

const SR = 48000

const DEFAULTS: TapeDelayParams = {
  time: 0.35,
  feedback: 0.45,
  mix: 0.35,
  wow: 0.3,
  age: 0.4,
  spread: 0.5,
  sync: 0,
  division: 1,
}

/** Feed silence for `n` samples so the time smoother settles to its target. */
function warmup(d: TapeDelay, n: number): void {
  for (let i = 0; i < n; i++) d.process(0, 0)
}

/** Feed an impulse, then find the sample index of the largest echo peak. */
function firstEchoIndex(d: TapeDelay, searchLen: number): number {
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

describe('TapeDelay', () => {
  it('produces finite, bounded output for a 220Hz sine', () => {
    const d = new TapeDelay(SR)
    d.setParams(DEFAULTS)
    let max = 0
    for (let i = 0; i < 4000; i++) {
      const [l, r] = d.process(Math.sin((2 * Math.PI * 220 * i) / SR), 0)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
      max = Math.max(max, Math.abs(l))
    }
    expect(max).toBeLessThan(50)
  })

  it('outputs exact silence for silent input after reset', () => {
    const d = new TapeDelay(SR)
    d.setParams(DEFAULTS)
    for (let i = 0; i < 2000; i++) d.process(Math.sin(i * 0.1), Math.sin(i * 0.13))
    d.reset()
    for (let i = 0; i < 10000; i++) {
      const [l, r] = d.process(0, 0)
      expect(l).toBe(0)
      expect(r).toBe(0)
    }
  })

  it('impulse response decays to a quiet tail with feedback < 1', () => {
    const d = new TapeDelay(SR)
    d.setParams({ ...DEFAULTS, time: 0.1, feedback: 0.5, mix: 1, wow: 0, spread: 0 })
    warmup(d, 60000)
    d.process(1, 1)
    let earlyMax = 0
    let lateMax = 0
    for (let i = 1; i < 60000; i++) {
      const [l] = d.process(0, 0)
      if (i < 20000) earlyMax = Math.max(earlyMax, Math.abs(l))
      if (i >= 50000) lateMax = Math.max(lateMax, Math.abs(l))
    }
    expect(earlyMax).toBeGreaterThan(0.1)
    expect(lateMax).toBeLessThan(0.05)
    expect(lateMax).toBeLessThan(earlyMax)
  })

  it('guards non-finite params and input, staying finite', () => {
    const d = new TapeDelay(SR)
    d.setParams({
      time: NaN,
      feedback: Infinity,
      mix: NaN,
      wow: -Infinity,
      age: NaN,
      spread: NaN,
      sync: NaN,
      division: NaN,
    })
    d.setTempo(NaN)
    for (let i = 0; i < 1000; i++) {
      const [l, r] = d.process(i === 0 ? NaN : Math.sin(i), Infinity)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
    }
  })

  it('is deterministic: two fresh instances match sample-for-sample', () => {
    const a = new TapeDelay(SR)
    const b = new TapeDelay(SR)
    a.setParams({ ...DEFAULTS, wow: 0.7, feedback: 0.8 })
    b.setParams({ ...DEFAULTS, wow: 0.7, feedback: 0.8 })
    for (let i = 0; i < 12000; i++) {
      const x = Math.sin((2 * Math.PI * 220 * i) / SR)
      const y = Math.sin((2 * Math.PI * 330 * i) / SR)
      const [al, ar] = a.process(x, y)
      const [bl, br] = b.process(x, y)
      expect(al).toBe(bl)
      expect(ar).toBe(br)
    }
  })

  it('produces a delayed echo at ~time seconds', () => {
    const d = new TapeDelay(SR)
    d.setParams({ ...DEFAULTS, time: 0.1, feedback: 0.3, mix: 0.6, wow: 0, spread: 0, age: 0 })
    warmup(d, 60000) // let the slewed time reach 0.1s
    const idx = firstEchoIndex(d, 8000)
    const expected = 0.1 * SR // 4800 samples
    expect(Math.abs(idx - expected)).toBeLessThan(60)
  })

  it('sync mode derives delay time from tempo and division', () => {
    const beatSec = 60 / 120

    // Division 0 => 1/4 note (factor 1) => 0.5s at 120 bpm
    const a = new TapeDelay(SR)
    a.setTempo(120)
    a.setParams({ ...DEFAULTS, feedback: 0.3, mix: 0.6, wow: 0, spread: 0, sync: 1, division: 0 })
    warmup(a, 80000)
    const idxA = firstEchoIndex(a, 30000)
    expect(Math.abs(idxA - beatSec * 1 * SR)).toBeLessThan(100)

    // Division 1 => 1/8 note (factor 0.5) => 0.25s
    const b = new TapeDelay(SR)
    b.setTempo(120)
    b.setParams({ ...DEFAULTS, feedback: 0.3, mix: 0.6, wow: 0, spread: 0, sync: 1, division: 1 })
    warmup(b, 80000)
    const idxB = firstEchoIndex(b, 30000)
    expect(Math.abs(idxB - beatSec * 0.5 * SR)).toBeLessThan(100)

    // The two divisions must yield audibly different delay times.
    expect(idxA).toBeGreaterThan(idxB + 5000)
  })

  it('stays bounded (< 3) at feedback 1.0 over a long run', () => {
    const d = new TapeDelay(SR)
    d.setParams({ ...DEFAULTS, time: 0.15, feedback: 1, mix: 1 })
    let max = 0
    for (let i = 0; i < 60000; i++) {
      const [l, r] = d.process(Math.sin((2 * Math.PI * 220 * i) / SR), Math.sin((2 * Math.PI * 220 * i) / SR))
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
      max = Math.max(max, Math.abs(l), Math.abs(r))
    }
    expect(max).toBeLessThan(3)
  })

  it('age 1 makes repeats darker than age 0', () => {
    // The 2nd echo has passed through the loop filters exactly once, so its
    // high-frequency content (successive-sample abs diff over energy) must be
    // lower when the tape is worn.
    const hfRatioOfSecondEcho = (age: number): number => {
      const d = new TapeDelay(SR)
      d.setParams({ ...DEFAULTS, time: 0.1, feedback: 0.6, mix: 1, wow: 0, spread: 0, age })
      warmup(d, 60000)
      d.process(1, 1)
      const center = Math.round(0.2 * SR) // 2nd echo at 2 * time
      let hf = 0
      let energy = 0
      let prev = 0
      for (let i = 1; i <= center + 400; i++) {
        const [l] = d.process(0, 0)
        if (i >= center - 400) {
          hf += Math.abs(l - prev)
          energy += Math.abs(l)
        }
        prev = l
      }
      expect(energy).toBeGreaterThan(0)
      return hf / energy
    }

    const fresh = hfRatioOfSecondEcho(0)
    const worn = hfRatioOfSecondEcho(1)
    expect(worn).toBeLessThan(fresh)
  })
})

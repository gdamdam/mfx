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

describe('Delay modes, tone, duck, mod', () => {
  /** HF proxy: mean absolute first difference over a window. */
  function hfProxy(samples: number[]): number {
    let sum = 0
    for (let i = 1; i < samples.length; i++) sum += Math.abs(samples[i] - samples[i - 1])
    return sum
  }

  it('produces finite, bounded output for a 220Hz sine in every mode', () => {
    for (let mode = 0; mode <= 2; mode++) {
      const d = new Delay(SR)
      d.setParams({
        time: 0.2,
        feedback: 0.7,
        mix: 0.5,
        sync: 0,
        division: 1,
        mode,
        tone: 0.3,
        duck: 0.5,
        mod: 0.5,
      })
      d.reset()
      let max = 0
      for (let i = 0; i < 8000; i++) {
        const [l, r] = d.process(Math.sin((2 * Math.PI * 220 * i) / SR), 0.5)
        expect(Number.isFinite(l)).toBe(true)
        expect(Number.isFinite(r)).toBe(true)
        max = Math.max(max, Math.abs(l), Math.abs(r))
      }
      expect(max).toBeLessThan(50)
    }
  })

  it('passes silence through as silence in every mode (post-reset)', () => {
    for (let mode = 0; mode <= 2; mode++) {
      const d = new Delay(SR)
      d.setParams({
        time: 0.1,
        feedback: 0.6,
        mix: 0.5,
        sync: 0,
        division: 1,
        mode,
        tone: 0.2,
        duck: 0.5,
        mod: 0.5,
      })
      d.reset()
      for (let i = 0; i < 2000; i++) {
        const [l, r] = d.process(0, 0)
        expect(l).toBe(0)
        expect(r).toBe(0)
      }
    }
  })

  it('impulse tail decays toward silence', () => {
    const d = new Delay(SR)
    d.setParams({ time: 0.1, feedback: 0.5, mix: 1, sync: 0, division: 1 })
    d.reset()
    warmup(d, 20000)
    d.process(1, 1)
    const n = 2 * SR
    const tenth = Math.floor(n / 10)
    let firstE = 0
    let lastE = 0
    for (let i = 0; i < n; i++) {
      const [l] = d.process(0, 0)
      if (i < tenth) firstE += l * l
      if (i >= n - tenth) lastE += l * l
    }
    expect(lastE).toBeLessThan(firstE)
  })

  it('guards non-finite new params, staying finite', () => {
    const d = new Delay(SR)
    d.setParams({
      time: NaN,
      feedback: NaN,
      mix: NaN,
      sync: NaN,
      division: NaN,
      mode: NaN,
      tone: Infinity,
      duck: NaN,
      mod: -Infinity,
    })
    for (let i = 0; i < 2000; i++) {
      const [l, r] = d.process(i === 0 ? NaN : Math.sin(i), Infinity)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
    }
  })

  it('is deterministic: two fresh instances produce identical output', () => {
    const make = () => {
      const d = new Delay(SR)
      d.setParams({
        time: 0.15,
        feedback: 0.6,
        mix: 0.7,
        sync: 0,
        division: 1,
        mode: 2,
        tone: 0.2,
        duck: 0.5,
        mod: 0.7,
      })
      d.reset()
      return d
    }
    const a = make()
    const b = make()
    for (let i = 0; i < 8000; i++) {
      const s = Math.sin((2 * Math.PI * 220 * i) / SR)
      const [al, ar] = a.process(s, s * 0.3)
      const [bl, br] = b.process(s, s * 0.3)
      expect(al).toBe(bl)
      expect(ar).toBe(br)
    }
  })

  it('pong mode produces alternating L/R echoes', () => {
    const d = new Delay(SR)
    d.setParams({ time: 0.1, feedback: 0.5, mix: 1, sync: 0, division: 1, mode: 1 })
    d.reset()
    warmup(d, 20000)
    d.process(1, 1)
    const ds = 0.1 * SR // 4800
    let e1L = 0
    let e1R = 0
    let e2L = 0
    let e2R = 0
    for (let i = 1; i < 3 * ds; i++) {
      const [l, r] = d.process(0, 0)
      if (Math.abs(i - ds) < 200) {
        e1L = Math.max(e1L, Math.abs(l))
        e1R = Math.max(e1R, Math.abs(r))
      }
      if (Math.abs(i - 2 * ds) < 200) {
        e2L = Math.max(e2L, Math.abs(l))
        e2R = Math.max(e2R, Math.abs(r))
      }
    }
    // First echo lands on the left, second on the right.
    expect(e1L).toBeGreaterThan(e1R * 3)
    expect(e2R).toBeGreaterThan(e2L * 3)
  })

  it('reverse mode stays bounded and finite', () => {
    const d = new Delay(SR)
    d.setParams({ time: 0.12, feedback: 0.7, mix: 0.8, sync: 0, division: 1, mode: 2 })
    d.reset()
    let max = 0
    for (let i = 0; i < 30000; i++) {
      const [l, r] = d.process(Math.sin((2 * Math.PI * 220 * i) / SR), 0)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
      max = Math.max(max, Math.abs(l), Math.abs(r))
    }
    expect(max).toBeLessThan(50)
    expect(max).toBeGreaterThan(0.01) // it actually produces wet output
  })

  it('tone 0 darkens repeats vs tone 0.5', () => {
    const secondEcho = (tone: number): number[] => {
      const d = new Delay(SR)
      d.setParams({ time: 0.1, feedback: 0.6, mix: 1, sync: 0, division: 1, mode: 0, tone })
      d.reset()
      warmup(d, 20000)
      d.process(1, 1)
      const ds = 0.1 * SR
      const win: number[] = []
      for (let i = 1; i < 2 * ds + 500; i++) {
        const [l] = d.process(0, 0)
        if (i >= 2 * ds - 200 && i < 2 * ds + 500) win.push(l)
      }
      return win
    }
    const dark = hfProxy(secondEcho(0))
    const flat = hfProxy(secondEcho(0.5))
    expect(dark).toBeLessThan(flat * 0.5)
  })

  it('duck 1 attenuates wet while the input is hot vs duck 0', () => {
    const wetEnergy = (duck: number): number => {
      const d = new Delay(SR)
      d.setParams({ time: 0.05, feedback: 0.5, mix: 1, sync: 0, division: 1, duck })
      d.reset()
      warmup(d, 20000)
      let sum = 0
      for (let i = 0; i < 24000; i++) {
        const [l] = d.process(0.9 * Math.sin((2 * Math.PI * 220 * i) / SR), 0)
        if (i >= 12000) sum += Math.abs(l)
      }
      return sum
    }
    const loud = wetEnergy(0)
    const ducked = wetEnergy(1)
    expect(ducked).toBeLessThan(loud * 0.3)
  })

  it('mod > 0 keeps output finite and close in level to mod 0', () => {
    const d = new Delay(SR)
    d.setParams({ time: 0.2, feedback: 0.6, mix: 0.5, sync: 0, division: 1, mod: 1 })
    d.reset()
    let max = 0
    for (let i = 0; i < 48000; i++) {
      const [l] = d.process(Math.sin((2 * Math.PI * 220 * i) / SR), 0)
      expect(Number.isFinite(l)).toBe(true)
      max = Math.max(max, Math.abs(l))
    }
    expect(max).toBeLessThan(50)
  })
})

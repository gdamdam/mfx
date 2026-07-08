import { describe, it, expect } from 'vitest'
import { Bloom } from './bloom.ts'

const SR = 48000

const DEFAULTS = {
  mix: 0.4,
  grow: 0.5,
  density: 0.5,
  space: 0.6,
  rich: 0.4,
  evolve: 0.4,
}

function rms(xs: number[]): number {
  let s = 0
  for (const x of xs) s += x * x
  return Math.sqrt(s / xs.length)
}

describe('Bloom', () => {
  it('produces finite, bounded output under sustained loud input at max settings', () => {
    const b = new Bloom(SR)
    b.setParams({ mix: 1, grow: 1, density: 1, space: 1, rich: 1, evolve: 1 })
    let max = 0
    for (let i = 0; i < SR * 3; i++) {
      const [l, r] = b.process(Math.sin((2 * Math.PI * 220 * i) / SR), Math.sin((2 * Math.PI * 277 * i) / SR))
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
      max = Math.max(max, Math.abs(l), Math.abs(r))
    }
    // The governor + soft ceiling keep the accumulating pad bounded.
    expect(max).toBeLessThan(6)
  })

  it('silence in -> silence out after reset', () => {
    const b = new Bloom(SR)
    b.setParams(DEFAULTS)
    b.reset()
    for (let i = 0; i < 4000; i++) {
      const [l, r] = b.process(0, 0)
      expect(l).toBe(0)
      expect(r).toBe(0)
    }
  })

  it('the pad grows over time under input, then sustains far longer than a reverb tail', () => {
    const b = new Bloom(SR)
    b.setParams({ ...DEFAULTS, mix: 1, grow: 0.7 })
    // Feed 2 s of tone; measure wet growth between second 1 and 2.
    const early: number[] = []
    const later: number[] = []
    for (let i = 0; i < SR * 2; i++) {
      const [l] = b.process(Math.sin((2 * Math.PI * 220 * i) / SR) * 0.5, 0)
      if (i > SR * 0.25 && i < SR * 0.75) early.push(l)
      if (i > SR * 1.5) later.push(l)
    }
    expect(rms(later)).toBeGreaterThan(rms(early) * 1.2) // charging up
    // Stop input: the pad should still be audible 3 s later (recirculation).
    const tail: number[] = []
    for (let i = 0; i < SR * 3; i++) {
      const [l] = b.process(0, 0)
      if (i > SR * 2.5) tail.push(l)
    }
    expect(rms(tail)).toBeGreaterThan(rms(later) * 0.12)
  })

  it('grow 0 injects nothing (dry passes, no pad forms)', () => {
    const b = new Bloom(SR)
    b.setParams({ ...DEFAULTS, mix: 1, grow: 0 })
    b.reset()
    const wet: number[] = []
    for (let i = 0; i < SR; i++) {
      const [l] = b.process(Math.sin((2 * Math.PI * 220 * i) / SR), 0)
      if (i > SR / 2) wet.push(l)
    }
    expect(rms(wet)).toBeLessThan(1e-3)
  })

  it('evolve 1 pad varies over time more than evolve 0', () => {
    const variance = (evolve: number): number => {
      const b = new Bloom(SR)
      b.setParams({ ...DEFAULTS, mix: 1, evolve, rich: 0 })
      for (let i = 0; i < SR; i++) b.process(Math.sin((2 * Math.PI * 220 * i) / SR) * 0.5, 0)
      const windows: number[] = []
      for (let w = 0; w < 8; w++) {
        const buf: number[] = []
        for (let i = 0; i < SR / 4; i++) buf.push(b.process(0, 0)[0])
        windows.push(rms(buf))
      }
      const mean = windows.reduce((a, x) => a + x, 0) / windows.length
      return windows.reduce((a, x) => a + (x - mean) ** 2, 0) / (mean * mean + 1e-12)
    }
    expect(variance(1)).toBeGreaterThan(variance(0) * 1.05)
  })

  it('is deterministic across instances', () => {
    const a = new Bloom(SR)
    const b = new Bloom(SR)
    a.setParams(DEFAULTS)
    b.setParams(DEFAULTS)
    for (let i = 0; i < 12000; i++) {
      const x = Math.sin((2 * Math.PI * 220 * i) / SR)
      const [al, ar] = a.process(x, -x)
      const [bl, br] = b.process(x, -x)
      expect(al).toBe(bl)
      expect(ar).toBe(br)
    }
  })

  it('guards non-finite params and input', () => {
    const b = new Bloom(SR)
    b.setParams({ mix: NaN, grow: Infinity, density: NaN, space: NaN, rich: NaN, evolve: NaN })
    for (let i = 0; i < 2000; i++) {
      const [l, r] = b.process(i === 0 ? NaN : 0.5, Infinity)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
    }
  })
})

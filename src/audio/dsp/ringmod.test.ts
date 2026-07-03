import { describe, it, expect } from 'vitest'
import { RingMod } from './ringmod.ts'

const SR = 48000

describe('RingMod', () => {
  it('produces finite, bounded output for a 220Hz sine', () => {
    const rm = new RingMod(SR)
    rm.setParams({ freq: 440, mix: 0.5 })
    let max = 0
    for (let i = 0; i < 4000; i++) {
      const [l, r] = rm.process(Math.sin((2 * Math.PI * 220 * i) / SR), 0)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
      max = Math.max(max, Math.abs(l))
    }
    // Product of two [-1,1] signals is bounded by 1.
    expect(max).toBeLessThanOrEqual(1.0001)
  })

  it('mix=0 leaves the signal (near-)dry', () => {
    const rm = new RingMod(SR)
    rm.setParams({ freq: 800, mix: 0 })
    for (let i = 0; i < 20000; i++) rm.process(0, 0) // settle mix -> 0
    for (let i = 0; i < 4000; i++) {
      const x = Math.sin((2 * Math.PI * 220 * i) / SR)
      const [l] = rm.process(x, 0)
      expect(Math.abs(l - x)).toBeLessThan(1e-5)
    }
  })

  it('mix=1 modulates the signal (differs from dry)', () => {
    const rm = new RingMod(SR)
    rm.setParams({ freq: 800, mix: 1 })
    for (let i = 0; i < 2000; i++) rm.process(0, 0)
    let differs = false
    for (let i = 0; i < 4000; i++) {
      const x = Math.sin((2 * Math.PI * 220 * i) / SR)
      const [l] = rm.process(x, 0)
      if (Math.abs(l - x) > 0.1) differs = true
    }
    expect(differs).toBe(true)
  })

  it('guards non-finite params and input, staying finite', () => {
    const rm = new RingMod(SR)
    rm.setParams({ freq: NaN, mix: NaN })
    for (let i = 0; i < 1000; i++) {
      const [l, r] = rm.process(i === 0 ? NaN : Math.sin(i), Infinity)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
    }
  })
})

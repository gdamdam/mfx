import { describe, it, expect } from 'vitest'
import { Freeze } from './freeze.ts'

const SR = 48000

describe('Freeze', () => {
  it('passes dry through when hold is off', () => {
    const fz = new Freeze(SR)
    fz.setParams({ hold: 0, size: 0.5, mix: 1 })
    for (let i = 0; i < 4000; i++) {
      const x = Math.sin((2 * Math.PI * 220 * i) / SR)
      const [l, r] = fz.process(x, 0)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
      expect(Math.abs(l - x)).toBeLessThan(1e-9)
    }
  })

  it('keeps producing signal after input goes silent when frozen', () => {
    const fz = new Freeze(SR)
    fz.setParams({ hold: 0, size: 0.5, mix: 1 })
    // Record enough sine to fill the grain window (~225ms at size 0.5).
    for (let i = 0; i < 12000; i++) {
      fz.process(Math.sin((2 * Math.PI * 220 * i) / SR), 0)
    }
    // Engage hold: the transition captures the grain.
    fz.setParams({ hold: 1, size: 0.5, mix: 1 })
    fz.process(Math.sin((2 * Math.PI * 220 * 12000) / SR), 0)

    // Input now silent — the frozen pad should keep looping.
    let energy = 0
    let max = 0
    for (let i = 0; i < 8000; i++) {
      const [l, r] = fz.process(0, 0)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
      energy += Math.abs(l)
      max = Math.max(max, Math.abs(l))
    }
    expect(energy).toBeGreaterThan(1) // clearly not silent
    expect(max).toBeLessThan(2) // bounded
  })

  it('produces finite, bounded output while frozen with live input', () => {
    const fz = new Freeze(SR)
    fz.setParams({ hold: 0, size: 0.5, mix: 0.6 })
    for (let i = 0; i < 12000; i++) {
      fz.process(Math.sin((2 * Math.PI * 220 * i) / SR), 0)
    }
    fz.setParams({ hold: 1, size: 0.5, mix: 0.6 })
    let max = 0
    for (let i = 12000; i < 16000; i++) {
      const [l, r] = fz.process(Math.sin((2 * Math.PI * 220 * i) / SR), 0)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
      max = Math.max(max, Math.abs(l))
    }
    expect(max).toBeLessThan(2)
  })

  it('guards non-finite params and input, staying finite', () => {
    const fz = new Freeze(SR)
    fz.setParams({ hold: NaN, size: NaN, mix: NaN })
    for (let i = 0; i < 1000; i++) {
      const [l, r] = fz.process(i === 0 ? NaN : Math.sin(i), Infinity)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
    }
  })
})

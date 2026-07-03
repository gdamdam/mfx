import { describe, it, expect } from 'vitest'
import { Comp } from './comp.ts'

const SR = 48000

/** Peak |output| over `n` samples of a sine, measured after `settle` samples. */
function peakOfSine(comp: Comp, amp: number, freq: number, settle: number, n: number): number {
  const out = new Float64Array(2)
  let peak = 0
  for (let i = 0; i < settle + n; i++) {
    const s = amp * Math.sin((2 * Math.PI * freq * i) / SR)
    comp.processInto(s, s, out)
    if (i >= settle) peak = Math.max(peak, Math.abs(out[0]), Math.abs(out[1]))
  }
  return peak
}

describe('Comp', () => {
  it('passes silence through as silence', () => {
    const comp = new Comp(SR)
    comp.setParams({ amount: 0.5, attack: 0.2, release: 0.4, makeup: 0.5 })
    comp.reset()
    const out = new Float64Array(2)
    for (let i = 0; i < 500; i++) comp.processInto(0, 0, out)
    expect(out[0]).toBe(0)
    expect(out[1]).toBe(0)
  })

  it('keeps output finite and bounded for a loud sine', () => {
    const comp = new Comp(SR)
    comp.setParams({ amount: 0.4, attack: 0.2, release: 0.45, makeup: 0.5 })
    comp.reset()
    const out = new Float64Array(2)
    for (let i = 0; i < 4000; i++) {
      const s = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR)
      comp.processInto(s, s, out)
      expect(Number.isFinite(out[0])).toBe(true)
      expect(Math.abs(out[0])).toBeLessThan(4)
    }
  })

  it('reduces peak more at high amount than at low amount', () => {
    const low = new Comp(SR)
    low.setParams({ amount: 0.05, attack: 0.2, release: 0.45, makeup: 0 })
    low.reset()
    const high = new Comp(SR)
    high.setParams({ amount: 0.95, attack: 0.2, release: 0.45, makeup: 0 })
    high.reset()
    const lowPeak = peakOfSine(low, 0.9, 220, 4000, 2000)
    const highPeak = peakOfSine(high, 0.9, 220, 4000, 2000)
    expect(highPeak).toBeLessThan(lowPeak)
  })

  it('stays finite when fed NaN params', () => {
    const comp = new Comp(SR)
    comp.setParams({ amount: NaN, attack: NaN, release: NaN, makeup: NaN })
    const out = new Float64Array(2)
    for (let i = 0; i < 1000; i++) {
      const s = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR)
      comp.processInto(s, s, out)
      expect(Number.isFinite(out[0])).toBe(true)
      expect(Number.isFinite(out[1])).toBe(true)
    }
  })
})

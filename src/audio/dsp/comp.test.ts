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

  it('keeps output finite and bounded across mode/lookahead combos', () => {
    for (const mode of [0, 1]) {
      for (const lookahead of [0, 1]) {
        const comp = new Comp(SR)
        comp.setParams({ amount: 0.7, attack: 0.1, release: 0.3, makeup: 0.6, mix: 0.8, mode, lookahead })
        comp.reset()
        const out = new Float64Array(2)
        for (let i = 0; i < 4000; i++) {
          const s = 0.8 * Math.sin((2 * Math.PI * 220 * i) / SR)
          comp.processInto(s, s, out)
          expect(Number.isFinite(out[0])).toBe(true)
          expect(Number.isFinite(out[1])).toBe(true)
          expect(Math.abs(out[0])).toBeLessThan(4)
        }
      }
    }
  })

  it('passes silence through as silence with lookahead on (post-reset)', () => {
    const comp = new Comp(SR)
    comp.setParams({ amount: 0.5, attack: 0.2, release: 0.4, makeup: 0.5, mix: 1, mode: 1, lookahead: 1 })
    comp.reset()
    const out = new Float64Array(2)
    for (let i = 0; i < 2000; i++) {
      comp.processInto(0, 0, out)
      expect(out[0]).toBe(0)
      expect(out[1]).toBe(0)
    }
  })

  it('reduces the peak of a loud sine (gain reduction happens)', () => {
    const comp = new Comp(SR)
    comp.setParams({ amount: 0.8, attack: 0.1, release: 0.4, makeup: 0, mix: 1, mode: 0, lookahead: 0 })
    comp.reset()
    const peak = peakOfSine(comp, 0.9, 220, 4000, 2000)
    expect(peak).toBeLessThan(0.5)
  })

  it('RMS mode also compresses a sustained sine', () => {
    const comp = new Comp(SR)
    comp.setParams({ amount: 0.8, attack: 0.1, release: 0.4, makeup: 0, mix: 1, mode: 1, lookahead: 0 })
    comp.reset()
    const peak = peakOfSine(comp, 0.9, 220, 4000, 2000)
    expect(peak).toBeLessThan(0.5)
  })

  it('mix 0.5 output sits between full-wet and dry', () => {
    const mk = (mix: number): Comp => {
      const c = new Comp(SR)
      c.setParams({ amount: 0.8, attack: 0.1, release: 0.4, makeup: 0, mix, mode: 0, lookahead: 0 })
      c.reset()
      return c
    }
    const wetPeak = peakOfSine(mk(1), 0.9, 220, 4000, 2000)
    const halfPeak = peakOfSine(mk(0.5), 0.9, 220, 4000, 2000)
    expect(halfPeak).toBeGreaterThan(wetPeak)
    expect(halfPeak).toBeLessThan(0.9)
  })

  it('toggling lookahead mid-stream does not click', () => {
    const comp = new Comp(SR)
    comp.setParams({ amount: 0.5, attack: 0.2, release: 0.4, makeup: 0.5, mix: 1, mode: 0, lookahead: 0 })
    comp.reset()
    const out = new Float64Array(2)
    for (let i = 0; i < 4000; i++) {
      comp.processInto(0.5 * Math.sin((2 * Math.PI * 220 * i) / SR), 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR), out)
    }
    comp.setParams({ amount: 0.5, attack: 0.2, release: 0.4, makeup: 0.5, mix: 1, mode: 0, lookahead: 1 })
    let prev = out[0]
    let maxDelta = 0
    for (let i = 4000; i < 6000; i++) {
      const s = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR)
      comp.processInto(s, s, out)
      maxDelta = Math.max(maxDelta, Math.abs(out[0] - prev))
      prev = out[0]
    }
    expect(maxDelta).toBeLessThan(0.1)
  })

  it('is deterministic across fresh instances', () => {
    const mk = (): Comp => {
      const c = new Comp(SR)
      c.setParams({ amount: 0.6, attack: 0.15, release: 0.35, makeup: 0.4, mix: 0.7, mode: 1, lookahead: 1 })
      c.reset()
      return c
    }
    const a = mk()
    const b = mk()
    const oa = new Float64Array(2)
    const ob = new Float64Array(2)
    for (let i = 0; i < 3000; i++) {
      const s = 0.7 * Math.sin((2 * Math.PI * 220 * i) / SR)
      a.processInto(s, -s, oa)
      b.processInto(s, -s, ob)
      expect(oa[0]).toBe(ob[0])
      expect(oa[1]).toBe(ob[1])
    }
  })

  it('stays finite with NaN/Infinity in new params and inputs', () => {
    const comp = new Comp(SR)
    comp.setParams({
      amount: NaN, attack: Infinity, release: NaN, makeup: NaN, mix: NaN, mode: NaN, lookahead: Infinity,
    })
    const out = new Float64Array(2)
    for (let i = 0; i < 1000; i++) {
      comp.processInto(i === 0 ? NaN : 0.5 * Math.sin(i * 0.1), Infinity, out)
      expect(Number.isFinite(out[0])).toBe(true)
      expect(Number.isFinite(out[1])).toBe(true)
    }
  })
})

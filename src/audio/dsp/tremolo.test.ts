import { describe, it, expect } from 'vitest'
import { Tremolo } from './tremolo.ts'

const SR = 48000

/** Peak-to-peak spread of the output when a DC level is fed for `n` samples. */
function dcSpread(trem: Tremolo, level: number, settle: number, n: number): number {
  const out = new Float64Array(2)
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < settle + n; i++) {
    trem.processInto(level, level, out)
    if (i >= settle) {
      lo = Math.min(lo, out[0])
      hi = Math.max(hi, out[0])
    }
  }
  return hi - lo
}

describe('Tremolo', () => {
  it('passes silence through as silence', () => {
    const trem = new Tremolo(SR)
    trem.setParams({ rate: 5, depth: 0.6, shape: 0 })
    trem.reset()
    const out = new Float64Array(2)
    for (let i = 0; i < 500; i++) trem.processInto(0, 0, out)
    expect(out[0]).toBe(0)
    expect(out[1]).toBe(0)
  })

  it('leaves the signal unmodulated at depth 0', () => {
    const trem = new Tremolo(SR)
    trem.setParams({ rate: 5, depth: 0, shape: 0 })
    trem.reset()
    // depth 0 pins gain at unity, so a DC input stays flat.
    const spread = dcSpread(trem, 0.5, 1000, 4000)
    expect(spread).toBeLessThan(1e-6)
  })

  it('modulates amplitude when depth > 0', () => {
    const trem = new Tremolo(SR)
    trem.setParams({ rate: 5, depth: 0.8, shape: 0 })
    trem.reset()
    const spread = dcSpread(trem, 0.5, 1000, 4000)
    expect(spread).toBeGreaterThan(0.1)
  })

  it('keeps output finite and bounded for a sine', () => {
    const trem = new Tremolo(SR)
    trem.setParams({ rate: 8, depth: 0.6, shape: 1 })
    trem.reset()
    const out = new Float64Array(2)
    for (let i = 0; i < 4000; i++) {
      const s = 0.9 * Math.sin((2 * Math.PI * 220 * i) / SR)
      trem.processInto(s, s, out)
      expect(Number.isFinite(out[0])).toBe(true)
      expect(Math.abs(out[0])).toBeLessThan(4)
    }
  })

  it('stays finite when fed NaN params', () => {
    const trem = new Tremolo(SR)
    trem.setParams({ rate: NaN, depth: NaN, shape: NaN })
    const out = new Float64Array(2)
    for (let i = 0; i < 1000; i++) {
      const s = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR)
      trem.processInto(s, s, out)
      expect(Number.isFinite(out[0])).toBe(true)
      expect(Number.isFinite(out[1])).toBe(true)
    }
  })
})

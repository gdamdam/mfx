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

describe('Tremolo modes', () => {
  it('produces finite, bounded output for a 220Hz sine in every mode', () => {
    for (let mode = 0; mode <= 2; mode++) {
      const trem = new Tremolo(SR)
      trem.setParams({ rate: 8, depth: 1, shape: 1, mode })
      trem.reset()
      const out = new Float64Array(2)
      for (let i = 0; i < 4000; i++) {
        const s = 0.9 * Math.sin((2 * Math.PI * 220 * i) / SR)
        trem.processInto(s, s, out)
        expect(Number.isFinite(out[0])).toBe(true)
        expect(Number.isFinite(out[1])).toBe(true)
        expect(Math.abs(out[0])).toBeLessThan(4)
        expect(Math.abs(out[1])).toBeLessThan(4)
      }
    }
  })

  it('passes silence through as silence in every mode (post-reset)', () => {
    for (let mode = 0; mode <= 2; mode++) {
      const trem = new Tremolo(SR)
      trem.setParams({ rate: 5, depth: 0.8, shape: 0.5, mode })
      trem.reset()
      const out = new Float64Array(2)
      for (let i = 0; i < 500; i++) trem.processInto(0, 0, out)
      expect(out[0]).toBe(0)
      expect(out[1]).toBe(0)
    }
  })

  it('stays finite with NaN/Infinity params and inputs in every mode shape', () => {
    const trem = new Tremolo(SR)
    trem.setParams({ rate: NaN, depth: Infinity, shape: NaN, mode: NaN })
    const out = new Float64Array(2)
    for (let i = 0; i < 1000; i++) {
      trem.processInto(i === 0 ? NaN : Math.sin(i), Infinity, out)
      expect(Number.isFinite(out[0])).toBe(true)
      expect(Number.isFinite(out[1])).toBe(true)
    }
  })

  it('is deterministic: two fresh instances produce identical output', () => {
    const a = new Tremolo(SR)
    const b = new Tremolo(SR)
    for (const t of [a, b]) {
      t.setParams({ rate: 6, depth: 0.9, shape: 0.5, mode: 2 })
      t.reset()
    }
    const oa = new Float64Array(2)
    const ob = new Float64Array(2)
    for (let i = 0; i < 4000; i++) {
      const s = Math.sin((2 * Math.PI * 220 * i) / SR)
      a.processInto(s, s * 0.5, oa)
      b.processInto(s, s * 0.5, ob)
      expect(oa[0]).toBe(ob[0])
      expect(oa[1]).toBe(ob[1])
    }
  })

  it('pan mode conserves total power and moves signal between channels', () => {
    const trem = new Tremolo(SR)
    trem.setParams({ rate: 2, depth: 1, shape: 0, mode: 2 })
    trem.reset()
    const out = new Float64Array(2)
    // Settle the depth smoother, then measure over a full LFO cycle.
    for (let i = 0; i < 4000; i++) trem.processInto(0.7, 0.7, out)
    let pMin = Infinity
    let pMax = -Infinity
    let lMin = Infinity
    let lMax = -Infinity
    for (let i = 0; i < SR / 2; i++) {
      trem.processInto(0.7, 0.7, out)
      const p = out[0] * out[0] + out[1] * out[1]
      pMin = Math.min(pMin, p)
      pMax = Math.max(pMax, p)
      lMin = Math.min(lMin, Math.abs(out[0]))
      lMax = Math.max(lMax, Math.abs(out[0]))
    }
    // Equal-power law: L² + R² stays constant while L swings toward zero.
    expect(pMax - pMin).toBeLessThan(0.02)
    expect(lMax).toBeGreaterThan(0.9)
    expect(lMin).toBeLessThan(0.1)
  })

  it('harmonic mode differs from classic on broadband input', () => {
    const classic = new Tremolo(SR)
    classic.setParams({ rate: 5, depth: 0.8, shape: 0, mode: 0 })
    classic.reset()
    const harmonic = new Tremolo(SR)
    harmonic.setParams({ rate: 5, depth: 0.8, shape: 0, mode: 1 })
    harmonic.reset()
    const oc = new Float64Array(2)
    const oh = new Float64Array(2)
    let diff = 0
    for (let i = 0; i < 8000; i++) {
      const s =
        0.5 * Math.sin((2 * Math.PI * 220 * i) / SR) +
        0.4 * Math.sin((2 * Math.PI * 3000 * i) / SR)
      classic.processInto(s, s, oc)
      harmonic.processInto(s, s, oh)
      diff += Math.abs(oc[0] - oh[0])
    }
    expect(diff).toBeGreaterThan(1)
  })

  it('harmonic bands sum back to unity at depth 0', () => {
    const trem = new Tremolo(SR)
    trem.setParams({ rate: 5, depth: 0, shape: 0, mode: 1 })
    trem.reset()
    const out = new Float64Array(2)
    let maxErr = 0
    for (let i = 0; i < 4000; i++) {
      const s =
        0.5 * Math.sin((2 * Math.PI * 220 * i) / SR) +
        0.4 * Math.sin((2 * Math.PI * 3000 * i) / SR)
      trem.processInto(s, s, out)
      maxErr = Math.max(maxErr, Math.abs(out[0] - s))
    }
    expect(maxErr).toBeLessThan(1e-9)
  })
})

import { describe, it, expect } from 'vitest'
import { Chorus } from './chorus.ts'

const SR = 48000

describe('Chorus', () => {
  it('passes silence through as silence', () => {
    const chorus = new Chorus(SR)
    chorus.setParams({ rate: 0.8, depth: 0.5, mix: 0.5 })
    chorus.reset()
    const out = new Float64Array(2)
    for (let i = 0; i < 500; i++) chorus.processInto(0, 0, out)
    expect(out[0]).toBe(0)
    expect(out[1]).toBe(0)
  })

  it('keeps output finite and bounded for a sine', () => {
    const chorus = new Chorus(SR)
    chorus.setParams({ rate: 1.2, depth: 0.8, mix: 0.5 })
    chorus.reset()
    const out = new Float64Array(2)
    for (let i = 0; i < 4000; i++) {
      const s = 0.7 * Math.sin((2 * Math.PI * 220 * i) / SR)
      chorus.processInto(s, s, out)
      expect(Number.isFinite(out[0])).toBe(true)
      expect(Math.abs(out[0])).toBeLessThan(4)
    }
  })

  it('is nearly dry at mix = 0', () => {
    const chorus = new Chorus(SR)
    chorus.setParams({ rate: 1, depth: 0.5, mix: 0 })
    chorus.reset() // reset jumps the mix smoother to its target (0)
    const out = new Float64Array(2)
    for (let i = 0; i < 2000; i++) {
      const s = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR)
      chorus.processInto(s, s, out)
      expect(Math.abs(out[0] - s)).toBeLessThan(1e-6)
    }
  })

  it('stays finite when fed NaN params', () => {
    const chorus = new Chorus(SR)
    chorus.setParams({ rate: NaN, depth: NaN, mix: NaN, mode: NaN, width: NaN })
    const out = new Float64Array(2)
    for (let i = 0; i < 1000; i++) {
      const s = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR)
      chorus.processInto(s, s, out)
      expect(Number.isFinite(out[0])).toBe(true)
      expect(Number.isFinite(out[1])).toBe(true)
    }
  })

  it('keeps output finite and bounded for a sine in every mode', () => {
    for (const mode of [0, 1, 2]) {
      const chorus = new Chorus(SR)
      chorus.setParams({ rate: 1.2, depth: 0.8, mix: 0.5, mode, width: 0.7 })
      chorus.reset()
      const out = new Float64Array(2)
      for (let i = 0; i < 4000; i++) {
        const s = 0.7 * Math.sin((2 * Math.PI * 220 * i) / SR)
        chorus.processInto(s, s, out)
        expect(Number.isFinite(out[0])).toBe(true)
        expect(Number.isFinite(out[1])).toBe(true)
        expect(Math.abs(out[0])).toBeLessThan(4)
        expect(Math.abs(out[1])).toBeLessThan(4)
      }
    }
  })

  it('passes silence through as silence in every mode', () => {
    for (const mode of [0, 1, 2]) {
      const chorus = new Chorus(SR)
      chorus.setParams({ rate: 0.8, depth: 0.5, mix: 0.5, mode, width: 0.7 })
      chorus.reset()
      const out = new Float64Array(2)
      for (let i = 0; i < 2000; i++) {
        chorus.processInto(0, 0, out)
        expect(out[0]).toBe(0)
        expect(out[1]).toBe(0)
      }
    }
  })

  it('survives non-finite input samples', () => {
    const chorus = new Chorus(SR)
    chorus.setParams({ rate: 1, depth: 0.6, mix: 0.5, mode: 2, width: 0.5 })
    chorus.reset()
    const out = new Float64Array(2)
    for (let i = 0; i < 1000; i++) {
      const s = i === 0 ? NaN : 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR)
      chorus.processInto(s, i === 1 ? Infinity : s, out)
      expect(Number.isFinite(out[0])).toBe(true)
      expect(Number.isFinite(out[1])).toBe(true)
    }
  })

  it('is deterministic across fresh instances', () => {
    const a = new Chorus(SR)
    const b = new Chorus(SR)
    const params = { rate: 1.3, depth: 0.7, mix: 0.6, mode: 2, width: 0.5 }
    a.setParams(params)
    b.setParams(params)
    a.reset()
    b.reset()
    const outA = new Float64Array(2)
    const outB = new Float64Array(2)
    for (let i = 0; i < 4000; i++) {
      const s = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR)
      a.processInto(s, s, outA)
      b.processInto(s, s, outB)
      expect(outA[0]).toBe(outB[0])
      expect(outA[1]).toBe(outB[1])
    }
  })

  it('collapses the wet to mono at width 0 (L == R with mix 1)', () => {
    for (const mode of [0, 1, 2]) {
      const chorus = new Chorus(SR)
      chorus.setParams({ rate: 1, depth: 0.8, mix: 1, mode, width: 0 })
      chorus.reset()
      const out = new Float64Array(2)
      for (let i = 0; i < 4000; i++) {
        const s = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR)
        chorus.processInto(s, s, out)
        expect(Math.abs(out[0] - out[1])).toBeLessThan(1e-9)
      }
    }
  })

  it('ensemble mode differs from classic', () => {
    const classic = new Chorus(SR)
    const ensemble = new Chorus(SR)
    classic.setParams({ rate: 1, depth: 0.7, mix: 0.5, mode: 0, width: 0.7 })
    ensemble.setParams({ rate: 1, depth: 0.7, mix: 0.5, mode: 2, width: 0.7 })
    classic.reset()
    ensemble.reset()
    const outC = new Float64Array(2)
    const outE = new Float64Array(2)
    let maxDiff = 0
    for (let i = 0; i < 8000; i++) {
      const s = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR)
      classic.processInto(s, s, outC)
      ensemble.processInto(s, s, outE)
      maxDiff = Math.max(maxDiff, Math.abs(outC[0] - outE[0]))
    }
    expect(maxDiff).toBeGreaterThan(1e-3)
  })
})

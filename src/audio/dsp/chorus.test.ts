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
    chorus.setParams({ rate: NaN, depth: NaN, mix: NaN })
    const out = new Float64Array(2)
    for (let i = 0; i < 1000; i++) {
      const s = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR)
      chorus.processInto(s, s, out)
      expect(Number.isFinite(out[0])).toBe(true)
      expect(Number.isFinite(out[1])).toBe(true)
    }
  })
})

import { describe, it, expect } from 'vitest'
import { Filter } from './filter.ts'

const SR = 48000

/** RMS of the output when a sine of `freq` is passed for `n` samples. */
function rmsOfSine(filter: Filter, freq: number, settle: number, n: number): number {
  const out = new Float64Array(2)
  let sum = 0
  for (let i = 0; i < settle + n; i++) {
    const s = Math.sin((2 * Math.PI * freq * i) / SR)
    filter.processInto(s, s, out)
    if (i >= settle) sum += out[0] * out[0]
  }
  return Math.sqrt(sum / n)
}

describe('Filter', () => {
  it('passes silence through as silence', () => {
    const filter = new Filter(SR)
    filter.setParams({ freq: 1000, reso: 0.2, type: 0 })
    filter.reset()
    const out = new Float64Array(2)
    for (let i = 0; i < 500; i++) filter.processInto(0, 0, out)
    expect(out[0]).toBe(0)
    expect(out[1]).toBe(0)
  })

  it('keeps output finite and bounded for a sine', () => {
    const filter = new Filter(SR)
    filter.setParams({ freq: 1200, reso: 0.5, type: 0 })
    filter.reset()
    const out = new Float64Array(2)
    for (let i = 0; i < 4000; i++) {
      const s = Math.sin((2 * Math.PI * 220 * i) / SR)
      filter.processInto(s, s, out)
      expect(Number.isFinite(out[0])).toBe(true)
      expect(Math.abs(out[0])).toBeLessThan(4)
    }
  })

  it('lowpass attenuates a high tone more than a low tone', () => {
    const lowTone = new Filter(SR)
    lowTone.setParams({ freq: 500, reso: 0.1, type: 0 })
    lowTone.reset()
    const highTone = new Filter(SR)
    highTone.setParams({ freq: 500, reso: 0.1, type: 0 })
    highTone.reset()
    const lowRms = rmsOfSine(lowTone, 150, 2000, 4000)
    const highRms = rmsOfSine(highTone, 6000, 2000, 4000)
    expect(highRms).toBeLessThan(lowRms)
  })

  it('stays stable at maximum cutoff for every resonance', () => {
    // Regression: cutoff pushed to the top (e.g. XY pad far right) must not let
    // the Chamberlin SVF self-oscillate to huge values — that used to poison the
    // downstream delay/reverb and silence the whole rack.
    for (const reso of [0, 0.2, 0.5, 0.8, 1]) {
      const filter = new Filter(SR)
      filter.setParams({ freq: 18000, reso, type: 0 })
      filter.reset()
      const out = new Float64Array(2)
      let peak = 0
      for (let i = 0; i < SR; i++) {
        const s = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR)
        filter.processInto(s, s, out)
        expect(Number.isFinite(out[0])).toBe(true)
        peak = Math.max(peak, Math.abs(out[0]))
      }
      expect(peak).toBeLessThan(4)
    }
  })

  it('stays finite when fed NaN params', () => {
    const filter = new Filter(SR)
    filter.setParams({ freq: NaN, reso: NaN, type: NaN })
    const out = new Float64Array(2)
    for (let i = 0; i < 1000; i++) {
      const s = Math.sin((2 * Math.PI * 220 * i) / SR)
      filter.processInto(s, s, out)
      expect(Number.isFinite(out[0])).toBe(true)
      expect(Number.isFinite(out[1])).toBe(true)
    }
  })
})

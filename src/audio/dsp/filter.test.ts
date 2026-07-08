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

  it('lowpass opens above 8kHz (TPT SVF is stable to Nyquist) (M2)', () => {
    // Regression: the old Chamberlin cap (~7938Hz @44.1k, 0.18*fs) left the top
    // of the freq knob dead. A wide-open LP must now pass a 9kHz tone.
    const filter = new Filter(SR)
    filter.setParams({ freq: 18000, reso: 0, type: 0 })
    filter.reset()
    const rms = rmsOfSine(filter, 9000, 4000, 4000)
    // Unit sine RMS ~0.707; a cutoff well above 9kHz should pass most of it.
    expect(rms).toBeGreaterThan(0.5)
  })

  it('produces finite, bounded output across all models and types', () => {
    for (let model = 0; model < 4; model++) {
      for (let type = 0; type < 4; type++) {
        const filter = new Filter(SR)
        filter.setParams({ freq: 1200, reso: 0.7, type, model, drive: 0.5 })
        filter.reset()
        const out = new Float64Array(2)
        for (let i = 0; i < 4000; i++) {
          const s = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR)
          filter.processInto(s, s, out)
          expect(Number.isFinite(out[0])).toBe(true)
          expect(Number.isFinite(out[1])).toBe(true)
          expect(Math.abs(out[0])).toBeLessThan(30)
        }
      }
    }
  })

  it('silence in, silence out for every model (post-reset)', () => {
    for (let model = 0; model < 4; model++) {
      const filter = new Filter(SR)
      filter.setParams({ freq: 1200, reso: 0.5, type: 0, model, drive: 0.3 })
      filter.reset()
      const out = new Float64Array(2)
      for (let i = 0; i < 1000; i++) {
        filter.processInto(0, 0, out)
        expect(out[0]).toBe(0)
        expect(out[1]).toBe(0)
      }
    }
  })

  it('ladder lowpass at low cutoff strongly attenuates a high tone', () => {
    const hi = new Filter(SR)
    hi.setParams({ freq: 200, reso: 0.2, type: 0, model: 1, drive: 0 })
    hi.reset()
    const hiRms = rmsOfSine(hi, 6000, 4000, 4000)
    const lo = new Filter(SR)
    lo.setParams({ freq: 200, reso: 0.2, type: 0, model: 1, drive: 0 })
    lo.reset()
    const loRms = rmsOfSine(lo, 100, 4000, 4000)
    expect(hiRms).toBeLessThan(0.05)
    expect(loRms).toBeGreaterThan(0.2)
  })

  it('SVF notch attenuates the cutoff frequency but passes low tones', () => {
    const atFc = new Filter(SR)
    atFc.setParams({ freq: 1000, reso: 0.5, type: 3, model: 0, drive: 0 })
    atFc.reset()
    const notchRms = rmsOfSine(atFc, 1000, 4000, 4000)
    const off = new Filter(SR)
    off.setParams({ freq: 1000, reso: 0.5, type: 3, model: 0, drive: 0 })
    off.reset()
    const offRms = rmsOfSine(off, 100, 4000, 4000)
    expect(notchRms).toBeLessThan(0.2)
    expect(offRms).toBeGreaterThan(0.5)
  })

  it('comb model resonates with period ~ sampleRate/freq', () => {
    // freq 480 @48k => 100-sample loop; the first echo of an impulse lands there.
    const filter = new Filter(SR)
    filter.setParams({ freq: 480, reso: 0.9, type: 1, model: 3, drive: 0 })
    filter.reset()
    const out = new Float64Array(2)
    for (let i = 0; i < 2000; i++) filter.processInto(0, 0, out) // model fade settle
    filter.processInto(1, 1, out) // impulse
    let bestIdx = -1
    let bestMag = 0
    for (let i = 1; i <= 400; i++) {
      filter.processInto(0, 0, out)
      if (Math.abs(out[0]) > bestMag) {
        bestMag = Math.abs(out[0])
        bestIdx = i
      }
    }
    expect(bestMag).toBeGreaterThan(0.2)
    expect(Math.abs(bestIdx - 100)).toBeLessThanOrEqual(3)
  })

  it('switching models mid-stream does not click', () => {
    const filter = new Filter(SR)
    filter.setParams({ freq: 1200, reso: 0.3, type: 0, model: 0, drive: 0 })
    filter.reset()
    const out = new Float64Array(2)
    for (let i = 0; i < 4000; i++) {
      filter.processInto(0.5 * Math.sin((2 * Math.PI * 220 * i) / SR), 0, out)
    }
    filter.setParams({ freq: 1200, reso: 0.3, type: 0, model: 1, drive: 0 })
    let prev = out[0]
    let maxDelta = 0
    for (let i = 4000; i < 6000; i++) {
      filter.processInto(0.5 * Math.sin((2 * Math.PI * 220 * i) / SR), 0, out)
      maxDelta = Math.max(maxDelta, Math.abs(out[0] - prev))
      prev = out[0]
    }
    expect(maxDelta).toBeLessThan(0.1)
  })

  it('is deterministic across fresh instances', () => {
    const mk = (): Filter => {
      const f = new Filter(SR)
      f.setParams({ freq: 800, reso: 0.8, type: 1, model: 2, drive: 0.7 })
      f.reset()
      return f
    }
    const a = mk()
    const b = mk()
    const oa = new Float64Array(2)
    const ob = new Float64Array(2)
    for (let i = 0; i < 3000; i++) {
      const s = 0.6 * Math.sin((2 * Math.PI * 220 * i) / SR)
      a.processInto(s, -s, oa)
      b.processInto(s, -s, ob)
      expect(oa[0]).toBe(ob[0])
      expect(oa[1]).toBe(ob[1])
    }
  })

  it('stays finite with NaN/Infinity in new params and inputs', () => {
    const filter = new Filter(SR)
    filter.setParams({ freq: NaN, reso: Infinity, type: NaN, model: NaN, drive: Infinity })
    const out = new Float64Array(2)
    for (let i = 0; i < 1000; i++) {
      filter.processInto(i === 0 ? NaN : Math.sin(i * 0.1), Infinity, out)
      expect(Number.isFinite(out[0])).toBe(true)
      expect(Number.isFinite(out[1])).toBe(true)
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

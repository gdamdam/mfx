import { describe, it, expect } from 'vitest'
import { Flanger } from './flanger.ts'

const SR = 48000

describe('Flanger', () => {
  it('passes silence through as silence', () => {
    const flanger = new Flanger(SR)
    flanger.setParams({ rate: 0.3, depth: 0.6, feedback: 0.5, mix: 0.5 })
    flanger.reset()
    const out = new Float64Array(2)
    for (let i = 0; i < 500; i++) flanger.processInto(0, 0, out)
    expect(out[0]).toBe(0)
    expect(out[1]).toBe(0)
  })

  it('keeps output finite and bounded for a sine', () => {
    const flanger = new Flanger(SR)
    flanger.setParams({ rate: 0.5, depth: 0.6, feedback: 0.9, mix: 0.5 })
    flanger.reset()
    const out = new Float64Array(2)
    for (let i = 0; i < 4000; i++) {
      const s = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR)
      flanger.processInto(s, s, out)
      expect(Number.isFinite(out[0])).toBe(true)
      expect(Math.abs(out[0])).toBeLessThan(4)
    }
  })

  it('is nearly dry at mix = 0', () => {
    const flanger = new Flanger(SR)
    flanger.setParams({ rate: 0.4, depth: 0.6, feedback: 0.5, mix: 0 })
    flanger.reset()
    const out = new Float64Array(2)
    for (let i = 0; i < 2000; i++) {
      const s = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR)
      flanger.processInto(s, s, out)
      expect(Math.abs(out[0] - s)).toBeLessThan(1e-6)
    }
  })

  it('stays finite when fed NaN params', () => {
    const flanger = new Flanger(SR)
    flanger.setParams({ rate: NaN, depth: NaN, feedback: NaN, mix: NaN, mode: NaN, spread: NaN })
    const out = new Float64Array(2)
    for (let i = 0; i < 1000; i++) {
      const s = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR)
      flanger.processInto(s, s, out)
      expect(Number.isFinite(out[0])).toBe(true)
      expect(Number.isFinite(out[1])).toBe(true)
    }
  })

  it('keeps output finite and bounded for a sine in both modes at max feedback', () => {
    for (const mode of [0, 1]) {
      const flanger = new Flanger(SR)
      flanger.setParams({ rate: 0.5, depth: 1, feedback: 0.95, mix: 0.5, mode, spread: 0.4 })
      flanger.reset()
      const out = new Float64Array(2)
      for (let i = 0; i < 8000; i++) {
        const s = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR)
        flanger.processInto(s, s, out)
        expect(Number.isFinite(out[0])).toBe(true)
        expect(Number.isFinite(out[1])).toBe(true)
        expect(Math.abs(out[0])).toBeLessThan(8)
        expect(Math.abs(out[1])).toBeLessThan(8)
      }
    }
  })

  it('passes silence through as silence in both modes', () => {
    for (const mode of [0, 1]) {
      const flanger = new Flanger(SR)
      flanger.setParams({ rate: 0.3, depth: 0.6, feedback: 0.5, mix: 0.5, mode, spread: 0.4 })
      flanger.reset()
      const out = new Float64Array(2)
      for (let i = 0; i < 2000; i++) {
        flanger.processInto(0, 0, out)
        expect(out[0]).toBe(0)
        expect(out[1]).toBe(0)
      }
    }
  })

  it('survives non-finite input samples', () => {
    const flanger = new Flanger(SR)
    flanger.setParams({ rate: 0.5, depth: 0.8, feedback: 0.9, mix: 0.5, mode: 1, spread: 0.6 })
    flanger.reset()
    const out = new Float64Array(2)
    for (let i = 0; i < 1000; i++) {
      const s = i === 0 ? NaN : 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR)
      flanger.processInto(s, i === 1 ? Infinity : s, out)
      expect(Number.isFinite(out[0])).toBe(true)
      expect(Number.isFinite(out[1])).toBe(true)
    }
  })

  it('is deterministic across fresh instances', () => {
    const a = new Flanger(SR)
    const b = new Flanger(SR)
    const params = { rate: 0.7, depth: 0.8, feedback: 0.8, mix: 0.5, mode: 1, spread: 0.6 }
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

  it('spread 0 keeps channels identical; spread 1 decorrelates them', () => {
    const mono = new Flanger(SR)
    mono.setParams({ rate: 0.6, depth: 0.8, feedback: 0.5, mix: 0.5, mode: 0, spread: 0 })
    mono.reset()
    const wide = new Flanger(SR)
    wide.setParams({ rate: 0.6, depth: 0.8, feedback: 0.5, mix: 0.5, mode: 0, spread: 1 })
    wide.reset()
    const out = new Float64Array(2)
    let wideDiff = 0
    for (let i = 0; i < 4000; i++) {
      const s = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR)
      mono.processInto(s, s, out)
      expect(Math.abs(out[0] - out[1])).toBeLessThan(1e-9)
      wide.processInto(s, s, out)
      wideDiff = Math.max(wideDiff, Math.abs(out[0] - out[1]))
    }
    expect(wideDiff).toBeGreaterThan(1e-3)
  })

  it('Zero mode cancels far deeper than Classic at the sweep crossing', () => {
    // Broadband-ish probe (three non-harmonic tones): a through-zero crossing
    // nulls every frequency at once, while a classic comb can only notch some.
    const probe = (i: number): number =>
      0.3 * Math.sin((2 * Math.PI * 220 * i) / SR) +
      0.3 * Math.sin((2 * Math.PI * 347 * i) / SR) +
      0.3 * Math.sin((2 * Math.PI * 523 * i) / SR)

    const minWindowRms = (mode: number): number => {
      const f = new Flanger(SR)
      // Low feedback keeps the loop's residual out of the null so the
      // through-zero cancellation depth is what gets measured.
      f.setParams({ rate: 0.5, depth: 1, feedback: 0.15, mix: 0.5, mode, spread: 0 })
      f.reset()
      const out = new Float64Array(2)
      const win = 256
      let sum = 0
      let count = 0
      let min = Infinity
      const total = 120000 // > one full sweep cycle at 0.5 Hz
      for (let i = 0; i < total; i++) {
        f.processInto(probe(i), probe(i), out)
        if (i < 4000) continue // let smoothers and delay lines settle
        sum += out[0] * out[0]
        count++
        if (count === win) {
          min = Math.min(min, Math.sqrt(sum / win))
          sum = 0
          count = 0
        }
      }
      return min
    }

    const minClassic = minWindowRms(0)
    const minZero = minWindowRms(1)
    expect(minZero).toBeLessThan(minClassic * 0.6)
  })
})

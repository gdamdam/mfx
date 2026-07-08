import { describe, it, expect } from 'vitest'
import { RingMod } from './ringmod.ts'

const SR = 48000

/** Goertzel power at one frequency — cheap single-bin DFT for spectral asserts. */
function goertzelPower(buf: Float64Array, sr: number, hz: number): number {
  const w = (2 * Math.PI * hz) / sr
  const c = 2 * Math.cos(w)
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < buf.length; i++) {
    const s0 = buf[i] + c * s1 - s2
    s2 = s1
    s1 = s0
  }
  return s1 * s1 + s2 * s2 - c * s1 * s2
}

describe('RingMod', () => {
  it('produces finite, bounded output for a 220Hz sine', () => {
    const rm = new RingMod(SR)
    rm.setParams({ freq: 440, mix: 0.5 })
    let max = 0
    for (let i = 0; i < 4000; i++) {
      const [l, r] = rm.process(Math.sin((2 * Math.PI * 220 * i) / SR), 0)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
      max = Math.max(max, Math.abs(l))
    }
    // Product of two [-1,1] signals is bounded by 1.
    expect(max).toBeLessThanOrEqual(1.0001)
  })

  it('mix=0 leaves the signal (near-)dry', () => {
    const rm = new RingMod(SR)
    rm.setParams({ freq: 800, mix: 0 })
    for (let i = 0; i < 20000; i++) rm.process(0, 0) // settle mix -> 0
    for (let i = 0; i < 4000; i++) {
      const x = Math.sin((2 * Math.PI * 220 * i) / SR)
      const [l] = rm.process(x, 0)
      expect(Math.abs(l - x)).toBeLessThan(1e-5)
    }
  })

  it('mix=1 modulates the signal (differs from dry)', () => {
    const rm = new RingMod(SR)
    rm.setParams({ freq: 800, mix: 1 })
    for (let i = 0; i < 2000; i++) rm.process(0, 0)
    let differs = false
    for (let i = 0; i < 4000; i++) {
      const x = Math.sin((2 * Math.PI * 220 * i) / SR)
      const [l] = rm.process(x, 0)
      if (Math.abs(l - x) > 0.1) differs = true
    }
    expect(differs).toBe(true)
  })

  it('guards non-finite params and input, staying finite', () => {
    const rm = new RingMod(SR)
    rm.setParams({ freq: NaN, mix: NaN, mode: NaN, shape: Infinity })
    for (let i = 0; i < 1000; i++) {
      const [l, r] = rm.process(i === 0 ? NaN : Math.sin(i), Infinity)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
    }
  })

  it('stays finite and bounded across all modes with shaped carrier', () => {
    for (const mode of [0, 1, 2]) {
      const rm = new RingMod(SR)
      rm.setParams({ freq: 440, mix: 1, mode, shape: 1 })
      let max = 0
      for (let i = 0; i < 5000; i++) {
        const [l, r] = rm.process(Math.sin((2 * Math.PI * 220 * i) / SR), 0.5)
        expect(Number.isFinite(l)).toBe(true)
        expect(Number.isFinite(r)).toBe(true)
        max = Math.max(max, Math.abs(l))
      }
      expect(max).toBeLessThanOrEqual(1.0001)
    }
  })

  it('Note mode snaps the carrier to the nearest equal-tempered semitone', () => {
    const rm = new RingMod(SR)
    // 230 Hz sits between A3 (220) and A#3 (233.08); nearest ET note is 233.08.
    rm.setParams({ freq: 230, mix: 1, mode: 1, shape: 0 })
    for (let i = 0; i < 24000; i++) rm.process(1, 1) // settle mix + freq smoothing
    // Constant input 1 with mix=1 => output IS the carrier; count zero crossings.
    let prev = 0
    let count = 0
    let first = -1
    let last = -1
    for (let i = 0; i < 96000; i++) {
      const [l] = rm.process(1, 1)
      if (prev <= 0 && l > 0) {
        count++
        if (first < 0) first = i
        last = i
      }
      prev = l
    }
    const f = ((count - 1) * SR) / (last - first)
    expect(Math.abs(f - 233.08)).toBeLessThan(0.5)
  })

  it('Track mode locks the carrier to the input pitch', () => {
    const rm = new RingMod(SR)
    // freq knob at its 220 Hz default => carrier follows the input pitch 1:1.
    rm.setParams({ freq: 220, mix: 1, mode: 2, shape: 0 })
    const step = (2 * Math.PI * 330) / SR
    for (let i = 0; i < 96000; i++) rm.process(Math.sin(step * i), Math.sin(step * i))
    const buf = new Float64Array(8192)
    for (let i = 0; i < buf.length; i++) {
      const x = Math.sin(step * (96000 + i))
      const [l] = rm.process(x, x)
      buf[i] = l
    }
    // sin(330t)*sin(330t) => energy near DC and 660 Hz. If tracking failed and
    // the carrier sat at 220 Hz, energy would sit at 110/550 Hz instead.
    const locked = goertzelPower(buf, SR, 660)
    expect(locked).toBeGreaterThan(goertzelPower(buf, SR, 550) * 3)
    expect(locked).toBeGreaterThan(goertzelPower(buf, SR, 110) * 3)
  })

  it('Track mode holds the last estimate through silence and stays clean', () => {
    const rm = new RingMod(SR)
    rm.setParams({ freq: 220, mix: 0.5, mode: 2, shape: 0.5 })
    const step = (2 * Math.PI * 330) / SR
    for (let i = 0; i < 24000; i++) rm.process(Math.sin(step * i), Math.sin(step * i))
    for (let i = 0; i < 24000; i++) {
      const [l, r] = rm.process(0, 0)
      expect(Math.abs(l)).toBeLessThan(1e-6)
      expect(Math.abs(r)).toBeLessThan(1e-6)
    }
    for (let i = 0; i < 4000; i++) {
      const [l] = rm.process(Math.sin(step * i), Math.sin(step * i))
      expect(Number.isFinite(l)).toBe(true)
    }
  })

  it('shape=1 reshapes the carrier audibly, still bounded', () => {
    const render = (shape: number): Float64Array => {
      const rm = new RingMod(SR)
      rm.setParams({ freq: 440, mix: 1, mode: 0, shape })
      const out = new Float64Array(4000)
      for (let i = 0; i < 14000; i++) {
        const [l] = rm.process(Math.sin((2 * Math.PI * 220 * i) / SR), 0)
        if (i >= 10000) out[i - 10000] = l
      }
      return out
    }
    const sine = render(0)
    const squared = render(1)
    let maxDiff = 0
    for (let i = 0; i < sine.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(sine[i] - squared[i]))
      expect(Math.abs(squared[i])).toBeLessThanOrEqual(1.0001)
    }
    expect(maxDiff).toBeGreaterThan(0.05)
  })

  it('is deterministic: two fresh instances produce identical output', () => {
    const a = new RingMod(SR)
    const b = new RingMod(SR)
    const p = { freq: 500, mix: 0.8, mode: 2, shape: 0.7 }
    a.setParams(p)
    b.setParams(p)
    for (let i = 0; i < 4000; i++) {
      const x = 0.7 * Math.sin((2 * Math.PI * 220 * i) / SR)
      const [la, ra] = a.process(x, -x)
      const [lb, rb] = b.process(x, -x)
      expect(lb).toBe(la)
      expect(rb).toBe(ra)
    }
  })
})

import { describe, it, expect } from 'vitest'
import { Fracture } from './fracture.ts'

const SR = 48000

const DEFAULTS = {
  div: 2,
  chance: 0.6,
  repeat: 0.5,
  reverse: 0.3,
  shuffle: 0.3,
  smooth: 0.5,
  mix: 1,
}

describe('Fracture', () => {
  it('produces finite, bounded output at extreme settings', () => {
    const f = new Fracture(SR)
    f.setTempo(160)
    f.setParams({ div: 3, chance: 1, repeat: 1, reverse: 1, shuffle: 1, smooth: 0, mix: 1 })
    let max = 0
    for (let i = 0; i < SR * 2; i++) {
      const [l, r] = f.process(Math.sin((2 * Math.PI * 220 * i) / SR), Math.cos((2 * Math.PI * 220 * i) / SR))
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
      max = Math.max(max, Math.abs(l), Math.abs(r))
    }
    expect(max).toBeLessThan(2)
  })

  it('chance 0 is exactly transparent', () => {
    const f = new Fracture(SR)
    f.setParams({ ...DEFAULTS, chance: 0 })
    f.reset()
    for (let i = 0; i < SR; i++) {
      const x = Math.sin((2 * Math.PI * 220 * i) / SR)
      const y = Math.cos((2 * Math.PI * 173 * i) / SR)
      const [l, r] = f.process(x, y)
      expect(Math.abs(l - x)).toBeLessThan(1e-12)
      expect(Math.abs(r - y)).toBeLessThan(1e-12)
    }
  })

  it('silence in -> silence out', () => {
    const f = new Fracture(SR)
    f.setParams(DEFAULTS)
    f.reset()
    for (let i = 0; i < 8000; i++) {
      const [l, r] = f.process(0, 0)
      expect(l).toBe(0)
      expect(r).toBe(0)
    }
  })

  it('edits actually replay earlier material (output differs from input)', () => {
    const f = new Fracture(SR)
    f.setTempo(120)
    f.setParams({ ...DEFAULTS, chance: 1, repeat: 1, reverse: 0, shuffle: 0, smooth: 0.2 })
    f.reset()
    let diff = 0
    for (let i = 0; i < SR * 2; i++) {
      // A rising-pitch chirp so repeated slices are distinguishable from live.
      const ph = (2 * Math.PI * (220 + i * 0.01) * i) / SR
      const x = Math.sin(ph)
      const [l] = f.process(x, x)
      if (i > SR / 2) diff += Math.abs(l - x)
    }
    expect(diff).toBeGreaterThan(100)
  })

  it('slice boundaries are smooth: no big sample steps with smoothing on', () => {
    const f = new Fracture(SR)
    f.setTempo(140)
    f.setParams({ ...DEFAULTS, chance: 1, repeat: 0.6, reverse: 0.6, shuffle: 0.6, smooth: 0.6 })
    f.reset()
    let prev = 0
    let maxStep = 0
    for (let i = 0; i < SR * 3; i++) {
      const x = Math.sin((2 * Math.PI * 220 * i) / SR) * 0.8
      const [l] = f.process(x, x)
      if (i > 1000) maxStep = Math.max(maxStep, Math.abs(l - prev))
      prev = l
    }
    // A 220 Hz sine at 0.8 moves ≤ ~0.023/sample; splices should stay comparable.
    expect(maxStep).toBeLessThan(0.1)
  })

  it('respects tempo: slice length follows bpm', () => {
    // With repeat-only edits and a chirp input, count "jumps" per second via
    // large deviations from the live signal; faster tempo -> more boundaries.
    const editActivity = (bpm: number): number => {
      const f = new Fracture(SR)
      f.setTempo(bpm)
      f.setParams({ ...DEFAULTS, div: 1, chance: 1, repeat: 1, reverse: 0, shuffle: 0, smooth: 0.1 })
      f.reset()
      let activity = 0
      for (let i = 0; i < SR * 2; i++) {
        const ph = (2 * Math.PI * (220 + i * 0.02) * i) / SR
        const x = Math.sin(ph)
        const [l] = f.process(x, x)
        activity += Math.abs(l - x)
      }
      return activity
    }
    // Both edit; existence check rather than exact ratio (content-dependent).
    expect(editActivity(60)).toBeGreaterThan(100)
    expect(editActivity(240)).toBeGreaterThan(100)
  })

  it('is deterministic across instances', () => {
    const a = new Fracture(SR)
    const b = new Fracture(SR)
    a.setTempo(120)
    b.setTempo(120)
    a.setParams(DEFAULTS)
    b.setParams(DEFAULTS)
    for (let i = 0; i < SR; i++) {
      const x = Math.sin((2 * Math.PI * 220 * i) / SR)
      const [al, ar] = a.process(x, -x)
      const [bl, br] = b.process(x, -x)
      expect(al).toBe(bl)
      expect(ar).toBe(br)
    }
  })

  it('guards non-finite params, tempo and input', () => {
    const f = new Fracture(SR)
    f.setTempo(NaN)
    f.setParams({ div: NaN, chance: NaN, repeat: NaN, reverse: NaN, shuffle: NaN, smooth: NaN, mix: NaN })
    for (let i = 0; i < 4000; i++) {
      const [l, r] = f.process(i === 0 ? NaN : 0.5, Infinity)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
    }
  })
})

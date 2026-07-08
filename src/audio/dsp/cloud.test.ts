import { describe, it, expect } from 'vitest'
import { Cloud } from './cloud.ts'

const SR = 48000

const DEFAULTS = {
  mix: 0.35,
  size: 0.6,
  decay: 0.5,
  bloom: 0.4,
  mod: 0.3,
  width: 1,
  shimmer: 0,
  freeze: 0,
}

function rms(xs: number[]): number {
  let s = 0
  for (const x of xs) s += x * x
  return Math.sqrt(s / xs.length)
}

describe('Cloud', () => {
  it('produces finite, bounded output for a 220 Hz sine', () => {
    const c = new Cloud(SR)
    c.setParams({ ...DEFAULTS, mix: 0.5 })
    let max = 0
    for (let i = 0; i < 48000; i++) {
      const [l, r] = c.process(Math.sin((2 * Math.PI * 220 * i) / SR), Math.cos((2 * Math.PI * 220 * i) / SR))
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
      max = Math.max(max, Math.abs(l), Math.abs(r))
    }
    expect(max).toBeLessThan(8)
  })

  it('silence in -> silence out after reset', () => {
    const c = new Cloud(SR)
    c.setParams(DEFAULTS)
    c.reset()
    for (let i = 0; i < 4000; i++) {
      const [l, r] = c.process(0, 0)
      expect(l).toBe(0)
      expect(r).toBe(0)
    }
  })

  it('impulse tail decays at moderate decay and grows longer with decay', () => {
    const tailEnergy = (decay: number): number => {
      const c = new Cloud(SR)
      c.setParams({ ...DEFAULTS, decay, mix: 1, bloom: 0 })
      c.process(1, 1)
      const late: number[] = []
      for (let i = 0; i < SR * 2; i++) {
        const [l] = c.process(0, 0)
        if (i > SR * 1.6) late.push(l)
      }
      return rms(late)
    }
    const short = tailEnergy(0.1)
    const long = tailEnergy(0.9)
    expect(long).toBeGreaterThan(short)
    expect(short).toBeLessThan(0.05)
  })

  it('freeze holds the tail at stable level indefinitely without clicks', () => {
    const c = new Cloud(SR)
    c.setParams({ ...DEFAULTS, mix: 1, decay: 0.6 })
    // Excite with half a second of tone.
    for (let i = 0; i < SR / 2; i++) {
      c.process(Math.sin((2 * Math.PI * 220 * i) / SR) * 0.5, Math.sin((2 * Math.PI * 331 * i) / SR) * 0.5)
    }
    c.setParams({ ...DEFAULTS, mix: 1, decay: 0.6, freeze: 1 })
    // Let the freeze crossfade settle, then measure windows far apart.
    const windows: number[] = []
    let prev = 0
    let maxStep = 0
    for (let w = 0; w < 8; w++) {
      const buf: number[] = []
      for (let i = 0; i < SR; i++) {
        const [l] = c.process(0, 0)
        expect(Number.isFinite(l)).toBe(true)
        buf.push(l)
        maxStep = Math.max(maxStep, Math.abs(l - prev))
        prev = l
      }
      windows.push(rms(buf))
    }
    // 8 seconds of hold: level neither dies nor blows up.
    expect(windows[7]).toBeGreaterThan(windows[0] * 0.5)
    expect(windows[7]).toBeLessThan(windows[0] * 2)
    expect(windows[7]).toBeGreaterThan(1e-4)
    // No clicks: sample-to-sample steps stay small for a frozen wash.
    expect(maxStep).toBeLessThan(0.5)
  })

  it('shimmer raises the spectral center of the tail', () => {
    const zcRate = (shimmer: number): number => {
      const c = new Cloud(SR)
      c.setParams({ ...DEFAULTS, mix: 1, decay: 0.8, shimmer, mod: 0 })
      for (let i = 0; i < SR; i++) c.process(Math.sin((2 * Math.PI * 220 * i) / SR) * 0.5, 0)
      let crossings = 0
      let prev = 0
      for (let i = 0; i < SR; i++) {
        const [l] = c.process(0, 0)
        if (prev <= 0 && l > 0) crossings++
        prev = l
      }
      return crossings
    }
    expect(zcRate(1)).toBeGreaterThan(zcRate(0) * 1.1)
  })

  it('width 0 collapses the wet to mono', () => {
    const c = new Cloud(SR)
    c.setParams({ ...DEFAULTS, mix: 1, width: 0 })
    c.reset() // snap smoothers to targets so we measure steady state
    for (let i = 0; i < 20000; i++) {
      const [l, r] = c.process(Math.sin((2 * Math.PI * 220 * i) / SR), Math.sin((2 * Math.PI * 173 * i) / SR))
      if (i > 10000) expect(Math.abs(l - r)).toBeLessThan(1e-9)
    }
  })

  it('is deterministic across instances', () => {
    const a = new Cloud(SR)
    const b = new Cloud(SR)
    a.setParams({ ...DEFAULTS, shimmer: 0.5, mod: 0.8 })
    b.setParams({ ...DEFAULTS, shimmer: 0.5, mod: 0.8 })
    for (let i = 0; i < 12000; i++) {
      const x = Math.sin((2 * Math.PI * 220 * i) / SR)
      const [al, ar] = a.process(x, -x)
      const [bl, br] = b.process(x, -x)
      expect(al).toBe(bl)
      expect(ar).toBe(br)
    }
  })

  it('guards non-finite params and input', () => {
    const c = new Cloud(SR)
    c.setParams({
      mix: NaN,
      size: Infinity,
      decay: NaN,
      bloom: NaN,
      mod: NaN,
      width: NaN,
      shimmer: NaN,
      freeze: NaN,
    })
    for (let i = 0; i < 2000; i++) {
      const [l, r] = c.process(i === 0 ? NaN : 0.5, Infinity)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
    }
  })
})

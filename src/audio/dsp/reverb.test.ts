import { describe, it, expect } from 'vitest'
import { Reverb } from './reverb.ts'

const SR = 48000

describe('Reverb', () => {
  it('produces finite, bounded output for a 220Hz sine', () => {
    const rv = new Reverb(SR)
    rv.setParams({ size: 0.5, decay: 0.5, mix: 0.5, mode: 1 })
    let max = 0
    for (let i = 0; i < 4000; i++) {
      const [l, r] = rv.process(Math.sin((2 * Math.PI * 220 * i) / SR), 0)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
      max = Math.max(max, Math.abs(l))
    }
    expect(max).toBeLessThan(64)
  })

  it('stays stable at high decay over 20k samples (all modes)', () => {
    for (let mode = 0; mode <= 3; mode++) {
      const rv = new Reverb(SR)
      rv.setParams({ size: 1, decay: 1, mix: 1, mode })
      let max = 0
      for (let i = 0; i < 20000; i++) {
        const [l] = rv.process(Math.sin((2 * Math.PI * 220 * i) / SR), 0)
        expect(Number.isFinite(l)).toBe(true)
        max = Math.max(max, Math.abs(l))
      }
      expect(max).toBeLessThan(64)
    }
  })

  it('mix=0 is dry, mix=1 differs from dry', () => {
    const dry = new Reverb(SR)
    dry.setParams({ size: 0.6, decay: 0.6, mix: 0, mode: 1 })
    const wet = new Reverb(SR)
    wet.setParams({ size: 0.6, decay: 0.6, mix: 1, mode: 1 })
    // Settle the mix smoother (one-pole; needs several time-constants).
    for (let i = 0; i < 8000; i++) {
      dry.process(0, 0)
      wet.process(0, 0)
    }
    let dryMatchesInput = true
    let wetDiffers = false
    for (let i = 0; i < 4000; i++) {
      const x = Math.sin((2 * Math.PI * 220 * i) / SR)
      const [dl] = dry.process(x, 0)
      const [wl] = wet.process(x, 0)
      // A smoothed mix leaves an inaudible bleed; require dry within ~-60 dB.
      if (Math.abs(dl - x) > 1e-3) dryMatchesInput = false
      if (Math.abs(wl - x) > 0.05) wetDiffers = true
    }
    expect(dryMatchesInput).toBe(true)
    expect(wetDiffers).toBe(true)
  })

  it('flushes the delay network on mode change (no garble/runaway) (L2)', () => {
    const rv = new Reverb(SR)
    rv.setParams({ size: 1, decay: 1, mix: 1, mode: 1 })
    // Build a substantial tail.
    for (let i = 0; i < 8000; i++) rv.process(Math.sin((2 * Math.PI * 220 * i) / SR), 0)
    // Switch mode, then feed silence: the old tail must be flushed, not read
    // through the new (different-length) combs.
    rv.setParams({ size: 1, decay: 1, mix: 1, mode: 3 })
    let max = 0
    for (let i = 0; i < 32; i++) {
      const [l, r] = rv.process(0, 0)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
      max = Math.max(max, Math.abs(l))
    }
    expect(max).toBeLessThan(0.05)
  })

  it('guards non-finite params and input, staying finite', () => {
    const rv = new Reverb(SR)
    rv.setParams({ size: NaN, decay: NaN, mix: NaN, mode: NaN })
    for (let i = 0; i < 2000; i++) {
      const [l, r] = rv.process(i === 0 ? NaN : Math.sin(i), Infinity)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
    }
  })
})

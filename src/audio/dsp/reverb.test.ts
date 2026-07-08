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

describe('Reverb damp, predelay, width, new modes', () => {
  /** HF proxy: mean |first difference| normalised by mean |x| over a window. */
  function hfRatio(samples: number[]): number {
    let diff = 0
    let mag = 0
    for (let i = 1; i < samples.length; i++) {
      diff += Math.abs(samples[i] - samples[i - 1])
      mag += Math.abs(samples[i])
    }
    return mag > 1e-12 ? diff / mag : 0
  }

  it('produces finite, bounded output for a 220Hz sine in every mode', () => {
    for (let mode = 0; mode <= 5; mode++) {
      const rv = new Reverb(SR)
      rv.setParams({
        size: 0.7,
        decay: 0.8,
        mix: 0.6,
        mode,
        damp: 0.3,
        predelay: 0.05,
        width: 0.7,
      })
      rv.reset()
      let max = 0
      for (let i = 0; i < 6000; i++) {
        const [l, r] = rv.process(Math.sin((2 * Math.PI * 220 * i) / SR), 0)
        expect(Number.isFinite(l)).toBe(true)
        expect(Number.isFinite(r)).toBe(true)
        max = Math.max(max, Math.abs(l), Math.abs(r))
      }
      expect(max).toBeLessThan(64)
    }
  })

  it('passes silence through as silence (post-reset)', () => {
    const rv = new Reverb(SR)
    rv.setParams({ size: 0.8, decay: 0.8, mix: 0.5, mode: 5, damp: 0.5, predelay: 0.1, width: 1 })
    rv.reset()
    for (let i = 0; i < 4000; i++) {
      const [l, r] = rv.process(0, 0)
      expect(l).toBe(0)
      expect(r).toBe(0)
    }
  })

  it('impulse tail decays toward silence at decay 0.5', () => {
    const rv = new Reverb(SR)
    rv.setParams({ size: 0.5, decay: 0.5, mix: 1, mode: 1 })
    rv.reset()
    // Settle the mix smoother on silence first.
    for (let i = 0; i < 8000; i++) rv.process(0, 0)
    rv.process(1, 1)
    const n = 2 * SR
    const tenth = Math.floor(n / 10)
    let firstE = 0
    let lastE = 0
    for (let i = 0; i < n; i++) {
      const [l] = rv.process(0, 0)
      if (i < tenth) firstE += l * l
      if (i >= n - tenth) lastE += l * l
    }
    expect(lastE).toBeLessThan(firstE)
  })

  it('stays stable at decay 1 over 3+ seconds in every mode', () => {
    for (let mode = 0; mode <= 5; mode++) {
      const rv = new Reverb(SR)
      rv.setParams({ size: 1, decay: 1, mix: 1, mode, damp: 0, predelay: 0.2, width: 1 })
      rv.reset()
      let max = 0
      const n = Math.ceil(3.2 * SR)
      for (let i = 0; i < n; i++) {
        const x = i < SR ? Math.sin((2 * Math.PI * 220 * i) / SR) : 0
        const [l, r] = rv.process(x, x)
        if (!Number.isFinite(l) || !Number.isFinite(r)) throw new Error(`non-finite mode ${mode}`)
        max = Math.max(max, Math.abs(l), Math.abs(r))
      }
      expect(max).toBeLessThan(64)
    }
  })

  it('guards non-finite new params, staying finite', () => {
    const rv = new Reverb(SR)
    rv.setParams({
      size: NaN,
      decay: Infinity,
      mix: NaN,
      mode: NaN,
      damp: NaN,
      predelay: Infinity,
      width: -Infinity,
    })
    for (let i = 0; i < 2000; i++) {
      const [l, r] = rv.process(i === 0 ? NaN : Math.sin(i), Infinity)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
    }
  })

  it('is deterministic: two fresh instances produce identical output', () => {
    const make = () => {
      const rv = new Reverb(SR)
      rv.setParams({ size: 0.7, decay: 0.9, mix: 0.8, mode: 5, damp: 0.6, predelay: 0.03, width: 0.8 })
      rv.reset()
      return rv
    }
    const a = make()
    const b = make()
    for (let i = 0; i < 8000; i++) {
      const s = Math.sin((2 * Math.PI * 220 * i) / SR)
      const [al, ar] = a.process(s, s * 0.5)
      const [bl, br] = b.process(s, s * 0.5)
      expect(al).toBe(bl)
      expect(ar).toBe(br)
    }
  })

  it('damp 1 loses HF faster than damp 0', () => {
    const tailWindow = (damp: number): number[] => {
      const rv = new Reverb(SR)
      rv.setParams({ size: 0.5, decay: 0.8, mix: 1, mode: 1, damp })
      rv.reset()
      for (let i = 0; i < 8000; i++) rv.process(0, 0)
      rv.process(1, 1)
      const win: number[] = []
      for (let i = 0; i < 48000; i++) {
        const [l] = rv.process(0, 0)
        if (i >= 24000) win.push(l)
      }
      return win
    }
    const bright = hfRatio(tailWindow(0))
    const dark = hfRatio(tailWindow(1))
    expect(dark).toBeLessThan(bright * 0.7)
  })

  it('width 0 collapses the wet signal to mono (L == R)', () => {
    const rv = new Reverb(SR)
    rv.setParams({ size: 0.6, decay: 0.7, mix: 1, mode: 1, width: 0 })
    rv.reset()
    // Feed the left channel only: any L/R difference must come from the tail.
    for (let i = 0; i < 8000; i++) rv.process(Math.sin((2 * Math.PI * 220 * i) / SR), 0)
    for (let i = 0; i < 8000; i++) {
      const [l, r] = rv.process(Math.sin((2 * Math.PI * 220 * i) / SR), 0)
      expect(Math.abs(l - r)).toBeLessThan(1e-9)
    }
  })

  it('predelay shifts the wet onset later', () => {
    const onset = (predelay: number): number => {
      const rv = new Reverb(SR)
      rv.setParams({ size: 0.5, decay: 0.5, mix: 1, mode: 0, predelay })
      rv.reset()
      for (let i = 0; i < 8000; i++) rv.process(0, 0)
      rv.process(1, 1)
      for (let i = 1; i < SR; i++) {
        const [l] = rv.process(0, 0)
        if (Math.abs(l) > 1e-4) return i
      }
      return SR
    }
    const early = onset(0)
    const late = onset(0.15)
    expect(late - early).toBeGreaterThan(0.12 * SR)
  })
})

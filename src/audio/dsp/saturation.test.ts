import { describe, it, expect } from 'vitest'
import { Saturation, type SaturationParams } from './saturation.ts'

const SR = 48000

function params(over: Partial<SaturationParams> = {}): SaturationParams {
  // contract defaults
  return { amount: 0.35, type: 0, tone: 0.5, mix: 1, level: 0.8, ...over }
}

function sine(i: number, hz = 220, amp = 0.5): number {
  return amp * Math.sin((2 * Math.PI * hz * i) / SR)
}

function rms(xs: number[]): number {
  let sum = 0
  for (const x of xs) sum += x * x
  return Math.sqrt(sum / xs.length)
}

/** Run n samples of a stereo sine through s, returning the left outputs. */
function run(s: Saturation, n: number, hz = 220, amp = 0.5): number[] {
  const outs: number[] = []
  for (let i = 0; i < n; i++) {
    const x = sine(i, hz, amp)
    const [l] = s.process(x, x)
    outs.push(l)
  }
  return outs
}

describe('Saturation', () => {
  it('produces finite, bounded output for a 220Hz sine across all types', () => {
    for (let type = 0; type <= 4; type++) {
      const s = new Saturation(SR)
      s.setParams(params({ type, amount: 0.9 }))
      s.reset()
      for (let i = 0; i < 4000; i++) {
        const [l, r] = s.process(sine(i), sine(i, 220, -0.5))
        expect(Number.isFinite(l)).toBe(true)
        expect(Number.isFinite(r)).toBe(true)
        expect(Math.abs(l)).toBeLessThan(4)
        expect(Math.abs(r)).toBeLessThan(4)
      }
    }
  })

  it('outputs silence for silence after reset', () => {
    for (let type = 0; type <= 4; type++) {
      const s = new Saturation(SR)
      s.setParams(params({ type, amount: 1 }))
      run(s, 2000) // dirty the filter state
      s.reset()
      for (let i = 0; i < 1000; i++) {
        const [l, r] = s.process(0, 0)
        expect(Math.abs(l)).toBeLessThan(1e-9)
        expect(Math.abs(r)).toBeLessThan(1e-9)
      }
    }
  })

  it('has no DC even for Tube/Xfmr at high amount', () => {
    // 240Hz has an exactly integer period (200 samples at 48k), so the mean
    // over whole cycles isolates true DC from waveform asymmetry.
    for (const type of [1, 2]) {
      const s = new Saturation(SR)
      s.setParams(params({ type, amount: 1 }))
      s.reset()
      let sum = 0
      for (let i = 0; i < 12000; i++) {
        const x = sine(i, 240)
        const [l] = s.process(x, x)
        if (i >= 4000) sum += l // skip 4000 = 20 periods of settling
      }
      const mean = sum / 8000
      expect(Math.abs(mean)).toBeLessThan(0.01)
    }
  })

  it('guards non-finite params and input, staying finite', () => {
    const s = new Saturation(SR)
    s.setParams({ amount: NaN, type: Infinity, tone: NaN, mix: -Infinity, level: NaN })
    for (let i = 0; i < 1000; i++) {
      const [l, r] = s.process(i === 0 ? NaN : Math.sin(i), Infinity)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
    }
  })

  it('is deterministic across fresh instances', () => {
    const make = () => {
      const s = new Saturation(SR)
      s.setParams(params({ type: 1, amount: 0.7, tone: 0.3 }))
      return s
    }
    const a = make()
    const b = make()
    for (let i = 0; i < 4000; i++) {
      const x = sine(i) + 0.2 * sine(i, 1370, 1)
      const [la, ra] = a.process(x, -x)
      const [lb, rb] = b.process(x, -x)
      expect(la).toBe(lb)
      expect(ra).toBe(rb)
    }
  })

  it('is near-transparent at amount 0 for every type (defaults: unity gain)', () => {
    for (let type = 0; type <= 4; type++) {
      // level 0.8 maps to exactly unity; tone 0.5 is the flat tilt position.
      const s = new Saturation(SR)
      s.setParams(params({ type, amount: 0 }))
      s.reset()
      run(s, 2000) // warm the (inert at amount 0) filter states
      const ins: number[] = []
      const outs: number[] = []
      for (let i = 2000; i < 6000; i++) {
        const x = sine(i)
        ins.push(x)
        const [l] = s.process(x, x)
        outs.push(l)
        // waveform closely tracks the input (only the tiny 2x downsampler lag)
        expect(Math.abs(l - x)).toBeLessThan(0.02)
      }
      const ratio = rms(outs) / rms(ins)
      // within ~1 dB of unity
      expect(ratio).toBeGreaterThan(0.89)
      expect(ratio).toBeLessThan(1.13)
    }
  })

  it('tone 0.5 is truly flat (transparent chain stays transparent)', () => {
    // With amount 0 / mix 1 / level 0.8 the rest of the chain is identity, so
    // any deviation here would come from the tone stage: it must reconstruct
    // its input exactly at 0.5.
    const s = new Saturation(SR)
    s.setParams(params({ amount: 0, tone: 0.5 }))
    s.reset()
    run(s, 2000)
    for (let i = 2000; i < 6000; i++) {
      const x = sine(i)
      const [l] = s.process(x, x)
      expect(Math.abs(l - x)).toBeLessThan(0.02)
    }
  })

  it('tone darkens at 0 and brightens at 1 on high-frequency content', () => {
    const runTone = (tone: number) => {
      const s = new Saturation(SR)
      s.setParams(params({ amount: 0, tone }))
      s.reset()
      run(s, 2000, 6000)
      return rms(run(s, 4000, 6000))
    }
    const dark = runTone(0)
    const flat = runTone(0.5)
    const bright = runTone(1)
    expect(dark).toBeLessThan(flat * 0.8)
    expect(bright).toBeGreaterThan(flat * 1.2)
  })

  it('each type differs from Clip at amount 0.7', () => {
    const render = (type: number) => {
      const s = new Saturation(SR)
      s.setParams(params({ type, amount: 0.7 }))
      s.reset()
      run(s, 1000)
      return run(s, 4000)
    }
    const clip = render(4)
    for (let type = 0; type <= 3; type++) {
      const outs = render(type)
      let maxDiff = 0
      for (let i = 0; i < outs.length; i++) {
        maxDiff = Math.max(maxDiff, Math.abs(outs[i] - clip[i]))
      }
      expect(maxDiff).toBeGreaterThan(1e-3)
    }
  })

  it('holds RMS level compensation within +/-6 dB across the amount range', () => {
    for (let type = 0; type <= 4; type++) {
      for (const amount of [0, 0.25, 0.5, 0.75, 1]) {
        const s = new Saturation(SR)
        s.setParams(params({ type, amount }))
        s.reset()
        run(s, 2000)
        const ins: number[] = []
        const outs: number[] = []
        for (let i = 2000; i < 6000; i++) {
          const x = sine(i)
          ins.push(x)
          const [l] = s.process(x, x)
          outs.push(l)
        }
        const ratio = rms(outs) / rms(ins)
        expect(ratio).toBeGreaterThan(0.5) // -6 dB
        expect(ratio).toBeLessThan(2) // +6 dB
      }
    }
  })

  it('crossfades type switches without discontinuities', () => {
    const s = new Saturation(SR)
    s.setParams(params({ type: 0, amount: 0.8 }))
    s.reset()
    let prev = 0
    for (let i = 0; i < 12000; i++) {
      if (i === 4000) s.setParams(params({ type: 4, amount: 0.8 }))
      const [l] = s.process(sine(i), sine(i))
      expect(Number.isFinite(l)).toBe(true)
      // no sample-to-sample jump beyond what a 220Hz signal could produce
      expect(Math.abs(l - prev)).toBeLessThan(0.3)
      prev = l
    }
  })
})

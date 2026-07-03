import { describe, it, expect } from 'vitest'
import { Drive } from './drive.ts'

const SR = 48000

// Feed a signal through the core for N samples, return last output.
function run(fx: Drive, input: number, n: number): [number, number] {
  let out: [number, number] = [0, 0]
  for (let i = 0; i < n; i++) out = fx.process(input, input)
  return out
}

describe('Drive', () => {
  it('passes silence as silence', () => {
    const fx = new Drive(SR)
    fx.setParams({ drive: 0.8, tone: 0.5, level: 1 })
    const [l, r] = run(fx, 0, 256)
    expect(l).toBeCloseTo(0, 6)
    expect(r).toBeCloseTo(0, 6)
  })

  it('never exceeds unity for in-range input (soft clip is bounded)', () => {
    const fx = new Drive(SR)
    fx.setParams({ drive: 1, tone: 1, level: 1 })
    for (let i = 0; i < 2000; i++) {
      const x = Math.sin((i / SR) * 2 * Math.PI * 220)
      const [l, r] = fx.process(x, x)
      expect(Math.abs(l)).toBeLessThanOrEqual(1.001)
      expect(Math.abs(r)).toBeLessThanOrEqual(1.001)
    }
  })

  it('more drive increases harmonic content (raises RMS for a small signal)', () => {
    const measure = (drive: number): number => {
      const fx = new Drive(SR)
      fx.setParams({ drive, tone: 1, level: 1 })
      let sum = 0
      const n = 4000
      for (let i = 0; i < n; i++) {
        const x = 0.15 * Math.sin((i / SR) * 2 * Math.PI * 220)
        const [l] = fx.process(x, x)
        sum += l * l
      }
      return Math.sqrt(sum / n)
    }
    expect(measure(0.9)).toBeGreaterThan(measure(0.05))
  })

  it('level scales output linearly', () => {
    const peak = (level: number): number => {
      const fx = new Drive(SR)
      fx.setParams({ drive: 0.5, tone: 1, level })
      let p = 0
      // Let the level smoother settle before measuring (avoid the ramp transient).
      for (let i = 0; i < 8000; i++) {
        const x = Math.sin((i / SR) * 2 * Math.PI * 220)
        const [l] = fx.process(x, x)
        if (i > 4000) p = Math.max(p, Math.abs(l))
      }
      return p
    }
    expect(peak(0.25)).toBeLessThan(peak(1) * 0.5 + 0.05)
  })

  it('guards against non-finite input', () => {
    const fx = new Drive(SR)
    fx.setParams({ drive: NaN, tone: Infinity, level: 0.8 })
    const [l, r] = fx.process(0.3, 0.3)
    expect(Number.isFinite(l)).toBe(true)
    expect(Number.isFinite(r)).toBe(true)
  })
})

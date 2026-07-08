import { describe, it, expect } from 'vitest'
import { Imager, type ImagerParams } from './imager.ts'

const SR = 48000

function params(over: Partial<ImagerParams> = {}): ImagerParams {
  // contract defaults
  return { width: 1, rotate: 0.5, bass: 0, balance: 0.5, ...over }
}

/** Uncorrelated-ish stereo test program: different sines per channel. */
function stereoIn(i: number): [number, number] {
  return [0.5 * Math.sin((2 * Math.PI * 220 * i) / SR), 0.4 * Math.sin((2 * Math.PI * 331 * i) / SR)]
}

function rms(xs: number[]): number {
  let sum = 0
  for (const x of xs) sum += x * x
  return Math.sqrt(sum / xs.length)
}

describe('Imager', () => {
  it('produces finite, bounded output at extreme widths', () => {
    for (const width of [0, 2]) {
      const im = new Imager(SR)
      im.setParams(params({ width, rotate: 1, bass: 300, balance: 0 }))
      for (let i = 0; i < 4000; i++) {
        const [x, y] = stereoIn(i)
        const [l, r] = im.process(x, y)
        expect(Number.isFinite(l)).toBe(true)
        expect(Number.isFinite(r)).toBe(true)
        expect(Math.abs(l)).toBeLessThan(4)
        expect(Math.abs(r)).toBeLessThan(4)
      }
    }
  })

  it('is transparent at defaults to 1e-6 after warmup', () => {
    const im = new Imager(SR)
    im.setParams(params())
    for (let i = 0; i < 4000; i++) {
      const [x, y] = stereoIn(i)
      im.process(x, y)
    }
    for (let i = 4000; i < 8000; i++) {
      const [x, y] = stereoIn(i)
      const [l, r] = im.process(x, y)
      expect(Math.abs(l - x)).toBeLessThan(1e-6)
      expect(Math.abs(r - y)).toBeLessThan(1e-6)
    }
  })

  it('outputs silence for silence after reset', () => {
    const im = new Imager(SR)
    im.setParams(params({ width: 2, bass: 200 }))
    for (let i = 0; i < 2000; i++) {
      const [x, y] = stereoIn(i)
      im.process(x, y)
    }
    im.reset()
    for (let i = 0; i < 1000; i++) {
      const [l, r] = im.process(0, 0)
      expect(Math.abs(l)).toBeLessThan(1e-12)
      expect(Math.abs(r)).toBeLessThan(1e-12)
    }
  })

  it('collapses to mono (L == R) at width 0', () => {
    const im = new Imager(SR)
    im.setParams(params({ width: 0 }))
    im.reset() // snap smoothers to targets
    for (let i = 0; i < 4000; i++) {
      const [x, y] = stereoIn(i)
      const [l, r] = im.process(x, y)
      expect(Math.abs(l - r)).toBeLessThan(1e-9)
    }
  })

  it('leaves the mono sum unchanged by width and bass (phase-safe)', () => {
    for (const over of [{ width: 2 }, { width: 0.3 }, { bass: 150 }, { width: 2, bass: 300 }]) {
      const im = new Imager(SR)
      im.setParams(params(over))
      im.reset()
      for (let i = 0; i < 4000; i++) {
        const [x, y] = stereoIn(i)
        const [l, r] = im.process(x, y)
        expect(Math.abs(0.5 * (l + r) - 0.5 * (x + y))).toBeLessThan(1e-9)
      }
    }
  })

  it('mono-folds low side content but passes high side content (bass 200Hz)', () => {
    const sideRms = (hz: number): [number, number] => {
      const im = new Imager(SR)
      im.setParams(params({ bass: 200 }))
      im.reset()
      const sideIn: number[] = []
      const sideOut: number[] = []
      for (let i = 0; i < 8000; i++) {
        // side-only signal: L = +s, R = -s (no mid component at all)
        const s = 0.5 * Math.sin((2 * Math.PI * hz * i) / SR)
        const [l, r] = im.process(s, -s)
        if (i >= 2000) {
          sideIn.push(s)
          sideOut.push(0.5 * (l - r))
        }
      }
      return [rms(sideOut), rms(sideIn)]
    }
    const [low, lowIn] = sideRms(60)
    expect(low).toBeLessThan(0.4 * lowIn) // 60Hz side strongly attenuated
    const [high, highIn] = sideRms(1000)
    expect(high).toBeGreaterThan(0.8 * highIn) // 1kHz side passes
  })

  it('balance is equal-power: 0 kills R at full L, 1 kills L, center is unity', () => {
    const render = (balance: number): [number, number] => {
      const im = new Imager(SR)
      im.setParams(params({ balance }))
      im.reset()
      const ls: number[] = []
      const rs: number[] = []
      for (let i = 0; i < 4000; i++) {
        const [x, y] = stereoIn(i)
        const [l, r] = im.process(x, y)
        ls.push(l)
        rs.push(r)
      }
      return [rms(ls), rms(rs)]
    }
    const [lFull, rDead] = render(0)
    expect(rDead).toBeLessThan(1e-9)
    expect(lFull).toBeGreaterThan(0.1) // L survives, boosted by the pan law
    const [lDead, rFull] = render(1)
    expect(lDead).toBeLessThan(1e-9)
    expect(rFull).toBeGreaterThan(0.1)
  })

  it('stays bounded and finite at rotation extremes', () => {
    for (const rotate of [0, 1]) {
      const im = new Imager(SR)
      im.setParams(params({ rotate }))
      im.reset()
      for (let i = 0; i < 4000; i++) {
        const [x, y] = stereoIn(i)
        const [l, r] = im.process(x, y)
        expect(Number.isFinite(l)).toBe(true)
        expect(Number.isFinite(r)).toBe(true)
        // orthonormal rotation: peak can grow at most sqrt(2) over the input
        expect(Math.abs(l)).toBeLessThan(1.3)
        expect(Math.abs(r)).toBeLessThan(1.3)
      }
    }
  })

  it('guards non-finite params and input, staying finite', () => {
    const im = new Imager(SR)
    im.setParams({ width: NaN, rotate: Infinity, bass: NaN, balance: -Infinity })
    for (let i = 0; i < 1000; i++) {
      const [l, r] = im.process(i === 0 ? NaN : Math.sin(i), Infinity)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
    }
  })

  it('is deterministic across fresh instances', () => {
    const make = () => {
      const im = new Imager(SR)
      im.setParams(params({ width: 1.7, rotate: 0.2, bass: 120, balance: 0.4 }))
      return im
    }
    const a = make()
    const b = make()
    for (let i = 0; i < 4000; i++) {
      const [x, y] = stereoIn(i)
      const [la, ra] = a.process(x, y)
      const [lb, rb] = b.process(x, y)
      expect(la).toBe(lb)
      expect(ra).toBe(rb)
    }
  })
})

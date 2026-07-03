import { describe, it, expect } from 'vitest'
import { Bitcrusher } from './bitcrusher.ts'

const SR = 48000

describe('Bitcrusher', () => {
  it('produces finite, bounded output for a 220Hz sine', () => {
    const bc = new Bitcrusher(SR)
    bc.setParams({ bits: 8, downsample: 0.5, mix: 0.7 })
    let max = 0
    for (let i = 0; i < 4000; i++) {
      const [l, r] = bc.process(Math.sin((2 * Math.PI * 220 * i) / SR), 0)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
      max = Math.max(max, Math.abs(l))
    }
    expect(max).toBeLessThanOrEqual(1.0001)
  })

  it('quantizes to a small set of distinct values at bits=2', () => {
    const bc = new Bitcrusher(SR)
    // downsample=0 => capture every sample, so distinctness comes only from
    // bit-depth quantization. mix=1 => output is the quantized signal.
    bc.setParams({ bits: 2, downsample: 0, mix: 1 })
    for (let i = 0; i < 5000; i++) bc.process(0, 0) // let bits smoother settle to 2
    const seen = new Set<number>()
    for (let i = 0; i < 4000; i++) {
      const [l] = bc.process(Math.sin((2 * Math.PI * 220 * i) / SR), 0)
      seen.add(Math.round(l * 1000) / 1000)
    }
    // 2 bits => 4 levels => at most 5 distinct quantized values over [-1,1].
    expect(seen.size).toBeLessThanOrEqual(8)
    expect(seen.size).toBeGreaterThan(1)
  })

  it('bits=1 yields a true 2-level mid-riser quantizer (L3)', () => {
    const bc = new Bitcrusher(SR)
    bc.setParams({ bits: 1, downsample: 0, mix: 1 })
    for (let i = 0; i < 8000; i++) bc.process(0, 0) // settle bits smoother to 1
    const seen = new Set<number>()
    for (let i = 0; i < 4000; i++) {
      const [l] = bc.process(Math.sin((2 * Math.PI * 220 * i) / SR), 0)
      seen.add(Math.round(l * 1000) / 1000)
    }
    // Mid-riser: exactly {-0.5, +0.5}, never a 0 code.
    expect(seen.size).toBe(2)
    expect(seen.has(0)).toBe(false)
  })

  it('mix=0 is (near-)dry once the mix smoother settles', () => {
    const bc = new Bitcrusher(SR)
    bc.setParams({ bits: 4, downsample: 1, mix: 0 })
    for (let i = 0; i < 20000; i++) bc.process(0, 0) // fully settle mix -> 0
    for (let i = 0; i < 2000; i++) {
      const x = Math.sin((2 * Math.PI * 220 * i) / SR)
      const [l] = bc.process(x, 0)
      expect(Math.abs(l - x)).toBeLessThan(1e-5)
    }
  })

  it('guards non-finite params and input, staying finite', () => {
    const bc = new Bitcrusher(SR)
    bc.setParams({ bits: NaN, downsample: NaN, mix: NaN })
    for (let i = 0; i < 1000; i++) {
      const [l, r] = bc.process(i === 0 ? NaN : Math.sin(i), Infinity)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
    }
  })
})

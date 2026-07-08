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
    // Start at i=1: sin(0)=0 is silence, and silence now decays to a true 0
    // code (intentional fix for the stuck-LSB buzz) instead of latching +0.5.
    for (let i = 1; i <= 4000; i++) {
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
    bc.setParams({ bits: NaN, downsample: NaN, mix: NaN, smooth: NaN, alias: Infinity })
    for (let i = 0; i < 1000; i++) {
      const [l, r] = bc.process(i === 0 ? NaN : Math.sin(i), Infinity)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
    }
  })

  it('omitted smooth/alias equal explicit zeros (backward compatible defaults)', () => {
    const a = new Bitcrusher(SR)
    const b = new Bitcrusher(SR)
    a.setParams({ bits: 6, downsample: 0.6, mix: 1 })
    b.setParams({ bits: 6, downsample: 0.6, mix: 1, smooth: 0, alias: 0 })
    for (let i = 0; i < 4000; i++) {
      const x = Math.sin((2 * Math.PI * 220 * i) / SR)
      const [la] = a.process(x, 0)
      const [lb] = b.process(x, 0)
      expect(lb).toBe(la)
    }
  })

  it('stays finite and bounded with smooth=1 and alias=1 under heavy crush', () => {
    const bc = new Bitcrusher(SR)
    bc.setParams({ bits: 4, downsample: 1, mix: 1, smooth: 1, alias: 1 })
    let max = 0
    for (let i = 0; i < 8000; i++) {
      const [l, r] = bc.process(Math.sin((2 * Math.PI * 220 * i) / SR), 0.5)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
      max = Math.max(max, Math.abs(l))
    }
    expect(max).toBeLessThanOrEqual(1.0001)
  })

  it('smooth=1 output has smaller steps than smooth=0 under heavy crush', () => {
    const maxStep = (smooth: number): number => {
      const bc = new Bitcrusher(SR)
      bc.setParams({ bits: 16, downsample: 1, mix: 1, smooth, alias: 0 })
      let prev = 0
      let m = 0
      for (let i = 0; i < 20000; i++) {
        const [l] = bc.process(Math.sin((2 * Math.PI * 220 * i) / SR), 0)
        if (i > 10000) m = Math.max(m, Math.abs(l - prev))
        prev = l
      }
      return m
    }
    expect(maxStep(1)).toBeLessThan(maxStep(0) * 0.5)
  })

  it('alias=1 tames HF energy versus alias=0 under heavy crush', () => {
    const hfEnergy = (alias: number): number => {
      const bc = new Bitcrusher(SR)
      bc.setParams({ bits: 12, downsample: 0.8, mix: 1, smooth: 0, alias })
      let prev = 0
      let sum = 0
      for (let i = 0; i < 20000; i++) {
        const [l] = bc.process(Math.sin((2 * Math.PI * 220 * i) / SR), 0)
        if (i > 10000) {
          const d = l - prev
          sum += d * d
        }
        prev = l
      }
      return sum
    }
    expect(hfEnergy(1)).toBeLessThan(hfEnergy(0) * 0.5)
  })

  it('silence in decays to true digital silence (no stuck LSB buzz)', () => {
    const bc = new Bitcrusher(SR)
    bc.setParams({ bits: 8, downsample: 0.5, mix: 1 })
    for (let i = 0; i < 2000; i++) bc.process(Math.sin((2 * Math.PI * 220 * i) / SR), 0.3)
    let tail = 0
    for (let i = 0; i < 48000; i++) {
      const [l, r] = bc.process(0, 0)
      expect(Number.isFinite(l)).toBe(true)
      if (i >= 47900) tail = Math.max(tail, Math.abs(l), Math.abs(r))
    }
    expect(tail).toBe(0)
  })

  it('is deterministic: two fresh instances produce identical output', () => {
    const a = new Bitcrusher(SR)
    const b = new Bitcrusher(SR)
    const p = { bits: 5, downsample: 0.7, mix: 0.9, smooth: 0.5, alias: 0.5 }
    a.setParams(p)
    b.setParams(p)
    for (let i = 0; i < 4000; i++) {
      const x = 0.8 * Math.sin((2 * Math.PI * 220 * i) / SR)
      const [la, ra] = a.process(x, -x)
      const [lb, rb] = b.process(x, -x)
      expect(lb).toBe(la)
      expect(rb).toBe(ra)
    }
  })
})

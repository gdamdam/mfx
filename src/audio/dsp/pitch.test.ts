import { describe, it, expect } from 'vitest'
import { Pitch } from './pitch.ts'

const SR = 48000

function sine(i: number, hz: number): number {
  return Math.sin((2 * Math.PI * hz * i) / SR)
}

/** Count sign changes in a buffer (zero-crossing proxy for frequency). */
function zeroCrossings(buf: Float64Array): number {
  let n = 0
  for (let i = 1; i < buf.length; i++) {
    if ((buf[i - 1] <= 0 && buf[i] > 0) || (buf[i - 1] >= 0 && buf[i] < 0)) n++
  }
  return n
}

/** Run 1s of 220Hz sine; return wet L of the back half plus the matching input. */
function runWet(params: Parameters<Pitch['setParams']>[0]): {
  wet: Float64Array
  dry: Float64Array
} {
  const p = new Pitch(SR)
  p.setParams(params)
  p.reset()
  const half = SR / 2
  const wet = new Float64Array(half)
  const dry = new Float64Array(half)
  for (let i = 0; i < SR; i++) {
    const x = sine(i, 220)
    const [l] = p.process(x, x)
    if (i >= half) {
      wet[i - half] = l
      dry[i - half] = x
    }
  }
  return { wet, dry }
}

describe('Pitch', () => {
  it('produces finite, bounded output for a 220Hz sine in every mode', () => {
    for (const mode of [0, 1, 2]) {
      const p = new Pitch(SR)
      p.setParams({ pitch: 5, fine: 0.7, mode, spread: 0.8, mix: 0.6 })
      let max = 0
      for (let i = 0; i < 4000; i++) {
        const [l, r] = p.process(sine(i, 220), sine(i, 220) * 0.8)
        expect(Number.isFinite(l)).toBe(true)
        expect(Number.isFinite(r)).toBe(true)
        max = Math.max(max, Math.abs(l), Math.abs(r))
      }
      expect(max).toBeLessThan(8)
    }
  })

  it('outputs silence for silence after reset', () => {
    const p = new Pitch(SR)
    p.setParams({ pitch: 7, fine: 0.5, mode: 1, spread: 1, mix: 1 })
    p.reset()
    for (let i = 0; i < 4000; i++) {
      const [l, r] = p.process(0, 0)
      expect(l).toBe(0)
      expect(r).toBe(0)
    }
  })

  it('is bit-transparent at mix 0', () => {
    const p = new Pitch(SR)
    p.setParams({ pitch: 12, fine: 0.9, mode: 2, spread: 1, mix: 0 })
    p.reset()
    for (let i = 0; i < 2000; i++) {
      const inL = sine(i, 220)
      const inR = sine(i, 330)
      const [l, r] = p.process(inL, inR)
      expect(l).toBe(inL)
      expect(r).toBe(inR)
    }
  })

  it('shifts +12st to ~2x the zero-crossing rate', () => {
    const { wet, dry } = runWet({ pitch: 12, fine: 0.5, mode: 0, spread: 0, mix: 1 })
    const ratio = zeroCrossings(wet) / zeroCrossings(dry)
    expect(ratio).toBeGreaterThan(2 * 0.95)
    expect(ratio).toBeLessThan(2 * 1.05)
  })

  it('shifts -12st to ~0.5x the zero-crossing rate', () => {
    const { wet, dry } = runWet({ pitch: -12, fine: 0.5, mode: 0, spread: 0, mix: 1 })
    const ratio = zeroCrossings(wet) / zeroCrossings(dry)
    expect(ratio).toBeGreaterThan(0.5 * 0.95)
    expect(ratio).toBeLessThan(0.5 * 1.05)
  })

  it('Dual mode with full spread decorrelates L and R', () => {
    const p = new Pitch(SR)
    p.setParams({ pitch: 0, fine: 0.8, mode: 1, spread: 1, mix: 1 })
    p.reset()
    let diff = 0
    for (let i = 0; i < 20000; i++) {
      const x = sine(i, 220)
      const [l, r] = p.process(x, x)
      diff += Math.abs(l - r)
    }
    expect(diff).toBeGreaterThan(100)
  })

  it('guards non-finite params and input, staying finite', () => {
    const p = new Pitch(SR)
    p.setParams({ pitch: NaN, fine: Infinity, mode: NaN, spread: -Infinity, mix: NaN })
    for (let i = 0; i < 1000; i++) {
      const [l, r] = p.process(i === 0 ? NaN : sine(i, 220), Infinity)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
    }
  })

  it('is deterministic across fresh instances', () => {
    const mk = (): Pitch => {
      const p = new Pitch(SR)
      p.setParams({ pitch: 3, fine: 0.6, mode: 2, spread: 0.5, mix: 0.7 })
      return p
    }
    const a = mk()
    const b = mk()
    for (let i = 0; i < 5000; i++) {
      const x = sine(i, 220)
      const [al, ar] = a.process(x, x * 0.5)
      const [bl, br] = b.process(x, x * 0.5)
      expect(al).toBe(bl)
      expect(ar).toBe(br)
    }
  })
})

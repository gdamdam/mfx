import { describe, it, expect } from 'vitest'
import { Mosaic } from './mosaic.ts'

const SR = 48000

const DEFAULTS = {
  size: 0.12,
  density: 0.5,
  pitch: 0,
  reverse: 0.2,
  spread: 0.5,
  feedback: 0.2,
  chaos: 0.3,
  freeze: 0,
  mix: 0.5,
}

function rms(xs: number[]): number {
  let s = 0
  for (const x of xs) s += x * x
  return Math.sqrt(s / xs.length)
}

describe('Mosaic', () => {
  it('produces finite, bounded output for a 220 Hz sine at extreme settings', () => {
    const m = new Mosaic(SR)
    m.setParams({
      size: 0.4,
      density: 1,
      pitch: 12,
      reverse: 1,
      spread: 1,
      feedback: 0.9,
      chaos: 1,
      freeze: 0,
      mix: 1,
    })
    let max = 0
    for (let i = 0; i < 48000; i++) {
      const [l, r] = m.process(Math.sin((2 * Math.PI * 220 * i) / SR), Math.cos((2 * Math.PI * 220 * i) / SR))
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
      max = Math.max(max, Math.abs(l), Math.abs(r))
    }
    expect(max).toBeLessThan(10)
  })

  it('silence in -> silence out after reset', () => {
    const m = new Mosaic(SR)
    m.setParams(DEFAULTS)
    m.reset()
    for (let i = 0; i < 8000; i++) {
      const [l, r] = m.process(0, 0)
      expect(l).toBe(0)
      expect(r).toBe(0)
    }
  })

  it('emits granular wet signal when fed audio', () => {
    const m = new Mosaic(SR)
    m.setParams({ ...DEFAULTS, mix: 1 })
    const wet: number[] = []
    for (let i = 0; i < SR; i++) {
      const [l] = m.process(Math.sin((2 * Math.PI * 330 * i) / SR), 0)
      if (i > SR / 2) wet.push(l)
    }
    expect(rms(wet)).toBeGreaterThan(0.02)
  })

  it('pitch +12 doubles the zero-crossing rate of the texture', () => {
    const zc = (pitch: number): number => {
      const m = new Mosaic(SR)
      m.setParams({ ...DEFAULTS, pitch, chaos: 0, reverse: 0, mix: 1, density: 1, feedback: 0 })
      let crossings = 0
      let prev = 0
      for (let i = 0; i < SR; i++) {
        const [l] = m.process(Math.sin((2 * Math.PI * 220 * i) / SR), Math.sin((2 * Math.PI * 220 * i) / SR))
        if (i > SR / 2) {
          if (prev <= 0 && l > 0) crossings++
          prev = l
        }
      }
      return crossings
    }
    const base = zc(0)
    const up = zc(12)
    expect(up).toBeGreaterThan(base * 1.7)
    expect(up).toBeLessThan(base * 2.3)
  })

  it('freeze holds a stable texture from the captured buffer', () => {
    const m = new Mosaic(SR)
    m.setParams({ ...DEFAULTS, mix: 1, feedback: 0 })
    for (let i = 0; i < SR; i++) {
      m.process(Math.sin((2 * Math.PI * 220 * i) / SR) * 0.7, Math.sin((2 * Math.PI * 277 * i) / SR) * 0.7)
    }
    m.setParams({ ...DEFAULTS, mix: 1, feedback: 0, freeze: 1 })
    const windows: number[] = []
    for (let w = 0; w < 6; w++) {
      const buf: number[] = []
      for (let i = 0; i < SR; i++) {
        const [l] = m.process(0, 0)
        expect(Number.isFinite(l)).toBe(true)
        buf.push(l)
      }
      windows.push(rms(buf))
    }
    // The frozen texture neither dies nor grows across 6 seconds.
    expect(windows[5]).toBeGreaterThan(windows[0] * 0.4)
    expect(windows[5]).toBeLessThan(windows[0] * 2.5)
    expect(windows[5]).toBeGreaterThan(1e-3)
  })

  it('is deterministic across instances even with chaos', () => {
    const a = new Mosaic(SR)
    const b = new Mosaic(SR)
    const params = { ...DEFAULTS, chaos: 1, reverse: 0.5, spread: 1 }
    a.setParams(params)
    b.setParams(params)
    for (let i = 0; i < 20000; i++) {
      const x = Math.sin((2 * Math.PI * 220 * i) / SR)
      const [al, ar] = a.process(x, -x)
      const [bl, br] = b.process(x, -x)
      expect(al).toBe(bl)
      expect(ar).toBe(br)
    }
  })

  it('guards non-finite params and input', () => {
    const m = new Mosaic(SR)
    m.setParams({
      size: NaN,
      density: NaN,
      pitch: Infinity,
      reverse: NaN,
      spread: NaN,
      feedback: NaN,
      chaos: NaN,
      freeze: NaN,
      mix: NaN,
    })
    for (let i = 0; i < 4000; i++) {
      const [l, r] = m.process(i === 0 ? NaN : 0.5, Infinity)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
    }
  })
})

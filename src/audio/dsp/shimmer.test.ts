import { describe, it, expect } from 'vitest'
import { Shimmer } from './shimmer.ts'

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

/** Mean absolute successive-sample difference — cheap HF-content proxy. */
function hfProxy(buf: Float64Array): number {
  let sum = 0
  for (let i = 1; i < buf.length; i++) sum += Math.abs(buf[i] - buf[i - 1])
  return sum / (buf.length - 1)
}

/** Feed 1s of 440Hz sine then 0.5s of silence; return the silent-period tail (L). */
function captureTail(s: Shimmer): Float64Array {
  for (let i = 0; i < SR; i++) {
    const x = sine(i, 440) * 0.5
    s.process(x, x)
  }
  const tail = new Float64Array(SR / 2)
  for (let i = 0; i < tail.length; i++) {
    const [l] = s.process(0, 0)
    tail[i] = l
  }
  return tail
}

describe('Shimmer', () => {
  it('produces finite, bounded output for a 220Hz sine at every interval', () => {
    for (const interval of [0, 1, 2, 3]) {
      const s = new Shimmer(SR)
      s.setParams({ mix: 0.5, amount: 0.6, decay: 0.7, tone: 0.5, interval })
      let max = 0
      for (let i = 0; i < 4000; i++) {
        const [l, r] = s.process(sine(i, 220), sine(i, 220) * 0.8)
        expect(Number.isFinite(l)).toBe(true)
        expect(Number.isFinite(r)).toBe(true)
        max = Math.max(max, Math.abs(l), Math.abs(r))
      }
      expect(max).toBeLessThan(8)
    }
  })

  it('outputs silence for silence after reset', () => {
    const s = new Shimmer(SR)
    s.setParams({ mix: 1, amount: 1, decay: 1, tone: 1, interval: 0 })
    s.reset()
    for (let i = 0; i < 8000; i++) {
      const [l, r] = s.process(0, 0)
      expect(l).toBe(0)
      expect(r).toBe(0)
    }
  })

  it('impulse tail decays at decay 0.4', () => {
    const s = new Shimmer(SR)
    s.setParams({ mix: 1, amount: 0, decay: 0.4, tone: 0.5, interval: 0 })
    s.reset()
    s.process(1, 1)
    let early = 0
    let late = 0
    for (let i = 1; i < SR; i++) {
      const [l] = s.process(0, 0)
      if (i < 20000) early += l * l
      else if (i >= 28000) late += l * l
    }
    expect(early).toBeGreaterThan(0)
    expect(late).toBeLessThan(early)
  })

  it('stays bounded at decay 1 + amount 1 over 60k sine + 60k silence', () => {
    const s = new Shimmer(SR)
    s.setParams({ mix: 1, amount: 1, decay: 1, tone: 1, interval: 0 })
    s.reset()
    let max = 0
    for (let i = 0; i < 120000; i++) {
      const x = i < 60000 ? sine(i, 220) * 0.5 : 0
      const [l, r] = s.process(x, x)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
      max = Math.max(max, Math.abs(l), Math.abs(r))
    }
    expect(max).toBeLessThan(4)
  })

  it('Oct+ tail contains higher frequencies than the input', () => {
    const s = new Shimmer(SR)
    s.setParams({ mix: 1, amount: 1, decay: 0.9, tone: 1, interval: 0 })
    s.reset()
    const tail = captureTail(s)
    // Skip the first loop pass so we only measure recirculated (shifted) sound,
    // then compare against the 440Hz input's crossing rate over the same span.
    const window = tail.subarray(6000, 26000)
    const tailRate = zeroCrossings(window) / window.length
    const inputRate = (440 * 2) / SR
    expect(tailRate).toBeGreaterThan(inputRate * 1.3)
  })

  it('tone 0 tail is darker than tone 1', () => {
    const run = (tone: number): Float64Array => {
      const s = new Shimmer(SR)
      s.setParams({ mix: 1, amount: 0.6, decay: 0.8, tone, interval: 0 })
      s.reset()
      return captureTail(s)
    }
    const dark = hfProxy(run(0))
    const bright = hfProxy(run(1))
    expect(bright).toBeGreaterThan(0)
    expect(dark).toBeLessThan(bright)
  })

  it('guards non-finite params and input, staying finite', () => {
    const s = new Shimmer(SR)
    s.setParams({ mix: NaN, amount: Infinity, decay: NaN, tone: -Infinity, interval: NaN })
    for (let i = 0; i < 1000; i++) {
      const [l, r] = s.process(i === 0 ? NaN : sine(i, 220), Infinity)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
    }
  })

  it('is deterministic across fresh instances', () => {
    const mk = (): Shimmer => {
      const s = new Shimmer(SR)
      s.setParams({ mix: 0.6, amount: 0.7, decay: 0.8, tone: 0.4, interval: 3 })
      return s
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

import { describe, it, expect } from 'vitest'
import { Particle, type ParticleParams } from './particle.ts'

const SR = 48000

const DEFAULTS: ParticleParams = {
  time: 0.3,
  density: 0.5,
  size: 0.09,
  pitch: 0,
  scatter: 0.3,
  spread: 0.6,
  feedback: 0.35,
  mix: 0.4,
}

/** Count strict sign changes of channel L over `n` samples of sine input. */
function zeroCrossings(p: Particle, freq: number, n: number): number {
  let prevSign = 0
  let count = 0
  for (let i = 0; i < n; i++) {
    const x = Math.sin((2 * Math.PI * freq * i) / SR)
    const [l] = p.process(x, x)
    const sign = l > 1e-9 ? 1 : l < -1e-9 ? -1 : 0
    if (sign !== 0 && prevSign !== 0 && sign !== prevSign) count++
    if (sign !== 0) prevSign = sign
  }
  return count
}

describe('Particle', () => {
  it('produces finite, bounded output for a 220Hz sine', () => {
    const p = new Particle(SR)
    p.setParams(DEFAULTS)
    let max = 0
    for (let i = 0; i < 4000; i++) {
      const [l, r] = p.process(Math.sin((2 * Math.PI * 220 * i) / SR), 0)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
      max = Math.max(max, Math.abs(l))
    }
    expect(max).toBeLessThan(50)
  })

  it('outputs exact silence for silent input after reset', () => {
    const p = new Particle(SR)
    p.setParams(DEFAULTS)
    for (let i = 0; i < 3000; i++) p.process(Math.sin(i * 0.1), Math.sin(i * 0.13))
    p.reset()
    for (let i = 0; i < 20000; i++) {
      const [l, r] = p.process(0, 0)
      expect(l).toBe(0)
      expect(r).toBe(0)
    }
  })

  it('impulse response decays to a quiet tail with feedback < 1', () => {
    const p = new Particle(SR)
    p.setParams({ ...DEFAULTS, time: 0.2, feedback: 0.5, mix: 1, scatter: 0, spread: 0 })
    p.process(1, 1)
    let earlyMax = 0
    let lateMax = 0
    for (let i = 1; i < 60000; i++) {
      const [l] = p.process(0, 0)
      if (i < 30000) earlyMax = Math.max(earlyMax, Math.abs(l))
      if (i >= 50000) lateMax = Math.max(lateMax, Math.abs(l))
    }
    expect(earlyMax).toBeGreaterThan(0.01)
    expect(lateMax).toBeLessThan(0.05)
    expect(lateMax).toBeLessThan(earlyMax)
  })

  it('guards non-finite params and input, staying finite', () => {
    const p = new Particle(SR)
    p.setParams({
      time: NaN,
      density: Infinity,
      size: NaN,
      pitch: -Infinity,
      scatter: NaN,
      spread: NaN,
      feedback: NaN,
      mix: NaN,
    })
    for (let i = 0; i < 1000; i++) {
      const [l, r] = p.process(i === 0 ? NaN : Math.sin(i), Infinity)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
    }
  })

  it('is deterministic: two fresh instances match sample-for-sample', () => {
    const a = new Particle(SR)
    const b = new Particle(SR)
    a.setParams({ ...DEFAULTS, density: 0.9, scatter: 0.8, spread: 1 })
    b.setParams({ ...DEFAULTS, density: 0.9, scatter: 0.8, spread: 1 })
    for (let i = 0; i < 12000; i++) {
      const x = Math.sin((2 * Math.PI * 220 * i) / SR)
      const y = Math.sin((2 * Math.PI * 330 * i) / SR)
      const [al, ar] = a.process(x, y)
      const [bl, br] = b.process(x, y)
      expect(al).toBe(bl)
      expect(ar).toBe(br)
    }
  })

  it('wet energy appears roughly `time` after an impulse burst', () => {
    const time = 0.3
    const p = new Particle(SR)
    p.setParams({ ...DEFAULTS, time, density: 0.8, size: 0.09, pitch: 0, scatter: 0, spread: 0, feedback: 0, mix: 1 })
    // 200-sample burst, then silence; grains read exactly `time` back.
    let firstIdx = -1
    for (let i = 0; i < 30000; i++) {
      const x = i < 200 ? Math.sin((2 * Math.PI * 220 * i) / SR) : 0
      const [l] = p.process(x, x)
      if (firstIdx < 0 && i >= 200 && Math.abs(l) > 1e-3) {
        firstIdx = i
        break
      }
    }
    expect(firstIdx).toBeGreaterThan(time * 0.7 * SR)
    expect(firstIdx).toBeLessThan(time * 1.3 * SR)
  })

  it('pitch +12 doubles the wet zero-crossing rate vs pitch 0', () => {
    const run = (pitch: number): number => {
      const p = new Particle(SR)
      p.setParams({
        ...DEFAULTS,
        time: 0.3,
        density: 1,
        size: 0.15,
        pitch,
        scatter: 0,
        spread: 0,
        feedback: 0,
        mix: 1,
      })
      // Warm up 1s so the buffer is full of sine and grains are flowing.
      zeroCrossings(p, 220, SR)
      return zeroCrossings(p, 220, SR / 2)
    }
    const base = run(0)
    const up = run(12)
    // 220 Hz over 0.5s => ~220 sign changes; +12 st => ~440.
    expect(Math.abs(base - 220)).toBeLessThan(22)
    expect(Math.abs(up - 440)).toBeLessThan(44)
    expect(up / base).toBeGreaterThan(1.8)
    expect(up / base).toBeLessThan(2.2)
  })

  it('stays stable at maximum feedback over 40k samples', () => {
    const p = new Particle(SR)
    p.setParams({ ...DEFAULTS, density: 1, feedback: 0.9, mix: 1 })
    let max = 0
    for (let i = 0; i < 40000; i++) {
      const x = Math.sin((2 * Math.PI * 220 * i) / SR)
      const [l, r] = p.process(x, x)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
      max = Math.max(max, Math.abs(l), Math.abs(r))
    }
    expect(max).toBeLessThan(6)
  })

  it('spread 0 keeps channels identical; spread 1 decorrelates them', () => {
    const diffFor = (spread: number): number => {
      const p = new Particle(SR)
      p.setParams({ ...DEFAULTS, spread, scatter: 0, feedback: 0, mix: 1 })
      let diff = 0
      for (let i = 0; i < 30000; i++) {
        const x = Math.sin((2 * Math.PI * 220 * i) / SR)
        const [l, r] = p.process(x, x)
        diff += Math.abs(l - r)
      }
      return diff
    }
    expect(diffFor(0)).toBeLessThan(1e-6)
    expect(diffFor(1)).toBeGreaterThan(0.1)
  })
})

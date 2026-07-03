import { describe, it, expect } from 'vitest'
import { fillSine, fillNoise, fillDrumLoop } from './testSource.ts'

const SR = 48000

const isFiniteBuffer = (b: Float32Array) => b.every((v) => Number.isFinite(v))
const rms = (b: Float32Array) => Math.sqrt(b.reduce((s, v) => s + v * v, 0) / b.length)

describe('testSource generators', () => {
  it('fillSine produces a finite, non-silent, bounded signal', () => {
    const b = new Float32Array(SR)
    fillSine(b, SR)
    expect(isFiniteBuffer(b)).toBe(true)
    expect(rms(b)).toBeGreaterThan(0.1)
    expect(Math.max(...b)).toBeLessThanOrEqual(0.4)
  })

  it('fillNoise is deterministic for a given seed', () => {
    const a = new Float32Array(256)
    const b = new Float32Array(256)
    fillNoise(a, 7)
    fillNoise(b, 7)
    expect(Array.from(a)).toEqual(Array.from(b))
    expect(rms(a)).toBeGreaterThan(0.05)
  })

  it('different seeds give different noise', () => {
    const a = new Float32Array(256)
    const b = new Float32Array(256)
    fillNoise(a, 1)
    fillNoise(b, 2)
    expect(Array.from(a)).not.toEqual(Array.from(b))
  })

  it('fillDrumLoop makes a finite, non-silent stereo loop', () => {
    const l = new Float32Array(SR * 4)
    const r = new Float32Array(SR * 4)
    fillDrumLoop(l, r, SR, 120)
    expect(isFiniteBuffer(l)).toBe(true)
    expect(isFiniteBuffer(r)).toBe(true)
    expect(rms(l)).toBeGreaterThan(0.01)
  })
})

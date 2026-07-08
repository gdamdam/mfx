import { describe, it, expect } from 'vitest'
import { Phaser } from './phaser.ts'

const SR = 48000

describe('Phaser', () => {
  it('passes silence through as silence', () => {
    const phaser = new Phaser(SR)
    phaser.setParams({ rate: 0.4, depth: 0.7, feedback: 0.4, mix: 0.5 })
    phaser.reset()
    const out = new Float64Array(2)
    for (let i = 0; i < 500; i++) phaser.processInto(0, 0, out)
    expect(out[0]).toBe(0)
    expect(out[1]).toBe(0)
  })

  it('keeps output finite and bounded for a sine', () => {
    const phaser = new Phaser(SR)
    phaser.setParams({ rate: 0.6, depth: 0.7, feedback: 0.9, mix: 0.5 })
    phaser.reset()
    const out = new Float64Array(2)
    for (let i = 0; i < 4000; i++) {
      const s = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR)
      phaser.processInto(s, s, out)
      expect(Number.isFinite(out[0])).toBe(true)
      expect(Math.abs(out[0])).toBeLessThan(4)
    }
  })

  it('is nearly dry at mix = 0', () => {
    const phaser = new Phaser(SR)
    phaser.setParams({ rate: 0.4, depth: 0.7, feedback: 0.4, mix: 0 })
    phaser.reset()
    const out = new Float64Array(2)
    for (let i = 0; i < 2000; i++) {
      const s = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR)
      phaser.processInto(s, s, out)
      expect(Math.abs(out[0] - s)).toBeLessThan(1e-6)
    }
  })

  it('stays finite when fed NaN params', () => {
    const phaser = new Phaser(SR)
    phaser.setParams({ rate: NaN, depth: NaN, feedback: NaN, mix: NaN, stages: NaN, spread: NaN })
    const out = new Float64Array(2)
    for (let i = 0; i < 1000; i++) {
      const s = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR)
      phaser.processInto(s, s, out)
      expect(Number.isFinite(out[0])).toBe(true)
      expect(Number.isFinite(out[1])).toBe(true)
    }
  })

  it('keeps output finite and bounded for a sine at every stage count', () => {
    for (const stages of [0, 1, 2]) {
      const phaser = new Phaser(SR)
      phaser.setParams({ rate: 0.6, depth: 0.7, feedback: 0.9, mix: 0.5, stages, spread: 0.5 })
      phaser.reset()
      const out = new Float64Array(2)
      for (let i = 0; i < 4000; i++) {
        const s = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR)
        phaser.processInto(s, s, out)
        expect(Number.isFinite(out[0])).toBe(true)
        expect(Number.isFinite(out[1])).toBe(true)
        expect(Math.abs(out[0])).toBeLessThan(4)
        expect(Math.abs(out[1])).toBeLessThan(4)
      }
    }
  })

  it('passes silence through as silence at every stage count', () => {
    for (const stages of [0, 1, 2]) {
      const phaser = new Phaser(SR)
      phaser.setParams({ rate: 0.4, depth: 0.7, feedback: 0.4, mix: 0.5, stages, spread: 0.5 })
      phaser.reset()
      const out = new Float64Array(2)
      for (let i = 0; i < 2000; i++) {
        phaser.processInto(0, 0, out)
        expect(out[0]).toBe(0)
        expect(out[1]).toBe(0)
      }
    }
  })

  it('survives non-finite input samples', () => {
    const phaser = new Phaser(SR)
    phaser.setParams({ rate: 0.5, depth: 0.8, feedback: 0.8, mix: 0.5, stages: 2, spread: 0.7 })
    phaser.reset()
    const out = new Float64Array(2)
    for (let i = 0; i < 1000; i++) {
      const s = i === 0 ? NaN : 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR)
      phaser.processInto(s, i === 1 ? Infinity : s, out)
      expect(Number.isFinite(out[0])).toBe(true)
      expect(Number.isFinite(out[1])).toBe(true)
    }
  })

  it('is deterministic across fresh instances', () => {
    const a = new Phaser(SR)
    const b = new Phaser(SR)
    const params = { rate: 0.7, depth: 0.8, feedback: 0.6, mix: 0.5, stages: 2, spread: 0.7 }
    a.setParams(params)
    b.setParams(params)
    a.reset()
    b.reset()
    const outA = new Float64Array(2)
    const outB = new Float64Array(2)
    for (let i = 0; i < 4000; i++) {
      const s = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR)
      a.processInto(s, s, outA)
      b.processInto(s, s, outB)
      expect(outA[0]).toBe(outB[0])
      expect(outA[1]).toBe(outB[1])
    }
  })

  it('12-stage output differs from 4-stage output', () => {
    const four = new Phaser(SR)
    const twelve = new Phaser(SR)
    four.setParams({ rate: 0.5, depth: 0.7, feedback: 0.4, mix: 0.5, stages: 0, spread: 0 })
    twelve.setParams({ rate: 0.5, depth: 0.7, feedback: 0.4, mix: 0.5, stages: 2, spread: 0 })
    four.reset()
    twelve.reset()
    const out4 = new Float64Array(2)
    const out12 = new Float64Array(2)
    let maxDiff = 0
    for (let i = 0; i < 8000; i++) {
      const s = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR)
      four.processInto(s, s, out4)
      twelve.processInto(s, s, out12)
      maxDiff = Math.max(maxDiff, Math.abs(out4[0] - out12[0]))
    }
    expect(maxDiff).toBeGreaterThan(1e-3)
  })

  it('spread 0 keeps channels identical; spread 1 decorrelates them', () => {
    const mono = new Phaser(SR)
    mono.setParams({ rate: 0.6, depth: 0.8, feedback: 0.4, mix: 0.5, stages: 1, spread: 0 })
    mono.reset()
    const wide = new Phaser(SR)
    wide.setParams({ rate: 0.6, depth: 0.8, feedback: 0.4, mix: 0.5, stages: 1, spread: 1 })
    wide.reset()
    const out = new Float64Array(2)
    let wideDiff = 0
    for (let i = 0; i < 4000; i++) {
      const s = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR)
      mono.processInto(s, s, out)
      expect(Math.abs(out[0] - out[1])).toBeLessThan(1e-9)
      wide.processInto(s, s, out)
      wideDiff = Math.max(wideDiff, Math.abs(out[0] - out[1]))
    }
    expect(wideDiff).toBeGreaterThan(1e-3)
  })
})

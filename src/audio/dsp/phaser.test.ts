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
    phaser.setParams({ rate: NaN, depth: NaN, feedback: NaN, mix: NaN })
    const out = new Float64Array(2)
    for (let i = 0; i < 1000; i++) {
      const s = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR)
      phaser.processInto(s, s, out)
      expect(Number.isFinite(out[0])).toBe(true)
      expect(Number.isFinite(out[1])).toBe(true)
    }
  })
})

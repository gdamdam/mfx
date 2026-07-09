import { describe, it, expect } from 'vitest'
import { estimateLatencyMs, classifyLatency } from './latency.ts'

describe('estimateLatencyMs', () => {
  it('sums baseLatency and outputLatency into rounded ms', () => {
    // 0.005s + 0.012s = 17ms round-trip.
    expect(estimateLatencyMs(0.005, 0.012)).toBe(17)
  })

  it('falls back to whatever field is present when the other is absent', () => {
    expect(estimateLatencyMs(0.008, undefined)).toBe(8)
    expect(estimateLatencyMs(undefined, 0.02)).toBe(20)
  })

  it('returns 0 when neither field is available', () => {
    expect(estimateLatencyMs(undefined, undefined)).toBe(0)
  })
})

describe('classifyLatency', () => {
  it('classifies each tier by its threshold', () => {
    expect(classifyLatency(8).level).toBe('tight')
    expect(classifyLatency(20).level).toBe('playable')
    expect(classifyLatency(45).level).toBe('production')
    expect(classifyLatency(80).level).toBe('avoid')
  })

  it('places tier boundaries at 15 / 30 / 60 (lower bound belongs to the higher tier)', () => {
    expect(classifyLatency(14.9).level).toBe('tight')
    expect(classifyLatency(15).level).toBe('playable')
    expect(classifyLatency(29.9).level).toBe('playable')
    expect(classifyLatency(30).level).toBe('production')
    expect(classifyLatency(59.9).level).toBe('production')
    expect(classifyLatency(60).level).toBe('avoid')
  })

  it('returns a neutral unknown for missing / nonsense estimates', () => {
    for (const v of [undefined, null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(classifyLatency(v).level).toBe('unknown')
    }
  })

  it('hints at Bluetooth on an unusually high figure without faking detection', () => {
    expect(classifyLatency(140).level).toBe('avoid')
    expect(classifyLatency(140).detail.toLowerCase()).toContain('bluetooth')
    // A merely-high (but sub-100) figure stays in avoid without the BT hint.
    expect(classifyLatency(75).detail.toLowerCase()).not.toContain('bluetooth')
  })

  it('always yields a non-empty label and detail (safe to render)', () => {
    for (const v of [undefined, 0, 8, 20, 45, 80, 140]) {
      const g = classifyLatency(v)
      expect(g.label.length).toBeGreaterThan(0)
      expect(g.detail.length).toBeGreaterThan(0)
    }
  })
})

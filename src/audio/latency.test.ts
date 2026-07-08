import { describe, it, expect } from 'vitest'
import { estimateLatencyMs } from './latency.ts'

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

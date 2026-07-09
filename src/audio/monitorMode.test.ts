import { describe, it, expect } from 'vitest'
import {
  monitorModeOf,
  applyMonitorMode,
  WETDRY_MIX,
  type MonitorMode,
} from './monitorMode.ts'

describe('monitorModeOf', () => {
  it('reports muted whenever the monitor is muted, regardless of mix', () => {
    expect(monitorModeOf(1, true)).toBe('muted')
    expect(monitorModeOf(0.5, true)).toBe('muted')
    expect(monitorModeOf(0, true)).toBe('muted')
  })

  it('reports wet when fully wet and unmuted', () => {
    expect(monitorModeOf(1, false)).toBe('wet')
    // float drift just under 1.0 still reads as fully wet
    expect(monitorModeOf(0.999, false)).toBe('wet')
  })

  it('reports wetdry for any blend below fully wet', () => {
    expect(monitorModeOf(0.5, false)).toBe('wetdry')
    expect(monitorModeOf(0, false)).toBe('wetdry')
    expect(monitorModeOf(0.9, false)).toBe('wetdry')
  })

  it('treats a non-finite mix as fully wet rather than NaN-poisoning', () => {
    expect(monitorModeOf(Number.NaN, false)).toBe('wet')
    expect(monitorModeOf(Number.POSITIVE_INFINITY, false)).toBe('wet')
  })
})

describe('applyMonitorMode', () => {
  it('wet forces full wet and unmutes', () => {
    expect(applyMonitorMode('wet', 0.3)).toEqual({ muted: false, mix: 1 })
  })

  it('wetdry snaps a fully-wet chain to the blend default', () => {
    expect(applyMonitorMode('wetdry', 1)).toEqual({ muted: false, mix: WETDRY_MIX })
  })

  it('wetdry preserves an existing dialed-in blend', () => {
    expect(applyMonitorMode('wetdry', 0.3)).toEqual({ muted: false, mix: 0.3 })
  })

  it('muted leaves the mix untouched so unmuting restores it', () => {
    expect(applyMonitorMode('muted', 0.42)).toEqual({ muted: true })
    expect(applyMonitorMode('muted', 0.42).mix).toBeUndefined()
  })

  it('handles a non-finite current mix without emitting NaN', () => {
    const r = applyMonitorMode('wetdry', Number.NaN)
    expect(r.mix).toBe(WETDRY_MIX)
    expect(Number.isNaN(r.mix)).toBe(false)
  })

  it('round-trips every mode label', () => {
    const modes: MonitorMode[] = ['wet', 'wetdry', 'muted']
    for (const m of modes) {
      const r = applyMonitorMode(m, 0.5)
      expect(typeof r.muted).toBe('boolean')
    }
  })
})

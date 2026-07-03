import { describe, it, expect } from 'vitest'
import { morphPatch } from './morph.ts'
import { clonePatch, DEFAULT_PATCH, EFFECT_IDS, getSpec } from '../audio/contracts.ts'

const idx = (id: (typeof EFFECT_IDS)[number]) => EFFECT_IDS.indexOf(id)

describe('morphPatch', () => {
  it('t=0 returns A values, t=1 returns B values', () => {
    const a = clonePatch(DEFAULT_PATCH)
    const b = clonePatch(DEFAULT_PATCH)
    const di = idx('drive')
    a.slots[di].params.drive = 0.2
    b.slots[di].params.drive = 0.9
    expect(morphPatch(a, b, 0).slots[di].params.drive).toBeCloseTo(0.2, 5)
    expect(morphPatch(a, b, 1).slots[di].params.drive).toBeCloseTo(0.9, 5)
  })

  it('lerps continuous params at the midpoint', () => {
    const a = clonePatch(DEFAULT_PATCH)
    const b = clonePatch(DEFAULT_PATCH)
    a.mix = 0
    b.mix = 1
    expect(morphPatch(a, b, 0.5).mix).toBeCloseTo(0.5, 5)
  })

  it('snaps option params instead of sweeping them', () => {
    const a = clonePatch(DEFAULT_PATCH)
    const b = clonePatch(DEFAULT_PATCH)
    const fi = idx('filter')
    a.slots[fi].params.type = 0 // LP
    b.slots[fi].params.type = 2 // HP
    expect(morphPatch(a, b, 0.3).slots[fi].params.type).toBe(0)
    expect(morphPatch(a, b, 0.7).slots[fi].params.type).toBe(2)
  })

  it('snaps enabled flags at the midpoint', () => {
    const a = clonePatch(DEFAULT_PATCH)
    const b = clonePatch(DEFAULT_PATCH)
    const ci = idx('chorus')
    a.slots[ci].enabled = false
    b.slots[ci].enabled = true
    expect(morphPatch(a, b, 0.4).slots[ci].enabled).toBe(false)
    expect(morphPatch(a, b, 0.6).slots[ci].enabled).toBe(true)
  })

  it('keeps all params within their declared range', () => {
    const a = clonePatch(DEFAULT_PATCH)
    const b = clonePatch(DEFAULT_PATCH)
    const morphed = morphPatch(a, b, 0.5)
    for (const slot of morphed.slots) {
      for (const ps of getSpec(slot.id).params) {
        expect(slot.params[ps.key]).toBeGreaterThanOrEqual(ps.min - 1e-9)
        expect(slot.params[ps.key]).toBeLessThanOrEqual(ps.max + 1e-9)
      }
    }
  })
})

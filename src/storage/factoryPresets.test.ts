import { describe, it, expect } from 'vitest'
import { FACTORY_PRESETS } from './factoryPresets.ts'
import { sanitizePatch, EFFECT_SPECS, getSpec } from '../audio/contracts.ts'
import { serializePreset, deserializePreset } from './presets.ts'

describe('FACTORY_PRESETS', () => {
  it('covers the promised source/style range with unique names', () => {
    expect(FACTORY_PRESETS.length).toBeGreaterThanOrEqual(8)
    const names = FACTORY_PRESETS.map((p) => p.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('every preset is a complete, sanitize-stable patch', () => {
    for (const f of FACTORY_PRESETS) {
      // Complete rack in registry order (keeps default macro refs valid).
      expect(f.patch.slots).toHaveLength(EFFECT_SPECS.length)
      f.patch.slots.forEach((s, i) => expect(s.id).toBe(EFFECT_SPECS[i].id))
      // Sanitizing again is a no-op: params are already in range.
      expect(sanitizePatch(JSON.parse(JSON.stringify(f.patch)))).toEqual(f.patch)
      // At least one pedal is on — a preset that does nothing is a bug.
      expect(f.patch.slots.some((s) => s.enabled)).toBe(true)
      // XY assignments survive.
      expect(f.patch.xy.xTarget).not.toBeNull()
      expect(f.patch.xy.yTarget).not.toBeNull()
    }
  })

  it('every enabled slot only overrides params that exist in its spec', () => {
    for (const f of FACTORY_PRESETS) {
      for (const slot of f.patch.slots) {
        const keys = new Set(getSpec(slot.id).params.map((p) => p.key))
        for (const k of Object.keys(slot.params)) expect(keys.has(k)).toBe(true)
      }
    }
  })

  it('round-trips through preset envelope serialization', () => {
    for (const f of FACTORY_PRESETS) {
      const round = deserializePreset(
        JSON.parse(JSON.stringify(serializePreset(f.name, f.patch, 123))),
      )
      expect(round.patch).toEqual(f.patch)
      expect(round.name).toBe(f.name)
    }
  })
})

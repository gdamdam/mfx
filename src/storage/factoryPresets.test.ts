import { describe, it, expect } from 'vitest'
import { FACTORY_PRESETS, buildPatch } from './factoryPresets.ts'
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

  it('buildPatch rejects an override param that no spec declares', () => {
    // A real key is accepted; a typo is not. sanitizePatch alone would silently
    // drop the typo, so this guard is what keeps a preset from shipping a no-op.
    expect(() => buildPatch({ codec: { enabled: true, params: { crush: 0.5 } } })).not.toThrow()
    expect(() =>
      buildPatch({ codec: { enabled: true, params: { britrate: 0.5 } } }),
    ).toThrow(/unknown param "britrate"/)
  })

  it('buildPatch rejects an XY/macro target on a bypassed effect', () => {
    // The dead-performance-surface guard: pointing the pad or a macro at a
    // pedal that isn't enabled is exactly the bug these assignments fix.
    expect(() =>
      buildPatch(
        { drive: { enabled: true, params: { drive: 0.5 } } },
        {
          xy: { x: { id: 'filter', param: 'freq' }, y: { id: 'drive', param: 'tone' } },
          macros: { Dirt: [], Motion: [], Space: [], Weird: [] },
        },
      ),
    ).toThrow(/targets bypassed effect "filter"/)
  })

  it('every preset drives an enabled pedal from both XY axes and every macro', () => {
    for (const f of FACTORY_PRESETS) {
      const enabled = new Set(f.patch.slots.flatMap((s, i) => (s.enabled ? [i] : [])))
      const specAt = (slot: number) => getSpec(f.patch.slots[slot].id)
      const checkTarget = (t: { slot: number; param: string }, where: string) => {
        expect(enabled.has(t.slot), `${f.name} ${where} → bypassed slot`).toBe(true)
        const keys = specAt(t.slot).params.map((p) => p.key)
        expect(keys, `${f.name} ${where} → unknown param`).toContain(t.param)
      }
      checkTarget(f.patch.xy.xTarget!, 'XY x')
      checkTarget(f.patch.xy.yTarget!, 'XY y')
      // XY absolute-sets its target after macros run (resolve.ts), so a macro on
      // the same param would be silently overridden — assignments must differ.
      const axes = new Set(
        [f.patch.xy.xTarget!, f.patch.xy.yTarget!].map((t) => `${t.slot}:${t.param}`),
      )
      for (const macro of f.patch.macros) {
        expect(macro.assignments.length, `${f.name} macro ${macro.label} is empty`).toBeGreaterThan(0)
        for (const a of macro.assignments) {
          checkTarget(a.target, `macro ${macro.label}`)
          expect(axes.has(`${a.target.slot}:${a.target.param}`), `${f.name} macro ${macro.label} collides with an XY axis`).toBe(false)
        }
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

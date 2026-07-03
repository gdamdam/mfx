import { describe, it, expect } from 'vitest'
import { DEFAULT_PATCH, sanitizePatch } from './contracts.ts'

describe('sanitizePatch never throws on prototype-key slot ids (H6)', () => {
  it('drops slots whose id is an inherited Object.prototype key', () => {
    for (const badId of ['toString', 'hasOwnProperty', 'constructor', '__proto__']) {
      expect(() => sanitizePatch({ slots: [{ id: badId, enabled: true }] })).not.toThrow()
      const patch = sanitizePatch({ slots: [{ id: badId, enabled: true }] })
      // The bogus slot is dropped; the rack is still the complete default set.
      expect(patch.slots).toHaveLength(DEFAULT_PATCH.slots.length)
      expect(patch.slots.some((s) => (s.id as string) === badId)).toBe(false)
    }
  })
})

describe('sanitizeMacros depth defaulting (M7)', () => {
  it('missing macro depth defaults to neutral 0, not -1', () => {
    const patch = sanitizePatch({
      ...DEFAULT_PATCH,
      macros: [
        { label: 'M', value: 0, assignments: [{ target: { slot: 0, param: 'drive' } }] },
        ...DEFAULT_PATCH.macros.slice(1),
      ],
    })
    expect(patch.macros[0].assignments[0].depth).toBe(0)
  })

  it('non-finite macro depth defaults to 0', () => {
    const patch = sanitizePatch({
      ...DEFAULT_PATCH,
      macros: [
        {
          label: 'M',
          value: 0,
          assignments: [{ target: { slot: 0, param: 'drive' }, depth: NaN }],
        },
        ...DEFAULT_PATCH.macros.slice(1),
      ],
    })
    expect(patch.macros[0].assignments[0].depth).toBe(0)
  })
})

describe('sanitizeParams rounds discrete/option params (M8)', () => {
  it('rounds fractional discrete params to integer indices', () => {
    const patch = sanitizePatch({
      slots: [
        { id: 'filter', enabled: true, params: { type: 1.5 } },
        { id: 'delay', enabled: true, params: { sync: 0.7, division: 2.4 } },
        { id: 'reverb', enabled: true, params: { mode: 2.6 } },
      ],
    })
    const filter = patch.slots.find((s) => s.id === 'filter')!
    const delay = patch.slots.find((s) => s.id === 'delay')!
    const reverb = patch.slots.find((s) => s.id === 'reverb')!
    expect(filter.params.type).toBe(2)
    expect(delay.params.sync).toBe(1)
    expect(delay.params.division).toBe(2)
    expect(reverb.params.mode).toBe(3)
    // A continuous param keeps its fractional value.
    expect(filter.params.reso).toBeCloseTo(0.2)
  })
})

describe('sanitize NaN numerics fall back to defaults (L6)', () => {
  it('NaN inputGain/tempo/mix use defaults, not range min', () => {
    const patch = sanitizePatch({ inputGain: NaN, tempo: NaN, mix: NaN })
    expect(patch.inputGain).toBe(1)
    expect(patch.tempo).toBe(120)
    expect(patch.mix).toBe(1)
  })

  it('NaN discrete/continuous params fall back to spec default', () => {
    const patch = sanitizePatch({
      slots: [{ id: 'filter', enabled: true, params: { type: NaN, freq: NaN } }],
    })
    const filter = patch.slots.find((s) => s.id === 'filter')!
    expect(filter.params.type).toBe(0)
    expect(filter.params.freq).toBe(1200)
  })
})

describe('array raw rejected as record (L5)', () => {
  it('sanitizePatch treats an array as an empty record (a full valid rack), not a crash', () => {
    expect(() => sanitizePatch([1, 2, 3])).not.toThrow()
    const patch = sanitizePatch([1, 2, 3])
    // Array rejected as a record -> {} -> the complete default slot set.
    expect(patch.slots).toHaveLength(DEFAULT_PATCH.slots.length)
    expect(patch.inputGain).toBe(1)
    expect(patch.tempo).toBe(120)
  })
})

describe('ModTargetRef remap when slots are dropped (L7)', () => {
  it('remaps macro/XY refs through the drop permutation', () => {
    // Source rack: [drive, <bad>, filter]. The bad slot at index 1 is dropped,
    // so filter shifts from source index 2 to sanitized index 1.
    const raw = {
      slots: [
        { id: 'drive', enabled: true },
        { id: 'not-an-effect', enabled: true },
        { id: 'filter', enabled: true },
      ],
      macros: [
        {
          label: 'M',
          value: 0,
          assignments: [
            { target: { slot: 2, param: 'freq' }, depth: 0.5 }, // -> filter
            { target: { slot: 1, param: 'x' }, depth: 0.5 }, // -> dropped, remove
          ],
        },
        ...DEFAULT_PATCH.macros.slice(1),
      ],
      xy: {
        x: 0.5,
        y: 0.5,
        xTarget: { slot: 2, param: 'freq' },
        yTarget: { slot: 1, param: 'x' },
      },
    }
    const patch = sanitizePatch(raw)
    // filter is now at sanitized index 1.
    expect(patch.slots[1].id).toBe('filter')
    // The surviving assignment retargets to index 1; the dropped one is gone.
    expect(patch.macros[0].assignments).toHaveLength(1)
    expect(patch.macros[0].assignments[0].target.slot).toBe(1)
    // XY: xTarget follows filter to 1; yTarget pointed at the dropped slot -> null.
    expect(patch.xy.xTarget).toEqual({ slot: 1, param: 'freq' })
    expect(patch.xy.yTarget).toBeNull()
  })
})

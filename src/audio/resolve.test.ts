import { describe, it, expect } from 'vitest'
import { resolvePatch } from './resolve.ts'
import {
  clonePatch,
  DEFAULT_PATCH,
  EFFECT_IDS,
  getSpec,
  type Patch,
} from './contracts.ts'

const idx = (id: (typeof EFFECT_IDS)[number]) => EFFECT_IDS.indexOf(id)

describe('resolvePatch', () => {
  it('is identity when no modulation is active', () => {
    const patch = clonePatch(DEFAULT_PATCH)
    // clear XY targets and macro values
    patch.xy.xTarget = null
    patch.xy.yTarget = null
    for (const m of patch.macros) m.value = 0
    const state = resolvePatch(patch)
    for (let i = 0; i < patch.slots.length; i++) {
      expect(state.slots[i].params).toEqual(patch.slots[i].params)
    }
  })

  it('macro at full value pushes assigned params upward', () => {
    const patch = clonePatch(DEFAULT_PATCH)
    patch.xy.xTarget = null
    patch.xy.yTarget = null
    const driveIdx = idx('drive')
    const base = patch.slots[driveIdx].params.drive
    // Dirt macro assigns drive with positive depth
    patch.macros[0].value = 1
    const state = resolvePatch(patch)
    expect(state.slots[driveIdx].params.drive).toBeGreaterThan(base)
  })

  it('XY sets the target param absolutely across its range', () => {
    const patch = clonePatch(DEFAULT_PATCH)
    const filterIdx = idx('filter')
    const spec = getSpec('filter').params.find((p) => p.key === 'freq')!
    patch.xy = { x: 1, y: 0, xTarget: { slot: filterIdx, param: 'freq' }, yTarget: null }
    for (const m of patch.macros) m.value = 0
    const state = resolvePatch(patch)
    expect(state.slots[filterIdx].params.freq).toBeCloseTo(spec.max, 3)
  })

  it('clamps modulation within the param range', () => {
    const patch: Patch = clonePatch(DEFAULT_PATCH)
    for (const m of patch.macros) m.value = 1
    patch.xy.xTarget = null
    patch.xy.yTarget = null
    const state = resolvePatch(patch)
    for (const slot of state.slots) {
      for (const p of getSpec(slot.id).params) {
        const v = slot.params[p.key]
        expect(v).toBeGreaterThanOrEqual(p.min - 1e-6)
        expect(v).toBeLessThanOrEqual(p.max + 1e-6)
      }
    }
  })

  it('passes through transport fields untouched', () => {
    const patch = clonePatch(DEFAULT_PATCH)
    patch.tempo = 128
    patch.sync = true
    patch.inputGain = 1.5
    patch.mix = 0.7
    const state = resolvePatch(patch)
    expect(state.tempo).toBe(128)
    expect(state.sync).toBe(true)
    expect(state.inputGain).toBe(1.5)
    expect(state.mix).toBe(0.7)
  })
})

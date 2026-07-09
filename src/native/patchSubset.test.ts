import { describe, it, expect } from 'vitest'
import {
  DEFAULT_PATCH,
  getSpec,
  sanitizePatch,
  type EffectId,
  type Patch,
} from '../audio/contracts.ts'
import { SUPPORTED, toNativePatch } from './patchSubset.ts'

describe('toNativePatch', () => {
  it('keeps only enabled, supported effects and preserves order', () => {
    const native = toNativePatch(DEFAULT_PATCH)
    // DEFAULT_PATCH enables drive, filter, delay, reverb (comp/tremolo off).
    const ids = native.slots.map((s) => s.id)
    expect(ids).toEqual(['drive', 'filter', 'delay', 'reverb'])
  })

  it('drops unsupported effects even when enabled', () => {
    const patch: Patch = sanitizePatch({
      ...DEFAULT_PATCH,
      slots: DEFAULT_PATCH.slots.map((s) => (s.id === 'chorus' ? { ...s, enabled: true } : s)),
    })
    const ids = toNativePatch(patch).slots.map((s) => s.id)
    expect(ids).not.toContain('chorus')
  })

  it('forwards only the supported params for an effect', () => {
    const native = toNativePatch(DEFAULT_PATCH)
    const drive = native.slots.find((s) => s.id === 'drive')!
    expect(Object.keys(drive.params).sort()).toEqual(['character', 'drive', 'level', 'tone'])
  })

  it('carries top-level input gain and mix', () => {
    const patch = sanitizePatch({ ...DEFAULT_PATCH, inputGain: 2, mix: 0.4 })
    const native = toNativePatch(patch)
    expect(native.inputGain).toBe(2)
    expect(native.mix).toBe(0.4)
  })

  it('is deterministic', () => {
    expect(toNativePatch(DEFAULT_PATCH)).toEqual(toNativePatch(DEFAULT_PATCH))
  })

  it('drops disabled slots', () => {
    const patch: Patch = sanitizePatch({
      ...DEFAULT_PATCH,
      slots: DEFAULT_PATCH.slots.map((s) => ({ ...s, enabled: false })),
    })
    expect(toNativePatch(patch).slots).toHaveLength(0)
  })
})

describe('SUPPORTED stays in sync with contracts', () => {
  // Guards against a param rename in EFFECT_SPECS silently breaking forwarding:
  // SUPPORTED hand-lists the keys the Rust engine reads, so every one must still
  // be a real param key on its effect spec. (It need not cover every spec param.)
  for (const [id, keys] of Object.entries(SUPPORTED)) {
    it(`every SUPPORTED[${id}] key exists in EFFECT_SPECS`, () => {
      const specKeys = new Set(getSpec(id as EffectId).params.map((p) => p.key))
      for (const key of keys!) expect(specKeys.has(key)).toBe(true)
    })
  }
})

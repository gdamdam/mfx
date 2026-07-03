import { describe, it, expect } from 'vitest'
import { DEFAULT_PATCH, sanitizePatch, type Patch } from '../audio/contracts.ts'
import {
  PRESET_SCHEMA_VERSION,
  deserializePreset,
  serializePreset,
} from './presets.ts'

// A patch that differs from DEFAULT so round-trips prove real preservation.
function tweakedPatch(): Patch {
  return sanitizePatch({ ...DEFAULT_PATCH, inputGain: 2, mix: 0.25, tempo: 90, sync: true })
}

// Note: PresetStore is a raw IndexedDB wrapper and is intentionally NOT tested
// in node (no indexedDB global). Only the pure serialize/deserialize codecs are.

describe('serializePreset', () => {
  it('runs sanitizePatch on the patch and keeps the passed-in createdAt', () => {
    const preset = serializePreset('My Sound', tweakedPatch(), 1234)
    expect(preset.name).toBe('My Sound')
    expect(preset.schemaVersion).toBe(PRESET_SCHEMA_VERSION)
    expect(preset.createdAt).toBe(1234)
    expect(preset.patch).toEqual(sanitizePatch(tweakedPatch()))
  })

  it('clamps a hostile patch through sanitizePatch', () => {
    const hostile = { ...DEFAULT_PATCH, inputGain: 999, mix: 50 } as unknown as Patch
    const preset = serializePreset('x', hostile, 0)
    expect(preset.patch.inputGain).toBeLessThanOrEqual(3)
    expect(preset.patch.mix).toBeLessThanOrEqual(1)
  })

  it('falls back to createdAt 0 when the timestamp is not finite', () => {
    expect(serializePreset('x', DEFAULT_PATCH, NaN).createdAt).toBe(0)
    expect(serializePreset('x', DEFAULT_PATCH, Infinity).createdAt).toBe(0)
  })

  it('coerces a blank/non-string name to "untitled"', () => {
    expect(serializePreset('   ', DEFAULT_PATCH, 0).name).toBe('untitled')
    expect(serializePreset(42 as unknown as string, DEFAULT_PATCH, 0).name).toBe('untitled')
  })

  it('attaches sourceLabel only when it is a string', () => {
    expect(serializePreset('x', DEFAULT_PATCH, 0, { sourceLabel: 'mic' }).sourceLabel).toBe('mic')
    expect('sourceLabel' in serializePreset('x', DEFAULT_PATCH, 0)).toBe(false)
  })
})

describe('serialize → deserialize round-trip', () => {
  it('preserves name, patch, createdAt, and sourceLabel', () => {
    const preset = serializePreset('Round Trip', tweakedPatch(), 777, { sourceLabel: 'guitar' })
    // Simulate a JSON storage boundary, then read back.
    const back = deserializePreset(JSON.parse(JSON.stringify(preset)))
    expect(back.name).toBe('Round Trip')
    expect(back.createdAt).toBe(777)
    expect(back.sourceLabel).toBe('guitar')
    expect(back.patch).toEqual(preset.patch)
    expect(back.schemaVersion).toBe(PRESET_SCHEMA_VERSION)
  })
})

describe('deserializePreset never throws', () => {
  it('returns a valid DEFAULT-ish preset for {} / null / garbage', () => {
    for (const bad of [{}, null, undefined, 42, 'nope', [], { patch: 'x' }]) {
      const preset = deserializePreset(bad)
      expect(preset.name).toBe('untitled')
      expect(preset.schemaVersion).toBe(PRESET_SCHEMA_VERSION)
      expect(preset.createdAt).toBe(0)
      // Missing/garbage patch → a fully-sanitized DEFAULT-equivalent patch.
      expect(preset.patch).toEqual(sanitizePatch(DEFAULT_PATCH))
    }
  })

  it('always normalizes schemaVersion forward to the current version', () => {
    expect(deserializePreset({ schemaVersion: 0 }).schemaVersion).toBe(PRESET_SCHEMA_VERSION)
    expect(deserializePreset({ schemaVersion: 999 }).schemaVersion).toBe(PRESET_SCHEMA_VERSION)
  })

  it('preserves a finite createdAt read back from storage', () => {
    expect(deserializePreset({ createdAt: 555 }).createdAt).toBe(555)
    expect(deserializePreset({ createdAt: 'bad' }).createdAt).toBe(0)
  })

  it('sanitizes a partial/hostile stored patch', () => {
    const preset = deserializePreset({ patch: { inputGain: 999, tempo: 5 } })
    expect(preset.patch.inputGain).toBeLessThanOrEqual(3)
    expect(preset.patch.tempo).toBeGreaterThanOrEqual(20)
  })
})

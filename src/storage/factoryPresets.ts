/**
 * Curated factory presets — musical starting points across sources and
 * styles. Each preset is a full valid Patch built through sanitizePatch, so
 * anything not specified here (params, macros, XY) falls back to the same
 * defaults the rest of the app uses.
 *
 * Slots are always emitted in EFFECT_SPECS order: sanitize's default macro
 * assignments reference slot indices in that order, so preserving it keeps
 * the Dirt/Motion/Space/Weird macros pointing at the right pedals.
 */
import {
  DEFAULT_PATCH,
  EFFECT_SPECS,
  sanitizePatch,
  type EffectId,
  type Patch,
} from '../audio/contracts.ts'

interface SlotOverride {
  enabled?: boolean
  params?: Record<string, number>
}

export interface FactoryPreset {
  name: string
  /** Short "who is this for" hint shown in the UI. */
  hint: string
  patch: Patch
}

function buildPatch(
  overrides: Partial<Record<EffectId, SlotOverride>>,
  extras: Partial<Pick<Patch, 'mix' | 'inputGain' | 'tempo'>> = {},
): Patch {
  return sanitizePatch({
    slots: EFFECT_SPECS.map((spec) => {
      const o = overrides[spec.id]
      return {
        id: spec.id,
        enabled: o?.enabled === true,
        params: {
          ...Object.fromEntries(spec.params.map((p) => [p.key, p.default])),
          ...(o?.params ?? {}),
        },
      }
    }),
    // Keep the default XY pad assignments (sanitize would otherwise null them).
    xy: DEFAULT_PATCH.xy,
    ...extras,
  })
}

export const FACTORY_PRESETS: readonly FactoryPreset[] = [
  {
    name: 'Velvet Guitar',
    hint: 'guitar — warm tube drive into worn tape echo',
    patch: buildPatch({
      comp: { enabled: true, params: { amount: 0.35, mix: 0.85 } },
      drive: { enabled: true, params: { drive: 0.3, tone: 0.5, character: 2 } },
      tapedelay: {
        enabled: true,
        params: { time: 0.38, feedback: 0.4, mix: 0.26, wow: 0.3, age: 0.45, spread: 0.6 },
      },
      reverb: { enabled: true, params: { mode: 0, mix: 0.18, decay: 0.4, size: 0.4 } },
    }),
  },
  {
    name: 'Dimension Synth',
    hint: 'synth — wide calm chorus, ping-pong echoes',
    patch: buildPatch({
      saturation: { enabled: true, params: { amount: 0.22, type: 3, mix: 0.8 } },
      chorus: { enabled: true, params: { mode: 1, depth: 0.55, mix: 0.55, width: 0.85, rate: 0.5 } },
      delay: {
        enabled: true,
        params: { sync: 1, division: 1, feedback: 0.45, mix: 0.3, mode: 1, tone: 0.42 },
      },
      cloud: { enabled: true, params: { mix: 0.24, size: 0.55, decay: 0.45 } },
    }),
  },
  {
    name: 'Drum Glue',
    hint: 'drums — parallel squash, tape weight, wide-safe image',
    patch: buildPatch({
      comp: {
        enabled: true,
        params: { amount: 0.55, attack: 0.12, release: 0.4, mix: 0.55, mode: 1, lookahead: 1 },
      },
      saturation: { enabled: true, params: { amount: 0.35, type: 0, mix: 0.9 } },
      imager: { enabled: true, params: { width: 1.15, bass: 110 } },
    }),
  },
  {
    name: 'Silk Vocal',
    hint: 'vocals — smooth leveling, ducked echo, plate air',
    patch: buildPatch({
      comp: { enabled: true, params: { amount: 0.42, mode: 1, lookahead: 1, release: 0.5 } },
      saturation: { enabled: true, params: { amount: 0.15, type: 1, mix: 0.7 } },
      delay: {
        enabled: true,
        params: { sync: 1, division: 2, feedback: 0.35, mix: 0.2, duck: 0.75, tone: 0.42 },
      },
      reverb: { enabled: true, params: { mode: 2, mix: 0.22, decay: 0.5, predelay: 0.045 } },
    }),
  },
  {
    name: 'Endless Drone',
    hint: 'drones — resonant body feeding a self-growing pad',
    patch: buildPatch({
      resonator: { enabled: true, params: { mix: 0.35, damp: 0.15, spread: 0.6, model: 0 } },
      bloom: {
        enabled: true,
        params: { mix: 0.6, grow: 0.7, density: 0.7, space: 0.85, rich: 0.5, evolve: 0.6 },
      },
      shimmer: { enabled: true, params: { mix: 0.3, amount: 0.45, decay: 0.75, interval: 0 } },
    }),
  },
  {
    name: 'Invisible Glue',
    hint: 'subtle production — console warmth you only notice when it leaves',
    patch: buildPatch({
      comp: { enabled: true, params: { amount: 0.28, mix: 0.5, mode: 1 } },
      saturation: { enabled: true, params: { amount: 0.18, type: 3, mix: 0.6 } },
      imager: { enabled: true, params: { width: 1.08, bass: 90 } },
      reverb: { enabled: true, params: { mode: 0, mix: 0.1, decay: 0.35, size: 0.35 } },
    }),
  },
  {
    name: 'Ambient Weather',
    hint: 'ambient textures — pitched particles inside a blooming cloud',
    patch: buildPatch({
      particle: {
        enabled: true,
        params: { mix: 0.4, density: 0.65, pitch: 12, feedback: 0.5, spread: 0.8, scatter: 0.45 },
      },
      cloud: {
        enabled: true,
        params: { mix: 0.5, size: 0.75, decay: 0.75, bloom: 0.65, mod: 0.4, shimmer: 0.3 },
      },
      imager: { enabled: true, params: { width: 1.3 } },
    }),
  },
  {
    name: 'Broken Transmission',
    hint: 'experimental — sliced, crushed, ring-modulated wreckage',
    patch: buildPatch({
      bitcrusher: { enabled: true, params: { bits: 6, downsample: 0.45, mix: 0.5, smooth: 0.2 } },
      ringmod: { enabled: true, params: { mix: 0.3, mode: 1, freq: 660 } },
      fracture: {
        enabled: true,
        params: { chance: 0.7, repeat: 0.6, reverse: 0.5, shuffle: 0.4, smooth: 0.35 },
      },
      mosaic: {
        enabled: true,
        params: { mix: 0.35, chaos: 0.6, reverse: 0.4, feedback: 0.35, density: 0.6 },
      },
      spectralfreeze: { enabled: true, params: { smear: 0.5, mix: 0.3 } },
    }),
  },
  {
    name: 'Lo-Fi Bedroom',
    hint: 'lo-fi — warm tape into a narrowed, gently warbling codec',
    patch: buildPatch({
      saturation: { enabled: true, params: { amount: 0.2, type: 0, mix: 0.8 } },
      codec: {
        enabled: true,
        params: { crush: 0.4, warble: 0.35, drop: 0, tone: 0.5, mix: 0.6 },
      },
      reverb: { enabled: true, params: { mode: 0, mix: 0.15, decay: 0.4, size: 0.4 } },
    }),
  },
  {
    name: 'Data Rot',
    hint: 'experimental — codec collapse, stuttering dropouts, wide space',
    patch: buildPatch({
      codec: {
        enabled: true,
        params: { crush: 0.8, warble: 0.6, drop: 0.5, tone: 0.35, mix: 0.75 },
      },
      fracture: {
        enabled: true,
        params: { chance: 0.5, repeat: 0.5, reverse: 0.4, shuffle: 0.3, smooth: 0.3 },
      },
      cloud: { enabled: true, params: { mix: 0.3, size: 0.6, decay: 0.6, bloom: 0.4 } },
    }),
  },
] as const

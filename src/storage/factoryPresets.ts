/**
 * Curated factory presets — musical starting points across sources and
 * styles. Each preset is a full valid Patch built through sanitizePatch, so
 * anything not specified here (params) falls back to the same defaults the
 * rest of the app uses.
 *
 * Slots are always emitted in EFFECT_SPECS order so macro/XY target slot
 * indices line up with the rack the worklet renders.
 *
 * Every preset assigns its own XY pad axes and Dirt/Motion/Space/Weird macros
 * to params of *enabled* effects — buildPatch throws otherwise, so no preset
 * can ship with a dead performance surface pointing at a bypassed pedal.
 */
import {
  EFFECT_SPECS,
  MACRO_LABELS,
  getSpec,
  sanitizePatch,
  type EffectId,
  type Macro,
  type ModTargetRef,
  type Patch,
} from '../audio/contracts.ts'

interface SlotOverride {
  enabled?: boolean
  params?: Record<string, number>
}

/** A param on a specific effect — the unit XY axes and macros target. */
interface ParamRef {
  id: EffectId
  param: string
}

interface MacroAssign extends ParamRef {
  /** Depth applied to the param's normalized range, -1..1. */
  depth: number
}

type MacroLabel = (typeof MACRO_LABELS)[number]

interface PerfSpec {
  /** XY pad axes. Resting position is derived from each target's base value. */
  xy: { x: ParamRef; y: ParamRef }
  /** One assignment list per macro label; every label must be present. */
  macros: Record<MacroLabel, MacroAssign[]>
}

export interface FactoryPreset {
  name: string
  /** Short "who is this for" hint shown in the UI. */
  hint: string
  patch: Patch
}

/**
 * Exported for tests. Throws on:
 *  - an override/target param key that no spec declares (sanitizePatch would
 *    otherwise silently drop it, shipping a preset that quietly does nothing),
 *  - an XY/macro target on a bypassed effect (a dead performance control).
 * Failing loudly at construction turns these into test/dev-time errors.
 */
export function buildPatch(
  overrides: Partial<Record<EffectId, SlotOverride>>,
  perf?: PerfSpec,
  extras: Partial<Pick<Patch, 'mix' | 'inputGain' | 'tempo'>> = {},
): Patch {
  for (const [id, o] of Object.entries(overrides) as [EffectId, SlotOverride][]) {
    if (!o?.params) continue
    const keys = new Set(getSpec(id).params.map((p) => p.key))
    for (const k of Object.keys(o.params)) {
      if (!keys.has(k)) {
        throw new Error(`Factory preset override for "${id}" sets unknown param "${k}"`)
      }
    }
  }

  const slotIdx = (id: EffectId): number => EFFECT_SPECS.findIndex((s) => s.id === id)
  const isEnabled = (id: EffectId): boolean => overrides[id]?.enabled === true

  // Resolve a ParamRef to a slot/param target, validating that the param
  // exists and its effect is enabled (an XY/macro on a bypassed pedal is dead).
  const resolveRef = (r: ParamRef, where: string): { target: ModTargetRef; base: number } => {
    const p = getSpec(r.id).params.find((pp) => pp.key === r.param)
    if (!p) throw new Error(`Factory preset ${where} references unknown param "${r.param}" on "${r.id}"`)
    if (!isEnabled(r.id)) throw new Error(`Factory preset ${where} targets bypassed effect "${r.id}"`)
    const value = overrides[r.id]?.params?.[r.param] ?? p.default
    // Linear normalized position — matches resolve.ts's absolute XY mapping, so
    // the pad rests exactly on the preset's designed value (no jump on load).
    const base = p.max > p.min ? (value - p.min) / (p.max - p.min) : 0
    return { target: { slot: slotIdx(r.id), param: r.param }, base }
  }

  const xy = perf && (() => {
    const x = resolveRef(perf.xy.x, 'XY x')
    const y = resolveRef(perf.xy.y, 'XY y')
    return { x: x.base, y: y.base, xTarget: x.target, yTarget: y.target }
  })()

  const macros =
    perf &&
    (MACRO_LABELS.map((label) => ({
      label,
      value: 0,
      assignments: perf.macros[label].map((a) => ({
        target: resolveRef(a, `macro "${label}"`).target,
        depth: a.depth,
      })),
    })) as [Macro, Macro, Macro, Macro])

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
    ...(xy ? { xy } : {}),
    ...(macros ? { macros } : {}),
    ...extras,
  })
}

export const FACTORY_PRESETS: readonly FactoryPreset[] = [
  // Browser-latency-safe starting points first: these lean on wet sends,
  // reamping, and file/tab/loop/mbus sources — the workflows that stay great
  // even though a live monitor round-trip can't beat the platform floor. The
  // hint's leading word doubles as the use-case tag shown in the picker.
  {
    name: 'Wet Send Ambience',
    hint: 'wet send — lush tail to float under a dry hardware signal',
    patch: buildPatch(
      {
        reverb: {
          enabled: true,
          params: { mode: 1, size: 0.72, decay: 0.62, mix: 1, predelay: 0.03, width: 1, damp: 0.4 },
        },
        shimmer: { enabled: true, params: { mix: 0.4, amount: 0.55, decay: 0.65, tone: 0.6 } },
        cloud: {
          enabled: true,
          params: { mix: 0.45, size: 0.7, decay: 0.6, bloom: 0.45, mod: 0.4, width: 1, shimmer: 0.3 },
        },
      },
      {
        xy: { x: { id: 'reverb', param: 'size' }, y: { id: 'cloud', param: 'mix' } },
        macros: {
          Dirt: [{ id: 'shimmer', param: 'amount', depth: 0.6 }],
          Motion: [{ id: 'cloud', param: 'mod', depth: 0.6 }],
          Space: [
            { id: 'reverb', param: 'decay', depth: 0.6 },
            { id: 'cloud', param: 'bloom', depth: 0.4 },
          ],
          Weird: [{ id: 'shimmer', param: 'tone', depth: 0.5 }],
        },
      },
      { mix: 1 },
    ),
  },
  {
    name: 'Reamp Grit',
    hint: 'reamp — re-amp a DI or recorded take with saturated drive',
    patch: buildPatch(
      {
        comp: { enabled: true, params: { amount: 0.42, mix: 0.9, makeup: 0.5 } },
        drive: { enabled: true, params: { drive: 0.55, tone: 0.5, level: 0.8, character: 2 } },
        saturation: { enabled: true, params: { amount: 0.45, type: 0, tone: 0.5, mix: 0.7, level: 0.82 } },
        delay: { enabled: true, params: { time: 0.28, feedback: 0.32, mix: 0.2, mode: 0, tone: 0.5 } },
        reverb: { enabled: true, params: { mode: 0, size: 0.4, decay: 0.4, mix: 0.16, width: 0.9 } },
      },
      {
        xy: { x: { id: 'drive', param: 'drive' }, y: { id: 'delay', param: 'mix' } },
        macros: {
          Dirt: [
            { id: 'saturation', param: 'amount', depth: 0.7 },
            { id: 'comp', param: 'amount', depth: 0.4 },
          ],
          Motion: [{ id: 'delay', param: 'feedback', depth: 0.6 }],
          Space: [
            { id: 'reverb', param: 'mix', depth: 0.6 },
            { id: 'reverb', param: 'decay', depth: 0.4 },
          ],
          Weird: [{ id: 'drive', param: 'tone', depth: 0.5 }],
        },
      },
      { mix: 1 },
    ),
  },
  {
    name: 'Loop Mangler',
    hint: 'loop — glitch, crush, and slice a file or loop',
    patch: buildPatch(
      {
        bitcrusher: { enabled: true, params: { bits: 7, downsample: 0.45, mix: 0.55, smooth: 0.2, alias: 0.3 } },
        fracture: {
          enabled: true,
          params: { div: 2, chance: 0.6, repeat: 0.5, reverse: 0.35, shuffle: 0.4, smooth: 0.5, mix: 0.7 },
        },
        mosaic: {
          enabled: true,
          params: { size: 0.12, density: 0.55, pitch: 0, reverse: 0.25, spread: 0.6, feedback: 0.3, chaos: 0.4, mix: 0.45 },
        },
        delay: { enabled: true, params: { time: 0.25, feedback: 0.45, mix: 0.3, mode: 1, tone: 0.5 } },
      },
      {
        xy: { x: { id: 'fracture', param: 'chance' }, y: { id: 'mosaic', param: 'chaos' } },
        macros: {
          Dirt: [{ id: 'bitcrusher', param: 'downsample', depth: 0.6 }],
          Motion: [
            { id: 'fracture', param: 'shuffle', depth: 0.6 },
            { id: 'mosaic', param: 'density', depth: 0.5 },
          ],
          Space: [{ id: 'delay', param: 'feedback', depth: 0.5 }],
          Weird: [
            { id: 'mosaic', param: 'feedback', depth: 0.6 },
            { id: 'fracture', param: 'reverse', depth: 0.5 },
          ],
        },
      },
      { mix: 1 },
    ),
  },
  {
    name: 'Tab Polish',
    hint: 'tab — glue, widen, and sweeten captured tab audio',
    patch: buildPatch(
      {
        comp: { enabled: true, params: { amount: 0.35, attack: 0.25, release: 0.5, makeup: 0.5, mix: 0.9 } },
        saturation: { enabled: true, params: { amount: 0.25, type: 3, tone: 0.55, mix: 0.5, level: 0.85 } },
        imager: { enabled: true, params: { width: 1.3, rotate: 0.5, bass: 120, balance: 0.5 } },
        reverb: { enabled: true, params: { mode: 4, size: 0.35, decay: 0.35, mix: 0.14, width: 1 } },
      },
      {
        xy: { x: { id: 'imager', param: 'width' }, y: { id: 'comp', param: 'amount' } },
        macros: {
          Dirt: [{ id: 'saturation', param: 'amount', depth: 0.5 }],
          Motion: [{ id: 'imager', param: 'rotate', depth: 0.4 }],
          Space: [
            { id: 'reverb', param: 'mix', depth: 0.5 },
            { id: 'reverb', param: 'size', depth: 0.4 },
          ],
          Weird: [{ id: 'saturation', param: 'tone', depth: 0.5 }],
        },
      },
      { mix: 0.85 },
    ),
  },
  {
    name: 'mbus Space',
    hint: 'mbus send — cavernous space for a sibling instrument',
    patch: buildPatch(
      {
        filter: { enabled: true, params: { freq: 8000, reso: 0.15, type: 0, model: 0, drive: 0.1 } },
        reverb: {
          enabled: true,
          params: { mode: 1, size: 0.85, decay: 0.78, mix: 1, predelay: 0.05, width: 1, damp: 0.35 },
        },
        cloud: {
          enabled: true,
          params: { mix: 0.5, size: 0.8, decay: 0.7, bloom: 0.5, mod: 0.45, width: 1, shimmer: 0.25 },
        },
        delay: {
          enabled: true,
          params: { time: 0.5, feedback: 0.5, mix: 0.3, mode: 2, tone: 0.4, sync: 1, division: 2 },
        },
      },
      {
        xy: { x: { id: 'reverb', param: 'decay' }, y: { id: 'delay', param: 'feedback' } },
        macros: {
          Dirt: [{ id: 'filter', param: 'drive', depth: 0.5 }],
          Motion: [
            { id: 'cloud', param: 'mod', depth: 0.6 },
            { id: 'delay', param: 'time', depth: 0.4 },
          ],
          Space: [
            { id: 'reverb', param: 'size', depth: 0.5 },
            { id: 'cloud', param: 'mix', depth: 0.5 },
          ],
          Weird: [{ id: 'cloud', param: 'shimmer', depth: 0.6 }],
        },
      },
      { mix: 1 },
    ),
  },
  {
    name: 'Velvet Guitar',
    hint: 'guitar — warm tube drive into worn tape echo',
    patch: buildPatch(
      {
        comp: { enabled: true, params: { amount: 0.35, mix: 0.85 } },
        drive: { enabled: true, params: { drive: 0.3, tone: 0.5, character: 2 } },
        tapedelay: {
          enabled: true,
          params: { time: 0.38, feedback: 0.4, mix: 0.26, wow: 0.3, age: 0.45, spread: 0.6 },
        },
        reverb: { enabled: true, params: { mode: 0, mix: 0.18, decay: 0.4, size: 0.4 } },
      },
      {
        xy: { x: { id: 'drive', param: 'tone' }, y: { id: 'tapedelay', param: 'mix' } },
        macros: {
          Dirt: [
            { id: 'drive', param: 'drive', depth: 0.8 },
            { id: 'comp', param: 'amount', depth: 0.4 },
          ],
          Motion: [{ id: 'tapedelay', param: 'wow', depth: 0.7 }],
          Space: [
            { id: 'reverb', param: 'mix', depth: 0.7 },
            { id: 'reverb', param: 'size', depth: 0.4 },
          ],
          Weird: [
            { id: 'tapedelay', param: 'feedback', depth: 0.6 },
            { id: 'tapedelay', param: 'age', depth: 0.5 },
          ],
        },
      },
    ),
  },
  {
    name: 'Dimension Synth',
    hint: 'synth — wide calm chorus, ping-pong echoes',
    patch: buildPatch(
      {
        saturation: { enabled: true, params: { amount: 0.22, type: 3, mix: 0.8 } },
        chorus: {
          enabled: true,
          params: { mode: 1, depth: 0.55, mix: 0.55, width: 0.85, rate: 0.5 },
        },
        delay: {
          enabled: true,
          params: { sync: 1, division: 1, feedback: 0.45, mix: 0.3, mode: 1, tone: 0.42 },
        },
        cloud: { enabled: true, params: { mix: 0.24, size: 0.55, decay: 0.45 } },
      },
      {
        xy: { x: { id: 'chorus', param: 'width' }, y: { id: 'cloud', param: 'mix' } },
        macros: {
          Dirt: [{ id: 'saturation', param: 'amount', depth: 0.6 }],
          Motion: [
            { id: 'chorus', param: 'depth', depth: 0.8 },
            { id: 'chorus', param: 'rate', depth: 0.4 },
          ],
          Space: [
            { id: 'delay', param: 'mix', depth: 0.6 },
            { id: 'delay', param: 'feedback', depth: 0.4 },
          ],
          Weird: [
            { id: 'cloud', param: 'mod', depth: 0.6 },
            { id: 'cloud', param: 'bloom', depth: 0.5 },
          ],
        },
      },
    ),
  },
  {
    name: 'Drum Glue',
    hint: 'drums — parallel squash, tape weight, wide-safe image',
    patch: buildPatch(
      {
        comp: {
          enabled: true,
          params: { amount: 0.55, attack: 0.12, release: 0.4, mix: 0.55, mode: 1, lookahead: 1 },
        },
        saturation: { enabled: true, params: { amount: 0.35, type: 0, mix: 0.9 } },
        imager: { enabled: true, params: { width: 1.15, bass: 110 } },
      },
      {
        xy: { x: { id: 'comp', param: 'amount' }, y: { id: 'imager', param: 'width' } },
        macros: {
          Dirt: [{ id: 'saturation', param: 'amount', depth: 0.8 }],
          Motion: [{ id: 'comp', param: 'release', depth: 0.6 }],
          Space: [{ id: 'imager', param: 'rotate', depth: 0.5 }],
          Weird: [{ id: 'saturation', param: 'tone', depth: 0.6 }],
        },
      },
    ),
  },
  {
    name: 'Silk Vocal',
    hint: 'vocals — smooth leveling, ducked echo, plate air',
    patch: buildPatch(
      {
        comp: { enabled: true, params: { amount: 0.42, mode: 1, lookahead: 1, release: 0.5 } },
        saturation: { enabled: true, params: { amount: 0.15, type: 1, mix: 0.7 } },
        delay: {
          enabled: true,
          params: { sync: 1, division: 2, feedback: 0.35, mix: 0.2, duck: 0.75, tone: 0.42 },
        },
        reverb: { enabled: true, params: { mode: 2, mix: 0.22, decay: 0.5, predelay: 0.045 } },
      },
      {
        xy: { x: { id: 'delay', param: 'mix' }, y: { id: 'reverb', param: 'mix' } },
        macros: {
          Dirt: [
            { id: 'saturation', param: 'amount', depth: 0.6 },
            { id: 'comp', param: 'amount', depth: 0.4 },
          ],
          Motion: [{ id: 'delay', param: 'mod', depth: 0.6 }],
          Space: [
            { id: 'reverb', param: 'decay', depth: 0.5 },
            { id: 'reverb', param: 'size', depth: 0.4 },
            { id: 'delay', param: 'feedback', depth: 0.4 },
          ],
          Weird: [
            { id: 'reverb', param: 'predelay', depth: 0.5 },
            { id: 'delay', param: 'duck', depth: 0.5 },
          ],
        },
      },
    ),
  },
  {
    name: 'Endless Drone',
    hint: 'drones — resonant body feeding a self-growing pad',
    patch: buildPatch(
      {
        resonator: { enabled: true, params: { mix: 0.35, damp: 0.15, spread: 0.6, model: 0 } },
        bloom: {
          enabled: true,
          params: { mix: 0.6, grow: 0.7, density: 0.7, space: 0.85, rich: 0.5, evolve: 0.6 },
        },
        shimmer: { enabled: true, params: { mix: 0.3, amount: 0.45, decay: 0.75, interval: 0 } },
      },
      {
        xy: { x: { id: 'bloom', param: 'grow' }, y: { id: 'shimmer', param: 'mix' } },
        macros: {
          Dirt: [{ id: 'resonator', param: 'bright', depth: 0.6 }],
          Motion: [
            { id: 'bloom', param: 'evolve', depth: 0.7 },
            { id: 'bloom', param: 'density', depth: 0.5 },
          ],
          Space: [
            { id: 'bloom', param: 'space', depth: 0.7 },
            { id: 'bloom', param: 'mix', depth: 0.5 },
          ],
          Weird: [
            { id: 'shimmer', param: 'amount', depth: 0.7 },
            { id: 'resonator', param: 'damp', depth: 0.5 },
          ],
        },
      },
    ),
  },
  {
    name: 'Invisible Glue',
    hint: 'subtle production — console warmth you only notice when it leaves',
    patch: buildPatch(
      {
        comp: { enabled: true, params: { amount: 0.28, mix: 0.5, mode: 1 } },
        saturation: { enabled: true, params: { amount: 0.18, type: 3, mix: 0.6 } },
        imager: { enabled: true, params: { width: 1.08, bass: 90 } },
        reverb: { enabled: true, params: { mode: 0, mix: 0.1, decay: 0.35, size: 0.35 } },
      },
      {
        xy: { x: { id: 'comp', param: 'amount' }, y: { id: 'reverb', param: 'mix' } },
        macros: {
          Dirt: [{ id: 'saturation', param: 'amount', depth: 0.6 }],
          Motion: [{ id: 'imager', param: 'rotate', depth: 0.4 }],
          Space: [
            { id: 'reverb', param: 'size', depth: 0.5 },
            { id: 'reverb', param: 'decay', depth: 0.4 },
            { id: 'imager', param: 'width', depth: 0.4 },
          ],
          Weird: [{ id: 'saturation', param: 'tone', depth: 0.5 }],
        },
      },
    ),
  },
  {
    name: 'Ambient Weather',
    hint: 'ambient textures — pitched particles inside a blooming cloud',
    patch: buildPatch(
      {
        particle: {
          enabled: true,
          params: { mix: 0.4, density: 0.65, pitch: 12, feedback: 0.5, spread: 0.8, scatter: 0.45 },
        },
        cloud: {
          enabled: true,
          params: { mix: 0.5, size: 0.75, decay: 0.75, bloom: 0.65, mod: 0.4, shimmer: 0.3 },
        },
        imager: { enabled: true, params: { width: 1.3 } },
      },
      {
        xy: { x: { id: 'particle', param: 'density' }, y: { id: 'cloud', param: 'mix' } },
        macros: {
          Dirt: [{ id: 'particle', param: 'feedback', depth: 0.6 }],
          Motion: [
            { id: 'particle', param: 'scatter', depth: 0.7 },
            { id: 'cloud', param: 'mod', depth: 0.5 },
          ],
          Space: [
            { id: 'cloud', param: 'size', depth: 0.5 },
            { id: 'cloud', param: 'bloom', depth: 0.5 },
            { id: 'imager', param: 'width', depth: 0.4 },
          ],
          Weird: [
            { id: 'particle', param: 'pitch', depth: 0.5 },
            { id: 'cloud', param: 'shimmer', depth: 0.5 },
          ],
        },
      },
    ),
  },
  {
    name: 'Broken Transmission',
    hint: 'experimental — sliced, crushed, ring-modulated wreckage',
    patch: buildPatch(
      {
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
      },
      {
        xy: {
          x: { id: 'bitcrusher', param: 'downsample' },
          y: { id: 'fracture', param: 'chance' },
        },
        macros: {
          Dirt: [
            { id: 'ringmod', param: 'mix', depth: 0.6 },
            { id: 'bitcrusher', param: 'mix', depth: 0.5 },
          ],
          Motion: [
            { id: 'mosaic', param: 'density', depth: 0.6 },
            { id: 'mosaic', param: 'chaos', depth: 0.5 },
          ],
          Space: [
            { id: 'spectralfreeze', param: 'smear', depth: 0.6 },
            { id: 'mosaic', param: 'mix', depth: 0.4 },
          ],
          Weird: [
            { id: 'fracture', param: 'repeat', depth: 0.6 },
            { id: 'mosaic', param: 'reverse', depth: 0.5 },
            { id: 'spectralfreeze', param: 'mix', depth: 0.4 },
          ],
        },
      },
    ),
  },
  {
    name: 'Lo-Fi Bedroom',
    hint: 'lo-fi — warm tape into a narrowed, gently warbling codec',
    patch: buildPatch(
      {
        saturation: { enabled: true, params: { amount: 0.2, type: 0, mix: 0.8 } },
        codec: {
          enabled: true,
          params: { crush: 0.4, warble: 0.35, drop: 0, tone: 0.5, mix: 0.6 },
        },
        reverb: { enabled: true, params: { mode: 0, mix: 0.15, decay: 0.4, size: 0.4 } },
      },
      {
        xy: { x: { id: 'codec', param: 'crush' }, y: { id: 'reverb', param: 'mix' } },
        macros: {
          Dirt: [{ id: 'saturation', param: 'amount', depth: 0.6 }],
          Motion: [{ id: 'codec', param: 'warble', depth: 0.7 }],
          Space: [
            { id: 'reverb', param: 'size', depth: 0.5 },
            { id: 'reverb', param: 'decay', depth: 0.4 },
          ],
          Weird: [
            { id: 'codec', param: 'drop', depth: 0.6 },
            { id: 'codec', param: 'tone', depth: 0.4 },
          ],
        },
      },
    ),
  },
  {
    name: 'Data Rot',
    hint: 'experimental — codec collapse, stuttering dropouts, wide space',
    patch: buildPatch(
      {
        codec: {
          enabled: true,
          params: { crush: 0.8, warble: 0.6, drop: 0.5, tone: 0.35, mix: 0.75 },
        },
        fracture: {
          enabled: true,
          params: { chance: 0.5, repeat: 0.5, reverse: 0.4, shuffle: 0.3, smooth: 0.3 },
        },
        cloud: { enabled: true, params: { mix: 0.3, size: 0.6, decay: 0.6, bloom: 0.4 } },
      },
      {
        xy: { x: { id: 'codec', param: 'drop' }, y: { id: 'fracture', param: 'chance' } },
        macros: {
          Dirt: [{ id: 'codec', param: 'crush', depth: 0.7 }],
          Motion: [
            { id: 'codec', param: 'warble', depth: 0.6 },
            { id: 'fracture', param: 'shuffle', depth: 0.5 },
          ],
          Space: [
            { id: 'cloud', param: 'mix', depth: 0.7 },
            { id: 'cloud', param: 'size', depth: 0.5 },
            { id: 'cloud', param: 'bloom', depth: 0.4 },
          ],
          Weird: [
            { id: 'fracture', param: 'reverse', depth: 0.6 },
            { id: 'fracture', param: 'repeat', depth: 0.5 },
            { id: 'cloud', param: 'mod', depth: 0.4 },
          ],
        },
      },
    ),
  },
] as const

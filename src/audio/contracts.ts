/**
 * contracts.ts — the single source of truth for mfx.
 *
 * Owns: the effect registry (param specs + ranges), the canonical Patch type,
 * DEFAULT_PATCH (frozen), clamp, sanitizePatch (never throws), and the typed
 * message unions crossing the main-thread <-> AudioWorklet boundary.
 *
 * Every value that can reach us from an untrusted source (IndexedDB, a share
 * link, a worklet message) passes through sanitizePatch and is clamped to the
 * ranges declared here. DSP cores additionally guard with Number.isFinite.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Shared, finite-safe clamp. Non-finite input collapses to `min`. */
export function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min
}

// ---------------------------------------------------------------------------
// Effect registry
// ---------------------------------------------------------------------------

export type EffectId =
  | 'drive'
  | 'comp'
  | 'filter'
  | 'chorus'
  | 'flanger'
  | 'phaser'
  | 'tremolo'
  | 'delay'
  | 'reverb'
  | 'bitcrusher'
  | 'ringmod'
  | 'freeze'

export type EffectFamily =
  | 'tone'
  | 'dynamics'
  | 'modulation'
  | 'time'
  | 'texture'

export interface ParamSpec {
  key: string
  label: string
  min: number
  max: number
  default: number
  unit?: string
  /** UI mapping curve. DSP always receives the raw value in [min, max]. */
  curve?: 'lin' | 'log'
  /** When present the param is a discrete index 0..options.length-1. */
  options?: string[]
}

export interface EffectSpec {
  id: EffectId
  name: string
  /** 2–4 char silkscreen label for the pedal face. */
  short: string
  blurb: string
  family: EffectFamily
  /** The param the slot-face knob + modal amount ring drives. */
  amount: string
  params: ParamSpec[]
}

const P = (
  key: string,
  label: string,
  min: number,
  max: number,
  def: number,
  extra: Partial<ParamSpec> = {},
): ParamSpec => ({ key, label, min, max, default: def, ...extra })

/** The full effect catalogue. Order here is the default rack order. */
export const EFFECT_SPECS: readonly EffectSpec[] = [
  {
    id: 'drive',
    name: 'Drive',
    short: 'DRV',
    blurb: 'Soft-clip overdrive into hard distortion.',
    family: 'tone',
    amount: 'drive',
    params: [
      P('drive', 'Drive', 0, 1, 0.4),
      P('tone', 'Tone', 0, 1, 0.55),
      P('level', 'Level', 0, 1, 0.85),
    ],
  },
  {
    id: 'comp',
    name: 'Compressor',
    short: 'CMP',
    blurb: 'Feed-forward peak compressor with makeup.',
    family: 'dynamics',
    amount: 'amount',
    params: [
      P('amount', 'Amount', 0, 1, 0.4),
      P('attack', 'Attack', 0, 1, 0.2),
      P('release', 'Release', 0, 1, 0.45),
      P('makeup', 'Makeup', 0, 1, 0.5),
    ],
  },
  {
    id: 'filter',
    name: 'Filter',
    short: 'FLT',
    blurb: 'State-variable filter — low / band / high pass.',
    family: 'tone',
    amount: 'freq',
    params: [
      P('freq', 'Cutoff', 30, 18000, 1200, { unit: 'Hz', curve: 'log' }),
      P('reso', 'Resonance', 0, 1, 0.2),
      P('type', 'Type', 0, 2, 0, { options: ['LP', 'BP', 'HP'] }),
    ],
  },
  {
    id: 'chorus',
    name: 'Chorus',
    short: 'CHO',
    blurb: 'Lush dual-voice pitch-modulated widener.',
    family: 'modulation',
    amount: 'depth',
    params: [
      P('rate', 'Rate', 0.05, 8, 0.8, { unit: 'Hz', curve: 'log' }),
      P('depth', 'Depth', 0, 1, 0.5),
      P('mix', 'Mix', 0, 1, 0.5),
    ],
  },
  {
    id: 'flanger',
    name: 'Flanger',
    short: 'FLG',
    blurb: 'Swept comb filter with feedback jet.',
    family: 'modulation',
    amount: 'depth',
    params: [
      P('rate', 'Rate', 0.05, 6, 0.3, { unit: 'Hz', curve: 'log' }),
      P('depth', 'Depth', 0, 1, 0.6),
      P('feedback', 'Feedback', 0, 0.95, 0.5),
      P('mix', 'Mix', 0, 1, 0.5),
    ],
  },
  {
    id: 'phaser',
    name: 'Phaser',
    short: 'PHS',
    blurb: 'Four-stage all-pass sweep.',
    family: 'modulation',
    amount: 'depth',
    params: [
      P('rate', 'Rate', 0.05, 6, 0.4, { unit: 'Hz', curve: 'log' }),
      P('depth', 'Depth', 0, 1, 0.7),
      P('feedback', 'Feedback', 0, 0.9, 0.4),
      P('mix', 'Mix', 0, 1, 0.5),
    ],
  },
  {
    id: 'tremolo',
    name: 'Tremolo',
    short: 'TRM',
    blurb: 'Amplitude LFO, sine through square.',
    family: 'modulation',
    amount: 'depth',
    params: [
      P('rate', 'Rate', 0.1, 16, 5, { unit: 'Hz', curve: 'log' }),
      P('depth', 'Depth', 0, 1, 0.6),
      P('shape', 'Shape', 0, 1, 0),
    ],
  },
  {
    id: 'delay',
    name: 'Delay',
    short: 'DLY',
    blurb: 'Stereo feedback delay, tempo-syncable.',
    family: 'time',
    amount: 'mix',
    params: [
      P('time', 'Time', 0.02, 1.5, 0.3, { unit: 's', curve: 'log' }),
      P('feedback', 'Feedback', 0, 0.95, 0.4),
      P('mix', 'Mix', 0, 1, 0.35),
      P('sync', 'Sync', 0, 1, 0, { options: ['Free', 'Sync'] }),
      P('division', 'Division', 0, 4, 1, {
        options: ['1/4', '1/8', '1/8.', '1/16', '1/8T'],
      }),
    ],
  },
  {
    id: 'reverb',
    name: 'Reverb',
    short: 'RVB',
    blurb: 'Feedback-delay-network space: room to spring.',
    family: 'time',
    amount: 'mix',
    params: [
      P('size', 'Size', 0, 1, 0.5),
      P('decay', 'Decay', 0, 1, 0.5),
      P('mix', 'Mix', 0, 1, 0.3),
      P('mode', 'Mode', 0, 3, 1, {
        options: ['Room', 'Hall', 'Plate', 'Spring'],
      }),
    ],
  },
  {
    id: 'bitcrusher',
    name: 'Bitcrusher',
    short: 'BIT',
    blurb: 'Bit-depth + sample-rate decimation.',
    family: 'texture',
    amount: 'downsample',
    params: [
      P('bits', 'Bits', 1, 16, 8),
      P('downsample', 'Crush', 0, 1, 0.3),
      P('mix', 'Mix', 0, 1, 0.7),
    ],
  },
  {
    id: 'ringmod',
    name: 'Ring mod',
    short: 'RNG',
    blurb: 'Carrier multiplication for metallic tones.',
    family: 'texture',
    amount: 'mix',
    params: [
      P('freq', 'Freq', 20, 4000, 220, { unit: 'Hz', curve: 'log' }),
      P('mix', 'Mix', 0, 1, 0.5),
    ],
  },
  {
    id: 'freeze',
    name: 'Freeze',
    short: 'FRZ',
    blurb: 'Capture a grain and hold it as a pad.',
    family: 'texture',
    amount: 'mix',
    params: [
      P('hold', 'Hold', 0, 1, 0, { options: ['Off', 'Hold'] }),
      P('size', 'Grain', 0, 1, 0.5),
      P('mix', 'Mix', 0, 1, 1),
    ],
  },
] as const

export const EFFECT_IDS: readonly EffectId[] = EFFECT_SPECS.map((s) => s.id)

const SPEC_BY_ID: Record<EffectId, EffectSpec> = Object.fromEntries(
  EFFECT_SPECS.map((s) => [s.id, s]),
) as Record<EffectId, EffectSpec>

export function getSpec(id: EffectId): EffectSpec {
  return SPEC_BY_ID[id]
}

function isEffectId(v: unknown): v is EffectId {
  // Object.hasOwn (not `in`) so inherited prototype keys like "toString" or
  // "hasOwnProperty" can't masquerade as effect ids and later throw in getSpec.
  return typeof v === 'string' && Object.hasOwn(SPEC_BY_ID, v)
}

function defaultParams(id: EffectId): Record<string, number> {
  const out: Record<string, number> = {}
  for (const p of SPEC_BY_ID[id].params) out[p.key] = p.default
  return out
}

// ---------------------------------------------------------------------------
// Patch types
// ---------------------------------------------------------------------------

export interface EffectSlot {
  id: EffectId
  enabled: boolean
  params: Record<string, number>
}

/** Reference to a modulatable parameter: which rack slot, which param key. */
export interface ModTargetRef {
  slot: number
  param: string
}

export interface MacroAssignment {
  target: ModTargetRef
  /** Modulation depth applied to the param's normalized range, -1..1. */
  depth: number
}

export interface Macro {
  label: string
  value: number
  assignments: MacroAssignment[]
}

export interface XYState {
  x: number
  y: number
  xTarget: ModTargetRef | null
  yTarget: ModTargetRef | null
}

export interface Patch {
  version: number
  slots: EffectSlot[]
  /** Input trim, 0..3 (linear gain). */
  inputGain: number
  /** Master dry..wet, 0..1. */
  mix: number
  macros: [Macro, Macro, Macro, Macro]
  xy: XYState
  /** Beats per minute for synced time effects. */
  tempo: number
  sync: boolean
}

export const PATCH_VERSION = 1

export const MACRO_LABELS = ['Dirt', 'Motion', 'Space', 'Weird'] as const

const slotIndex = (id: EffectId): number => EFFECT_IDS.indexOf(id)

function defaultSlots(): EffectSlot[] {
  return EFFECT_SPECS.map((s) => ({
    id: s.id,
    // A small musical starting rack: drive + filter + delay + reverb on.
    enabled: s.id === 'drive' || s.id === 'filter' || s.id === 'delay' || s.id === 'reverb',
    params: defaultParams(s.id),
  }))
}

function defaultMacros(): [Macro, Macro, Macro, Macro] {
  return [
    {
      label: 'Dirt',
      value: 0,
      assignments: [
        { target: { slot: slotIndex('drive'), param: 'drive' }, depth: 0.9 },
        { target: { slot: slotIndex('bitcrusher'), param: 'downsample' }, depth: 0.4 },
      ],
    },
    {
      label: 'Motion',
      value: 0,
      assignments: [
        { target: { slot: slotIndex('chorus'), param: 'depth' }, depth: 0.7 },
        { target: { slot: slotIndex('phaser'), param: 'depth' }, depth: 0.6 },
        { target: { slot: slotIndex('tremolo'), param: 'depth' }, depth: 0.5 },
      ],
    },
    {
      label: 'Space',
      value: 0,
      assignments: [
        { target: { slot: slotIndex('delay'), param: 'mix' }, depth: 0.6 },
        { target: { slot: slotIndex('reverb'), param: 'mix' }, depth: 0.7 },
        { target: { slot: slotIndex('reverb'), param: 'size' }, depth: 0.4 },
      ],
    },
    {
      label: 'Weird',
      value: 0,
      assignments: [
        { target: { slot: slotIndex('ringmod'), param: 'mix' }, depth: 0.7 },
        { target: { slot: slotIndex('freeze'), param: 'mix' }, depth: 0.5 },
        { target: { slot: slotIndex('flanger'), param: 'feedback' }, depth: 0.5 },
      ],
    },
  ]
}

export const DEFAULT_PATCH: Patch = Object.freeze({
  version: PATCH_VERSION,
  slots: defaultSlots(),
  inputGain: 1,
  mix: 1,
  macros: defaultMacros(),
  xy: {
    x: 0.5,
    y: 0.5,
    xTarget: { slot: slotIndex('filter'), param: 'freq' },
    yTarget: { slot: slotIndex('delay'), param: 'mix' },
  },
  tempo: 120,
  sync: false,
}) as Patch

// ---------------------------------------------------------------------------
// Sanitization — the trust boundary. Never throws; always returns a valid Patch.
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> {
  // Reject arrays: an array is `typeof 'object'` but not a keyed record, and
  // treating one as a record would silently accept junk shapes.
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function sanitizeParams(id: EffectId, raw: unknown): Record<string, number> {
  const src = asRecord(raw)
  const out: Record<string, number> = {}
  for (const p of SPEC_BY_ID[id].params) {
    const v = src[p.key]
    // Number.isFinite gate so NaN/Infinity fall back to the default rather than
    // collapsing to p.min via clamp.
    const clamped = clamp(Number.isFinite(v) ? (v as number) : p.default, p.min, p.max)
    // Discrete/option params are integer indices — round so e.g. type:1.5 can't
    // survive into the DSP as a fractional index.
    out[p.key] = p.options ? Math.round(clamped) : clamped
  }
  return out
}

/**
 * Result of sanitizing slots. `indexMap` maps a raw source slot index to its
 * index in the sanitized array so ModTargetRefs can be remapped when dropping
 * invalid/duplicate slots shifts subsequent positions. Dropped source indices
 * have no entry (refs to them are dropped); appended effects have no source
 * index and are therefore unreachable by incoming refs.
 */
interface SanitizedSlots {
  slots: EffectSlot[]
  indexMap: Map<number, number>
}

function sanitizeSlots(raw: unknown): SanitizedSlots {
  const list = Array.isArray(raw) ? raw : []
  const seen = new Set<EffectId>()
  const out: EffectSlot[] = []
  const indexMap = new Map<number, number>()
  for (let i = 0; i < list.length; i++) {
    const rec = asRecord(list[i])
    if (!isEffectId(rec.id) || seen.has(rec.id)) continue
    seen.add(rec.id)
    indexMap.set(i, out.length)
    out.push({
      id: rec.id,
      enabled: rec.enabled === true,
      params: sanitizeParams(rec.id, rec.params),
    })
  }
  // Append any effects the source omitted so the rack is always complete.
  for (const spec of EFFECT_SPECS) {
    if (!seen.has(spec.id)) {
      out.push({ id: spec.id, enabled: false, params: defaultParams(spec.id) })
    }
  }
  return { slots: out, indexMap }
}

function sanitizeTargetRef(
  raw: unknown,
  slotCount: number,
  indexMap: Map<number, number>,
): ModTargetRef | null {
  const rec = asRecord(raw)
  const slot = rec.slot
  const param = rec.param
  if (typeof slot !== 'number' || !Number.isInteger(slot)) return null
  // Remap the source index through the slot permutation: a ref to a dropped
  // slot has no mapping (drop it), and a ref to a shifted slot follows it.
  const mapped = indexMap.get(slot)
  if (mapped === undefined) return null
  if (mapped < 0 || mapped >= slotCount) return null
  if (typeof param !== 'string') return null
  return { slot: mapped, param }
}

function sanitizeMacros(
  raw: unknown,
  slotCount: number,
  indexMap: Map<number, number>,
): [Macro, Macro, Macro, Macro] {
  const list = Array.isArray(raw) ? raw : []
  const fallback = defaultMacros()
  const out = fallback.map((def, i) => {
    const rec = asRecord(list[i])
    const rawAssigns = Array.isArray(rec.assignments) ? rec.assignments : null
    const assignments: MacroAssignment[] = rawAssigns
      ? rawAssigns
          .map((a) => {
            const ar = asRecord(a)
            const target = sanitizeTargetRef(ar.target, slotCount, indexMap)
            if (!target) return null
            // Default missing/non-finite depth to a neutral 0; without this,
            // clamp(undefined,-1,1) collapses to -1 (full inverse modulation).
            const depth = Number.isFinite(ar.depth) ? (ar.depth as number) : 0
            return { target, depth: clamp(depth, -1, 1) }
          })
          .filter((a): a is MacroAssignment => a !== null)
      : def.assignments
    return {
      label: typeof rec.label === 'string' ? rec.label.slice(0, 16) : def.label,
      value: clamp(typeof rec.value === 'number' ? rec.value : 0, 0, 1),
      assignments,
    }
  })
  return [out[0], out[1], out[2], out[3]]
}

function sanitizeXY(raw: unknown, slotCount: number, indexMap: Map<number, number>): XYState {
  const rec = asRecord(raw)
  return {
    x: clamp(typeof rec.x === 'number' ? rec.x : 0.5, 0, 1),
    y: clamp(typeof rec.y === 'number' ? rec.y : 0.5, 0, 1),
    xTarget: sanitizeTargetRef(rec.xTarget, slotCount, indexMap),
    yTarget: sanitizeTargetRef(rec.yTarget, slotCount, indexMap),
  }
}

/**
 * Coerce any untrusted value into a valid Patch. This is the migration path:
 * missing/old/invalid fields collapse to safe defaults and clamped ranges.
 */
export function sanitizePatch(raw: unknown): Patch {
  const rec = asRecord(raw)
  const { slots, indexMap } = sanitizeSlots(rec.slots)
  return {
    version: PATCH_VERSION,
    slots,
    // Number.isFinite gate so NaN/Infinity fall back to the neutral default
    // rather than collapsing to the range min via clamp.
    inputGain: clamp(Number.isFinite(rec.inputGain) ? (rec.inputGain as number) : 1, 0, 3),
    mix: clamp(Number.isFinite(rec.mix) ? (rec.mix as number) : 1, 0, 1),
    macros: sanitizeMacros(rec.macros, slots.length, indexMap),
    xy: sanitizeXY(rec.xy, slots.length, indexMap),
    tempo: clamp(Number.isFinite(rec.tempo) ? (rec.tempo as number) : 120, 20, 300),
    sync: rec.sync === true,
  }
}

/** Structural deep clone of a patch (safe for snapshots / A-B). */
export function clonePatch(patch: Patch): Patch {
  return sanitizePatch(JSON.parse(JSON.stringify(patch)))
}

// ---------------------------------------------------------------------------
// Worklet message boundary
// ---------------------------------------------------------------------------

/** A slot with modulation already resolved on the main thread. */
export interface ResolvedSlot {
  id: EffectId
  enabled: boolean
  params: Record<string, number>
}

export interface RackState {
  slots: ResolvedSlot[]
  inputGain: number
  mix: number
  tempo: number
  sync: boolean
}

export type MainToWorkletMessage =
  | { type: 'rack'; state: RackState }
  | { type: 'reset' }

export interface MeterMessage {
  type: 'meter'
  inPeak: number
  outPeak: number
  /** Limiter gain reduction, 0..1 (0 = none). */
  reduction: number
}

export type WorkletToMainMessage = MeterMessage

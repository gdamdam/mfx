/**
 * patchSubset — convert a full mfx Patch into the native companion's supported
 * subset (see native-companion/docs and `protocol::sanitize_patch` on the Rust
 * side). The browser sends only what the companion understands; the companion
 * clamps everything again at its own trust boundary.
 *
 * MVP subset: input gain + master mix, plus the six ported effects
 * (drive, filter, comp, delay, tremolo, reverb). Unsupported effects and params
 * are dropped. Disabled slots are dropped. Chain order is preserved.
 */

import type { EffectId, Patch } from '../audio/contracts.ts'

/** Native slot as it goes over the wire (matches the Rust `RawSlot`). */
export interface NativeSlot {
  id: string
  enabled: true
  params: Record<string, number>
}

/** Native patch subset payload (matches the Rust `RawPatch`). */
export interface NativePatch {
  inputGain: number
  mix: number
  slots: NativeSlot[]
}

/**
 * Effects the companion implements, mapped to the param keys it honors. Keys use
 * the same names as `contracts.ts` so the companion can read them directly.
 *
 * This list must mirror exactly what the Rust engine reads in its per-effect
 * `set_params` calls (native-companion/src/engine.rs): the Rust side consumes a
 * fixed param set and silently drops anything else, so forwarding a key it
 * doesn't read is a no-op and omitting one it does read loses the control. It is
 * NOT auto-derived from EFFECT_SPECS for that reason; the patchSubset test only
 * asserts these keys still *exist* in contracts.ts (catching renames), not that
 * they cover every spec param.
 */
export const SUPPORTED: Partial<Record<EffectId, readonly string[]>> = {
  drive: ['drive', 'tone', 'level', 'character'],
  filter: ['freq', 'reso', 'type', 'drive'],
  comp: ['amount', 'attack', 'release', 'makeup', 'mix'],
  delay: ['time', 'feedback', 'mix', 'tone'],
  tremolo: ['rate', 'depth', 'shape'],
  reverb: ['size', 'decay', 'mix', 'damp'],
}

function pickParams(keys: readonly string[], params: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const k of keys) {
    const v = params[k]
    // Only forward finite numbers; the companion defaults anything missing.
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
  }
  return out
}

/**
 * Build the native subset payload from a full patch. Pure and deterministic.
 */
export function toNativePatch(patch: Patch): NativePatch {
  const slots: NativeSlot[] = []
  for (const slot of patch.slots) {
    if (!slot.enabled) continue
    const keys = SUPPORTED[slot.id]
    if (!keys) continue
    slots.push({ id: slot.id, enabled: true, params: pickParams(keys, slot.params) })
  }
  return {
    inputGain: Number.isFinite(patch.inputGain) ? patch.inputGain : 1,
    mix: Number.isFinite(patch.mix) ? patch.mix : 1,
    slots,
  }
}

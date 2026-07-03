/**
 * resolve.ts — pure modulation math (no React, no DOM, no audio).
 *
 * Folds macro knobs (additive) and the XY pad (absolute) into a base Patch to
 * produce the RackState the worklet consumes. Kept on the main thread so the
 * worklet stays a dumb chain runner and this math is directly unit-testable.
 */
import {
  clamp,
  getSpec,
  type Patch,
  type RackState,
  type ResolvedSlot,
} from './contracts.ts'

function paramSpec(slotId: ResolvedSlot['id'], key: string) {
  return getSpec(slotId).params.find((p) => p.key === key) ?? null
}

export function resolvePatch(patch: Patch): RackState {
  const slots: ResolvedSlot[] = patch.slots.map((s) => ({
    id: s.id,
    enabled: s.enabled,
    params: { ...s.params },
  }))

  const normalized = (value: number, min: number, max: number): number =>
    max > min ? (value - min) / (max - min) : 0
  const denormalize = (n: number, min: number, max: number): number =>
    min + clamp(n, 0, 1) * (max - min)

  // Macros: additive offset in normalized parameter space.
  const applyDelta = (slotIdx: number, key: string, deltaNorm: number): void => {
    const slot = slots[slotIdx]
    if (!slot) return
    const spec = paramSpec(slot.id, key)
    if (!spec) return
    const cur = slot.params[key] ?? spec.default
    const n = normalized(cur, spec.min, spec.max)
    slot.params[key] = denormalize(n + deltaNorm, spec.min, spec.max)
  }

  // XY: absolute set in normalized parameter space (the pad *is* the control).
  const applyAbsolute = (slotIdx: number, key: string, absNorm: number): void => {
    const slot = slots[slotIdx]
    if (!slot) return
    const spec = paramSpec(slot.id, key)
    if (!spec) return
    slot.params[key] = denormalize(absNorm, spec.min, spec.max)
  }

  for (const macro of patch.macros) {
    if (macro.value <= 0) continue
    for (const a of macro.assignments) {
      applyDelta(a.target.slot, a.target.param, a.depth * macro.value)
    }
  }

  if (patch.xy.xTarget) {
    applyAbsolute(patch.xy.xTarget.slot, patch.xy.xTarget.param, patch.xy.x)
  }
  if (patch.xy.yTarget) {
    applyAbsolute(patch.xy.yTarget.slot, patch.xy.yTarget.param, patch.xy.y)
  }

  return {
    slots,
    inputGain: patch.inputGain,
    mix: patch.mix,
    tempo: patch.tempo,
    sync: patch.sync,
  }
}

/**
 * morph.ts — interpolate between two chain snapshots (A/B) for click-free
 * morphing. Continuous params lerp; discrete/option params and enable flags
 * snap at the midpoint (sweeping a filter *type* or reverb *mode* would be
 * meaningless). Order follows A. Pure and unit-tested.
 */
import { clamp, getSpec, type Patch } from '../audio/contracts.ts'

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

// Interpolate log-curve params (freq, rate, delay time) in the log domain so a
// 100→10000Hz sweep spends equal time per octave instead of racing the top end.
const logLerp = (a: number, b: number, t: number) =>
  a > 0 && b > 0 ? Math.exp(lerp(Math.log(a), Math.log(b), t)) : lerp(a, b, t)

export function morphPatch(a: Patch, b: Patch, t: number): Patch {
  const f = clamp(t, 0, 1)
  const snap = f >= 0.5

  const slots = a.slots.map((slotA) => {
    const slotB = b.slots.find((s) => s.id === slotA.id) ?? slotA
    const spec = getSpec(slotA.id)
    const params: Record<string, number> = {}
    for (const ps of spec.params) {
      const va = slotA.params[ps.key] ?? ps.default
      const vb = slotB.params[ps.key] ?? ps.default
      params[ps.key] = ps.options
        ? snap
          ? vb
          : va
        : ps.curve === 'log'
          ? logLerp(va, vb, f)
          : lerp(va, vb, f)
    }
    return { id: slotA.id, enabled: snap ? slotB.enabled : slotA.enabled, params }
  })

  return {
    version: a.version,
    slots,
    inputGain: lerp(a.inputGain, b.inputGain, f),
    mix: lerp(a.mix, b.mix, f),
    // performance controls follow A (macros/XY are live, not morph targets).
    // Deep-copy so mutating the morph output can't corrupt snapshot A.
    macros: structuredClone(a.macros),
    xy: structuredClone(a.xy),
    tempo: lerp(a.tempo, b.tempo, f),
    sync: a.sync,
  }
}

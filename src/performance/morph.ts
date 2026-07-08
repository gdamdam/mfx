/**
 * morph.ts — interpolate between two chain snapshots (A/B) for click-free
 * morphing. Continuous params lerp; discrete/option params snap at the midpoint
 * (sweeping a filter *type* or reverb *mode* would be meaningless).
 *
 * Enable transitions: when a slot is on in exactly one snapshot, a hard flag
 * snap at t=0.5 pops the whole effect in or out. If the effect has a dry/wet
 * `mix`, we instead keep it enabled across the morph and crossfade `mix` from
 * the bypassed side's 0 — a smooth transformation rather than a jump. Effects
 * with no wet control (drive, filter, tremolo, imager) still snap. Order
 * follows A. Pure and unit-tested.
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
    // Crossfade instead of snapping when exactly one side is enabled and the
    // effect has a `mix` to ramp its wet signal in/out of the chain.
    const hasMix = spec.params.some((p) => p.key === 'mix')
    const crossfade = slotA.enabled !== slotB.enabled && hasMix

    const params: Record<string, number> = {}
    for (const ps of spec.params) {
      const va = slotA.params[ps.key] ?? ps.default
      const vb = slotB.params[ps.key] ?? ps.default
      if (crossfade && ps.key === 'mix') {
        // The bypassed side contributes 0 wet; the enabled side its stored mix.
        params[ps.key] = lerp(slotA.enabled ? va : 0, slotB.enabled ? vb : 0, f)
      } else if (ps.options) {
        params[ps.key] = snap ? vb : va
      } else if (ps.curve === 'log') {
        params[ps.key] = logLerp(va, vb, f)
      } else {
        params[ps.key] = lerp(va, vb, f)
      }
    }
    return {
      id: slotA.id,
      enabled: crossfade ? true : snap ? slotB.enabled : slotA.enabled,
      params,
    }
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

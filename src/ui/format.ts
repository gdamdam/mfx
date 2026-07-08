import type { ParamSpec } from '../audio/contracts.ts'
import { clamp } from '../audio/contracts.ts'

/** Raw param value → normalized 0..1 for the knob, honouring log curve. */
export function rawToNorm(spec: ParamSpec, raw: number): number {
  const v = clamp(raw, spec.min, spec.max)
  if (spec.curve === 'log' && spec.min > 0) {
    return Math.log(v / spec.min) / Math.log(spec.max / spec.min)
  }
  return spec.max > spec.min ? (v - spec.min) / (spec.max - spec.min) : 0
}

/** Normalized 0..1 → raw param value. */
export function normToRaw(spec: ParamSpec, n: number): number {
  const t = clamp(n, 0, 1)
  if (spec.curve === 'log' && spec.min > 0) {
    return spec.min * Math.pow(spec.max / spec.min, t)
  }
  return spec.min + t * (spec.max - spec.min)
}

/** Human-readable value with unit or option label. */
export function formatParam(spec: ParamSpec, raw: number): string {
  if (spec.options) {
    const idx = clamp(Math.round(raw), 0, spec.options.length - 1)
    return spec.options[idx]
  }
  const v = clamp(raw, spec.min, spec.max)
  if (spec.unit === 'Hz') {
    return v >= 1000 ? `${(v / 1000).toFixed(2)} kHz` : `${Math.round(v)} Hz`
  }
  if (spec.unit === 's') {
    return v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`
  }
  if (spec.unit === 'st') {
    const st = Math.round(v)
    return `${st > 0 ? '+' : ''}${st} st`
  }
  // 0..1 knobs read as a percentage; wider ranges as a rounded number.
  if (spec.min === 0 && spec.max === 1) return `${Math.round(v * 100)}%`
  return v >= 10 ? Math.round(v).toString() : v.toFixed(1)
}

/**
 * monitorMode.ts — pure mapping between the two live monitoring controls that
 * already exist (the master `mix` in the patch and the transient monitor mute)
 * and a single, honest "monitor mode" the UI can present as one choice.
 *
 * There is deliberately no new persisted state here: a mode is just a *view* of
 * `mix` + `muted`, so old patches, share links, and presets stay compatible
 * without migration. This is the browser-latency-safe workflow made obvious:
 *
 *   - `wet`    — 100% processed out; monitor your dry signal through hardware.
 *   - `wetdry` — blend of dry + wet; production / reamp / file / tab default.
 *   - `muted`  — nothing to the speakers (recording still taps post-limiter).
 */

export type MonitorMode = 'wet' | 'wetdry' | 'muted'

/** The `mix` value "Wet + dry" snaps to when coming from a fully-wet chain. */
export const WETDRY_MIX = 0.5

/** Mix at or above this reads as fully wet (guards float drift near 1.0). */
const FULLY_WET = 0.999

/** Which mode the current (mix, muted) pair represents — for highlighting. */
export function monitorModeOf(mix: number, muted: boolean): MonitorMode {
  if (muted) return 'muted'
  const m = Number.isFinite(mix) ? mix : 1
  return m >= FULLY_WET ? 'wet' : 'wetdry'
}

export interface MonitorModeApply {
  muted: boolean
  /** New master mix, or undefined to leave the current mix untouched. */
  mix?: number
}

/**
 * The control changes needed to enter `mode` from the current mix. Selecting
 * "Wet + dry" only snaps to a blend when the chain was fully wet — an existing
 * dialed-in blend is preserved rather than clobbered. "Muted" leaves the mix
 * alone so unmuting returns you to exactly where you were.
 */
export function applyMonitorMode(mode: MonitorMode, currentMix: number): MonitorModeApply {
  const cur = Number.isFinite(currentMix) ? currentMix : 1
  switch (mode) {
    case 'wet':
      return { muted: false, mix: 1 }
    case 'wetdry':
      return { muted: false, mix: cur >= FULLY_WET ? WETDRY_MIX : cur }
    case 'muted':
      return { muted: true }
  }
}

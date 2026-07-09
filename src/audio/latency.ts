/**
 * latency.ts — pure round-trip latency estimate from reported context fields.
 *
 * This is a *reported* figure (AudioContext.baseLatency + outputLatency), not a
 * loopback probe: it reflects the browser/platform's own estimate of the graph
 * round-trip, so surface it with "≈". Missing fields (older browsers, jsdom)
 * simply contribute nothing rather than poisoning the sum with NaN.
 */

/** Round-trip estimate in ms = (baseLatency + outputLatency) * 1000. */
export function estimateLatencyMs(
  baseLatency: number | undefined,
  outputLatency: number | undefined,
): number {
  const base = Number.isFinite(baseLatency) ? (baseLatency as number) : 0
  const out = Number.isFinite(outputLatency) ? (outputLatency as number) : 0
  return Math.round((base + out) * 1000)
}

/**
 * Latency guidance tier. `unknown` is neutral — no data, no shaming; used when
 * the browser reports nothing (0 ms, missing fields, jsdom) or a nonsense value.
 */
export type LatencyLevel = 'tight' | 'playable' | 'production' | 'avoid' | 'unknown'

export interface LatencyGuidance {
  level: LatencyLevel
  /** Short badge word, safe to render next to the millisecond readout. */
  label: string
  /** One sentence telling the player what this latency is good for. */
  detail: string
}

/**
 * Classify a round-trip estimate into an actionable tier. The thresholds match
 * the honest browser story: sub-15 ms feels tight, 15–30 ms is playable for
 * some but better as a wet send, 30–60 ms is production/reamp territory, and
 * above 60 ms live monitoring stops being trustworthy. A very high figure is
 * *likely* Bluetooth output — an inference from the number itself, not device
 * probing — so we hint at a wired switch rather than faking detection.
 *
 * A non-finite, zero, or negative input means "no estimate": returns `unknown`
 * so the UI never shows a NaN or a negative and never guesses.
 */
export function classifyLatency(ms: number | null | undefined): LatencyGuidance {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) {
    return {
      level: 'unknown',
      label: 'unknown',
      detail:
        'No latency estimate yet — if you play live, monitor the dry signal through your interface and let mfx add the wet.',
    }
  }
  if (ms < 15) {
    return {
      level: 'tight',
      label: 'tight',
      detail: 'Tight round-trip — responsive enough for live monitoring on most wired rigs.',
    }
  }
  if (ms < 30) {
    return {
      level: 'playable',
      label: 'playable',
      detail:
        'Playable for some players; feels safer as a wet send while you monitor dry through your interface.',
    }
  }
  if (ms < 60) {
    return {
      level: 'production',
      label: 'production',
      detail:
        'Best for production, reamping, and file/loop work — monitor dry through hardware if you play live.',
    }
  }
  if (ms >= 100) {
    return {
      level: 'avoid',
      label: 'high',
      detail:
        'Unusually high — often a Bluetooth output. Switch to a wired output for live use, or keep mfx to files, loops, reamp, and wet sends.',
    }
  }
  return {
    level: 'avoid',
    label: 'high',
    detail:
      'Too high for trustworthy live monitoring — use mfx on files, loops, and reamp, or as a wet send over dry hardware monitoring.',
  }
}

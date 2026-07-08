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

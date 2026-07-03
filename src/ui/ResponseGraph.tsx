import type { EffectSlot, EffectSpec } from '../audio/contracts.ts'
import { clamp } from '../audio/contracts.ts'
import { rawToNorm } from './format.ts'

const W = 260
const H = 92
const PAD = 8

/**
 * A small SVG "character" plot per effect — transfer curve, filter response,
 * LFO shape, decay tail, etc. Purely illustrative: it communicates the shape of
 * what the effect does, derived from its current params.
 */
export function ResponseGraph({ spec, slot }: { spec: EffectSpec; slot: EffectSlot }) {
  const p = slot.params
  const color = `var(--fam-${spec.family})`
  const pts = curveFor(spec, p)
  const path = toPath(pts)

  return (
    <svg
      className="response"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`${spec.name} response`}
      preserveAspectRatio="none"
    >
      <line x1={PAD} y1={H / 2} x2={W - PAD} y2={H / 2} className="response-axis" />
      <path d={path} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
    </svg>
  )
}

// Map a normalized [0..1] y (0 = bottom) to SVG coordinates.
function toPath(ys: number[]): string {
  const n = ys.length
  const innerW = W - PAD * 2
  const innerH = H - PAD * 2
  return ys
    .map((y, i) => {
      const x = PAD + (i / (n - 1)) * innerW
      const py = PAD + (1 - clamp(y, 0, 1)) * innerH
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${py.toFixed(1)}`
    })
    .join(' ')
}

function samples(n: number, f: (t: number) => number): number[] {
  const out = new Array<number>(n)
  for (let i = 0; i < n; i++) out[i] = f(i / (n - 1))
  return out
}

function curveFor(spec: EffectSpec, p: Record<string, number>): number[] {
  const N = 96
  switch (spec.id) {
    case 'drive': {
      const g = 1 + p.drive * 30
      return samples(N, (t) => 0.5 + 0.5 * Math.tanh((t * 2 - 1) * g) * 0.95)
    }
    case 'comp': {
      // input→output transfer with soft compression above threshold
      const amt = p.amount
      return samples(N, (t) => {
        const above = Math.max(0, t - (1 - amt * 0.8))
        return clamp(t - above * amt * 0.8, 0, 1)
      })
    }
    case 'filter': {
      const type = Math.round(p.type)
      const fc = rawToNorm(spec.params.find((s) => s.key === 'freq')!, p.freq)
      const q = 0.5 + p.reso * 6
      return samples(N, (t) => {
        const d = (t - fc) * 8
        let mag: number
        if (type === 0) mag = 1 / (1 + Math.max(0, d) ** 2) // low-pass
        else if (type === 2) mag = 1 / (1 + Math.max(0, -d) ** 2) // high-pass
        else mag = 1 / (1 + (d * 1.4) ** 2) // band-pass
        const peak = type === 1 ? 0 : Math.exp(-(((t - fc) * 14) ** 2)) * (q / 8)
        return clamp(mag * 0.85 + peak, 0, 1)
      })
    }
    case 'chorus':
    case 'flanger':
    case 'phaser':
    case 'tremolo': {
      const cycles = 1 + Math.round((p.rate ?? 1) / 2)
      const depth = p.depth ?? 0.6
      const square = spec.id === 'tremolo' ? (p.shape ?? 0) : 0
      return samples(N, (t) => {
        const s = Math.sin(t * Math.PI * 2 * cycles)
        const shaped = s * (1 - square) + Math.tanh(s * 6) * square
        return 0.5 + 0.42 * shaped * (0.25 + depth * 0.75)
      })
    }
    case 'delay': {
      const fb = p.feedback ?? 0.4
      const taps = 5
      const gap = 1 / (taps + 1)
      return samples(N, (t) => {
        let v = 0
        for (let k = 0; k < taps; k++) {
          const pos = gap * (k + 1)
          const amp = Math.pow(fb, k) * (0.9 - k * 0.05)
          v += amp * Math.exp(-(((t - pos) * 60) ** 2))
        }
        return clamp(v, 0, 1)
      })
    }
    case 'reverb': {
      const decay = 3 + (1 - (p.decay ?? 0.5)) * 12
      return samples(N, (t) => clamp(Math.exp(-t * decay) * (0.3 + Math.abs(Math.sin(t * 40)) * 0.7), 0, 1))
    }
    case 'bitcrusher': {
      const bits = clamp(Math.floor(p.bits ?? 8), 1, 6)
      const levels = Math.pow(2, bits)
      return samples(N, (t) => {
        const s = 0.5 + 0.45 * Math.sin(t * Math.PI * 2 * 2)
        return Math.round(s * levels) / levels
      })
    }
    case 'ringmod': {
      const f = 3 + (rawToNorm(spec.params.find((s) => s.key === 'freq')!, p.freq)) * 9
      return samples(N, (t) => 0.5 + 0.42 * Math.sin(t * Math.PI * 2 * 2) * Math.sin(t * Math.PI * 2 * f))
    }
    case 'freeze': {
      const grain = 0.2 + (p.size ?? 0.5) * 0.4
      return samples(N, (t) => {
        const phase = (t % grain) / grain
        return 0.5 + 0.4 * Math.sin(phase * Math.PI * 2 * 3) * (1 - phase * 0.3)
      })
    }
    default:
      return samples(N, () => 0.5)
  }
}

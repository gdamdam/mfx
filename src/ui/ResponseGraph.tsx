import { useEffect, useRef, useState } from 'react'
import type { EffectSlot, EffectSpec } from '../audio/contracts.ts'
import { clamp } from '../audio/contracts.ts'
import { rawToNorm } from './format.ts'

const W = 260
const H = 92
const PAD = 8

/** ~30 fps is plenty for an illustrative plot and keeps CPU negligible. */
const FRAME_MS = 33

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return
    const mq = matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduced(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduced
}

/**
 * A small animated SVG "character" plot per effect — transfer curve, filter
 * response, LFO shape, grains, decay tail, spectral motion. Purely
 * illustrative: it communicates the shape of what the effect does, derived
 * from its current params. Animation pauses under prefers-reduced-motion.
 */
export function ResponseGraph({ spec, slot }: { spec: EffectSpec; slot: EffectSlot }) {
  const reduced = usePrefersReducedMotion()
  const [t, setT] = useState(0)
  const lastFrame = useRef(0)

  useEffect(() => {
    if (reduced) return
    let raf = 0
    const loop = (ts: number) => {
      if (ts - lastFrame.current >= FRAME_MS) {
        lastFrame.current = ts
        setT(ts / 1000)
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [reduced])

  const p = slot.params
  const color = spec.color
  const time = reduced ? 0 : t
  const pts = curveFor(spec, p, time)
  const ghost = ghostFor(spec, p, time)

  return (
    <svg
      className="response"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`${spec.name} response`}
      preserveAspectRatio="none"
    >
      <line x1={PAD} y1={H / 2} x2={W - PAD} y2={H / 2} className="response-axis" />
      {ghost && (
        <path
          d={toPath(ghost)}
          fill="none"
          stroke={color}
          strokeOpacity={0.35}
          strokeWidth={1.4}
          strokeLinejoin="round"
        />
      )}
      <path d={toPath(pts)} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
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

/** Deterministic hash noise in [0,1) — stable per index, no Math.random. */
function hash(i: number): number {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

const N = 96

function curveFor(spec: EffectSpec, p: Record<string, number>, tm: number): number[] {
  switch (spec.id) {
    case 'drive': {
      const g = 1 + p.drive * 30
      const ch = Math.round(p.character ?? 0)
      return samples(N, (t) => {
        const x = t * 2 - 1
        let y: number
        if (ch === 6) {
          // fold: reflect peaks back down
          const u = x * (1 + p.drive * 3)
          y = Math.abs(((u + 1) % 4 + 4) % 4 - 2) - 1
        } else if (ch === 1 || ch === 5) {
          y = clamp(x * g * 0.5, -1, 1) * 0.95 // hard/silicon edge
        } else if (ch === 2 || ch === 4) {
          y = Math.tanh((x + 0.18) * g) * 0.9 - Math.tanh(0.18 * g) * 0.9 // asymmetric
        } else {
          y = Math.tanh(x * g) * 0.95
        }
        return 0.5 + 0.5 * clamp(y, -1, 1)
      })
    }
    case 'saturation': {
      const g = 1 + (p.amount ?? 0.35) * 8
      const type = Math.round(p.type ?? 0)
      return samples(N, (t) => {
        const x = t * 2 - 1
        let y: number
        if (type === 1) y = Math.tanh((x + 0.12) * g) - Math.tanh(0.12 * g)
        else if (type === 2) y = Math.tanh(x * g * 1.3) * 0.85
        else if (type === 3) y = x - (x * x * x) / 3 / (1 + 1 / g)
        else if (type === 4) y = clamp(x * (1 + g * 0.3), -1, 1)
        else y = x / (1 + Math.abs(x * g * 0.5))
        return 0.5 + 0.48 * clamp(y, -1, 1)
      })
    }
    case 'comp': {
      const amt = p.amount
      return samples(N, (t) => {
        const above = Math.max(0, t - (1 - amt * 0.8))
        return clamp(t - above * amt * 0.8, 0, 1)
      })
    }
    case 'filter': {
      const model = Math.round(p.model ?? 0)
      const type = Math.round(p.type)
      const fc = rawToNorm(spec.params.find((s) => s.key === 'freq')!, p.freq)
      const q = 0.5 + p.reso * 6
      if (model === 3) {
        // comb: repeating peaks spaced by the tuned frequency
        return samples(N, (t) => {
          const peaks = 0.5 + 0.5 * Math.cos((t - fc) * Math.PI * 2 * (3 + fc * 6))
          const res = Math.pow(peaks, 1 + (1 - p.reso) * 6)
          return clamp(0.18 + res * (0.35 + p.reso * 0.45), 0, 1)
        })
      }
      return samples(N, (t) => {
        const d = (t - fc) * 8
        let mag: number
        if (type === 0) mag = 1 / (1 + Math.max(0, d) ** 2)
        else if (type === 2) mag = 1 / (1 + Math.max(0, -d) ** 2)
        else if (type === 3) mag = 1 - Math.exp(-(((t - fc) * 10) ** 2)) // notch
        else mag = 1 / (1 + (d * 1.4) ** 2)
        const slope = model >= 1 ? 1.6 : 1 // ladder/diode fall steeper
        const peak = type === 1 || type === 3 ? 0 : Math.exp(-(((t - fc) * 14) ** 2)) * (q / 8)
        return clamp(Math.pow(mag, slope) * 0.85 + peak + (p.drive ?? 0) * 0.05, 0, 1)
      })
    }
    case 'chorus':
    case 'flanger':
    case 'phaser': {
      const rate = p.rate ?? 1
      const cycles = 1 + Math.round(rate / 2)
      const depth = p.depth ?? 0.6
      const phase = tm * rate * 0.9
      const voices = spec.id === 'chorus' && Math.round(p.mode ?? 0) === 2 ? 3 : 1
      return samples(N, (t) => {
        let s = 0
        for (let v = 0; v < voices; v++) {
          s += Math.sin((t * cycles + phase + v / 3) * Math.PI * 2) / voices
        }
        return 0.5 + 0.42 * s * (0.25 + depth * 0.75)
      })
    }
    case 'tremolo': {
      const rate = p.rate ?? 5
      const cycles = 1 + Math.round(rate / 2)
      const square = p.shape ?? 0
      const phase = tm * rate * 0.5
      return samples(N, (t) => {
        const s = Math.sin((t * cycles + phase) * Math.PI * 2)
        const shaped = s * (1 - square) + Math.tanh(s * 6) * square
        return 0.5 + 0.42 * shaped * (0.25 + (p.depth ?? 0.6) * 0.75)
      })
    }
    case 'delay': {
      const fb = p.feedback ?? 0.4
      const taps = 5
      const gap = 1 / (taps + 1)
      const pulse = 0.9 + 0.1 * Math.sin(tm * 2.4)
      return samples(N, (t) => {
        let v = 0
        for (let k = 0; k < taps; k++) {
          const pos = gap * (k + 1)
          const amp = Math.pow(fb, k) * (0.9 - k * 0.05) * pulse
          v += amp * Math.exp(-(((t - pos) * 60) ** 2))
        }
        return clamp(v, 0, 1)
      })
    }
    case 'tapedelay': {
      const fb = p.feedback ?? 0.45
      const wow = p.wow ?? 0.3
      const taps = 5
      const gap = 1 / (taps + 1)
      return samples(N, (t) => {
        let v = 0
        for (let k = 0; k < taps; k++) {
          const wob = Math.sin(tm * 2.2 + k * 1.7) * wow * 0.02
          const pos = gap * (k + 1) + wob
          const amp = Math.pow(fb * 0.95, k) * (0.85 - k * 0.04)
          v += amp * Math.exp(-(((t - pos) * 55) ** 2))
        }
        return clamp(v, 0, 1)
      })
    }
    case 'particle': {
      const density = p.density ?? 0.5
      const scatter = p.scatter ?? 0.3
      const grains = 3 + Math.round(density * 9)
      const drift = Math.floor(tm * (0.6 + density))
      return samples(N, (t) => {
        let v = 0
        for (let k = 0; k < grains; k++) {
          const seed = k + drift * 31
          const pos = 0.15 + hash(seed) * 0.8 * (0.3 + scatter * 0.7) + k * (0.5 / grains)
          const amp = 0.25 + hash(seed + 7) * 0.55
          v += amp * Math.exp(-(((t - (pos % 1)) * 70) ** 2))
        }
        return clamp(v * 0.8, 0, 1)
      })
    }
    case 'mosaic': {
      const density = p.density ?? 0.5
      const chaos = p.chaos ?? 0.3
      const grains = 4 + Math.round(density * 10)
      const drift = Math.floor(tm * (0.8 + chaos * 2))
      return samples(N, (t) => {
        let v = 0
        for (let k = 0; k < grains; k++) {
          const seed = k * 3 + drift * 17
          const pos = hash(seed) * (0.4 + chaos * 0.6) + (k / grains) * (1 - chaos * 0.5)
          const w = 0.02 + (p.size ?? 0.12) * 0.15
          v += (0.3 + hash(seed + 3) * 0.5) * Math.exp(-(((t - (pos % 1)) / w) ** 2))
        }
        return clamp(v * 0.7, 0, 1)
      })
    }
    case 'reverb': {
      const decay = 3 + (1 - (p.decay ?? 0.5)) * 12
      return samples(N, (t) =>
        clamp(Math.exp(-t * decay) * (0.3 + Math.abs(Math.sin(t * 40 + tm * 0.8)) * 0.7), 0, 1),
      )
    }
    case 'cloud': {
      const decay = 1.2 + (1 - (p.decay ?? 0.5)) * 5
      const bloomAmt = p.bloom ?? 0.4
      const mod = p.mod ?? 0.3
      return samples(N, (t) => {
        const rise = 1 - Math.exp(-t / (0.05 + bloomAmt * 0.25))
        const fall = Math.exp(-t * decay)
        const billow =
          0.7 +
          0.3 * Math.sin(t * 9 + tm * (0.4 + mod * 1.6)) * Math.sin(t * 4.3 - tm * 0.7 * (0.3 + mod))
        return clamp(rise * fall * billow * 1.5, 0, 1)
      })
    }
    case 'shimmer': {
      const decay = 1.5 + (1 - (p.decay ?? 0.6)) * 6
      const amt = p.amount ?? 0.5
      return samples(N, (t) => {
        const base = Math.exp(-t * decay) * 0.6
        const sparkle = Math.exp(-t * decay * 0.7) * amt * 0.4 * Math.abs(Math.sin(t * 60 + tm * 2))
        return clamp(base + sparkle, 0, 1)
      })
    }
    case 'bloom': {
      const grow = p.grow ?? 0.5
      const cycle = (tm * (0.15 + grow * 0.2)) % 1
      return samples(N, (t) => {
        const growth = 1 - Math.exp(-t * (2 + grow * 6))
        const breathe = 0.8 + 0.2 * Math.sin((t * 3 + cycle * 2) * Math.PI * 2 * (0.4 + (p.evolve ?? 0.4)))
        return clamp(growth * breathe * (0.4 + (p.density ?? 0.5) * 0.5), 0, 1)
      })
    }
    case 'codec': {
      const crush = p.crush ?? 0.5
      const warble = p.warble ?? 0.3
      const tone = p.tone ?? 0.6
      const drift = tm * (0.2 + warble)
      return samples(N, (t) => {
        // Jagged partials: crush punches masking holes, tone rolls off the top,
        // warble swirls what survives.
        const b = hash(Math.floor(t * 22) * 7 + Math.floor(drift) * 13)
        const masked = b < crush * 0.6 ? 0 : 1
        const band = t < tone ? 1 : 0.12
        const swirl = 1 + warble * 0.25 * Math.sin((t * 6 + drift) * Math.PI * 2)
        return clamp((0.15 + b * 0.7) * masked * band * swirl, 0, 1)
      })
    }
    case 'bitcrusher': {
      const bits = clamp(Math.floor(p.bits ?? 8), 1, 6)
      const levels = Math.pow(2, bits)
      const smooth = p.smooth ?? 0
      return samples(N, (t) => {
        const s = 0.5 + 0.45 * Math.sin((t * 2 + tm * 0.15) * Math.PI * 2)
        const hard = Math.round(s * levels) / levels
        return hard * (1 - smooth) + s * smooth
      })
    }
    case 'ringmod': {
      const f = 3 + rawToNorm(spec.params.find((s) => s.key === 'freq')!, p.freq) * 9
      return samples(N, (t) => 0.5 + 0.42 * Math.sin((t * 2 + tm * 0.1) * Math.PI * 2) * Math.sin(t * Math.PI * 2 * f))
    }
    case 'resonator': {
      const model = Math.round(p.model ?? 0)
      const ratios =
        model === 1
          ? [1, 2.76, 5.4, 8.93]
          : model === 2
            ? [1, 3, 5, 7]
            : model === 3
              ? [1, 1.83, 2.51, 3.46]
              : [1, 2, 3, 4]
      const damp = p.damp ?? 0.4
      const ring = 0.85 + 0.15 * Math.sin(tm * 3)
      return samples(N, (t) => {
        let v = 0.08
        for (let k = 0; k < ratios.length; k++) {
          const pos = 0.12 + (ratios[k] / ratios[ratios.length - 1]) * 0.75
          const amp = (1 - k * 0.18) * (1 - damp * 0.6) * ring
          v += amp * Math.exp(-(((t - pos) * 40) ** 2))
        }
        return clamp(v, 0, 1)
      })
    }
    case 'pitch': {
      const st = p.pitch ?? 0
      const ratio = Math.pow(2, st / 12)
      return samples(N, (t) => 0.5 + 0.42 * Math.sin(t * Math.PI * 2 * 3 * ratio + tm * 1.2))
    }
    case 'spectralfreeze': {
      const smear = p.smear ?? 0.3
      const motion = p.motion ?? 0.2
      const tilt = (p.tilt ?? 0.5) - 0.5
      const frozen = (p.freeze ?? 0) >= 0.5
      const drift = frozen ? tm * motion * 0.7 : tm * (0.3 + motion)
      return samples(N, (t) => {
        let v = 0
        // jagged spectrum from stable hash bins, smoothed by smear
        const bins = 5
        for (let k = 0; k < bins; k++) {
          const b = hash(Math.floor(t * (18 - smear * 12)) + k * 37 + Math.floor(drift) * 13)
          v += b / bins
        }
        const tiltGain = 1 + tilt * (t * 2 - 1) * 1.6
        return clamp((0.2 + v * 0.6) * tiltGain, 0, 1)
      })
    }
    case 'freeze': {
      const grain = 0.2 + (p.size ?? 0.5) * 0.4
      const held = (p.hold ?? 0) >= 0.5
      const phase = held ? tm * 0.4 : 0
      return samples(N, (t) => {
        const ph = ((t + phase) % grain) / grain
        return 0.5 + 0.4 * Math.sin(ph * Math.PI * 2 * 3) * (1 - ph * 0.3)
      })
    }
    case 'fracture': {
      const chance = p.chance ?? 0.6
      const div = Math.round(p.div ?? 2)
      const slices = 4 + div * 4
      const step = Math.floor(tm * 1.5)
      return samples(N, (t) => {
        const s = Math.floor(t * slices)
        const edited = hash(s * 7 + step * 29) < chance
        const rev = edited && hash(s * 13 + step * 31) < (p.reverse ?? 0.3)
        let local = t * slices - s
        if (rev) local = 1 - local
        const src = edited ? Math.floor(hash(s * 3 + step * 11) * slices) : s
        return 0.5 + 0.38 * Math.sin(((src + local) / slices) * Math.PI * 2 * 4)
      })
    }
    case 'imager': {
      const width = (p.width ?? 1) / 2
      const rot = ((p.rotate ?? 0.5) - 0.5) * 1.2
      return samples(N, (t) => 0.5 + 0.42 * Math.sin(t * Math.PI * 2 * 2 + tm * 0.8) + rot * (t - 0.5) * 0.6 * width * 2)
    }
    default:
      return samples(N, () => 0.5)
  }
}

/** Secondary, fainter curve: stereo partner / dry reference where meaningful. */
function ghostFor(spec: EffectSpec, p: Record<string, number>, tm: number): number[] | null {
  switch (spec.id) {
    case 'imager': {
      const width = (p.width ?? 1) / 2
      return samples(N, (t) => 0.5 + 0.42 * Math.sin(t * Math.PI * 2 * 2 + tm * 0.8 + Math.PI * width))
    }
    case 'pitch':
      return samples(N, (t) => 0.5 + 0.3 * Math.sin(t * Math.PI * 2 * 3 + tm * 1.2))
    case 'tremolo': {
      if (Math.round(p.mode ?? 0) !== 2) return null
      const rate = p.rate ?? 5
      const cycles = 1 + Math.round(rate / 2)
      const phase = tm * rate * 0.5
      return samples(N, (t) => {
        const s = -Math.sin((t * cycles + phase) * Math.PI * 2)
        return 0.5 + 0.42 * s * (0.25 + (p.depth ?? 0.6) * 0.75)
      })
    }
    case 'chorus': {
      if ((p.width ?? 0.7) < 0.05) return null
      const rate = p.rate ?? 1
      const cycles = 1 + Math.round(rate / 2)
      const phase = tm * rate * 0.9 + (p.width ?? 0.7) * 0.4
      return samples(N, (t) => 0.5 + 0.36 * Math.sin((t * cycles + phase) * Math.PI * 2) * (0.25 + (p.depth ?? 0.5) * 0.75))
    }
    case 'cloud': {
      if ((p.width ?? 1) < 0.05) return null
      const decay = 1.2 + (1 - (p.decay ?? 0.5)) * 5
      return samples(N, (t) => {
        const rise = 1 - Math.exp(-t / (0.05 + (p.bloom ?? 0.4) * 0.25))
        const fall = Math.exp(-t * decay)
        const billow = 0.7 + 0.3 * Math.sin(t * 8.1 - tm * 0.5 + 1.7)
        return clamp(rise * fall * billow * 1.5 * (p.width ?? 1), 0, 1)
      })
    }
    default:
      return null
  }
}

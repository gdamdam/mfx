import { useCallback, useEffect, useId, useRef } from 'react'

interface KnobProps {
  /** Normalized 0..1. */
  value: number
  onChange: (v: number) => void
  label?: string
  /** Formatted current value for the readout (e.g. "1.2 kHz"). */
  display?: string
  size?: number
  color?: string
  /** Larger "amount" ring styling for the pedal face / modal hero control. */
  hero?: boolean
}

// The arc sweeps 270°, leaving a 90° gap at the bottom (classic knob dial).
const START = 135
const SWEEP = 270

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)]
}

function arcPath(cx: number, cy: number, r: number, from: number, to: number): string {
  const [x1, y1] = polar(cx, cy, r, from)
  const [x2, y2] = polar(cx, cy, r, to)
  const large = to - from > 180 ? 1 : 0
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`
}

export function Knob({
  value,
  onChange,
  label,
  display,
  size = 56,
  color = 'var(--accent)',
  hero = false,
}: KnobProps) {
  const id = useId()
  // Track the last pointer Y and the accumulated value so range changes
  // (shift toggled mid-drag) only scale subsequent increments, not the total.
  const drag = useRef<{ y: number; v: number } | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const v = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return // ignore non-primary buttons (e.g. right-click)
      ;(e.target as Element).setPointerCapture(e.pointerId)
      drag.current = { y: e.clientY, v }
    },
    [v],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current
      if (!d) return
      // Drag up = increase. Fine control while holding shift. Accumulate each
      // increment against the current range so toggling shift doesn't jump.
      const range = e.shiftKey ? 600 : 180
      const next = Math.min(1, Math.max(0, d.v + (d.y - e.clientY) / range))
      d.v = next
      d.y = e.clientY
      onChange(next)
    },
    [onChange],
  )

  const endDrag = useCallback((e: React.PointerEvent) => {
    drag.current = null
    ;(e.target as Element).releasePointerCapture?.(e.pointerId)
  }, [])

  // Wheel must be non-passive to preventDefault; React's synthetic wheel
  // listener is passive, so bind directly to the element.
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const cur = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))
      onChange(Math.min(1, Math.max(0, cur - Math.sign(e.deltaY) * 0.04)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onChange, value])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 0.01 : 0.05
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
        onChange(Math.min(1, v + step))
        e.preventDefault()
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
        onChange(Math.max(0, v - step))
        e.preventDefault()
      }
    },
    [onChange, v],
  )

  const r = size / 2 - 5
  const cx = size / 2
  const cy = size / 2
  const angle = START + SWEEP * v
  const [dotX, dotY] = polar(cx, cy, r - 6, angle)

  return (
    <div className={`knob ${hero ? 'knob-hero' : ''}`}>
      <svg
        ref={svgRef}
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="slider"
        aria-label={label ?? 'knob'}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(v * 100)}
        aria-valuetext={display}
        tabIndex={0}
        aria-describedby={display ? id : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onKeyDown={onKeyDown}
        style={{ touchAction: 'none', cursor: 'ns-resize' }}
      >
        <circle cx={cx} cy={cy} r={r + 2} className="knob-body" />
        <path
          d={arcPath(cx, cy, r, START, START + SWEEP)}
          className="knob-track"
          fill="none"
        />
        <path
          d={arcPath(cx, cy, r, START, angle)}
          fill="none"
          stroke={color}
          strokeWidth={hero ? 4 : 3}
          strokeLinecap="round"
          style={{ filter: `drop-shadow(0 0 4px ${color})` }}
        />
        <line
          x1={cx}
          y1={cy}
          x2={dotX}
          y2={dotY}
          stroke={color}
          strokeWidth={2}
          strokeLinecap="round"
        />
      </svg>
      {(label || display) && (
        <div className="knob-caption">
          {label && <span className="knob-label">{label}</span>}
          {display && (
            <span className="knob-value mono-val" id={id}>
              {display}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

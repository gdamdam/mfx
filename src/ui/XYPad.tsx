import { useCallback, useEffect, useRef } from 'react'

export interface AssignTarget {
  key: string // stable id "slot:param"
  label: string
}

interface XYPadProps {
  x: number
  y: number
  onMove: (x: number, y: number) => void
  targets: AssignTarget[]
  xKey: string | null
  yKey: string | null
  onAssignX: (key: string | null) => void
  onAssignY: (key: string | null) => void
  // gesture lane
  recording: boolean
  playing: boolean
  hasMotion: boolean
  onToggleRecord: () => void
  onTogglePlay: () => void
  onClearMotion: () => void
}

interface TrailPoint {
  x: number
  y: number
  life: number
}

const ACCENT = '#38e1c8'

export function XYPad(props: XYPadProps) {
  const { x, y, onMove, playing } = props
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const trail = useRef<TrailPoint[]>([])
  const pos = useRef({ x, y })
  const reduced = useRef(false)

  useEffect(() => {
    pos.current = { x, y }
  }, [x, y])

  useEffect(() => {
    reduced.current =
      typeof matchMedia !== 'undefined' &&
      matchMedia('(prefers-reduced-motion: reduce)').matches
  }, [])

  // Push a fading trail point whenever the position changes.
  useEffect(() => {
    trail.current.push({ x, y, life: 1 })
    if (trail.current.length > 120) trail.current.shift()
  }, [x, y])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const dpr = Math.min(2, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1)
    const w = wrap.clientWidth
    const h = wrap.clientHeight
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr
      canvas.height = h * dpr
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    // grid
    ctx.strokeStyle = 'rgba(120,140,150,0.10)'
    ctx.lineWidth = 1
    for (let i = 1; i < 8; i++) {
      const gx = (w / 8) * i
      const gy = (h / 8) * i
      ctx.beginPath()
      ctx.moveTo(gx, 0)
      ctx.lineTo(gx, h)
      ctx.moveTo(0, gy)
      ctx.lineTo(w, gy)
      ctx.stroke()
    }

    // fading phosphor trail. Always decay so the trail prunes; under reduced
    // motion we skip only the rendering, not the life decay.
    const t = trail.current
    for (let i = 0; i < t.length; i++) {
      const p = t[i]
      p.life *= 0.94
      if (reduced.current) continue
      const px = p.x * w
      const py = (1 - p.y) * h
      ctx.beginPath()
      ctx.fillStyle = `rgba(56,225,200,${Math.max(0, p.life) * 0.5})`
      ctx.arc(px, py, 2 + p.life * 3, 0, Math.PI * 2)
      ctx.fill()
    }
    trail.current = t.filter((p) => p.life > 0.05)

    // crosshair + puck
    const cx = pos.current.x * w
    const cy = (1 - pos.current.y) * h
    ctx.strokeStyle = 'rgba(56,225,200,0.35)'
    ctx.beginPath()
    ctx.moveTo(cx, 0)
    ctx.lineTo(cx, h)
    ctx.moveTo(0, cy)
    ctx.lineTo(w, cy)
    ctx.stroke()

    ctx.shadowColor = ACCENT
    ctx.shadowBlur = 18
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.arc(cx, cy, 9, 0, Math.PI * 2)
    ctx.fill()
    ctx.shadowBlur = 0
    ctx.fillStyle = '#0d0f13'
    ctx.beginPath()
    ctx.arc(cx, cy, 3.5, 0, Math.PI * 2)
    ctx.fill()
  }, [])

  const dragging = useRef(false)
  const rafRef = useRef(0)

  // Self-pausing draw loop: animate while dragging, replaying, or a trail is
  // still fading; otherwise sleep until the next interaction re-kicks it.
  const kick = useCallback(() => {
    if (rafRef.current) return
    const loop = () => {
      draw()
      if (dragging.current || playing || trail.current.length > 0) {
        rafRef.current = requestAnimationFrame(loop)
      } else {
        rafRef.current = 0
      }
    }
    rafRef.current = requestAnimationFrame(loop)
  }, [draw, playing])

  // Draw once, and resume whenever motion-producing inputs change.
  useEffect(() => {
    kick()
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
    }
  }, [kick, x, y])

  const pointerTo = useCallback(
    (e: React.PointerEvent) => {
      const wrap = wrapRef.current
      if (!wrap) return
      const rect = wrap.getBoundingClientRect()
      const nx = (e.clientX - rect.left) / rect.width
      const ny = 1 - (e.clientY - rect.top) / rect.height
      onMove(Math.min(1, Math.max(0, nx)), Math.min(1, Math.max(0, ny)))
    },
    [onMove],
  )

  const onDown = (e: React.PointerEvent) => {
    if (playing) return
    dragging.current = true
    ;(e.target as Element).setPointerCapture(e.pointerId)
    pointerTo(e)
    kick()
  }
  const onMoveEvt = (e: React.PointerEvent) => {
    if (dragging.current && !playing) pointerTo(e)
  }
  const onUp = () => {
    dragging.current = false
  }

  return (
    <div className="xy">
      <div className="xy-assign">
        <label className="xy-axis-sel">
          <span className="eyebrow">Y ↑</span>
          <select value={props.yKey ?? ''} onChange={(e) => props.onAssignY(e.target.value || null)}>
            <option value="">— unassigned —</option>
            {props.targets.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div
        ref={wrapRef}
        className={`xy-surface ${playing ? 'playing' : ''}`}
        onPointerDown={onDown}
        onPointerMove={onMoveEvt}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        role="application"
        aria-label="XY performance pad"
        style={{ touchAction: 'none' }}
      >
        <canvas ref={canvasRef} className="xy-canvas" />
        {playing && <span className="xy-badge">▶ replay</span>}
      </div>

      <div className="xy-foot">
        <label className="xy-axis-sel">
          <span className="eyebrow">X →</span>
          <select value={props.xKey ?? ''} onChange={(e) => props.onAssignX(e.target.value || null)}>
            <option value="">— unassigned —</option>
            {props.targets.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
        </label>

        <div className="xy-gesture">
          <button
            className={`btn ${props.recording ? 'warn is-active' : ''}`}
            onClick={props.onToggleRecord}
            aria-pressed={props.recording}
          >
            {props.recording ? '● recording' : '● record'}
          </button>
          <button
            className={`btn ${props.playing ? 'is-active' : ''}`}
            onClick={props.onTogglePlay}
            disabled={!props.hasMotion}
            aria-pressed={props.playing}
          >
            {props.playing ? '❚❚ stop' : '▶ play'}
          </button>
          <button className="btn" onClick={props.onClearMotion} disabled={!props.hasMotion}>
            clear
          </button>
        </div>
      </div>
    </div>
  )
}

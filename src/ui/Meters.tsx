import { useEffect, useRef, useState } from 'react'
import type { AudioEngine, EngineMeters } from '../audio/AudioEngine.ts'

/** Peak meter + low-signal hint, driven by the engine's ~30 Hz meter feed. */
export function Meters({ engine, running }: { engine: AudioEngine; running: boolean }) {
  const [m, setM] = useState<EngineMeters>({ inPeak: 0, outPeak: 0, reduction: 0 })
  const [lowSignal, setLowSignal] = useState(false)
  const streak = useRef(0)

  useEffect(() => {
    if (!running) return
    return engine.subscribeMeters((next) => {
      setM(next)
      // A sustained near-silent input suggests nothing is plugged in / low gain.
      streak.current = next.inPeak < 0.005 ? streak.current + 1 : 0
      setLowSignal(streak.current > 30)
    })
  }, [engine, running])

  return (
    <div className="meters">
      <Bar label="in" value={m.inPeak} />
      <Bar label="out" value={m.outPeak} />
      <div className="meter-gr" title="Limiter gain reduction">
        <span className="eyebrow">lim</span>
        <span className="mono-val">{m.reduction < -0.1 ? `${m.reduction.toFixed(1)} dB` : '—'}</span>
      </div>
      {lowSignal && <span className="low-hint">low signal — check input &amp; gain</span>}
    </div>
  )
}

function Bar({ label, value }: { label: string; value: number }) {
  const pct = Math.min(100, Math.max(0, value * 100))
  const clip = value >= 0.98
  return (
    <div className="meter">
      <span className="eyebrow">{label}</span>
      <div className="meter-track">
        <div
          className={`meter-fill ${clip ? 'clip' : ''}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

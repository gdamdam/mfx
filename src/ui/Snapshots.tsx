import { useRef, useState } from 'react'

interface SnapshotsProps {
  hasA: boolean
  hasB: boolean
  morph: number
  onCaptureA: () => void
  onCaptureB: () => void
  onMorph: (t: number) => void
  presetNames: string[]
  onSavePreset: (name: string) => void
  onLoadPreset: (name: string) => void
  onDeletePreset: (name: string) => void
  onExport: () => void
  onImport: (file: File) => void
  onShare: () => Promise<boolean>
}

export function Snapshots(props: SnapshotsProps) {
  const [name, setName] = useState('')
  const [shared, setShared] = useState(false)
  const importRef = useRef<HTMLInputElement | null>(null)

  const share = async () => {
    const ok = await props.onShare()
    setShared(ok)
    if (ok) setTimeout(() => setShared(false), 1600)
  }

  return (
    <div className="snapshots panel">
      <div className="section-label">
        <h2>Snapshots</h2>
        <span className="rule" />
      </div>

      <div className="ab">
        <button className={`ab-btn ${props.hasA ? 'set' : ''}`} onClick={props.onCaptureA}>
          <span className="ab-tag">A</span>
          <span className="ab-sub">{props.hasA ? 'set' : 'capture'}</span>
        </button>
        <div className="ab-morph">
          <input
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={props.morph}
            disabled={!props.hasA || !props.hasB}
            onChange={(e) => props.onMorph(Number(e.target.value))}
            aria-label="Morph between snapshot A and B"
          />
          <span className="eyebrow">morph {Math.round(props.morph * 100)}%</span>
        </div>
        <button className={`ab-btn ${props.hasB ? 'set' : ''}`} onClick={props.onCaptureB}>
          <span className="ab-tag">B</span>
          <span className="ab-sub">{props.hasB ? 'set' : 'capture'}</span>
        </button>
      </div>

      <div className="preset-save">
        <input
          className="text-input"
          placeholder="name this pedalboard"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && name.trim()) {
              props.onSavePreset(name.trim())
              setName('')
            }
          }}
        />
        <button
          className="btn"
          disabled={!name.trim()}
          onClick={() => {
            props.onSavePreset(name.trim())
            setName('')
          }}
        >
          save
        </button>
      </div>

      {props.presetNames.length > 0 && (
        <ul className="preset-list">
          {props.presetNames.map((n) => (
            <li key={n}>
              <button className="preset-name" onClick={() => props.onLoadPreset(n)}>
                {n}
              </button>
              <button
                className="mini"
                aria-label={`Delete ${n}`}
                onClick={() => props.onDeletePreset(n)}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="snap-actions">
        <button className={`btn ${shared ? 'is-active' : ''}`} onClick={share}>
          {shared ? '✓ link copied' : 'share link'}
        </button>
        <button className="btn" onClick={props.onExport}>export json</button>
        <button className="btn" onClick={() => importRef.current?.click()}>import json</button>
        <input
          ref={importRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) props.onImport(f)
          }}
        />
      </div>
    </div>
  )
}

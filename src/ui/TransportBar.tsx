import { useEffect, useRef, useState } from 'react'
import type { AudioEngine } from '../audio/AudioEngine.ts'
import type { InputKind } from '../audio/AudioEngine.ts'
import type { TestTone } from '../audio/testSource.ts'
import type { SourceInfo } from '../transport/mbus/index.ts'
import type { MonitorMode } from '../audio/monitorMode.ts'
import { classifyLatency } from '../audio/latency.ts'
import { Knob } from './Knob.tsx'
import { Meters } from './Meters.tsx'

export interface LinkStatus {
  connected: boolean
  peers: number
  following: boolean
}

interface TransportBarProps {
  engine: AudioEngine
  running: boolean
  input: InputKind
  testTone: TestTone
  mbusSources: SourceInfo[]
  mbusSourceId: string | null
  monitorMode: MonitorMode
  mix: number
  tempo: number
  sync: boolean
  link: LinkStatus
  recording: boolean
  latencyMs: number
  sampleRate: number
  onSetInput: (k: InputKind) => void
  onSetTestTone: (t: TestTone) => void
  onSetMbusSource: (id: string) => void
  onLoadFile: (f: File) => void
  onSetMonitorMode: (m: MonitorMode) => void
  onMix: (v: number) => void
  onTempo: (bpm: number) => void
  onToggleSync: () => void
  onToggleLink: () => void
  onToggleRecord: () => void
}

const INPUTS: { kind: InputKind; label: string }[] = [
  { kind: 'test', label: 'Test' },
  { kind: 'mic', label: 'Mic / Line' },
  { kind: 'tab', label: 'Tab' },
  { kind: 'file', label: 'File' },
  { kind: 'mbus', label: 'mbus' },
]
const TONES: TestTone[] = ['drums', 'sine', 'noise']
const MONITOR_MODES: { mode: MonitorMode; label: string; title: string }[] = [
  {
    mode: 'wet',
    label: 'Wet',
    title: 'Wet only — 100% processed out. Ideal as a send / reamp while you monitor your dry signal through hardware.',
  },
  {
    mode: 'wetdry',
    label: 'Wet + dry',
    title: 'Blend of dry + processed — production, reamping, and file / tab / loop work.',
  },
  {
    mode: 'muted',
    label: 'Muted',
    title: 'Silence to the speakers (recording still captures the wet output). Safe default for a live mic.',
  },
]

export function TransportBar(props: TransportBarProps) {
  const fileRef = useRef<HTMLInputElement | null>(null)
  const taps = useRef<number[]>([])
  // A ticking counter forces a re-render so the live timer reads fresh; the
  // value itself is read straight off the engine during render.
  const [, setTick] = useState(0)
  // Buffer tempo keystrokes locally; only clamp + commit to the engine on
  // blur/Enter so intermediate values (e.g. cleared field → 0) never reach it.
  const [tempoEdit, setTempoEdit] = useState<string | null>(null)

  const commitTempo = () => {
    if (tempoEdit === null) return
    const n = Number(tempoEdit)
    if (Number.isFinite(n) && n > 0) {
      props.onTempo(Math.min(300, Math.max(20, Math.round(n))))
    }
    setTempoEdit(null)
  }

  useEffect(() => {
    if (!props.recording) return
    const id = setInterval(() => setTick((t) => t + 1), 200)
    return () => clearInterval(id)
  }, [props.recording])

  const tap = () => {
    const now = performance.now()
    const t = taps.current
    t.push(now)
    while (t.length > 5) t.shift()
    if (t.length >= 2) {
      const intervals: number[] = []
      for (let i = 1; i < t.length; i++) intervals.push(t[i] - t[i - 1])
      const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length
      if (avg > 200 && avg < 2000) props.onTempo(Math.round(60000 / avg))
    }
  }

  const lat = classifyLatency(props.latencyMs)

  const linkLabel = props.link.connected
    ? `linked · ${props.link.peers} peer${props.link.peers === 1 ? '' : 's'}`
    : props.link.following
      ? 'searching…'
      : 'link off'

  return (
    <div className="transport panel">
      <div className="tp-group tp-inputs">
        <span className="eyebrow">Input</span>
        <div className="seg">
          {INPUTS.map((i) => (
            <button
              key={i.kind}
              className={`seg-btn ${props.input === i.kind ? 'is-on' : ''}`}
              onClick={() => (i.kind === 'file' ? fileRef.current?.click() : props.onSetInput(i.kind))}
            >
              {i.label}
            </button>
          ))}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) props.onLoadFile(f)
          }}
        />
        {props.input === 'test' && (
          <div className="seg seg-sm">
            {TONES.map((t) => (
              <button
                key={t}
                className={`seg-btn ${props.testTone === t ? 'is-on' : ''}`}
                onClick={() => props.onSetTestTone(t)}
              >
                {t}
              </button>
            ))}
          </div>
        )}
        {props.input === 'mbus' &&
          (props.mbusSources.length > 0 ? (
            <select
              className="mbus-select mono-val"
              value={props.mbusSourceId ?? ''}
              onChange={(e) => props.onSetMbusSource(e.target.value)}
              aria-label="mbus source"
            >
              {props.mbusSources.map((s) => (
                <option key={s.sourceId} value={s.sourceId}>
                  {s.name} · {s.sourceId}
                </option>
              ))}
            </select>
          ) : (
            <span className="hint" title="Start the mpump link-bridge and publish an output from another instrument.">
              no sources — is the bridge running?
            </span>
          ))}
        <div className="tp-monitor">
          <span className="eyebrow">Monitor</span>
          <div className="seg seg-sm">
            {MONITOR_MODES.map((m) => (
              <button
                key={m.mode}
                className={`seg-btn ${props.monitorMode === m.mode ? 'is-on' : ''} ${
                  m.mode === 'muted' && props.monitorMode === 'muted' ? 'is-muted' : ''
                }`}
                onClick={() => props.onSetMonitorMode(m.mode)}
                title={m.title}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
        {props.input === 'mic' && (
          <span className="hint">
            Live playing? Monitor dry through your interface — use mfx as a wet send / reamp.
          </span>
        )}
      </div>

      <div className="tp-group">
        <Knob value={props.mix} onChange={props.onMix} label="Dry / Wet" display={`${Math.round(props.mix * 100)}%`} size={50} color="var(--accent)" />
      </div>

      <div className="tp-group tp-tempo">
        <span className="eyebrow">Tempo</span>
        <input
          className="bpm-input mono-val"
          type="number"
          min={20}
          max={300}
          value={tempoEdit ?? Math.round(props.tempo)}
          onChange={(e) => setTempoEdit(e.target.value)}
          onBlur={commitTempo}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commitTempo()
              e.currentTarget.blur()
            }
          }}
          aria-label="Tempo in BPM"
        />
        <button className="btn" onClick={tap}>tap</button>
        <button className={`btn ${props.sync ? 'is-active' : ''}`} onClick={props.onToggleSync} aria-pressed={props.sync}>sync</button>
        <button className={`btn ${props.link.connected ? 'is-active' : ''}`} onClick={props.onToggleLink} title="Ableton Link via the mpump link-bridge">
          {linkLabel}
        </button>
      </div>

      <div className="tp-group tp-right">
        <Meters engine={props.engine} running={props.running} />
        <button
          className={`btn rec ${props.recording ? 'is-recording' : ''}`}
          onClick={props.onToggleRecord}
          aria-pressed={props.recording}
          title="Record the master output to a 24-bit WAV — works with any input, even with monitoring muted."
        >
          {props.recording ? `■ ${formatTime(props.engine.recordingSeconds)}` : '● REC'}
        </button>
        <span
          className={`latency mono-val lat-${lat.level}`}
          title={`Reported round-trip latency (baseLatency + outputLatency), not a loopback probe. ${lat.detail}`}
        >
          ≈{props.latencyMs} ms · {(props.sampleRate / 1000).toFixed(1)}k
          {lat.level !== 'unknown' && <span className="lat-tag"> · {lat.label}</span>}
        </span>
      </div>
    </div>
  )
}

function formatTime(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

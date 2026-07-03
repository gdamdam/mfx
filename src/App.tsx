import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './ui/ui.css'
import {
  clonePatch,
  DEFAULT_PATCH,
  getSpec,
  sanitizePatch,
  type ModTargetRef,
  type Patch,
} from './audio/contracts.ts'
import { resolvePatch } from './audio/resolve.ts'
import { morphPatch } from './performance/morph.ts'
import { MotionRecorder } from './performance/motion.ts'
import type { TestTone } from './audio/testSource.ts'
import { createLinkBridge, type LinkState } from './transport/linkBridge.ts'
import { PresetStore, serializePreset, deserializePreset } from './storage/presets.ts'
import { encodePatchLink, decodePatchLink } from './sharing/patchLink.ts'
import { useEngine } from './ui/useEngine.ts'
import { Knob } from './ui/Knob.tsx'
import { StartOverlay } from './ui/StartOverlay.tsx'
import { TransportBar } from './ui/TransportBar.tsx'
import { Rack } from './ui/Rack.tsx'
import { EffectModal } from './ui/EffectModal.tsx'
import { XYPad, type AssignTarget } from './ui/XYPad.tsx'
import { MacroBank } from './ui/MacroBank.tsx'
import { Snapshots } from './ui/Snapshots.tsx'

const refToKey = (ref: ModTargetRef | null): string | null =>
  ref ? `${ref.slot}:${ref.param}` : null
const keyToRef = (key: string | null): ModTargetRef | null => {
  if (!key) return null
  const [slot, param] = key.split(':')
  return { slot: Number(slot), param }
}

function initialPatch(): Patch {
  if (typeof location !== 'undefined' && location.hash.length > 1) {
    const decoded = decodePatchLink(location.hash)
    if (decoded) return decoded
  }
  return clonePatch(DEFAULT_PATCH)
}

export function App() {
  const engine = useEngine()
  const [patch, setPatch] = useState<Patch>(initialPatch)
  const [modalIndex, setModalIndex] = useState<number | null>(null)
  const [snapA, setSnapA] = useState<Patch | null>(null)
  const [snapB, setSnapB] = useState<Patch | null>(null)
  const [morph, setMorph] = useState(0)
  const [presetNames, setPresetNames] = useState<string[]>([])
  const [testTone, setTestTone] = useState<TestTone>('drums')
  const [linkStatus, setLinkStatus] = useState({ connected: false, peers: 0, following: false })

  const motion = useRef(new MotionRecorder())
  const [recordingGesture, setRecordingGesture] = useState(false)
  const [playingGesture, setPlayingGesture] = useState(false)
  const [hasMotion, setHasMotion] = useState(false)
  const store = useRef<PresetStore | null>(null)
  const link = useRef(createLinkBridge(true))

  // Push resolved modulation to the worklet whenever anything changes.
  useEffect(() => {
    if (engine.running) engine.setRack(resolvePatch(patch))
  }, [patch, engine.running, engine])

  // ---- immutable patch helpers ----
  const mutate = useCallback((fn: (draft: Patch) => void) => {
    setPatch((prev) => {
      const next = clonePatch(prev)
      fn(next)
      return next
    })
  }, [])

  const toggleSlot = (i: number) => mutate((p) => { p.slots[i].enabled = !p.slots[i].enabled })
  const setParam = (i: number, key: string, raw: number) =>
    mutate((p) => { p.slots[i].params[key] = raw })
  const setAmount = (i: number, raw: number) =>
    mutate((p) => { p.slots[i].params[getSpec(p.slots[i].id).amount] = raw })
  const reorder = (from: number, to: number) =>
    mutate((p) => {
      const [moved] = p.slots.splice(from, 1)
      p.slots.splice(to, 0, moved)
    })
  const setMacro = (i: number, v: number) => mutate((p) => { p.macros[i].value = v })
  const setMix = (v: number) => mutate((p) => { p.mix = v })
  const setInputGain = (v: number) => mutate((p) => { p.inputGain = v })
  const setTempo = (bpm: number) => mutate((p) => { p.tempo = bpm })
  const toggleSync = () => mutate((p) => { p.sync = !p.sync })

  // ---- XY + gesture ----
  const setXY = useCallback(
    (x: number, y: number) => {
      mutate((p) => { p.xy.x = x; p.xy.y = y })
      if (recordingGesture) motion.current.record(performance.now(), x, y)
    },
    [mutate, recordingGesture],
  )

  const toggleRecordGesture = () => {
    if (recordingGesture) {
      motion.current.stopRecording(performance.now())
      setRecordingGesture(false)
      setHasMotion(!motion.current.isEmpty)
    } else {
      if (playingGesture) setPlayingGesture(false)
      motion.current.startRecording(performance.now())
      setRecordingGesture(true)
    }
  }
  const togglePlayGesture = () => {
    if (playingGesture) setPlayingGesture(false)
    else if (!motion.current.isEmpty) setPlayingGesture(true)
  }
  const clearMotion = () => {
    motion.current.clear()
    setPlayingGesture(false)
    setRecordingGesture(false)
    setHasMotion(false)
  }

  // gesture replay loop
  useEffect(() => {
    if (!playingGesture) return
    const rec = motion.current
    const dur = rec.length || 1
    const start = performance.now()
    let raf = 0
    const tick = () => {
      const elapsed = (performance.now() - start) % dur
      const p = rec.sampleAt(elapsed)
      if (p) mutate((draft) => { draft.xy.x = p.x; draft.xy.y = p.y })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playingGesture, mutate])

  const assignTargets = useMemo<AssignTarget[]>(() => {
    const out: AssignTarget[] = []
    patch.slots.forEach((slot, i) => {
      const spec = getSpec(slot.id)
      for (const ps of spec.params) {
        if (ps.options) continue
        out.push({ key: `${i}:${ps.key}`, label: `${spec.short} · ${ps.label}` })
      }
    })
    return out
  }, [patch.slots])

  // ---- Link ----
  useEffect(() => {
    const bridge = link.current
    const unsub = bridge.subscribe((s: LinkState) => {
      setLinkStatus((prev) => ({ ...prev, connected: s.connected, peers: s.peers }))
      if (s.connected) setPatch((p) => (p.tempo === s.tempo ? p : { ...p, tempo: s.tempo }))
    })
    return () => {
      unsub()
      bridge.disconnect()
    }
  }, [])

  const toggleLink = () => {
    if (linkStatus.following) {
      link.current.disconnect()
      setLinkStatus({ connected: false, peers: 0, following: false })
    } else {
      link.current.connect()
      setLinkStatus((prev) => ({ ...prev, following: true }))
    }
  }

  // ---- presets ----
  const refreshPresets = useCallback(async () => {
    try {
      store.current ??= new PresetStore()
      const list = await store.current.list()
      setPresetNames(list.map((p) => p.name).sort())
    } catch {
      // IndexedDB unavailable — presets simply stay empty.
    }
  }, [])
  useEffect(() => { void refreshPresets() }, [refreshPresets])

  const savePreset = async (name: string) => {
    try {
      store.current ??= new PresetStore()
      await store.current.save(serializePreset(name, patch, Date.now()))
      await refreshPresets()
    } catch { /* ignore */ }
  }
  const loadPreset = async (name: string) => {
    try {
      store.current ??= new PresetStore()
      const p = await store.current.load(name)
      if (p) setPatch(sanitizePatch(p.patch))
    } catch { /* ignore */ }
  }
  const deletePreset = async (name: string) => {
    try {
      store.current ??= new PresetStore()
      await store.current.delete(name)
      await refreshPresets()
    } catch { /* ignore */ }
  }

  // ---- share / export / import ----
  const share = async (): Promise<boolean> => {
    const url = `${location.origin}${location.pathname}#${encodePatchLink(patch)}`
    try {
      history.replaceState(null, '', url)
      await navigator.clipboard.writeText(url)
      return true
    } catch {
      return false
    }
  }
  const exportJson = () => {
    const blob = new Blob([JSON.stringify(serializePreset('mfx-pedalboard', patch, Date.now()), null, 2)], {
      type: 'application/json',
    })
    downloadBlob(blob, 'mfx-pedalboard.json')
  }
  const importJson = async (file: File) => {
    try {
      const preset = deserializePreset(JSON.parse(await file.text()))
      setPatch(sanitizePatch(preset.patch))
    } catch { /* ignore malformed */ }
  }

  // ---- A/B ----
  const captureA = () => setSnapA(clonePatch(patch))
  const captureB = () => setSnapB(clonePatch(patch))
  const onMorph = (t: number) => {
    setMorph(t)
    if (snapA && snapB) setPatch(morphPatch(snapA, snapB, t))
  }

  // ---- record ----
  const toggleRecord = async () => {
    const blob = await engine.toggleRecording()
    if (blob) downloadBlob(blob, `mfx-take-${Math.round(engine.engine.recordingSeconds)}.wav`)
  }

  if (!engine.running) {
    return <StartOverlay onStart={engine.start} error={engine.error} />
  }

  const modalSlot = modalIndex !== null ? patch.slots[modalIndex] : null

  return (
    <div className="deck">
      <header className="masthead">
        <span className="wordmark">m<b>fx</b></span>
        <span className="hook">Your instrument in. Ten pedals. Play the effects.</span>
        <span className="spacer" />
        <div className="masthead-controls">
          <Knob
            value={patch.inputGain / 3}
            onChange={(n) => setInputGain(n * 3)}
            label="Gain"
            display={`${patch.inputGain.toFixed(2)}×`}
            size={46}
            color="var(--signal)"
          />
          <Knob
            value={engine.masterVolume}
            onChange={engine.setMasterVolume}
            label="Volume"
            display={`${Math.round(engine.masterVolume * 100)}%`}
            size={46}
            color="var(--accent)"
          />
        </div>
      </header>

      <TransportBar
        engine={engine.engine}
        running={engine.running}
        input={engine.input}
        testTone={testTone}
        monitorMuted={engine.monitorMuted}
        mix={patch.mix}
        inputGain={patch.inputGain}
        tempo={patch.tempo}
        sync={patch.sync}
        link={linkStatus}
        recording={engine.recording}
        latencyMs={engine.latencyMs}
        sampleRate={engine.sampleRate}
        onSetInput={(k) => void engine.setInput(k)}
        onSetTestTone={(t) => { setTestTone(t); engine.setTestTone(t) }}
        onLoadFile={(f) => void engine.loadFile(f)}
        onToggleMonitor={() => engine.setMonitorMuted(!engine.monitorMuted)}
        onMix={setMix}
        onInputGain={setInputGain}
        onTempo={setTempo}
        onToggleSync={toggleSync}
        onToggleLink={toggleLink}
        onToggleRecord={() => void toggleRecord()}
      />

      <div className="console">
        <section aria-label="Effects rack">
          <div className="section-label">
            <h2>Rack</h2>
            <span className="rule" />
            <span className="eyebrow">drag to reorder</span>
          </div>
          <Rack
            slots={patch.slots}
            onToggle={toggleSlot}
            onAmount={setAmount}
            onOpen={setModalIndex}
            onReorder={reorder}
          />
        </section>

        <section className="perf" aria-label="Performance surface">
          <div className="section-label">
            <h2>Perform</h2>
            <span className="rule" />
          </div>
          <div className="perf-pad panel">
            <XYPad
              x={patch.xy.x}
              y={patch.xy.y}
              onMove={setXY}
              targets={assignTargets}
              xKey={refToKey(patch.xy.xTarget)}
              yKey={refToKey(patch.xy.yTarget)}
              onAssignX={(k) => mutate((p) => { p.xy.xTarget = keyToRef(k) })}
              onAssignY={(k) => mutate((p) => { p.xy.yTarget = keyToRef(k) })}
              recording={recordingGesture}
              playing={playingGesture}
              hasMotion={hasMotion}
              onToggleRecord={toggleRecordGesture}
              onTogglePlay={togglePlayGesture}
              onClearMotion={clearMotion}
            />
          </div>
          <MacroBank macros={patch.macros} onChange={setMacro} />
          <Snapshots
            hasA={snapA !== null}
            hasB={snapB !== null}
            morph={morph}
            onCaptureA={captureA}
            onCaptureB={captureB}
            onMorph={onMorph}
            presetNames={presetNames}
            onSavePreset={(n) => void savePreset(n)}
            onLoadPreset={(n) => void loadPreset(n)}
            onDeletePreset={(n) => void deletePreset(n)}
            onExport={exportJson}
            onImport={(f) => void importJson(f)}
            onShare={share}
          />
        </section>
      </div>

      {modalSlot && modalIndex !== null && (
        <EffectModal
          slot={modalSlot}
          spec={getSpec(modalSlot.id)}
          onParam={(key, raw) => setParam(modalIndex, key, raw)}
          onToggle={() => toggleSlot(modalIndex)}
          onClose={() => setModalIndex(null)}
        />
      )}
    </div>
  )
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

import { useCallback, useEffect, useState } from 'react'
import { AudioEngine, type InputKind } from '../audio/AudioEngine.ts'
import type { RackState } from '../audio/contracts.ts'
import type { TestTone } from '../audio/testSource.ts'
import type { SourceInfo } from '../transport/mbus/index.ts'

export interface EngineApi {
  engine: AudioEngine
  running: boolean
  input: InputKind
  monitorMuted: boolean
  masterVolume: number
  recording: boolean
  latencyMs: number
  sampleRate: number
  mbusSources: SourceInfo[]
  mbusSourceId: string | null
  error: string | null
  clearError: () => void
  /** A take the engine auto-finished at the recording duration cap, awaiting
   *  delivery by the UI. Null until the cap fires; cleared via consumeAutoTake. */
  autoTake: Blob | null
  consumeAutoTake: () => void
  start: () => Promise<void>
  setInput: (kind: InputKind) => Promise<void>
  setMbusSource: (sourceId: string) => void
  loadFile: (file: File) => Promise<void>
  setTestTone: (tone: TestTone) => void
  setMonitorMuted: (muted: boolean) => void
  setMasterVolume: (v: number) => void
  setRack: (state: RackState) => void
  toggleRecording: () => Promise<Blob | null>
}

export function useEngine(): EngineApi {
  // Lazy singleton held in state (not a ref) so it can be read during render.
  const [engine] = useState(() => new AudioEngine())

  const [running, setRunning] = useState(false)
  const [input, setInputState] = useState<InputKind>('test')
  const [monitorMuted, setMonitorMutedState] = useState(false)
  const [masterVolume, setMasterVolumeState] = useState(1)
  const [recording, setRecording] = useState(false)
  const [latencyMs, setLatencyMs] = useState(0)
  const [mbusSources, setMbusSources] = useState<SourceInfo[]>([])
  const [mbusSourceId, setMbusSourceIdState] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [autoTake, setAutoTake] = useState<Blob | null>(null)

  const sync = useCallback(() => {
    setInputState(engine.currentInput)
    setMonitorMutedState(engine.isMonitorMuted)
    setLatencyMs(engine.latencyMs)
  }, [engine])

  const start = useCallback(async () => {
    try {
      await engine.start()
      setRunning(engine.isRunning)
      sync()
    } catch (e) {
      setError(errorMessage(e))
    }
  }, [engine, sync])

  const setInput = useCallback(
    async (kind: InputKind) => {
      try {
        await engine.setInput(kind)
        sync()
      } catch (e) {
        setError(errorMessage(e))
      }
    },
    [engine, sync],
  )

  const setMbusSource = useCallback(
    (sourceId: string) => {
      engine.setMbusSource(sourceId)
      setMbusSourceIdState(sourceId)
    },
    [engine],
  )

  const loadFile = useCallback(
    async (file: File) => {
      try {
        await engine.loadFile(file)
        sync()
      } catch (e) {
        setError(errorMessage(e))
      }
    },
    [engine, sync],
  )

  const setTestTone = useCallback(
    (tone: TestTone) => {
      engine.setTestTone(tone)
    },
    [engine],
  )

  const setMonitorMuted = useCallback(
    (muted: boolean) => {
      engine.setMonitorMuted(muted)
      setMonitorMutedState(muted)
    },
    [engine],
  )

  const setMasterVolume = useCallback(
    (v: number) => {
      engine.setMasterVolume(v)
      setMasterVolumeState(engine.masterVolumeLevel)
    },
    [engine],
  )

  const setRack = useCallback(
    (state: RackState) => {
      engine.setRack(state)
    },
    [engine],
  )

  const toggleRecording = useCallback(async (): Promise<Blob | null> => {
    if (engine.isRecording) {
      const blob = await engine.stopRecording()
      setRecording(false)
      return blob
    }
    engine.startRecording()
    setRecording(true)
    return null
  }, [engine])

  // Track the mbus source directory (populated once the engine starts and the
  // bridge, if present, sends a snapshot). The default selection follows the
  // first available source until the user picks one.
  useEffect(() => {
    return engine.subscribeMbusSources((sources) => {
      setMbusSources(sources)
      setMbusSourceIdState(engine.mbusSelectedSourceId ?? sources[0]?.sourceId ?? null)
    })
  }, [engine])

  // The engine auto-stops recording at its duration cap and emits the finished
  // take here. Without this registration the take would be silently discarded
  // and the REC UI would stay lit. Mirror the state the manual stop path sets.
  useEffect(() => {
    return engine.subscribeRecordingLimit((blob) => {
      setRecording(false)
      setAutoTake(blob)
    })
  }, [engine])

  useEffect(() => {
    return () => {
      void engine.close()
    }
  }, [engine])

  return {
    engine,
    running,
    input,
    monitorMuted,
    masterVolume,
    recording,
    latencyMs,
    sampleRate: engine.sampleRate,
    mbusSources,
    mbusSourceId,
    error,
    clearError: () => setError(null),
    autoTake,
    consumeAutoTake: () => setAutoTake(null),
    start,
    setInput,
    setMbusSource,
    loadFile,
    setTestTone,
    setMonitorMuted,
    setMasterVolume,
    setRack,
    toggleRecording,
  }
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === 'NotAllowedError') return 'Permission denied. Allow access and try again.'
    if (e.name === 'NotFoundError') return 'No input device found.'
    return e.message
  }
  return 'Something went wrong.'
}

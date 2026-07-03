import { useCallback, useEffect, useState } from 'react'
import { AudioEngine, type InputKind } from '../audio/AudioEngine.ts'
import type { RackState } from '../audio/contracts.ts'
import type { TestTone } from '../audio/testSource.ts'

export interface EngineApi {
  engine: AudioEngine
  running: boolean
  input: InputKind
  monitorMuted: boolean
  recording: boolean
  latencyMs: number
  sampleRate: number
  error: string | null
  clearError: () => void
  start: () => Promise<void>
  setInput: (kind: InputKind) => Promise<void>
  loadFile: (file: File) => Promise<void>
  setTestTone: (tone: TestTone) => void
  setMonitorMuted: (muted: boolean) => void
  setRack: (state: RackState) => void
  toggleRecording: () => Promise<Blob | null>
}

export function useEngine(): EngineApi {
  // Lazy singleton held in state (not a ref) so it can be read during render.
  const [engine] = useState(() => new AudioEngine())

  const [running, setRunning] = useState(false)
  const [input, setInputState] = useState<InputKind>('test')
  const [monitorMuted, setMonitorMutedState] = useState(false)
  const [recording, setRecording] = useState(false)
  const [latencyMs, setLatencyMs] = useState(0)
  const [error, setError] = useState<string | null>(null)

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
    recording,
    latencyMs,
    sampleRate: engine.sampleRate,
    error,
    clearError: () => setError(null),
    start,
    setInput,
    loadFile,
    setTestTone,
    setMonitorMuted,
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

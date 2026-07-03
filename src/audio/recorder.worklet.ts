/**
 * recorder.worklet.ts — taps the post-limiter signal and streams raw stereo
 * frames to the main thread while armed. The main thread (wavRecorder.ts)
 * accumulates the chunks and encodes a WAV on stop. Kept off the render path:
 * its output is left unconnected, it only observes its input.
 */
declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor()
}
declare function registerProcessor(
  name: string,
  ctor: typeof AudioWorkletProcessor,
): void

interface StartMsg {
  type: 'start'
}
interface StopMsg {
  type: 'stop'
}
type RecorderInMessage = StartMsg | StopMsg

class RecorderProcessor extends AudioWorkletProcessor {
  private active = false

  constructor() {
    super()
    this.port.onmessage = (event: MessageEvent<RecorderInMessage>) => {
      if (event.data.type === 'start') this.active = true
      else if (event.data.type === 'stop') this.active = false
    }
  }

  process(inputs: Float32Array[][]): boolean {
    if (!this.active) return true
    const input = inputs[0]
    if (!input || input.length === 0) return true
    const left = input[0]
    const right = input[1] ?? input[0]
    if (!left || left.length === 0) return true
    // Copy (the render buffers are reused) and transfer to the main thread.
    const l = new Float32Array(left)
    const r = new Float32Array(right)
    this.port.postMessage({ type: 'chunk', left: l, right: r }, [l.buffer, r.buffer])
    return true
  }
}

registerProcessor(
  'mfx-recorder',
  RecorderProcessor as unknown as typeof AudioWorkletProcessor,
)

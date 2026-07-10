/**
 * recorder.worklet.ts — taps the post-limiter signal and streams raw stereo
 * frames to the main thread while armed. The main thread (AudioEngine) encodes
 * each batch to PCM on arrival and never retains the raw Float32 take. It only
 * observes its input; its output is silent and routed through a zero-gain sink
 * to the destination so the pull-based renderer actually calls process().
 *
 * Frames are batched into a reused buffer and posted ~once per BATCH_FRAMES
 * (~170 ms) rather than allocating and transferring two arrays every 128-frame
 * render quantum. That keeps the audio thread from doing ~375 allocations and
 * cross-thread messages per second, which is what glitches long recordings.
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

// ~170 ms at 48 kHz (64 render quanta). Big enough to slash message rate, small
// enough that the auto-stop cap and stop-flush tail stay tight.
const BATCH_FRAMES = 8192

class RecorderProcessor extends AudioWorkletProcessor {
  private active = false
  // Reused across quanta: filled up to `fill`, then a right-sized copy is
  // transferred out and `fill` resets — no per-quantum allocation.
  private readonly batchL = new Float32Array(BATCH_FRAMES)
  private readonly batchR = new Float32Array(BATCH_FRAMES)
  private fill = 0

  constructor() {
    super()
    this.port.onmessage = (event: MessageEvent<RecorderInMessage>) => {
      if (event.data.type === 'start') {
        this.active = true
      } else if (event.data.type === 'stop') {
        this.flush() // emit the partial batch so the tail isn't dropped
        this.active = false
        // Explicit finalize ack: the main thread awaits this to know every
        // pending frame has been posted, so it never has to guess a flush
        // window. Posted after flush(); not on the process()/flush() hot path.
        this.port.postMessage({ type: 'flushed' })
      }
    }
  }

  /** Transfer the accumulated frames to the main thread and reset the batch. */
  private flush(): void {
    if (this.fill === 0) return
    // slice() yields a right-sized copy with its own buffer, so the batch
    // buffers stay usable after we transfer these out.
    const l = this.batchL.slice(0, this.fill)
    const r = this.batchR.slice(0, this.fill)
    this.port.postMessage({ type: 'chunk', left: l, right: r }, [l.buffer, r.buffer])
    this.fill = 0
  }

  process(inputs: Float32Array[][]): boolean {
    if (!this.active) return true
    const input = inputs[0]
    if (!input || input.length === 0) return true
    const left = input[0]
    const right = input[1] ?? input[0]
    if (!left || left.length === 0) return true

    // Copy the quantum into the batch, splitting across a flush boundary if the
    // batch fills mid-quantum (quanta are 128 frames, but don't assume it).
    let srcOff = 0
    const n = left.length
    while (srcOff < n) {
      const take = Math.min(BATCH_FRAMES - this.fill, n - srcOff)
      this.batchL.set(left.subarray(srcOff, srcOff + take), this.fill)
      this.batchR.set(right.subarray(srcOff, srcOff + take), this.fill)
      this.fill += take
      srcOff += take
      if (this.fill === BATCH_FRAMES) this.flush()
    }
    return true
  }
}

registerProcessor(
  'mfx-recorder',
  RecorderProcessor as unknown as typeof AudioWorkletProcessor,
)

/**
 * motion.ts — one-lane gesture record/replay for the XY pad.
 *
 * Records timestamped (x, y) points while the performer moves on the pad, then
 * loops them back. Timestamps are passed in by the caller (performance.now in
 * the UI) so this stays pure and unit-testable. Values are normalized 0..1.
 */
import { clamp } from '../audio/contracts.ts'

export interface MotionPoint {
  t: number // ms from the start of the recording
  x: number
  y: number
}

export interface MotionData {
  points: MotionPoint[]
  duration: number
}

export class MotionRecorder {
  private points: MotionPoint[] = []
  private recording = false
  private startTime = 0
  private duration = 0

  get isRecording(): boolean {
    return this.recording
  }

  get isEmpty(): boolean {
    return this.points.length === 0
  }

  get length(): number {
    return this.duration
  }

  startRecording(now: number): void {
    this.recording = true
    this.startTime = now
    this.points = []
    this.duration = 0
  }

  record(now: number, x: number, y: number): void {
    if (!this.recording) return
    this.points.push({
      t: Math.max(0, now - this.startTime),
      x: clamp(x, 0, 1),
      y: clamp(y, 0, 1),
    })
  }

  stopRecording(now: number): void {
    if (!this.recording) return
    this.recording = false
    this.duration = Math.max(0, now - this.startTime)
  }

  clear(): void {
    this.points = []
    this.duration = 0
    this.recording = false
  }

  /**
   * Interpolated point at `elapsed` ms into the loop. Caller is responsible for
   * wrapping elapsed into [0, duration) for looping. Returns null when empty.
   */
  sampleAt(elapsed: number): MotionPoint | null {
    const n = this.points.length
    if (n === 0) return null
    if (n === 1) return this.points[0]
    const e = clamp(elapsed, 0, this.duration)
    // Clamp to the first point: before t0 there is nothing to interpolate from,
    // and lerping would extrapolate to negative fractions.
    if (e <= this.points[0].t) return this.points[0]
    // linear scan is fine for one lane at ~60fps replay
    let lo = this.points[0]
    for (let i = 1; i < n; i++) {
      const hi = this.points[i]
      if (e <= hi.t) {
        const span = hi.t - lo.t
        const f = span > 0 ? (e - lo.t) / span : 0
        return { t: e, x: lo.x + (hi.x - lo.x) * f, y: lo.y + (hi.y - lo.y) * f }
      }
      lo = hi
    }
    return this.points[n - 1]
  }

  toData(): MotionData {
    return { points: this.points.slice(), duration: this.duration }
  }

  static fromData(raw: unknown): MotionRecorder {
    const rec = new MotionRecorder()
    const data = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const list = Array.isArray(data.points) ? data.points : []
    rec.points = list
      .map((p) => {
        const o = p && typeof p === 'object' ? (p as Record<string, unknown>) : {}
        return {
          t: clamp(typeof o.t === 'number' ? o.t : 0, 0, 1e7),
          x: clamp(typeof o.x === 'number' ? o.x : 0.5, 0, 1),
          y: clamp(typeof o.y === 'number' ? o.y : 0.5, 0, 1),
        }
      })
      .filter((p): p is MotionPoint => Number.isFinite(p.t))
      .sort((a, b) => a.t - b.t)
    rec.duration = clamp(typeof data.duration === 'number' ? data.duration : 0, 0, 1e7)
    return rec
  }
}

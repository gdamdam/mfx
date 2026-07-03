import { describe, it, expect } from 'vitest'
import { MotionRecorder } from './motion.ts'

describe('MotionRecorder', () => {
  it('starts empty', () => {
    const m = new MotionRecorder()
    expect(m.isEmpty).toBe(true)
    expect(m.sampleAt(0)).toBeNull()
  })

  it('records timestamped points relative to start', () => {
    const m = new MotionRecorder()
    m.startRecording(1000)
    m.record(1000, 0, 0)
    m.record(1500, 0.5, 0.5)
    m.record(2000, 1, 1)
    m.stopRecording(2000)
    expect(m.isEmpty).toBe(false)
    expect(m.length).toBe(1000)
  })

  it('interpolates between points', () => {
    const m = new MotionRecorder()
    m.startRecording(0)
    m.record(0, 0, 0)
    m.record(1000, 1, 1)
    m.stopRecording(1000)
    const mid = m.sampleAt(500)!
    expect(mid.x).toBeCloseTo(0.5, 3)
    expect(mid.y).toBeCloseTo(0.5, 3)
  })

  it('clamps recorded values to 0..1', () => {
    const m = new MotionRecorder()
    m.startRecording(0)
    m.record(0, -3, 5)
    m.stopRecording(10)
    const p = m.sampleAt(0)!
    expect(p.x).toBe(0)
    expect(p.y).toBe(1)
  })

  it('ignores record() when not recording', () => {
    const m = new MotionRecorder()
    m.record(0, 0.5, 0.5)
    expect(m.isEmpty).toBe(true)
  })

  it('round-trips through toData/fromData and survives garbage', () => {
    const m = new MotionRecorder()
    m.startRecording(0)
    m.record(0, 0.2, 0.8)
    m.record(500, 0.6, 0.4)
    m.stopRecording(500)
    const restored = MotionRecorder.fromData(m.toData())
    expect(restored.length).toBe(500)
    expect(restored.sampleAt(0)!.x).toBeCloseTo(0.2, 3)

    const junk = MotionRecorder.fromData({ points: 'nope', duration: NaN })
    expect(junk.isEmpty).toBe(true)
    expect(junk.length).toBe(0)
  })
})

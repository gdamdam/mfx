/**
 * rack.worklet.test.ts — sample-level tests for the chain runner, focused on
 * the hard-bypass/reset semantics (issue 4): a slot that fully fades out must
 * reset its core exactly once so re-enabling never replays stale ring-buffer /
 * reverb-tail / LFO material, while the dry path stays continuous and toggling
 * never clicks.
 *
 * The AudioWorklet globals (sampleRate, AudioWorkletProcessor base, and
 * registerProcessor) don't exist under vitest/node, so we stub them BEFORE
 * importing the module and capture the ctor the module hands to
 * registerProcessor.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import type { EffectId, RackState } from './contracts.ts'

const SR = 48000
const BLK = 128

class FakePort {
  onmessage: ((e: { data: unknown }) => void) | null = null
  readonly posted: unknown[] = []
  postMessage(msg: unknown): void {
    this.posted.push(msg)
  }
}

class FakeAudioWorkletProcessor {
  readonly port = new FakePort()
}

interface RackProc {
  port: FakePort
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let RackCtor: new () => RackProc

beforeAll(async () => {
  const g = globalThis as unknown as Record<string, unknown>
  g.sampleRate = SR
  g.AudioWorkletProcessor = FakeAudioWorkletProcessor
  g.registerProcessor = (_name: string, ctor: new () => RackProc) => {
    RackCtor = ctor
  }
  await import('./rack.worklet.ts')
})

const delayParams = {
  time: 0.05,
  feedback: 0.6,
  mix: 1,
  sync: 0,
  division: 1,
  mode: 0,
  tone: 0.5,
  duck: 0,
  mod: 0,
}

function makeState(id: EffectId, params: Record<string, number>): RackState {
  return {
    slots: [{ id, enabled: true, params }],
    inputGain: 1,
    mix: 1,
    tempo: 120,
    sync: false,
  }
}

function newProc(state: RackState): { proc: RackProc; state: RackState } {
  const proc = new RackCtor()
  proc.port.onmessage?.({ data: { type: 'rack', state } })
  return { proc, state }
}

/** Run `nBlocks` blocks; `inputFn(globalIndex)` supplies each mono sample. */
function run(
  proc: RackProc,
  nBlocks: number,
  inputFn: (i: number) => number,
): Float64Array {
  const inL = new Float32Array(BLK)
  const inR = new Float32Array(BLK)
  const outL = new Float32Array(BLK)
  const outR = new Float32Array(BLK)
  const inputs: Float32Array[][] = [[inL, inR]]
  const outputs: Float32Array[][] = [[outL, outR]]
  const out = new Float64Array(nBlocks * BLK)
  let g = 0
  for (let b = 0; b < nBlocks; b++) {
    for (let i = 0; i < BLK; i++) {
      const s = inputFn(g++)
      inL[i] = s
      inR[i] = s
    }
    proc.process(inputs, outputs)
    for (let i = 0; i < BLK; i++) out[b * BLK + i] = outL[i]
  }
  return out
}

function peak(buf: Float64Array): number {
  let m = 0
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i])
    if (a > m) m = a
  }
  return m
}

function maxStep(buf: Float64Array, from = 1): number {
  let m = 0
  for (let i = Math.max(1, from); i < buf.length; i++) {
    const d = Math.abs(buf[i] - buf[i - 1])
    if (d > m) m = d
  }
  return m
}

function allFinite(buf: Float64Array): boolean {
  for (let i = 0; i < buf.length; i++) if (!Number.isFinite(buf[i])) return false
  return true
}

function rms(buf: Float64Array, from = 0): number {
  let sum = 0
  for (let i = from; i < buf.length; i++) sum += buf[i] * buf[i]
  return Math.sqrt(sum / (buf.length - from))
}

const sine = (i: number, hz = 220, amp = 0.5) =>
  amp * Math.sin((2 * Math.PI * hz * i) / SR)

describe('RackProcessor hard-bypass/reset (issue 4)', () => {
  it('long bypass then re-enable does NOT replay stale delayed material', () => {
    const { proc, state } = newProc(makeState('delay', delayParams))

    // Phase A: enabled, feed a distinctive burst long enough to fill the delay
    // ring and produce audible echoes.
    const active = run(proc, 100, (i) => sine(i))
    expect(allFinite(active)).toBe(true)
    // The wet echoes are clearly present.
    expect(peak(active.subarray(60 * BLK))).toBeGreaterThan(0.05)

    // Phase B: disable and feed silence long enough for the 8 ms fade to reach
    // zero and the one-shot reset() to fire (well over ~28 blocks).
    state.slots[0].enabled = false
    const fading = run(proc, 100, () => 0)
    expect(allFinite(fading)).toBe(true)
    // Tail decays toward silence (no re-injection while bypassed).
    expect(peak(fading.subarray(80 * BLK))).toBeLessThan(1e-3)

    // Phase C: re-enable with SILENCE. A clean (reset) core must emit silence;
    // if the ring still held the old burst it would echo here.
    state.slots[0].enabled = true
    const revived = run(proc, 60, () => 0)
    expect(allFinite(revived)).toBe(true)
    expect(peak(revived)).toBeLessThan(1e-4)
  })

  it('re-enable carries no stale energy (tail RMS matches a fresh start)', () => {
    // Feedback-free echo so the steady tail energy is fully determined by the
    // input (a feedback delay's resonance is legitimately sensitive to the
    // reset-snapped param smoothers). NB: Delay.reset() does not restore the
    // exact construction phase, so we compare ENERGY, not sample values — which
    // is precisely the invariant issue 4 needs: no stale echo inflates the
    // revived output.
    const echo = { ...delayParams, feedback: 0 }
    // Reference: a from-scratch processor fed a quiet 330 Hz tone.
    const ref = newProc(makeState('delay', echo))
    const refOut = run(ref.proc, 130, (i) => sine(i, 330, 0.3))
    const refRms = rms(refOut, 8192)

    // Warm the core with a LOUD 220 Hz burst, bypass long enough to reset, then
    // re-enable with the quiet reference tone. Without the reset, the loud
    // warm-up would still be echoing and inflate the tail energy.
    const { proc, state } = newProc(makeState('delay', echo))
    run(proc, 60, (i) => sine(i, 220, 0.9))
    state.slots[0].enabled = false
    run(proc, 100, () => 0)
    state.slots[0].enabled = true
    const revived = run(proc, 130, (i) => sine(i, 330, 0.3))

    expect(allFinite(revived)).toBe(true)
    const revRms = rms(revived, 8192)
    // Energy matches the fresh start within a few percent — no stale carry-over.
    expect(Math.abs(revRms - refRms)).toBeLessThan(refRms * 0.05)
  })

  it('dry path stays continuous across a bypass toggle (no added click)', () => {
    // Phase-fair reference: a fresh core fed the SAME phase the re-enabled slot
    // will see (blocks 100+ => sample offset 100*BLK). Its maxStep is the
    // delay's OWN inherent onset transient at that phase, which the re-enabled
    // fresh core legitimately reproduces.
    const ref = newProc(makeState('delay', delayParams))
    const refOut = run(ref.proc, 40, (i) => sine(i + 100 * BLK))
    const refStep = maxStep(refOut, 0)

    // Toggled: bypass in the middle, continuous input phase throughout.
    const { proc, state } = newProc(makeState('delay', delayParams))
    const inL = new Float32Array(BLK)
    const inR = new Float32Array(BLK)
    const outL = new Float32Array(BLK)
    const outR = new Float32Array(BLK)
    const inputs: Float32Array[][] = [[inL, inR]]
    const outputs: Float32Array[][] = [[outL, outR]]
    const all = new Float64Array(140 * BLK)
    const dry = new Float64Array(140 * BLK)
    let g = 0
    for (let b = 0; b < 140; b++) {
      state.slots[0].enabled = b < 40 || b >= 100 // off for blocks 40..99
      for (let i = 0; i < BLK; i++) {
        const s = sine(g)
        inL[i] = s
        inR[i] = s
        dry[g] = s
        g++
      }
      proc.process(inputs, outputs)
      for (let i = 0; i < BLK; i++) all[b * BLK + i] = outL[i]
    }

    expect(allFinite(all)).toBe(true)
    expect(peak(all)).toBeLessThan(3)
    // Toggling adds no discontinuity beyond the effect's own onset transient at
    // the same phase (small tolerance for the reset-snapped smoother warm-up).
    expect(maxStep(all, 0)).toBeLessThanOrEqual(refStep * 1.3 + 0.02)
    // Deep inside the bypass window the dry signal passes through untouched.
    for (let i = 80 * BLK; i < 95 * BLK; i++) {
      expect(Math.abs(all[i] - dry[i])).toBeLessThan(1e-6)
    }
  })

  it('rapid bypass automation stays finite and click-bounded', () => {
    const { proc, state } = newProc(makeState('delay', delayParams))
    const inL = new Float32Array(BLK)
    const inR = new Float32Array(BLK)
    const outL = new Float32Array(BLK)
    const outR = new Float32Array(BLK)
    const inputs: Float32Array[][] = [[inL, inR]]
    const outputs: Float32Array[][] = [[outL, outR]]
    const all = new Float64Array(240 * BLK)
    let g = 0
    for (let b = 0; b < 240; b++) {
      // Toggle every 3 blocks — much faster than the 8 ms fade.
      state.slots[0].enabled = Math.floor(b / 3) % 2 === 0
      for (let i = 0; i < BLK; i++) {
        const s = sine(g++)
        inL[i] = s
        inR[i] = s
      }
      proc.process(inputs, outputs)
      for (let i = 0; i < BLK; i++) all[b * BLK + i] = outL[i]
    }
    expect(allFinite(all)).toBe(true)
    expect(peak(all)).toBeLessThan(3)
    expect(maxStep(all)).toBeLessThan(0.5)
  })

  it('no patch yet -> passes silence', () => {
    const proc = new RackCtor()
    const out = run(proc, 4, (i) => sine(i))
    expect(peak(out)).toBe(0)
  })
})

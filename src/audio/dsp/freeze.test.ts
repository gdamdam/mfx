import { describe, it, expect } from 'vitest'
import { Freeze } from './freeze.ts'
import { Rng } from './util.ts'

const SR = 48000

/** Grain loop length in samples for a given Size (mirrors Freeze.targetLen). */
function loopLen(size: number): number {
  return Math.floor((0.05 + 0.35 * size) * SR)
}

/** Record decorrelated noise then engage hold, so the frozen pad reads
 * independent samples half a loop apart — the case where the constant-power
 * window's gA^2+gB^2==1 governs loudness (correlated content like a sine does
 * not isolate the invariant). Deterministic via a seeded RNG. */
function engageNoise(fz: Freeze, size: number, morph: number, width: number): void {
  const rng = new Rng(0xc0ffee)
  fz.setParams({ hold: 0, size, mix: 1, morph, width })
  for (let i = 0; i < 24000; i++) {
    const x = rng.bipolar()
    fz.process(x, x)
  }
  fz.setParams({ hold: 1, size, mix: 1, morph, width })
  fz.process(0, 0)
}

describe('Freeze', () => {
  it('passes dry through when hold is off', () => {
    const fz = new Freeze(SR)
    fz.setParams({ hold: 0, size: 0.5, mix: 1 })
    for (let i = 0; i < 4000; i++) {
      const x = Math.sin((2 * Math.PI * 220 * i) / SR)
      const [l, r] = fz.process(x, 0)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
      expect(Math.abs(l - x)).toBeLessThan(1e-9)
    }
  })

  it('keeps producing signal after input goes silent when frozen', () => {
    const fz = new Freeze(SR)
    fz.setParams({ hold: 0, size: 0.5, mix: 1 })
    // Record enough sine to fill the grain window (~225ms at size 0.5).
    for (let i = 0; i < 12000; i++) {
      fz.process(Math.sin((2 * Math.PI * 220 * i) / SR), 0)
    }
    // Engage hold: the transition captures the grain.
    fz.setParams({ hold: 1, size: 0.5, mix: 1 })
    fz.process(Math.sin((2 * Math.PI * 220 * 12000) / SR), 0)

    // Input now silent — the frozen pad should keep looping.
    let energy = 0
    let max = 0
    for (let i = 0; i < 8000; i++) {
      const [l, r] = fz.process(0, 0)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
      energy += Math.abs(l)
      max = Math.max(max, Math.abs(l))
    }
    expect(energy).toBeGreaterThan(1) // clearly not silent
    expect(max).toBeLessThan(2) // bounded
  })

  it('produces finite, bounded output while frozen with live input', () => {
    const fz = new Freeze(SR)
    fz.setParams({ hold: 0, size: 0.5, mix: 0.6 })
    for (let i = 0; i < 12000; i++) {
      fz.process(Math.sin((2 * Math.PI * 220 * i) / SR), 0)
    }
    fz.setParams({ hold: 1, size: 0.5, mix: 0.6 })
    let max = 0
    for (let i = 12000; i < 16000; i++) {
      const [l, r] = fz.process(Math.sin((2 * Math.PI * 220 * i) / SR), 0)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
      max = Math.max(max, Math.abs(l))
    }
    expect(max).toBeLessThan(2)
  })

  it('does not click on engage — first frozen sample stays dry (M3)', () => {
    const fz = new Freeze(SR)
    fz.setParams({ hold: 0, size: 0.5, mix: 1 })
    for (let i = 0; i < 12000; i++) fz.process(Math.sin((2 * Math.PI * 220 * i) / SR), 0)
    fz.setParams({ hold: 1, size: 0.5, mix: 1 })
    const x = Math.sin((2 * Math.PI * 220 * 12000) / SR)
    const [l] = fz.process(x, 0)
    // env starts at 0: output must equal the dry sample, not jump to grain[0].
    expect(Math.abs(l - x)).toBeLessThan(0.02)
  })

  it('does not click on release — output ramps back to dry (M3)', () => {
    const fz = new Freeze(SR)
    fz.setParams({ hold: 0, size: 0.5, mix: 1 })
    for (let i = 0; i < 12000; i++) fz.process(Math.sin((2 * Math.PI * 220 * i) / SR), 0)
    fz.setParams({ hold: 1, size: 0.5, mix: 1 })
    // Settle env to 1 with input now silent so dry=0 and only the pad plays.
    for (let i = 0; i < 4000; i++) fz.process(0, 0)
    fz.setParams({ hold: 0, size: 0.5, mix: 1 })
    let prev = fz.process(0, 0)[0]
    let maxDelta = 0
    for (let i = 0; i < 4000; i++) {
      const [l] = fz.process(0, 0)
      maxDelta = Math.max(maxDelta, Math.abs(l - prev))
      prev = l
    }
    // A hard release would step from a mid-waveform pad value (~1) to dry (0).
    expect(maxDelta).toBeLessThan(0.1)
  })

  it('guards non-finite params and input, staying finite', () => {
    const fz = new Freeze(SR)
    fz.setParams({ hold: NaN, size: NaN, mix: NaN })
    for (let i = 0; i < 1000; i++) {
      const [l, r] = fz.process(i === 0 ? NaN : Math.sin(i), Infinity)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
    }
  })

  /** Feed a 220Hz mono sine for `n` samples, then engage hold. */
  function engage(fz: Freeze, size: number, morph: number, width: number, n = 24000): void {
    fz.setParams({ hold: 0, size, mix: 1, morph, width })
    for (let i = 0; i < n; i++) {
      const x = Math.sin((2 * Math.PI * 220 * i) / SR)
      fz.process(x, x)
    }
    fz.setParams({ hold: 1, size, mix: 1, morph, width })
    fz.process(0, 0)
  }

  it('infinite hold is stable: RMS constant over 5 seconds of silence', () => {
    const fz = new Freeze(SR)
    engage(fz, 0.5, 0.5, 0.3)
    // size 0.5 => 0.225s grain => 10800-sample loop; measure over whole periods.
    const loop = Math.floor((0.05 + 0.35 * 0.5) * SR)
    const win = 4 * loop
    let n = 0
    const rmsOver = (skip: number, len: number): number => {
      for (let i = 0; i < skip; i++) {
        fz.process(0, 0)
        n++
      }
      let sum = 0
      for (let i = 0; i < len; i++) {
        const [l] = fz.process(0, 0)
        expect(Number.isFinite(l)).toBe(true)
        sum += l * l
        n++
      }
      return Math.sqrt(sum / len)
    }
    const early = rmsOver(SR, win) // after 1s of hold
    const late = rmsOver(3 * SR - win, win) // around the 4-5s mark
    expect(n).toBeGreaterThan(4 * SR)
    expect(early).toBeGreaterThan(0.05) // clearly not silent
    expect(Math.abs(late / early - 1)).toBeLessThan(0.01) // no decay/growth/drift
  })

  it('held loop of a sine has no clicks at loop points', () => {
    for (const morph of [0, 0.5, 1]) {
      const fz = new Freeze(SR)
      engage(fz, 0.3, morph, 0.3)
      for (let i = 0; i < 2000; i++) fz.process(0, 0) // let the engage ramp settle
      let [prev] = fz.process(0, 0)
      let maxDelta = 0
      for (let i = 0; i < 40000; i++) {
        const [l] = fz.process(0, 0)
        maxDelta = Math.max(maxDelta, Math.abs(l - prev))
        prev = l
      }
      expect(maxDelta).toBeLessThan(0.2)
    }
  })

  it('width 0 stays mono, width 1 decorrelates the channels', () => {
    const diffSum = (width: number): number => {
      const fz = new Freeze(SR)
      engage(fz, 0.5, 0.5, width)
      for (let i = 0; i < 2000; i++) fz.process(0, 0)
      let sum = 0
      for (let i = 0; i < 8000; i++) {
        const [l, r] = fz.process(0, 0)
        sum += Math.abs(l - r)
      }
      return sum
    }
    expect(diffSum(0)).toBeLessThan(1e-6)
    expect(diffSum(1)).toBeGreaterThan(50)
  })

  it('changing size and morph while holding does not click', () => {
    const fz = new Freeze(SR)
    engage(fz, 0.5, 0.5, 0.3)
    for (let i = 0; i < 2000; i++) fz.process(0, 0)
    fz.setParams({ hold: 1, size: 0.9, mix: 1, morph: 0.1, width: 0.3 })
    let [prev] = fz.process(0, 0)
    let maxDelta = 0
    for (let i = 0; i < 60000; i++) {
      const [l] = fz.process(0, 0)
      expect(Number.isFinite(l)).toBe(true)
      maxDelta = Math.max(maxDelta, Math.abs(l - prev))
      prev = l
    }
    expect(maxDelta).toBeLessThan(0.25)
  })

  it('is deterministic across fresh instances', () => {
    const mk = (): Freeze => {
      const f = new Freeze(SR)
      engage(f, 0.4, 0.7, 0.8, 20000)
      return f
    }
    const a = mk()
    const b = mk()
    for (let i = 0; i < 5000; i++) {
      const x = i < 2500 ? Math.sin((2 * Math.PI * 110 * i) / SR) : 0
      const [al, ar] = a.process(x, -x)
      const [bl, br] = b.process(x, -x)
      expect(al).toBe(bl)
      expect(ar).toBe(br)
    }
  })

  it('steady-state pad power is flat across windows at each fixed morph', () => {
    // Constant-power sanity: on decorrelated (noise) content the two heads sum
    // to gA^2+gB^2==1, so the looped pad's short-window RMS must be steady at
    // ANY fixed morph — no per-loop loudness ripple.
    for (const morph of [0, 0.25, 0.5, 0.75, 1]) {
      const fz = new Freeze(SR)
      engageNoise(fz, 0.5, morph, 0) // width 0 keeps it mono for a clean measure
      for (let i = 0; i < 6000; i++) fz.process(0, 0) // settle engage env
      const loop = loopLen(0.5)
      const wins: number[] = []
      for (let w = 0; w < 6; w++) {
        let s = 0
        for (let i = 0; i < loop; i++) {
          const [l] = fz.process(0, 0)
          expect(Number.isFinite(l)).toBe(true)
          s += l * l
        }
        wins.push(Math.sqrt(s / loop))
      }
      const mn = Math.min(...wins)
      const mx = Math.max(...wins)
      expect(mn).toBeGreaterThan(0.05) // clearly not silent
      expect((mx - mn) / mn).toBeLessThan(0.1) // flat at fixed morph
    }
  })

  it('automating morph does not shift pad loudness vs the static morph value', () => {
    // The bug: head A latches its fade at phase>=1 while head B latches at
    // phase>=0.5, so while Morph is AUTOMATED the pair briefly holds different
    // f and gA^2+gB^2 drifts off 1 -> a loudness bump. Cleanest discriminator:
    // on decorrelated (noise) content the looped pad's long-window RMS equals
    // the noise variance IFF gA^2+gB^2==1. So RMS measured while *ramping
    // through* a morph value must equal RMS measured *statically* at that value.
    // Pre-fix this deviates ~2.7-4.4% under a fast ramp; the fix holds it <0.1%.
    const loop = loopLen(0.5)
    const measLen = 4 * loop // whole loops kill interp/statistical ripple

    // Static reference RMS at morph 0.5.
    const staticRms = (): number => {
      const fz = new Freeze(SR)
      engageNoise(fz, 0.5, 0.5, 0)
      for (let i = 0; i < 6000; i++) fz.process(0, 0)
      let s = 0
      for (let i = 0; i < measLen; i++) {
        const [l] = fz.process(0, 0)
        s += l * l
      }
      return Math.sqrt(s / measLen)
    }

    // RMS while ramping through 0.5. dir=+1 sweeps up, dir=-1 sweeps down, so we
    // exercise Morph automation in both directions (and its reversal).
    const rampRms = (dir: number): number => {
      const fz = new Freeze(SR)
      engageNoise(fz, 0.5, dir > 0 ? 0 : 1, 0)
      for (let i = 0; i < 6000; i++) fz.process(0, 0)
      const rampLoops = 3 // fast ramp: maximizes the pre-fix head divergence
      const total = rampLoops * loop
      const startAt = Math.floor(total * 0.5) - measLen / 2
      let sample = 0
      const morphAt = (): number => {
        const t = Math.min(1, sample / total)
        return dir > 0 ? t : 1 - t
      }
      for (let i = 0; i < startAt; i++) {
        fz.setParams({ hold: 1, size: 0.5, mix: 1, morph: morphAt(), width: 0 })
        fz.process(0, 0)
        sample++
      }
      let s = 0
      let maxAbs = 0
      for (let i = 0; i < measLen; i++) {
        fz.setParams({ hold: 1, size: 0.5, mix: 1, morph: morphAt(), width: 0 })
        const [l] = fz.process(0, 0)
        expect(Number.isFinite(l)).toBe(true)
        maxAbs = Math.max(maxAbs, Math.abs(l))
        s += l * l
        sample++
      }
      expect(maxAbs).toBeLessThan(2)
      return Math.sqrt(s / measLen)
    }

    const ref = staticRms()
    expect(ref).toBeGreaterThan(0.05) // clearly not silent
    // Documented tolerance: automation must not shift loudness by >1% (fix
    // achieves <0.1%; the pre-fix divergence bump is well above this).
    expect(Math.abs(rampRms(1) / ref - 1)).toBeLessThan(0.01)
    expect(Math.abs(rampRms(-1) / ref - 1)).toBeLessThan(0.01)
  })

  it('sweeping morph on a tonal grain has no sample-to-sample click', () => {
    // Smooth (sine) grain isolates the seam-discontinuity metric: a broken
    // constant-power pair (or a latch at non-zero gain) would step the output.
    const fz = new Freeze(SR)
    engage(fz, 0.5, 0, 0.3) // reuse the sine engage helper
    for (let i = 0; i < 4000; i++) fz.process(0, 0)
    const total = 120000
    let prev = fz.process(0, 0)[0]
    let maxDelta = 0
    for (let i = 0; i < total; i++) {
      const t = i / total
      const m = t < 0.5 ? t * 2 : 2 - 2 * t // sweep up then reverse down
      fz.setParams({ hold: 1, size: 0.5, mix: 1, morph: m, width: 0.3 })
      const [l] = fz.process(0, 0)
      expect(Number.isFinite(l)).toBe(true)
      maxDelta = Math.max(maxDelta, Math.abs(l - prev))
      prev = l
    }
    expect(maxDelta).toBeLessThan(0.05) // no click during Morph automation
  })

  it('rapid random morph changes while frozen stay finite and bounded', () => {
    const fz = new Freeze(SR)
    engageNoise(fz, 0.3, 0.5, 0.5) // width on too, to exercise the right heads
    for (let i = 0; i < 4000; i++) fz.process(0, 0)
    const rng = new Rng(0xbeef)
    for (let i = 0; i < 60000; i++) {
      if (i % 53 === 0) {
        fz.setParams({ hold: 1, size: 0.3, mix: 1, morph: rng.next(), width: 0.5 })
      }
      const [l, r] = fz.process(0, 0)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
      expect(Math.abs(l)).toBeLessThan(2)
      expect(Math.abs(r)).toBeLessThan(2)
    }
  })

  it('stays finite with NaN/Infinity in new params', () => {
    const fz = new Freeze(SR)
    fz.setParams({ hold: 1, size: NaN, mix: Infinity, morph: NaN, width: Infinity })
    for (let i = 0; i < 2000; i++) {
      const [l, r] = fz.process(i === 0 ? NaN : Math.sin(i * 0.1), Infinity)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
    }
  })
})

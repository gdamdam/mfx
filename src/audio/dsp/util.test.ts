import { describe, it, expect } from 'vitest'
import {
  AllpassDiffuser,
  DcBlocker,
  OnePoleLP,
  OnePoleHP,
  PitchShifter,
  Smoother,
  fastTanh,
  semitoneRatio,
} from './util.ts'
import { Fft, hannWindow } from './fft.ts'

const SR = 48000

describe('fastTanh', () => {
  it('tracks Math.tanh within 0.025, stays bounded and monotonic', () => {
    let prev = -1
    for (let x = -3; x <= 3; x += 0.05) {
      const y = fastTanh(x)
      expect(Math.abs(y - Math.tanh(x))).toBeLessThan(0.025)
      expect(Math.abs(y)).toBeLessThanOrEqual(1)
      expect(y).toBeGreaterThanOrEqual(prev)
      prev = y
    }
    expect(fastTanh(100)).toBe(1)
    expect(fastTanh(-100)).toBe(-1)
    expect(fastTanh(NaN)).toBe(0)
  })
})

describe('semitoneRatio', () => {
  it('maps octaves and unison correctly', () => {
    expect(semitoneRatio(12)).toBeCloseTo(2)
    expect(semitoneRatio(-12)).toBeCloseTo(0.5)
    expect(semitoneRatio(0)).toBe(1)
  })
})

describe('OnePoleLP / OnePoleHP', () => {
  it('LP converges to a DC input; HP rejects it', () => {
    const lp = new OnePoleLP()
    lp.setCutoff(SR, 100)
    const hp = new OnePoleHP()
    hp.setCutoff(SR, 100)
    let lpOut = 0
    let hpOut = 1
    for (let i = 0; i < SR; i++) {
      lpOut = lp.process(1)
      hpOut = hp.process(1)
    }
    expect(lpOut).toBeCloseTo(1, 3)
    expect(Math.abs(hpOut)).toBeLessThan(1e-3)
  })
})

describe('DcBlocker', () => {
  it('removes a DC offset from a sine', () => {
    const dc = new DcBlocker()
    let tail = 0
    for (let i = 0; i < SR; i++) {
      const x = 0.5 + 0.3 * Math.sin((2 * Math.PI * 220 * i) / SR)
      const y = dc.process(x)
      if (i > SR / 2) tail += y / (SR / 2)
    }
    // Mean of the output over the second half is ~0 (DC removed).
    expect(Math.abs(tail)).toBeLessThan(0.01)
  })
})

describe('AllpassDiffuser', () => {
  it('is stable and energy-bounded over sustained input', () => {
    const ap = new AllpassDiffuser(347, 0.65)
    let max = 0
    for (let i = 0; i < 48000; i++) {
      const y = ap.process(Math.sin((2 * Math.PI * 330 * i) / SR))
      expect(Number.isFinite(y)).toBe(true)
      max = Math.max(max, Math.abs(y))
    }
    expect(max).toBeLessThan(4)
  })
})

describe('PitchShifter', () => {
  /** Count zero crossings over the last `n` samples of output. */
  function measureFreq(ratio: number): number {
    const ps = new PitchShifter(SR, 0.08)
    ps.setRatio(ratio)
    const f0 = 440
    let crossings = 0
    let prev = 0
    const total = SR
    const measureStart = total / 2
    for (let i = 0; i < total; i++) {
      const y = ps.process(Math.sin((2 * Math.PI * f0 * i) / SR))
      if (i >= measureStart) {
        if (prev <= 0 && y > 0) crossings++
        prev = y
      }
    }
    return (crossings / (total - measureStart)) * SR
  }

  it('shifts a 440 Hz sine up an octave within 5%', () => {
    const f = measureFreq(2)
    expect(f).toBeGreaterThan(880 * 0.95)
    expect(f).toBeLessThan(880 * 1.05)
  })

  it('shifts down an octave within 5%', () => {
    const f = measureFreq(0.5)
    expect(f).toBeGreaterThan(220 * 0.95)
    expect(f).toBeLessThan(220 * 1.05)
  })

  it('is transparent-ish at ratio 1 (no dropouts)', () => {
    const ps = new PitchShifter(SR)
    ps.setRatio(1)
    let minEnv = 1
    let env = 0
    for (let i = 0; i < SR; i++) {
      const y = ps.process(Math.sin((2 * Math.PI * 440 * i) / SR))
      env = Math.max(Math.abs(y), env * 0.9995)
      if (i > SR / 4) minEnv = Math.min(minEnv, env)
    }
    expect(minEnv).toBeGreaterThan(0.5)
  })
})

describe('Fft', () => {
  it('round-trips a signal through forward+inverse', () => {
    const N = 1024
    const fft = new Fft(N)
    const re = new Float64Array(N)
    const im = new Float64Array(N)
    for (let i = 0; i < N; i++) re[i] = Math.sin((2 * Math.PI * 13 * i) / N) + 0.3
    const orig = re.slice()
    fft.transform(re, im, false)
    fft.transform(re, im, true)
    for (let i = 0; i < N; i++) {
      expect(re[i]).toBeCloseTo(orig[i], 9)
      expect(im[i]).toBeCloseTo(0, 9)
    }
  })

  it('localizes a pure tone in the expected bin', () => {
    const N = 512
    const fft = new Fft(N)
    const re = new Float64Array(N)
    const im = new Float64Array(N)
    const bin = 21
    for (let i = 0; i < N; i++) re[i] = Math.cos((2 * Math.PI * bin * i) / N)
    fft.transform(re, im, false)
    let best = 0
    let bestMag = 0
    for (let k = 0; k < N / 2; k++) {
      const mag = Math.hypot(re[k], im[k])
      if (mag > bestMag) {
        bestMag = mag
        best = k
      }
    }
    expect(best).toBe(bin)
  })

  it('rejects non-power-of-two sizes', () => {
    expect(() => new Fft(300)).toThrow()
  })
})

describe('Smoother', () => {
  it('converges without overshoot and flushes denormals', () => {
    const s = new Smoother(SR, 0.01, 0)
    let prev = 0
    for (let i = 0; i < 4800; i++) {
      const y = s.process(1)
      expect(y).toBeGreaterThanOrEqual(prev)
      expect(y).toBeLessThanOrEqual(1)
      prev = y
    }
    expect(prev).toBeGreaterThan(0.99)
    // Decay to zero must terminate at exactly 0 (denormal flush).
    for (let i = 0; i < SR; i++) s.process(0)
    expect(s.value).toBe(0)
  })
})

describe('hannWindow', () => {
  it('is zero at the start and symmetric around the peak', () => {
    const w = hannWindow(256)
    expect(w[0]).toBeCloseTo(0, 10)
    expect(w[128]).toBeCloseTo(1, 10)
    expect(w[64]).toBeCloseTo(w[192], 10)
  })
})

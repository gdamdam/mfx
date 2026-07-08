/**
 * Minimal iterative radix-2 FFT for spectral effects. All tables (twiddles,
 * bit-reversal) are precomputed in the constructor; transform() works in
 * place on caller-owned buffers, so the hot path never allocates.
 */

export class Fft {
  readonly size: number
  private readonly cosTable: Float64Array
  private readonly sinTable: Float64Array
  private readonly rev: Uint32Array

  constructor(size: number) {
    if (!Number.isInteger(size) || size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`Fft size must be a power of two >= 2, got ${size}`)
    }
    this.size = size
    const half = size / 2
    this.cosTable = new Float64Array(half)
    this.sinTable = new Float64Array(half)
    for (let i = 0; i < half; i++) {
      const a = (Math.PI * i) / half
      this.cosTable[i] = Math.cos(a)
      this.sinTable[i] = Math.sin(a)
    }
    this.rev = new Uint32Array(size)
    const bits = Math.log2(size)
    for (let i = 0; i < size; i++) {
      let r = 0
      for (let b = 0; b < bits; b++) r |= ((i >>> b) & 1) << (bits - 1 - b)
      this.rev[i] = r >>> 0
    }
  }

  /**
   * In-place FFT of (re, im). Pass inverse=true for the inverse transform;
   * the inverse includes the 1/N normalization so forward+inverse round-trips.
   */
  transform(re: Float64Array, im: Float64Array, inverse = false): void {
    const n = this.size
    const rev = this.rev
    for (let i = 0; i < n; i++) {
      const j = rev[i]
      if (j > i) {
        let t = re[i]
        re[i] = re[j]
        re[j] = t
        t = im[i]
        im[i] = im[j]
        im[j] = t
      }
    }
    const sign = inverse ? 1 : -1
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1
      const step = n / len
      for (let start = 0; start < n; start += len) {
        for (let k = 0; k < half; k++) {
          const tIdx = k * step
          const wr = this.cosTable[tIdx]
          const wi = sign * this.sinTable[tIdx]
          const i0 = start + k
          const i1 = i0 + half
          const xr = re[i1] * wr - im[i1] * wi
          const xi = re[i1] * wi + im[i1] * wr
          re[i1] = re[i0] - xr
          im[i1] = im[i0] - xi
          re[i0] += xr
          im[i0] += xi
        }
      }
    }
    if (inverse) {
      const inv = 1 / n
      for (let i = 0; i < n; i++) {
        re[i] *= inv
        im[i] *= inv
      }
    }
  }
}

/** Periodic Hann window (setup-time helper for overlap-add spectral blocks). */
export function hannWindow(size: number): Float64Array {
  const w = new Float64Array(Math.max(1, Math.floor(size)))
  for (let i = 0; i < w.length; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / w.length)
  }
  return w
}

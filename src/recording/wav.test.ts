import { describe, it, expect } from 'vitest'
import { encodeWavStereo } from './wav.ts'
import type { WavMetadata } from './wav.ts'

/** Read a 4-byte ASCII tag at a DataView offset. */
function readTag(view: DataView, offset: number): string {
  let s = ''
  for (let i = 0; i < 4; i++) s += String.fromCharCode(view.getUint8(offset + i))
  return s
}

/** Scan the whole buffer for a 4-byte ASCII tag; -1 if absent. */
function findTag(view: DataView, tag: string): number {
  for (let i = 0; i + 4 <= view.byteLength; i++) {
    if (readTag(view, i) === tag) return i
  }
  return -1
}

describe('encodeWavStereo', () => {
  it('writes RIFF/WAVE/fmt /data magic bytes at the correct offsets', () => {
    const ch = [new Float32Array([0, 0.5]), new Float32Array([0, -0.5])]
    const view = new DataView(encodeWavStereo(ch, 44100, 16))
    expect(readTag(view, 0)).toBe('RIFF')
    expect(readTag(view, 8)).toBe('WAVE')
    expect(readTag(view, 12)).toBe('fmt ')
    // No metadata → data chunk immediately follows the 24-byte fmt chunk.
    expect(readTag(view, 36)).toBe('data')
  })

  it('populates the fmt chunk header (16-bit stereo)', () => {
    const frames = 4
    const ch = [new Float32Array(frames), new Float32Array(frames)]
    const view = new DataView(encodeWavStereo(ch, 48000, 16))
    expect(view.getUint32(16, true)).toBe(16) // fmt body size
    expect(view.getUint16(20, true)).toBe(1) // PCM
    expect(view.getUint16(22, true)).toBe(2) // channels
    expect(view.getUint32(24, true)).toBe(48000) // sampleRate
    expect(view.getUint16(34, true)).toBe(16) // bitsPerSample
    const blockAlign = 2 * 2
    expect(view.getUint16(32, true)).toBe(blockAlign)
    expect(view.getUint32(28, true)).toBe(48000 * blockAlign) // byteRate
    expect(view.getUint32(40, true)).toBe(frames * blockAlign) // data size
  })

  it('populates the fmt chunk header (24-bit mono)', () => {
    const frames = 5
    const ch = [new Float32Array(frames)]
    const view = new DataView(encodeWavStereo(ch, 44100, 24))
    expect(view.getUint16(22, true)).toBe(1) // channels
    expect(view.getUint32(24, true)).toBe(44100) // sampleRate
    expect(view.getUint16(34, true)).toBe(24) // bitsPerSample
    const blockAlign = 1 * 3
    expect(view.getUint16(32, true)).toBe(blockAlign)
    expect(view.getUint32(28, true)).toBe(44100 * blockAlign) // byteRate
    expect(view.getUint32(40, true)).toBe(frames * blockAlign) // data size
  })

  it('sizes the total buffer consistently with the header (16 & 24 bit)', () => {
    const frames = 8
    const ch = [new Float32Array(frames), new Float32Array(frames)]
    for (const bits of [16, 24] as const) {
      const buf = encodeWavStereo(ch, 44100, bits)
      const view = new DataView(buf)
      const bytesPerSample = bits === 24 ? 3 : 2
      const dataSize = frames * 2 * bytesPerSample
      expect(buf.byteLength).toBe(44 + dataSize)
      expect(view.getUint32(4, true)).toBe(buf.byteLength - 8) // RIFF size
      expect(view.getUint32(40, true)).toBe(dataSize) // data size
    }
  })

  it('round-trips a 16-bit stereo signal within 1 LSB', () => {
    const left = new Float32Array([0, 0.25, -0.25, 0.5, -0.5, 1, -1])
    const right = new Float32Array([1, -1, 0.5, -0.5, 0.25, -0.25, 0])
    const view = new DataView(encodeWavStereo([left, right], 44100, 16))
    const dataStart = 44
    for (let i = 0; i < left.length; i++) {
      const l = view.getInt16(dataStart + (i * 2 + 0) * 2, true)
      const r = view.getInt16(dataStart + (i * 2 + 1) * 2, true)
      const expL = left[i] < 0 ? left[i] * 0x8000 : left[i] * 0x7fff
      const expR = right[i] < 0 ? right[i] * 0x8000 : right[i] * 0x7fff
      expect(Math.abs(l - expL)).toBeLessThanOrEqual(1)
      expect(Math.abs(r - expR)).toBeLessThanOrEqual(1)
    }
  })

  it('encodes non-finite input samples as 0', () => {
    const ch = [
      new Float32Array([NaN, Infinity, -Infinity, 0.5]),
      new Float32Array([Infinity, NaN, 0.5, -Infinity]),
    ]
    const view = new DataView(encodeWavStereo(ch, 44100, 16))
    const dataStart = 44
    // Frame 0: both NaN/Inf → silence.
    expect(view.getInt16(dataStart + 0, true)).toBe(0)
    expect(view.getInt16(dataStart + 2, true)).toBe(0)
    // Frame 3 left is a real 0.5 sample → non-zero.
    expect(view.getInt16(dataStart + (3 * 2 + 0) * 2, true)).not.toBe(0)
  })

  it('includes a LIST/INFO chunk when metadata is provided', () => {
    const meta: WavMetadata = {
      title: 'Take 1',
      artist: 'mfx',
      software: 'mfx',
      date: '2026-07-03',
      comment: 'hello',
    }
    const ch = [new Float32Array([0, 0.1]), new Float32Array([0, -0.1])]
    const view = new DataView(encodeWavStereo(ch, 44100, 16, meta))
    const listOff = findTag(view, 'LIST')
    expect(listOff).toBeGreaterThanOrEqual(0)
    expect(readTag(view, listOff + 8)).toBe('INFO')
    expect(findTag(view, 'INAM')).toBeGreaterThanOrEqual(0)
    expect(findTag(view, 'ISFT')).toBeGreaterThanOrEqual(0)
  })

  it('omits the LIST/INFO chunk when no metadata is provided', () => {
    const ch = [new Float32Array([0, 0.1]), new Float32Array([0, -0.1])]
    const view = new DataView(encodeWavStereo(ch, 44100, 16))
    expect(findTag(view, 'LIST')).toBe(-1)
  })
})

/**
 * WAV encoding utilities for the master-output recorder.
 *
 * RIFF/PCM container supporting 16-bit AND 24-bit interleaved output, with an
 * optional LIST/INFO metadata chunk (title/artist/software/date/comment).
 * Mono is produced automatically when a single channel is supplied; anything
 * else is written as N-channel interleaved PCM (the recorder always taps a
 * stereo post-limiter node, so the common case is 2 channels).
 *
 * Adapted from mspectr (src/recording/wav.ts) / mloop (src/utils/wav.ts,
 * AGPL-3.0, github.com/gdamdam/mloop): the RIFF header layout, INFO-chunk
 * builder and writeString helper are lifted from there; the 24-bit sample path
 * and bit-depth-aware sizing come from mspectr.
 *
 * No Date.now / Math.random here — callers pass timestamps/metadata in, so the
 * codec stays pure and deterministic for tests. Non-finite samples are coerced
 * to silence and the sample rate is clamped to a sane positive integer so a
 * bogus AudioContext value can never corrupt the header.
 */

import { clamp } from '../audio/contracts.ts'

export interface WavMetadata {
  title?: string // INAM
  artist?: string // IART
  software?: string // ISFT
  date?: string // ICRD
  comment?: string // ICMT
}

/** Coerce a possibly-bogus rate into a positive integer WAV header can hold. */
function sanitizeSampleRate(sampleRate: number): number {
  if (!Number.isFinite(sampleRate) || sampleRate < 1) return 1
  // Header field is a Uint32; floor to an integer and cap at its max.
  return Math.min(Math.floor(sampleRate), 0xffffffff)
}

/**
 * Build a RIFF/WAVE header up to and including the `data` chunk's size field —
 * i.e. every byte that precedes the raw PCM samples. Split out from
 * {@link encodeWavStereo} so a recorder can stream PCM to storage and emit only
 * this small header once the final sample count is known, instead of holding
 * the whole take in RAM to size the buffer up front.
 *
 * @param numChannels  Channel count written to the fmt chunk (>= 1).
 * @param sampleRate  Frames per second (clamped to a positive integer).
 * @param bitDepth  16 or 24 bits per sample.
 * @param dataSize  Byte length of the PCM payload that will follow the header.
 * @param meta  Optional LIST/INFO metadata, placed before the data chunk.
 */
export function wavHeader(
  numChannels: number,
  sampleRate: number,
  bitDepth: 16 | 24,
  dataSize: number,
  meta?: WavMetadata,
): ArrayBuffer {
  const numCh = numChannels > 0 ? numChannels : 1
  const rate = sanitizeSampleRate(sampleRate)
  const bytesPerSample = bitDepth === 24 ? 3 : 2
  const blockAlign = numCh * bytesPerSample
  const byteRate = rate * blockAlign

  const infoChunk = meta ? buildInfoChunk(meta) : null
  const infoSize = infoChunk ? infoChunk.byteLength : 0

  // 12 (RIFF/WAVE) + 24 (fmt) + 8 (data header) = 44 fixed bytes.
  const headerSize = 44 + infoSize
  const totalSize = headerSize + dataSize

  const buf = new ArrayBuffer(headerSize)
  const view = new DataView(buf)

  // RIFF container
  writeString(view, 0, 'RIFF')
  view.setUint32(4, totalSize - 8, true)
  writeString(view, 8, 'WAVE')

  // fmt chunk (PCM)
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk body size
  view.setUint16(20, 1, true) // audio format = PCM
  view.setUint16(22, numCh, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitDepth, true)

  // optional LIST/INFO chunk, placed before data
  let offset = 36
  if (infoChunk) {
    new Uint8Array(buf, offset, infoSize).set(new Uint8Array(infoChunk))
    offset += infoSize
  }

  // data chunk header (payload follows immediately after this)
  writeString(view, offset, 'data')
  view.setUint32(offset + 4, dataSize, true)

  return buf
}

/**
 * Encode one batch of equal-length Float32 channels to interleaved PCM bytes.
 * Callers stream these batches straight to storage (or concatenate a handful of
 * them into a Blob) so no giant contiguous Float32/WAV buffer is ever needed.
 *
 * @param channels  Per-channel sample data (all the same length).
 * @param bitDepth  16 or 24 bits per sample.
 */
export function encodePcmInterleaved(
  channels: Float32Array[],
  bitDepth: 16 | 24,
): Uint8Array<ArrayBuffer> {
  const numCh = channels.length > 0 ? channels.length : 1
  const len = channels.length > 0 ? channels[0].length : 0
  const bytesPerSample = bitDepth === 24 ? 3 : 2
  const out = new Uint8Array(len * numCh * bytesPerSample)
  const view = new DataView(out.buffer)

  let offset = 0
  if (bitDepth === 24) {
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < numCh; c++) {
        offset = write24(view, offset, sanitizeSample(channels[c][i]))
      }
    }
  } else {
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < numCh; c++) {
        const s = sanitizeSample(channels[c][i])
        // Asymmetric scaling: full-scale negative is -0x8000, positive +0x7FFF.
        view.setInt16(offset, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true)
        offset += 2
      }
    }
  }

  return out
}

/**
 * Encode interleaved PCM WAV from one or more equal-length Float32 channels.
 * Convenience one-shot wrapper over {@link wavHeader} + {@link encodePcmInterleaved}
 * for callers that already hold the full take in memory (e.g. tests).
 *
 * @param channels  Per-channel sample data. 1 channel → mono, 2 → stereo, etc.
 * @param sampleRate  Frames per second (clamped to a positive integer).
 * @param bitDepth  16 or 24 bits per sample.
 * @param meta  Optional LIST/INFO metadata.
 */
export function encodeWavStereo(
  channels: Float32Array[],
  sampleRate: number,
  bitDepth: 16 | 24,
  meta?: WavMetadata,
): ArrayBuffer {
  const numCh = channels.length > 0 ? channels.length : 1
  const pcm = encodePcmInterleaved(channels, bitDepth)
  const header = wavHeader(numCh, sampleRate, bitDepth, pcm.byteLength, meta)

  const out = new Uint8Array(header.byteLength + pcm.byteLength)
  out.set(new Uint8Array(header), 0)
  out.set(pcm, header.byteLength)
  return out.buffer
}

/** Guard non-finite (NaN/Inf) samples to silence, then clamp to [-1, 1]. */
function sanitizeSample(sample: number): number {
  if (!Number.isFinite(sample)) return 0
  return clamp(sample, -1, 1)
}

/** Write one little-endian signed 24-bit sample; returns the advanced offset. */
function write24(view: DataView, offset: number, sample: number): number {
  // 24-bit signed range: [-0x800000, 0x7FFFFF].
  let v = Math.round(sample < 0 ? sample * 0x800000 : sample * 0x7fffff)
  if (v < -0x800000) v = -0x800000
  else if (v > 0x7fffff) v = 0x7fffff
  if (v < 0) v += 0x1000000 // two's-complement into 24 bits
  view.setUint8(offset, v & 0xff)
  view.setUint8(offset + 1, (v >> 8) & 0xff)
  view.setUint8(offset + 2, (v >> 16) & 0xff)
  return offset + 3
}

/** Build a LIST/INFO RIFF chunk from metadata fields (adapted from mloop). */
function buildInfoChunk(meta: WavMetadata): ArrayBuffer | null {
  const tags: [string, string][] = []
  if (meta.title) tags.push(['INAM', meta.title])
  if (meta.artist) tags.push(['IART', meta.artist])
  if (meta.software) tags.push(['ISFT', meta.software])
  if (meta.date) tags.push(['ICRD', meta.date])
  if (meta.comment) tags.push(['ICMT', meta.comment])
  if (tags.length === 0) return null

  // body = "INFO" (4) + per-tag: id(4) + size(4) + null-terminated string padded to even.
  let bodySize = 4
  for (const [, val] of tags) {
    const strLen = val.length + 1 // include null terminator
    const padded = strLen % 2 === 0 ? strLen : strLen + 1
    bodySize += 8 + padded
  }

  const buf = new ArrayBuffer(8 + bodySize)
  const view = new DataView(buf)
  let off = 0

  writeString(view, off, 'LIST')
  off += 4
  view.setUint32(off, bodySize, true)
  off += 4
  writeString(view, off, 'INFO')
  off += 4

  for (const [tag, val] of tags) {
    writeString(view, off, tag)
    off += 4
    const strLen = val.length + 1
    const padded = strLen % 2 === 0 ? strLen : strLen + 1
    view.setUint32(off, strLen, true)
    off += 4
    writeString(view, off, val)
    off += val.length
    view.setUint8(off, 0) // null terminator
    off++
    if (padded > strLen) {
      view.setUint8(off, 0) // pad byte to even boundary
      off++
    }
  }

  return buf
}

/** Write an ASCII string into a DataView at a byte offset (adapted from mloop). */
function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i) & 0xff)
  }
}

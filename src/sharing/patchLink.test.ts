import { describe, it, expect } from 'vitest'
import { DEFAULT_PATCH, sanitizePatch, type Patch } from '../audio/contracts.ts'
import { MAX_PATCH_LINK_BYTES, decodePatchLink, encodePatchLink } from './patchLink.ts'

// A patch that differs from DEFAULT so the round-trip proves real preservation.
function tweakedPatch(): Patch {
  return sanitizePatch({ ...DEFAULT_PATCH, inputGain: 2, mix: 0.3, tempo: 90, sync: true })
}

describe('encodePatchLink / decodePatchLink', () => {
  it('round-trips a patch: decode equals sanitizePatch(patch)', () => {
    const patch = tweakedPatch()
    const link = encodePatchLink(patch)
    const back = decodePatchLink(link)
    expect(back).not.toBeNull()
    expect(back).toEqual(sanitizePatch(patch))
  })

  it('is deterministic — same input yields the same string', () => {
    const patch = tweakedPatch()
    expect(encodePatchLink(patch)).toBe(encodePatchLink(patch))
  })

  it('sanitizes an out-of-range patch through the link', () => {
    const hostile = { ...DEFAULT_PATCH, inputGain: 9999, mix: 50 } as unknown as Patch
    const back = decodePatchLink(encodePatchLink(hostile))
    expect(back).not.toBeNull()
    expect(back?.inputGain).toBeLessThanOrEqual(3)
    expect(back?.mix).toBeLessThanOrEqual(1)
  })

  it('emits URL-safe output (no +, /, or = padding)', () => {
    const link = encodePatchLink(tweakedPatch())
    expect(link).not.toMatch(/[+/=]/)
  })

  it('tolerates a leading # on the fragment', () => {
    const link = encodePatchLink(tweakedPatch())
    expect(decodePatchLink('#' + link)).toEqual(decodePatchLink(link))
  })

  it('returns null on malformed / empty / oversized input without throwing', () => {
    expect(decodePatchLink('')).toBeNull()
    expect(decodePatchLink('garbage!!!')).toBeNull()
    // Valid base64url but not JSON.
    expect(decodePatchLink(encodeNonJson('not json'))).toBeNull()
    // Oversized fragment is rejected before any decode work.
    expect(decodePatchLink('A'.repeat(MAX_PATCH_LINK_BYTES + 1))).toBeNull()
  })

  it('rejects an array-JSON fragment instead of wiping to DEFAULT_PATCH (L5)', () => {
    // Valid base64url + valid JSON, but a JSON array — not a patch object.
    expect(decodePatchLink(encodeNonJson('[1,2,3]'))).toBeNull()
    expect(decodePatchLink(encodeNonJson('[]'))).toBeNull()
  })
})

// base64url-encode an arbitrary string without going through JSON, to build a
// fragment that decodes to bytes but fails JSON.parse.
function encodeNonJson(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

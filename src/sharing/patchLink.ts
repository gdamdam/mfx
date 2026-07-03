/**
 * Shareable patch links.
 *
 * encodePatchLink / decodePatchLink move a Patch through a URL fragment as
 * base64url(JSON(sanitizePatch(patch))). Small, deterministic, always safe:
 * encode sanitizes on the way out so a copied link only ever carries in-range
 * data, and decode sanitizes on the way in so a hostile fragment can only ever
 * yield an in-range Patch (or null).
 *
 * decodePatchLink is a SECURITY BOUNDARY — it NEVER throws. Any malformed,
 * oversized, or out-of-range input returns null. Size is bounded before any
 * decode work so a hostile string can't force a large allocation or an
 * unpasteable URL.
 *
 * Adapted from mspectr (mspectr/src/sharing/patchLink.ts + snapshotCodec.ts,
 * AGPL-3.0). The base64url helpers work in the browser (btoa/atob) and in the
 * node test environment (Buffer); the JSON string is (de)serialized via
 * TextEncoder/TextDecoder when present.
 */

import { sanitizePatch, type Patch } from '../audio/contracts.ts'

// Narrow ambient for the non-DOM (node) base64 fallback, so we can typecheck
// under the browser tsconfig without pulling in @types/node globally. Both our
// runtimes (browser + node test) actually take the btoa/atob path.
declare const Buffer: {
  from(
    input: Uint8Array | string,
    encoding?: string,
  ): Uint8Array & { toString(encoding?: string): string }
}

/**
 * Hard ceiling on the encoded fragment length. A patch encodes small, so a
 * fragment past this is either corrupt or hostile — reject it before decoding.
 */
export const MAX_PATCH_LINK_BYTES = 16000

const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null
const textDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null

/** Encode raw bytes as base64url, no `=` padding (URL/fragment safe). */
function bytesToBase64Url(bytes: Uint8Array): string {
  let b64: string
  if (typeof btoa === 'function') {
    // btoa wants a binary string. Chunk to avoid call-stack limits on big inputs.
    let binary = ''
    const chunk = 0x8000
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
    }
    b64 = btoa(binary)
  } else {
    // Node / non-DOM environments.
    b64 = Buffer.from(bytes).toString('base64')
  }
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Decode a base64url string to bytes. Throws on non-base64 input (callers of
 *  decodePatchLink wrap this in try/catch so a bad fragment yields null). */
function base64UrlToBytes(input: string): Uint8Array {
  // Restore the standard alphabet; padding is optional for the decoders we use.
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/')
  if (!/^[A-Za-z0-9+/]*$/.test(normalized)) {
    throw new Error('base64UrlToBytes: contains non-base64 characters')
  }
  if (typeof atob === 'function') {
    const binary = atob(normalized)
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
    return out
  }
  return new Uint8Array(Buffer.from(normalized, 'base64'))
}

/** UTF-8 string → base64url. */
function stringToBase64Url(text: string): string {
  const bytes = textEncoder ? textEncoder.encode(text) : new Uint8Array(Buffer.from(text, 'utf-8'))
  return bytesToBase64Url(bytes)
}

/** base64url → UTF-8 string. Throws on malformed base64. */
function base64UrlToString(fragment: string): string {
  const bytes = base64UrlToBytes(fragment)
  if (textDecoder) return textDecoder.decode(bytes)
  return Buffer.from(bytes).toString('utf-8')
}

export function encodePatchLink(patch: Patch): string {
  // Sanitize on the way out too: the encoded link only ever carries in-range
  // data, so a copied link is trustworthy regardless of caller state.
  return stringToBase64Url(JSON.stringify(sanitizePatch(patch)))
}

export function decodePatchLink(fragment: string): Patch | null {
  if (typeof fragment !== 'string') return null
  // Tolerate a leading '#', as location.hash carries one.
  const frag = fragment.startsWith('#') ? fragment.slice(1) : fragment
  if (frag.length === 0) return null
  // Reject oversized fragments before decoding/parsing anything.
  if (frag.length > MAX_PATCH_LINK_BYTES) return null
  try {
    const parsed: unknown = JSON.parse(base64UrlToString(frag))
    if (parsed == null || typeof parsed !== 'object') return null
    // sanitizePatch is the trust boundary: any in-range-or-not object becomes a
    // valid Patch, so a decoded link is always safe to apply.
    return sanitizePatch(parsed)
  } catch {
    return null
  }
}

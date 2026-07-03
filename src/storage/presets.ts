/**
 * Preset persistence for mfx — named patch snapshots stored in IndexedDB.
 *
 * A Preset is a thin envelope around a Patch: a display name, an envelope
 * schema version, the caller-supplied createdAt, and an optional sourceLabel.
 * Patch-level migration is delegated entirely to sanitizePatch (the trust
 * boundary in contracts.ts), which coerces missing/old/invalid fields back into
 * safe ranges — so this file only owns the envelope.
 *
 * serialize/deserialize are pure and deterministic: createdAt is passed in (not
 * Date.now here) so serialization is testable and reproducible. deserializePreset
 * NEVER throws — any garbage read back from storage yields a valid Preset.
 *
 * The IndexedDB wrapper (PresetStore) is adapted from mgrains
 * (mgrains/src/storage/presets.ts, AGPL-3.0). IndexedDB is absent in the node
 * test environment, so the class is intentionally untested there and its methods
 * reject with a clear Error when IndexedDB is unavailable.
 */

import { DEFAULT_PATCH, sanitizePatch, type Patch } from '../audio/contracts.ts'

// Bump when the Preset envelope (name/schemaVersion/createdAt/sourceLabel)
// changes shape. Patch migration is handled by sanitizePatch, not here.
export const PRESET_SCHEMA_VERSION = 1

export interface Preset {
  name: string
  schemaVersion: number
  patch: Patch
  createdAt: number
  // Optional label of the audio source, used to prompt a relink on load.
  sourceLabel?: string
}

const DEFAULT_PRESET_NAME = 'untitled'

/**
 * Build a Preset from a name + patch + timestamp. Runs sanitizePatch so the
 * stored patch is always in-range and never aliases a caller-owned (or frozen)
 * object. createdAt is a caller argument to keep this deterministic.
 */
export function serializePreset(
  name: string,
  patch: Patch,
  createdAt: number,
  options?: { sourceLabel?: string },
): Preset {
  const preset: Preset = {
    name: coerceName(name),
    schemaVersion: PRESET_SCHEMA_VERSION,
    patch: sanitizePatch(patch),
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
  }
  // Only attach sourceLabel when it's a real string, so the stored preset never
  // carries garbage or an aliased undefined-typed field.
  if (typeof options?.sourceLabel === 'string') preset.sourceLabel = options.sourceLabel
  return preset
}

/**
 * Rebuild a Preset from an unknown value (e.g. parsed from IndexedDB). Never
 * throws: bad/missing fields collapse to safe defaults and the patch is migrated
 * through sanitizePatch. schemaVersion is always normalized to the current one.
 */
export function deserializePreset(raw: unknown): Preset {
  const record = isRecord(raw) ? raw : {}

  // sanitizePatch fills every field from a partial/invalid candidate; spread the
  // (possibly empty) raw patch over DEFAULT_PATCH so a missing patch → DEFAULT.
  const patchCandidate = isRecord(record.patch)
    ? { ...DEFAULT_PATCH, ...record.patch }
    : DEFAULT_PATCH

  const preset: Preset = {
    name: coerceName(record.name),
    // The envelope version is normalized forward: readers only ever see current.
    schemaVersion: PRESET_SCHEMA_VERSION,
    patch: sanitizePatch(patchCandidate),
    createdAt: Number.isFinite(record.createdAt) ? (record.createdAt as number) : 0,
  }

  if (typeof record.sourceLabel === 'string') preset.sourceLabel = record.sourceLabel
  return preset
}

function coerceName(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_PRESET_NAME
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : DEFAULT_PRESET_NAME
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Thin IndexedDB wrapper for persisting presets keyed by name. All reads pass
 * through deserializePreset so a corrupt row can never crash the app. IndexedDB
 * is not available in the node test environment, so this class is intentionally
 * untested there; open() rejects with a clear Error when IndexedDB is absent.
 */
export class PresetStore {
  private readonly dbName: string
  private readonly storeName: string

  constructor(dbName = 'mfx', storeName = 'presets') {
    this.dbName = dbName
    this.storeName = storeName
  }

  /** Open (and, on first use, create the object store in) the database. */
  open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('PresetStore: IndexedDB is not available in this environment'))
        return
      }
      let request: IDBOpenDBRequest
      try {
        request = indexedDB.open(this.dbName, 1)
      } catch (err) {
        // Some privacy modes throw synchronously from open().
        reject(err instanceof Error ? err : new Error('PresetStore: failed to open IndexedDB'))
        return
      }
      request.onupgradeneeded = () => {
        const db = request.result
        // keyPath 'name' → the preset's own name is its key, so put(preset)
        // upserts by name with no separate key argument.
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: 'name' })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () =>
        reject(request.error ?? new Error('PresetStore: failed to open IndexedDB'))
    })
  }

  async save(preset: Preset): Promise<void> {
    const db = await this.open()
    try {
      await this.tx(db, 'readwrite', (store) => store.put(preset))
    } finally {
      db.close()
    }
  }

  async load(name: string): Promise<Preset | null> {
    const db = await this.open()
    try {
      const raw = await this.tx(db, 'readonly', (store) => store.get(name))
      return raw === undefined ? null : deserializePreset(raw)
    } finally {
      db.close()
    }
  }

  async list(): Promise<Preset[]> {
    const db = await this.open()
    try {
      const raws = await this.tx<unknown[]>(db, 'readonly', (store) => store.getAll())
      return raws.map((raw) => deserializePreset(raw))
    } finally {
      db.close()
    }
  }

  async delete(name: string): Promise<void> {
    const db = await this.open()
    try {
      await this.tx(db, 'readwrite', (store) => store.delete(name))
    } finally {
      db.close()
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const existing = await this.load(from)
    if (existing === null) {
      throw new Error(`PresetStore.rename: no preset named "${from}"`)
    }
    const target = coerceName(to)
    await this.save({ ...existing, name: target })
    // Drop the old row only when the name actually changed, so a no-op rename
    // doesn't delete the preset it just saved.
    if (target !== from) await this.delete(from)
  }

  /** Run one request in its own transaction, resolving with its result. */
  private tx<T>(
    db: IDBDatabase,
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.storeName, mode)
      const store = transaction.objectStore(this.storeName)
      const request = run(store)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () =>
        reject(request.error ?? new Error('PresetStore: IndexedDB request failed'))
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('PresetStore: IndexedDB transaction aborted'))
    })
  }
}

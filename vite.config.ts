/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'
import pkg from './package.json' with { type: 'json' }

/**
 * Build-only plugin: emit a sorted list of hashed asset filenames so the
 * hand-rolled service worker can precache them, and stamp the SW with a
 * fingerprint derived from those names (so a content change busts the cache).
 */
function precacheManifest(): Plugin {
  let assets: string[] = []
  let base = '/'
  return {
    name: 'mfx-precache-manifest',
    apply: 'build',
    configResolved(config) {
      // Vite guarantees a trailing slash on the resolved base.
      base = config.base
    },
    generateBundle(_options, bundle) {
      assets = Object.keys(bundle)
        .filter((name) => !name.endsWith('.html') && name !== 'sw.js')
        .map((name) => `${base}${name}`)
        .sort()
      this.emitFile({
        type: 'asset',
        fileName: 'precache-manifest.json',
        source: JSON.stringify(assets, null, 2),
      })
    },
    async writeBundle(options) {
      const { readFile, writeFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const outDir = options.dir ?? 'dist'
      const swPath = join(outDir, 'sw.js')
      let src: string
      try {
        src = await readFile(swPath, 'utf8')
      } catch {
        // sw.js not present in this build target — skip silently.
        return
      }
      // Fingerprint from asset names + build time, so changes to public
      // assets (mfx.svg, manifest, …) that don't alter bundle names still
      // bust the cache.
      const fingerprint = createHash('sha256')
        .update(`${assets.join('\n')}\n${Date.now()}`)
        .digest('hex')
        .slice(0, 12)
      const injected = src
        .replace('__BUILD_FINGERPRINT__', fingerprint)
        .replace('__PRECACHE_ASSETS__', JSON.stringify(assets))
      // Build-time assertion: the deployed SW must precache a real, non-empty
      // array literal — otherwise the app is blank offline.
      const match = injected.match(/const PRECACHE_ASSETS = (\[.*?\])/)
      let parsed: unknown
      try {
        parsed = match ? JSON.parse(match[1]) : undefined
      } catch {
        parsed = undefined
      }
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error(
          'mfx-precache: injected sw.js precache list is empty or malformed; aborting build',
        )
      }
      await writeFile(swPath, injected)
    },
  }
}

export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? '/',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [react(), precacheManifest()],
  build: { target: 'es2022' },
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
  },
})

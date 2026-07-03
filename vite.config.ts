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
  return {
    name: 'mfx-precache-manifest',
    apply: 'build',
    generateBundle(_options, bundle) {
      assets = Object.keys(bundle)
        .filter((name) => !name.endsWith('.html') && name !== 'sw.js')
        .map((name) => `/${name}`)
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
      try {
        const fingerprint = createHash('sha256')
          .update(assets.join('\n'))
          .digest('hex')
          .slice(0, 12)
        const src = await readFile(swPath, 'utf8')
        await writeFile(
          swPath,
          src
            .replace('__BUILD_FINGERPRINT__', fingerprint)
            .replace('__PRECACHE_ASSETS__', JSON.stringify(assets)),
        )
      } catch {
        // sw.js not present in this build target — skip silently.
      }
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

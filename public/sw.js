/*
 * mfx service worker — hand-rolled, no build framework.
 * Strategy: network-first for navigations (always try fresh HTML, fall back
 * to cached shell offline); cache-first for hashed static assets (immutable).
 * The fingerprint + asset list are injected at build time by vite.config.ts.
 */
const FINGERPRINT = '__BUILD_FINGERPRINT__'
const PRECACHE = `mfx-precache-${FINGERPRINT}`
const RUNTIME = `mfx-runtime-${FINGERPRINT}`
const PRECACHE_ASSETS = '__PRECACHE_ASSETS__'

const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/mfx.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PRECACHE)
      const assets = Array.isArray(PRECACHE_ASSETS) ? PRECACHE_ASSETS : []
      await cache.addAll([...SHELL, ...assets].filter((v, i, a) => a.indexOf(v) === i))
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(
        keys
          .filter((k) => k !== PRECACHE && k !== RUNTIME)
          .map((k) => caches.delete(k)),
      )
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // Network-first for navigations.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request)
          const cache = await caches.open(RUNTIME)
          cache.put('/index.html', fresh.clone())
          return fresh
        } catch {
          const cached = await caches.match('/index.html')
          return cached ?? new Response('Offline', { status: 503 })
        }
      })(),
    )
    return
  }

  // Cache-first for everything else (hashed assets are immutable).
  event.respondWith(
    (async () => {
      const cached = await caches.match(request)
      if (cached) return cached
      try {
        const fresh = await fetch(request)
        if (fresh.ok && fresh.type === 'basic') {
          const cache = await caches.open(RUNTIME)
          cache.put(request, fresh.clone())
        }
        return fresh
      } catch {
        return new Response('', { status: 504 })
      }
    })(),
  )
})

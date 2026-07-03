/**
 * Registers the hand-rolled service worker (public/sw.js) in production only.
 * Dev keeps SW off so Vite HMR is never intercepted. Never throws.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Registration is best-effort; the app works fine without it.
    })
  })
}

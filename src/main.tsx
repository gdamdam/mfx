import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// Display: Bricolage Grotesque (used with restraint). Data: Space Mono.
import '@fontsource/bricolage-grotesque/400.css'
import '@fontsource/bricolage-grotesque/600.css'
import '@fontsource/bricolage-grotesque/800.css'
import '@fontsource/space-mono/400.css'
import '@fontsource/space-mono/700.css'

import './styles.css'
import { App } from './App.tsx'
import { registerServiceWorker } from './registerServiceWorker.ts'

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

registerServiceWorker()

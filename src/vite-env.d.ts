/// <reference types="vite/client" />

// Bundled worklet modules imported as URLs.
declare module '*?worker&url' {
  const src: string
  export default src
}

declare const __APP_VERSION__: string

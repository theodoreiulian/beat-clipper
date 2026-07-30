import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { libraryPlugin } from './vite-plugin-library'

// Static SPA. The single-threaded ffmpeg core needs no COOP/COEP headers,
// so this builds to a plain `dist/` deployable on any static host.
// If deploying under a sub-path (e.g. GitHub Pages project site), set `base`.
export default defineConfig({
  base: './',
  server: {
    // 5173 is taken by another process; pin dev to 5174.
    port: 5174,
    strictPort: true,
    watch: {
      // The Library tab writes uploaded clips + manifest.json straight into
      // public/clips (via libraryPlugin). Those writes must NOT trip Vite's
      // file watcher into a full-page reload — a reload mid-dump would drop
      // tagging state and thrash the tab. The client re-reads the manifest
      // explicitly after each write, so ignoring it here is free.
      ignored: ['**/public/clips/**'],
    },
  },
  // libraryPlugin is apply:'serve' and emits nothing into the production build.
  plugins: [libraryPlugin(), react()],
  optimizeDeps: {
    // ffmpeg.wasm ships its own worker/wasm; don't let Vite pre-bundle it.
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
})

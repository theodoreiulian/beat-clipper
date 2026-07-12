import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Static SPA. The single-threaded ffmpeg core needs no COOP/COEP headers,
// so this builds to a plain `dist/` deployable on any static host.
// If deploying under a sub-path (e.g. GitHub Pages project site), set `base`.
export default defineConfig({
  base: './',
  server: {
    // 5173 is taken by another process; pin dev to 5174.
    port: 5174,
    strictPort: true,
  },
  plugins: [react()],
  optimizeDeps: {
    // ffmpeg.wasm ships its own worker/wasm; don't let Vite pre-bundle it.
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
})

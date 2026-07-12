import { defineConfig, devices } from '@playwright/test'

// The render pipeline runs ffmpeg.wasm in a real browser (Web Worker + WASM +
// blob URLs), so these tests drive an actual Chromium against the Vite dev server
// rather than a Node/jsdom environment.
const PORT = Number(process.env.TEST_PORT ?? 5180)

export default defineConfig({
  testDir: './tests',
  // A single render on the single-threaded core takes tens of seconds and is
  // memory-hungry; run serially so renders don't compete.
  fullyParallel: false,
  workers: 1,
  // A full 15s render (load core + decode + encode) can take ~30-60s on the
  // single-threaded wasm core.
  timeout: 180_000,
  expect: { timeout: 15_000 },
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // `npm run dev` runs predev -> copy-core, so the ESM ffmpeg core is in place.
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})

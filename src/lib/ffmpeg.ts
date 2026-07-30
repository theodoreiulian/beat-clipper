import { FFmpeg } from '@ffmpeg/ffmpeg'

// Single-threaded ESM core, served as a local static asset from public/ffmpeg/
// (copied there by scripts/copy-ffmpeg-core.mjs). No runtime CDN and no
// COOP/COEP headers required.
//
// The core/wasm are passed to ffmpeg.load() as absolute same-origin URLs. We do
// NOT wrap them in blob URLs (the usual `toBlobURL` trick): @ffmpeg/ffmpeg's
// module worker loads the core via dynamic `import()`, and importing a blob URL
// fails there ("failed to import ffmpeg-core.js"). The blob trick only matters
// for cross-origin CDN loads; since we self-host, a direct URL is simpler and
// works. Absolute (resolved against the document) so the worker, whose own base
// URL is elsewhere, still resolves them correctly under any deploy sub-path.
const base = import.meta.env.BASE_URL
const coreURL = new URL(`${base}ffmpeg/ffmpeg-core.js`, document.baseURI).href
const wasmURL = new URL(`${base}ffmpeg/ffmpeg-core.wasm`, document.baseURI).href

let instance: FFmpeg | null = null
let loadPromise: Promise<FFmpeg> | null = null
let progressHandler: ((progress: number, timeMicros: number) => void) | null = null

// Ring buffer of the most recent ffmpeg log lines. ffmpeg.wasm's exec() resolves
// with an exit code instead of throwing, so the only way to know *why* a render
// failed is to keep its stderr around and surface it on failure.
const LOG_LIMIT = 200
const logLines: string[] = []

/** Drop buffered logs (call before each exec so the tail is render-specific). */
export function clearFFmpegLog(): void {
  logLines.length = 0
}

/** The tail of recent ffmpeg log output, newest last. */
export function getFFmpegLog(): string {
  return logLines.join('\n')
}

/**
 * Route ffmpeg progress events to the current render, if any. `progress` is the
 * core's own 0..1 estimate, which is unreliable with multi-input filter graphs;
 * `timeMicros` is the output mux timestamp in microseconds, which callers that
 * know their exact output duration should prefer.
 */
export function setProgressHandler(
  cb: ((progress: number, timeMicros: number) => void) | null,
): void {
  progressHandler = cb
}

// There is one FFmpeg instance, one virtual FS and one progress handler, so two
// jobs must never interleave — a preview rebuild triggered by a clip swap can
// otherwise land in the middle of a full-res export and corrupt both.
let queue: Promise<unknown> = Promise.resolve()

/** Run `fn` with exclusive use of the ffmpeg instance, queued behind any other job. */
export function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.catch(() => {})
  return run
}

/** Load the ffmpeg.wasm engine once and reuse it across renders. */
export function getFFmpeg(): Promise<FFmpeg> {
  if (instance) return Promise.resolve(instance)
  if (!loadPromise) {
    const ffmpeg = new FFmpeg()
    loadPromise = (async () => {
      ffmpeg.on('progress', ({ progress, time }) => progressHandler?.(progress, time))
      ffmpeg.on('log', ({ message }) => {
        logLines.push(message)
        if (logLines.length > LOG_LIMIT) logLines.shift()
      })
      await ffmpeg.load({ coreURL, wasmURL })
      instance = ffmpeg
      return ffmpeg
    })()
  }
  return loadPromise
}

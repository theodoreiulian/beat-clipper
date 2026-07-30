/**
 * Still frames for clip tiles.
 *
 * A tile used to be a live `<video>`. That meant every visible tile held a
 * demuxer and a decoded frame of a multi-megabyte clip: a five-cut timeline plus
 * an open picker is thirty live decoders competing with the preview for the same
 * media threads, which is exactly what makes preview playback stutter. A tile
 * only ever shows one still frame, so each frame is decoded once, captured to a
 * small JPEG, and the video element is thrown away immediately.
 *
 * Results are cached for the life of the page, so reopening the picker costs
 * nothing at all.
 */

/** Longest edge of a captured poster. Tiles are ~100px wide; this is generous. */
const POSTER_WIDTH = 220
/** Decoding several multi-MB clips at once is the thing we're avoiding. */
const MAX_PARALLEL = 2
/** A clip that never fires `seeked` must not occupy a queue slot forever. */
const CAPTURE_TIMEOUT_MS = 20000

const cache = new Map<string, Promise<string>>()
const queue: (() => void)[] = []
let active = 0
let enabled = true

function pump(): void {
  while (enabled && active < MAX_PARALLEL && queue.length > 0) {
    active++
    queue.shift()!()
  }
}

/**
 * Gate new captures. The preview turns this off while it plays: decoding a clip
 * for a thumbnail is precisely the background work that makes playback judder,
 * and a tile can wait.
 */
export function setPosterCaptureEnabled(next: boolean): void {
  enabled = next
  if (enabled) pump()
}

/** A still from `url` at `time` seconds, as an object URL. Decoded at most once. */
export function getPoster(url: string, time: number): Promise<string> {
  const key = `${url}@${time.toFixed(1)}`
  const hit = cache.get(key)
  if (hit) return hit

  const pending = new Promise<string>((resolve, reject) => {
    queue.push(() => {
      capture(url, time)
        .then(resolve, (err) => {
          // Don't cache a failure: a clip that lost a race (or was still being
          // written to disk by the Library tab) would stay blank forever.
          cache.delete(key)
          reject(err)
        })
        .finally(() => {
          active--
          pump()
        })
    })
    pump()
  })
  cache.set(key, pending)
  return pending
}

function capture(url: string, time: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.preload = 'auto'
    video.muted = true
    video.playsInline = true

    let settled = false
    // Dropping the source releases the decoder; without this the element we were
    // trying to avoid keeping around just lives on unreferenced.
    const release = () => {
      video.removeAttribute('src')
      video.load()
    }
    const fail = (reason: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      release()
      reject(new Error(reason))
    }
    const timer = setTimeout(() => fail(`poster timed out: ${url}`), CAPTURE_TIMEOUT_MS)

    video.onerror = () => fail(`poster could not load: ${url}`)
    video.onloadedmetadata = () => {
      const end = (video.duration || 0) - 0.05
      const at = Math.max(0, Math.min(time, Number.isFinite(end) ? end : time))
      video.currentTime = Number.isFinite(at) ? at : 0
    }
    video.onseeked = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        const w = POSTER_WIDTH
        const ratio = video.videoWidth > 0 ? video.videoHeight / video.videoWidth : 4 / 3
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = Math.max(1, Math.round(w * ratio))
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('no 2d context')
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        canvas.toBlob(
          (blob) => {
            release()
            if (blob) resolve(URL.createObjectURL(blob))
            else reject(new Error(`poster encode failed: ${url}`))
          },
          'image/jpeg',
          0.72,
        )
      } catch (e) {
        release()
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    }

    video.src = url
  })
}

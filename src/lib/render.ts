import { fetchFile } from '@ffmpeg/util'
import type { Clip, OutputLength } from '../types'
import { getFFmpeg, setProgressHandler, clearFFmpegLog, getFFmpegLog } from './ffmpeg'

// 3:4 output (not 9:16): the portrait clips keep more of their frame after the
// center crop, so dancers aren't cut off at the sides.
const OUT_W = 1080
const OUT_H = 1440
const OUT_FPS = 30
const BEATS_PER_CUT = 4
/** A full run is this many 4-beat bars. Clips whose footage can't supply a full
 *  run at their synced speed instead play a single 2-bar (half) run — never
 *  looped or time-warped to fill 4 bars (clips under 2 bars are excluded
 *  entirely), so the timeline is a mix of 4-bar and 2-bar cuts, all on the beat. */
const CUTS_PER_RUN = 4
/** Once a clip's run ends it stays out of the pool for this many bars, so the
 *  same dancer doesn't come back around every few cuts. Relaxed automatically
 *  when the library is too small to honour it. */
const COOLDOWN_BARS = 16
const MAX_FULL_SECONDS = 60

export interface Segment {
  clip: Clip
  segDuration: number
  speed: number
  /** Source-clip trim window (seconds). srcStart begins at the clip's grid offset
   *  and advances as footage is consumed, so every cut starts on a grid beat. */
  srcStart: number
  srcEnd: number
  /** present when this segment is the first of several back-to-back runs of the same clip */
  reuseGroup: string | null
}

/** Read a clip's duration via a throwaway <video> element. */
export function getClipDuration(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video')
    v.preload = 'metadata'
    v.muted = true
    v.onloadedmetadata = () => resolve(v.duration || 0)
    v.onerror = () => reject(new Error('Could not read clip metadata'))
    v.src = url
  })
}

export function buildSequence(
  clips: Clip[],
  durations: Map<string, number>,
  beatBpm: number,
  outLength: number,
): Segment[] {
  const tagged = clips.filter((c) => c.bpm != null)
  if (tagged.length === 0) throw new Error('No tagged clips available')

  const baseSegDuration = (BEATS_PER_CUT * 60) / beatBpm
  const runDuration = CUTS_PER_RUN * baseSegDuration
  const EPS = 1e-6

  // Footage left to play for each clip, measured from *after* its grid offset.
  // Each run starts on a grid beat and consumes a whole number of beats, so
  // advancing the read position by what we consume keeps the next run on-grid
  // (and therefore aligned to the song's beat) instead of replaying from offset.
  const footageAfterOffset = (c: Clip) =>
    Math.max(0, (durations.get(c.id) ?? 0) - (c.offset ?? 0))

  // Playback speed that lands this clip's beats on the producer's beats, kept near
  // natural speed by mapping a whole number of clip-beats onto each producer beat.
  const idealSpeedOf = (c: Clip) => {
    const clipBpm = c.bpm as number
    const beatMultiplier = Math.max(1, Math.round(clipBpm / beatBpm))
    return (beatMultiplier * beatBpm) / clipBpm
  }
  // Footage one full 4-bar run consumes from this clip at its ideal speed.
  const fullRunFootage = (c: Clip) => idealSpeedOf(c) * runDuration
  // Footage a half (2-bar) run consumes, for clips that fill a run by looping.
  const halfRunFootage = (c: Clip) => fullRunFootage(c) / 2

  // Clips that can supply a full 4-bar run play straight through. Clips holding
  // at least 2 bars but less than 4 (a "half-runner") play a single 2-bar cut,
  // so no clip is ever slowed off the beat. Clips under 2 bars are excluded.
  // Note eligibility depends on the beat's tempo: a slow beat maps two clip-beats
  // onto each song beat (beatMultiplier = 2), doubling the footage a run consumes.
  const isLooper = (c: Clip) => footageAfterOffset(c) < fullRunFootage(c) - EPS
  const usable = tagged.filter((c) => footageAfterOffset(c) >= halfRunFootage(c) - EPS)
  if (usable.length === 0) {
    throw new Error(
      'No clip in the library is long enough for even a 2-bar run at this tempo. Try a faster beat or add longer clips.',
    )
  }

  const remaining = new Map<string, number>(usable.map((c) => [c.id, footageAfterOffset(c)]))
  // Loopers always replay the same 2 bars, so they never run out of footage.
  const hasFullRun = (c: Clip) =>
    isLooper(c) || (remaining.get(c.id) ?? 0) >= fullRunFootage(c) - EPS

  const segments: Segment[] = []
  let lastId: string | null = null
  let totalDuration = 0

  // Bars emitted so far, and the bar each clip becomes eligible again at.
  let barsPlayed = 0
  const eligibleAtBar = new Map<string, number>()
  const offCooldown = (c: Clip) => barsPlayed >= (eligibleAtBar.get(c.id) ?? 0)

  // Clips holding at least one full 4-bar run, preferring those off cooldown.
  // Leftover footage below a full run is discarded (never time-warped to fill
  // one), so every emitted run is exactly 4 bars at its true synced speed. When
  // too few clips are off cooldown, the cooldown is dropped and we only avoid
  // an immediate repeat.
  const buildPool = (): Clip[] => {
    const ready = usable.filter(hasFullRun)
    const fresh = ready.filter(offCooldown)
    if (fresh.length > 0) return fresh
    const notLast = ready.filter((c) => c.id !== lastId)
    return notLast.length > 0 ? notLast : ready
  }

  while (totalDuration < outLength) {
    let pool = buildPool()

    if (pool.length === 0) {
      // Every straight-through clip's remaining footage is below one full run:
      // discard the tails and replay each clip from its grid offset. Every clip
      // in `usable` holds a run when fresh (loopers always do), so the pool is
      // guaranteed non-empty after this.
      for (const c of usable) remaining.set(c.id, footageAfterOffset(c))
      pool = buildPool()
    }

    const clip = pool[Math.floor(Math.random() * pool.length)]
    lastId = clip.id

    const duration = durations.get(clip.id) ?? 0
    const remainingLen = remaining.get(clip.id) ?? 0
    // Read position: the clip's grid offset on first play, advancing thereafter.
    const srcStart = duration - remainingLen

    const speed = idealSpeedOf(clip)
    const reuseGroup = clip.id + '-' + speed.toFixed(6)

    let runBars: number
    let runLength: number
    if (isLooper(clip)) {
      // Too short for a full 4-bar run, so it becomes a single 2-bar cut (played
      // once, never looped). The read position stays at the on-grid window, so
      // the timeline is a mix of 4-bar and 2-bar runs and every cut lands on a beat.
      const halfDuration = runDuration / 2
      const srcEnd = srcStart + halfDuration * speed
      segments.push({ clip, segDuration: halfDuration, speed, srcStart, srcEnd, reuseGroup: null })
      runBars = CUTS_PER_RUN / 2
      runLength = halfDuration
    } else {
      const srcEnd = srcStart + runDuration * speed
      remaining.set(clip.id, remainingLen - (srcEnd - srcStart))
      segments.push({ clip, segDuration: runDuration, speed, srcStart, srcEnd, reuseGroup })
      runBars = CUTS_PER_RUN
      runLength = runDuration
    }

    barsPlayed += runBars
    eligibleAtBar.set(clip.id, barsPlayed + COOLDOWN_BARS)
    totalDuration += runLength
  }

  return segments
}

/**
 * Snap every cut boundary to a whole output frame so concatenated segments join
 * cleanly. The *cumulative* boundary is snapped (not each duration independently),
 * so each boundary stays within half a frame of its true beat without drift
 * accumulating across cuts. Each segment's speed is recomputed so its trimmed
 * footage exactly fills the frame-aligned output duration.
 */
function frameAlignSegments(segments: Segment[], fps: number): void {
  let cumExact = 0
  let cumFrames = 0
  for (const seg of segments) {
    cumExact += seg.segDuration
    const targetFrames = Math.round(cumExact * fps)
    const frames = targetFrames - cumFrames
    const newDuration = frames / fps
    const footage = seg.srcEnd - seg.srcStart
    if (newDuration > 0 && footage > 0) seg.speed = footage / newDuration
    seg.segDuration = newDuration
    cumFrames = targetFrames
  }
}

export interface RenderResult {
  blob: Blob
  url: string
  segments: Segment[]
  /** Tagged clips dropped from this render because their footage was unreadable. */
  skipped: number
}

/**
 * Render the final vertical video: time-stretch each clip, cut every 4 bars,
 * concat, and mux the producer's beat as the audio track.
 */
export async function renderVideo(
  clips: Clip[],
  beatFile: File,
  beatBpm: number,
  outputLength: OutputLength,
  onset = 0,
  onProgress?: (ratio: number) => void,
): Promise<RenderResult> {
  const usable = clips.filter((c) => c.bpm != null)
  if (usable.length === 0) throw new Error('No tagged clips available')

  // Resolve each clip's duration (needed for speed clamping) and, at the same
  // time, drop any clip whose footage can't be loaded as real video. A missing
  // file (e.g. a manifest entry pointing at a clip that isn't deployed) typically
  // resolves to the SPA's index.html; feeding that to ffmpeg aborts the whole
  // render with "moov atom not found". Filtering here keeps one bad clip from
  // taking down a render the rest of the library could fulfil.
  const durations = new Map<string, number>()
  const playable: Clip[] = []
  await Promise.all(
    usable.map(async (c) => {
      try {
        durations.set(c.id, await getClipDuration(c.url))
        playable.push(c)
      } catch {
        /* unreadable footage -> exclude this clip from the render */
      }
    }),
  )
  if (playable.length === 0) {
    throw new Error(
      'No playable clips in the library. The clip files appear to be missing or unreadable.',
    )
  }

  const audioDuration = await getAudioDuration(beatFile)
  const requested = outputLength === 'full' ? audioDuration : outputLength
  const outLen = Math.min(requested, audioDuration, MAX_FULL_SECONDS)

  const segments = buildSequence(playable, durations, beatBpm, Math.max(0, outLen - onset))

  // If there's an intro before the beat starts, prepend a normal-speed clip.
  // The intro is pre-beat filler, so it plays from the clip's true start (0),
  // not its grid offset; there's no beat to align to yet.
  if (onset > 0) {
    const introClip = playable[Math.floor(Math.random() * playable.length)]
    const introSrc = durations.get(introClip.id) ?? 0
    segments.unshift({
      clip: introClip,
      segDuration: onset,
      speed: 1.0,
      srcStart: 0,
      srcEnd: Math.min(introSrc, onset),
      reuseGroup: null,
    })
  }

  // Snap cut boundaries (including the intro) to whole output frames.
  frameAlignSegments(segments, OUT_FPS)

  const ffmpeg = await getFFmpeg()

  // Progress is reported as one monotonic 0..1 ramp across two phases: writing
  // the input files into the ffmpeg FS (0 -> SETUP_SHARE, real time on multi-MB
  // clips) and encoding (SETUP_SHARE -> 0.99). The encode ratio is computed here
  // from the event's output timestamp against the known output length; the
  // core's own `progress` estimate is ignored because it guesses the duration
  // from the inputs, which is wrong for this multi-input filter graph.
  const SETUP_SHARE = 0.1
  let reported = 0
  const report = (r: number) => {
    reported = Math.max(reported, Math.min(1, r))
    onProgress?.(reported)
  }
  setProgressHandler((_progress, timeMicros) => {
    if (outLen > 0) report(SETUP_SHARE + (0.99 - SETUP_SHARE) * (timeMicros / 1e6 / outLen))
  })

  try {
    // Write one input file per segment (duplicates allowed; this keeps the filter
    // graph simple; fine for the handful of cuts in a <=60s clip).
    const inputArgs: string[] = []
    const filters: string[] = []
    const concatLabels: string[] = []
    for (let k = 0; k < segments.length; k++) {
      const seg = segments[k]
      const name = `in${k}.mp4`
      await ffmpeg.writeFile(name, await fetchFile(seg.clip.url))
      report(((k + 1) / segments.length) * SETUP_SHARE)
      inputArgs.push('-i', name)
      filters.push(
        `[${k}:v]trim=${seg.srcStart.toFixed(4)}:${seg.srcEnd.toFixed(4)},` +
          `setpts=(PTS-STARTPTS)/${seg.speed.toFixed(6)},` +
          `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,` +
          `crop=${OUT_W}:${OUT_H},setsar=1[v${k}]`,
      )
      concatLabels.push(`[v${k}]`)
    }

    const audioName = `audio.${extOf(beatFile.name)}`
    await ffmpeg.writeFile(audioName, await fetchFile(beatFile))
    const audioIndex = segments.length

    const filterComplex = [
      ...filters,
      `${concatLabels.join('')}concat=n=${segments.length}:v=1:a=0[outv]`,
      `[${audioIndex}:a]atrim=0:${outLen.toFixed(4)},asetpts=PTS-STARTPTS[outa]`,
    ].join(';')

    clearFFmpegLog()
    const code = await ffmpeg.exec([
      ...inputArgs,
      '-i', audioName,
      '-filter_complex', filterComplex,
      '-map', '[outv]',
      '-map', '[outa]',
      '-t', outLen.toFixed(4),
      '-r', String(OUT_FPS),
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      'out.mp4',
    ])
    // exec() resolves with the process exit code rather than throwing, so a
    // non-zero code means ffmpeg failed, so surface its log instead of dying on the
    // missing-output readFile below with a contentless error.
    if (code !== 0) {
      const tail = getFFmpegLog().split('\n').slice(-15).join('\n')
      throw new Error(`ffmpeg exited with code ${code}\n${tail}`)
    }

    const data = await ffmpeg.readFile('out.mp4')
    const blob = new Blob([data as BlobPart], { type: 'video/mp4' })
    report(1)

    // Clean up the in-memory FS so repeated renders don't accumulate.
    for (let k = 0; k < segments.length; k++) {
      await ffmpeg.deleteFile(`in${k}.mp4`).catch(() => {})
    }
    await ffmpeg.deleteFile(audioName).catch(() => {})
    await ffmpeg.deleteFile('out.mp4').catch(() => {})

    return {
      blob,
      url: URL.createObjectURL(blob),
      segments,
      skipped: usable.length - playable.length,
    }
  } finally {
    setProgressHandler(null)
  }
}

function extOf(name: string): string {
  const m = name.match(/\.([a-z0-9]+)$/i)
  return m ? m[1].toLowerCase() : 'mp3'
}

function getAudioDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const a = document.createElement('audio')
    a.preload = 'metadata'
    a.onloadedmetadata = () => resolve(a.duration || 0)
    a.onerror = () => reject(new Error('Could not read audio metadata'))
    a.src = URL.createObjectURL(file)
  })
}

import { fetchFile } from '@ffmpeg/util'
import type { Clip, OutputLength } from '../types'
import {
  getFFmpeg,
  setProgressHandler,
  clearFFmpegLog,
  getFFmpegLog,
  runExclusive,
} from './ffmpeg'

// 3:4 output (not 9:16): the portrait clips keep more of their frame after the
// center crop, so dancers aren't cut off at the sides.
const OUT_W = 1080
const OUT_H = 1440
const OUT_FPS = 30
// The editor's preview is encoded at a quarter of the pixels. It is displayed in
// a ~300px-wide monitor, so this is visually identical there, and it makes
// rebuilding after a clip swap a couple of seconds instead of half a minute.
// Download re-renders the same cut list at full size.
const PREVIEW_W = 540
const PREVIEW_H = 720
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
export const MAX_FULL_SECONDS = 60

const EPS = 1e-6

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
  /** 'intro' is the pre-beat filler prepended when the beat starts late: it plays
   *  at natural speed from the clip's trimStart because there is no beat to align
   *  to yet. Every other segment is 'beat' and is speed-synced to the grid. */
  kind: 'beat' | 'intro'
}

// ---------------------------------------------------------------------------
// Sync math. These three are the single source of truth for where a clip may be
// read from and how fast it must play; buildSequence and the editor's clip-swap
// path both go through them, so a swapped clip lands on the beat exactly the way
// a generated one does.
// ---------------------------------------------------------------------------

/** One bar: the 4-beat unit every cut lands on, and the only granularity the
 *  render can start at. The waveform's grid, the start picker and buildSequence
 *  all measure in these, so they can never disagree about where a bar begins. */
export function barSeconds(beatBpm: number): number {
  return (BEATS_PER_CUT * 60) / beatBpm
}

/**
 * Snap a time to a legal start point for the render. Legal points are the bar
 * lines drawn on the waveform — `onset + k` bars — plus 0, the head of the file,
 * which is the only start that includes the beat's lead-in.
 *
 * The result is clamped so at least one bar of music is left to render; a start
 * with nothing after it would produce an empty cut list.
 */
export function snapToBar(
  time: number,
  onset: number,
  beatBpm: number,
  duration: number,
): number {
  const bar = barSeconds(beatBpm)
  const maxStart = Math.max(0, duration - bar)
  if (onset >= maxStart) return 0
  const t = Math.max(0, Math.min(time, maxStart))
  // Below the halfway mark of the lead-in, the head of the file is nearer than
  // the first bar line, so that's what the click means.
  if (t < onset / 2) return 0
  const kMax = Math.floor((maxStart - onset) / bar + EPS)
  const k = Math.min(kMax, Math.max(0, Math.round((t - onset) / bar)))
  return onset + k * bar
}

/**
 * How many seconds of beat a render starting at `startAt` will cover: the
 * requested length, capped by what's left of the track and by MAX_FULL_SECONDS.
 * The generator shows this window on the waveform; planRender renders it.
 */
export function outputWindow(
  audioDuration: number,
  startAt: number,
  outputLength: OutputLength,
): number {
  const start = Math.max(0, Math.min(startAt, audioDuration))
  const available = Math.max(0, audioDuration - start)
  const requested = outputLength === 'full' ? available : outputLength
  return Math.min(requested, available, MAX_FULL_SECONDS)
}

/** Last readable position in a clip: its duration, capped by trimEnd. */
export function windowEnd(clip: Clip, duration: number): number {
  return Math.min(duration, Math.max(0, clip.trimEnd ?? duration))
}

/** First readable position: the clip's grid offset, snapped UP to the first grid
 *  beat at or after trimStart, so a run still begins on a beat. */
export function windowStart(clip: Clip): number {
  const off = clip.offset ?? 0
  const ts = Math.max(0, clip.trimStart ?? 0)
  if (ts <= off) return off
  const beat = 60 / (clip.bpm as number)
  const k = Math.max(0, Math.ceil((ts - off) / beat - EPS))
  return off + k * beat
}

/** Playback speed that lands this clip's beats on the producer's beats, kept near
 *  natural speed by mapping a whole number of clip-beats onto each producer beat. */
export function idealSpeedOf(clip: Clip, beatBpm: number): number {
  const clipBpm = clip.bpm as number
  const beatMultiplier = Math.max(1, Math.round(clipBpm / beatBpm))
  return (beatMultiplier * beatBpm) / clipBpm
}

/** Where a clip is read from when it fills the given slot, and how much footage
 *  that costs. Shared by canFillSlot and retimeSegment so the eligibility test and
 *  the swap itself can never disagree. */
function slotRead(
  seg: Segment,
  clip: Clip,
  beatBpm: number,
): { speed: number; srcStart: number; footage: number } {
  // The intro is pre-beat filler: natural speed, read from the clip's usable
  // start rather than its grid offset (see planRender).
  const speed = seg.kind === 'intro' ? 1 : idealSpeedOf(clip, beatBpm)
  const srcStart = seg.kind === 'intro' ? Math.max(0, clip.trimStart ?? 0) : windowStart(clip)
  return { speed, srcStart, footage: seg.segDuration * speed }
}

/**
 * Can this clip fill this slot without being time-warped off the beat? The slot's
 * output duration is fixed, so the clip must hold `segDuration * speed` seconds of
 * usable footage from its window start.
 */
export function canFillSlot(seg: Segment, clip: Clip, duration: number, beatBpm: number): boolean {
  if (clip.bpm == null) return false
  const { srcStart, footage } = slotRead(seg, clip, beatBpm)
  return windowEnd(clip, duration) - srcStart >= footage - EPS
}

/**
 * Put a different clip in an existing slot. `segDuration` is deliberately left
 * untouched — it was set by buildSequence and then snapped to whole output frames
 * by frameAlignSegments, so preserving it keeps every later cut exactly where it
 * was: still frame-aligned, still on the beat. Only the source window and speed
 * change. Callers must check canFillSlot first.
 */
export function retimeSegment(
  seg: Segment,
  clip: Clip,
  duration: number,
  beatBpm: number,
): Segment {
  const { speed, srcStart, footage } = slotRead(seg, clip, beatBpm)
  return {
    ...seg,
    clip,
    speed,
    srcStart,
    srcEnd: Math.min(windowEnd(clip, duration), srcStart + footage),
    reuseGroup: null,
  }
}

// ---------------------------------------------------------------------------
// Cut length editing
//
// A cut is a whole number of bars — 2 or 4, the same two lengths buildSequence
// emits. Changing one must not move any *other* cut: the timeline is frame-
// aligned to the beat, so a cut that gives up bars hands them to the cut beside
// it rather than dragging everything after it earlier. Total output length is
// invariant, every boundary outside the pair is untouched, and the preview only
// has to re-encode the one or two cuts that actually changed.
// ---------------------------------------------------------------------------

/** How many bars a cut spans. */
export function barsOf(seg: Segment, beatBpm: number): number {
  return Math.max(1, Math.round(seg.segDuration / barSeconds(beatBpm)))
}

/** Cumulative output frame a cut starts on. Every segDuration is a whole number
 *  of frames (frameAlignSegments), so this is exact rather than approximate. */
function startFrameOf(segments: Segment[], index: number): number {
  let frames = 0
  for (let i = 0; i < index; i++) frames += Math.round(segments[i].segDuration * OUT_FPS)
  return frames
}

/** The same clip at the same speed from the same place — just more or less of it. */
function resized(seg: Segment, segDuration: number): Segment {
  return {
    ...seg,
    segDuration,
    srcEnd: seg.srcStart + segDuration * seg.speed,
    reuseGroup: null,
  }
}

/** Does the clip hold enough footage to keep playing for `segDuration` from where
 *  this cut already reads? Lengthening a cut extends the take the viewer is
 *  already watching instead of restarting it at the clip's grid offset. */
function fitsExtended(
  seg: Segment,
  segDuration: number,
  durations: Map<string, number>,
): boolean {
  const end = windowEnd(seg.clip, durations.get(seg.clip.id) ?? 0)
  return seg.srcStart + segDuration * seg.speed <= end + EPS
}

/** Geometry of lengthening cut `index` to `bars` by taking music back from the
 *  cut after it: how long it becomes, and what's left of the cut it took from
 *  (null when that cut is swallowed whole). Null overall when there's nothing
 *  after it to take from. */
function growth(
  segments: Segment[],
  index: number,
  bars: number,
  beatBpm: number,
): { grownDur: number; followDur: number | null } | null {
  const seg = segments[index]
  const follow = segments[index + 1]
  if (!seg || !follow || follow.kind === 'intro') return null
  const startFrames = startFrameOf(segments, index)
  const endFrames = startFrames + Math.round(seg.segDuration * OUT_FPS)
  const followEnd = endFrames + Math.round(follow.segDuration * OUT_FPS)
  // The new boundary is the ideal bar line snapped to a whole frame — exactly
  // where frameAlignSegments would have put it had the plan contained this
  // layout in the first place, so the cut still lands on the music.
  const ideal = Math.round(startFrames + bars * barSeconds(beatBpm) * OUT_FPS)
  const mid = Math.min(ideal, followEnd)
  if (mid <= endFrames) return null
  return {
    grownDur: (mid - startFrames) / OUT_FPS,
    followDur: mid >= followEnd ? null : (followEnd - mid) / OUT_FPS,
  }
}

/** A cut for the bars freed by shortening `seg`: a library clip that fits them at
 *  its synced speed, preferring one that isn't already on either side of the join. */
function fillFreedBars(
  seg: Segment,
  segDuration: number,
  segments: Segment[],
  index: number,
  library: Clip[],
  durations: Map<string, number>,
  beatBpm: number,
): Segment {
  const slot: Segment = { ...seg, segDuration }
  const fits = library.filter((c) => canFillSlot(slot, c, durations.get(c.id) ?? 0, beatBpm))
  const neighbours = new Set([seg.clip.id, segments[index + 1]?.clip.id])
  const fresh = fits.filter((c) => !neighbours.has(c.id))
  const pool = fresh.length > 0 ? fresh : fits
  // seg's own clip is the guaranteed fallback: it just played this stretch and
  // more at the same speed, so it certainly holds the shorter slot.
  const clip = pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : seg.clip
  return retimeSegment(slot, clip, durations.get(clip.id) ?? 0, beatBpm)
}

/**
 * Can cut `index` be set to `bars`? Shortening always can (a new cut takes the
 * freed bars). Lengthening needs a cut after it to take the bars from, and needs
 * this clip to hold that much more footage without being time-warped off the beat.
 */
export function canSetBars(
  segments: Segment[],
  index: number,
  bars: number,
  durations: Map<string, number>,
  beatBpm: number,
): boolean {
  const seg = segments[index]
  if (!seg || seg.kind === 'intro') return false
  const current = barsOf(seg, beatBpm)
  if (bars === current) return true
  if (bars < current) return true
  const g = growth(segments, index, bars, beatBpm)
  return g != null && fitsExtended(seg, g.grownDur, durations)
}

/**
 * Set cut `index` to `bars`, returning the new cut list — or the list unchanged
 * if that isn't possible (check `canSetBars` to offer it in the first place).
 *
 * Shortening splits the slot: the cut keeps its first `bars` and a fresh cut
 * plays the rest of the same stretch of music. Lengthening does the reverse,
 * taking bars back from the cut that follows and dropping it if nothing is left.
 * Either way the boundary at the far end of the pair stays exactly where it was.
 */
export function setBars(
  segments: Segment[],
  index: number,
  bars: number,
  library: Clip[],
  durations: Map<string, number>,
  beatBpm: number,
): Segment[] {
  const seg = segments[index]
  if (!seg || seg.kind === 'intro') return segments
  const current = barsOf(seg, beatBpm)
  if (bars === current) return segments
  const next = segments.slice()

  if (bars > current) {
    const g = growth(segments, index, bars, beatBpm)
    if (!g || !fitsExtended(seg, g.grownDur, durations)) return segments
    const grown = resized(seg, g.grownDur)
    if (g.followDur == null) next.splice(index, 2, grown)
    else next.splice(index, 2, grown, resized(segments[index + 1], g.followDur))
    return next
  }

  const startFrames = startFrameOf(segments, index)
  const endFrames = startFrames + Math.round(seg.segDuration * OUT_FPS)
  const ideal = Math.round(startFrames + bars * barSeconds(beatBpm) * OUT_FPS)
  // Both halves must keep at least a frame, or the concat would carry an empty cut.
  const mid = Math.min(endFrames - 1, Math.max(startFrames + 1, ideal))
  const head = resized(seg, (mid - startFrames) / OUT_FPS)
  const tail = fillFreedBars(
    seg,
    (endFrames - mid) / OUT_FPS,
    segments,
    index,
    library,
    durations,
    beatBpm,
  )
  next.splice(index, 1, head, tail)
  return next
}

// Clip durations never change within a session, and probing one costs a media
// load. Caching them makes every render after the first skip the whole probe
// pass (25 clips = 25 loads) instead of repeating it.
const durationCache = new Map<string, number>()

/** Read a clip's duration via a throwaway <video> element. */
export function getClipDuration(url: string): Promise<number> {
  const cached = durationCache.get(url)
  if (cached != null) return Promise.resolve(cached)

  return new Promise((resolve, reject) => {
    const v = document.createElement('video')
    v.preload = 'metadata'
    v.muted = true
    // Drop the source as soon as we have the number: without this the element
    // keeps its buffered data (and decoder) until GC gets round to it.
    const release = () => {
      v.removeAttribute('src')
      v.load()
    }
    v.onloadedmetadata = () => {
      const duration = v.duration || 0
      release()
      durationCache.set(url, duration)
      resolve(duration)
    }
    v.onerror = () => {
      release()
      reject(new Error('Could not read clip metadata'))
    }
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

  // Usable footage window per clip: [windowStart, windowEnd] (module-level, shared
  // with the editor's swap path). Anything before trimStart or after trimEnd is
  // NEVER read, so trimmed footage can never end up in a render.
  const endOf = (c: Clip) => windowEnd(c, durations.get(c.id) ?? 0)
  // Footage left to play for each clip, measured from windowStart. Each run
  // starts on a grid beat and consumes a whole number of beats, so advancing the
  // read position by what we consume keeps the next run on-grid.
  const footageAfterOffset = (c: Clip) => Math.max(0, endOf(c) - windowStart(c))

  // Footage one full 4-bar run consumes from this clip at its ideal speed.
  const fullRunFootage = (c: Clip) => idealSpeedOf(c, beatBpm) * runDuration
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

    const remainingLen = remaining.get(clip.id) ?? 0
    // Read position: windowStart on first play, advancing thereafter. Counting
    // back from windowEnd keeps every read inside [windowStart, windowEnd].
    const srcStart = endOf(clip) - remainingLen

    const speed = idealSpeedOf(clip, beatBpm)
    const reuseGroup = clip.id + '-' + speed.toFixed(6)

    let runBars: number
    let runLength: number
    if (isLooper(clip)) {
      // Too short for a full 4-bar run, so it becomes a single 2-bar cut (played
      // once, never looped). The read position stays at the on-grid window, so
      // the timeline is a mix of 4-bar and 2-bar runs and every cut lands on a beat.
      const halfDuration = runDuration / 2
      const srcEnd = srcStart + halfDuration * speed
      segments.push({
        clip,
        segDuration: halfDuration,
        speed,
        srcStart,
        srcEnd,
        reuseGroup: null,
        kind: 'beat',
      })
      runBars = CUTS_PER_RUN / 2
      runLength = halfDuration
    } else {
      const srcEnd = srcStart + runDuration * speed
      remaining.set(clip.id, remainingLen - (srcEnd - srcStart))
      segments.push({
        clip,
        segDuration: runDuration,
        speed,
        srcStart,
        srcEnd,
        reuseGroup,
        kind: 'beat',
      })
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

export interface RenderPlan {
  /** The cut list: which clip plays when, at what speed, from where. */
  segments: Segment[]
  /** Clips that loaded as real video, with their measured durations. The editor
   *  needs both to offer replacements and test whether one fits a slot. */
  playable: Clip[]
  durations: Map<string, number>
  /** Final output length in seconds (capped by the beat and MAX_FULL_SECONDS). */
  outLen: number
  /** Where in the beat this render starts (seconds). The cut list is relative to
   *  it, so every encode of these segments must trim the audio from here. */
  audioStart: number
  /** Tagged clips dropped from this plan because their footage was unreadable. */
  skipped: number
}

/**
 * Decide what the video will contain, without encoding anything: probe the
 * library, work out the output length, and build the frame-aligned cut list.
 * Cheap enough to run before the (slow) encode, and it produces the Segment[]
 * the editor lets the user rework before exporting.
 */
export async function planRender(
  clips: Clip[],
  beatFile: File,
  beatBpm: number,
  outputLength: OutputLength,
  onset = 0,
  startAt = 0,
): Promise<RenderPlan> {
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
  // The render starts here in the beat, not necessarily at 0: the user can pick
  // any bar line. Everything below is measured from this point.
  const audioStart = Math.max(0, Math.min(startAt, audioDuration))
  const outLen = outputWindow(audioDuration, audioStart, outputLength)
  if (outLen <= 0) {
    throw new Error('The start point is at the end of the beat. Move it earlier and try again.')
  }

  // Only a render that starts before the first beat has a lead-in to cover. Start
  // on any bar line and the music is already going, so there is no filler at all.
  const introLen = Math.max(0, onset - audioStart)

  const segments = buildSequence(playable, durations, beatBpm, Math.max(0, outLen - introLen))

  // If there's an intro before the beat starts, prepend a normal-speed clip.
  // The intro is pre-beat filler, so it plays from the start of the clip's
  // usable window (trimStart), not its grid offset; there's no beat to align to
  // yet. It still never reaches past trimEnd.
  if (introLen > 0) {
    const introClip = playable[Math.floor(Math.random() * playable.length)]
    const introDur = durations.get(introClip.id) ?? 0
    const introStart = Math.max(0, introClip.trimStart ?? 0)
    const introEnd = Math.min(introDur, introClip.trimEnd ?? introDur)
    segments.unshift({
      clip: introClip,
      segDuration: introLen,
      speed: 1.0,
      srcStart: introStart,
      srcEnd: Math.min(introEnd, introStart + introLen),
      reuseGroup: null,
      kind: 'intro',
    })
  }

  // Snap cut boundaries (including the intro) to whole output frames.
  frameAlignSegments(segments, OUT_FPS)

  return {
    segments,
    playable,
    durations,
    outLen,
    audioStart,
    skipped: usable.length - playable.length,
  }
}

/**
 * Encode a cut list at full output size in one pass: time-stretch each clip,
 * concat, and mux the producer's beat as the audio track. This is the download
 * path — the editor previews with `renderPreview` instead, which is far cheaper
 * to rebuild after an edit.
 */
export async function renderSegments(
  segments: Segment[],
  beatFile: File,
  outLen: number,
  audioStart: number,
  onProgress?: (ratio: number) => void,
): Promise<{ blob: Blob; url: string }> {
  if (segments.length === 0) throw new Error('Nothing to render')
  return runExclusive(() =>
    renderSegmentsExclusive(segments, beatFile, outLen, audioStart, onProgress),
  )
}

async function renderSegmentsExclusive(
  segments: Segment[],
  beatFile: File,
  outLen: number,
  audioStart: number,
  onProgress?: (ratio: number) => void,
): Promise<{ blob: Blob; url: string }> {
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

  // A clip used by several cuts is written into the ffmpeg FS *once* and opened
  // once per cut. The emscripten heap holds every written file for the whole
  // render, so writing per-cut used to store a 9MB clip as many times as it was
  // cut in — the quickest way to hit "memory access out of bounds" on a long
  // edit. Passing the same filename to several -i costs only an extra demuxer.
  // Input index still equals segment index, so the filter graph is unchanged.
  const fileFor = new Map<string, string>()
  for (const seg of segments) {
    if (!fileFor.has(seg.clip.url)) fileFor.set(seg.clip.url, `in${fileFor.size}.mp4`)
  }

  try {
    const inputArgs: string[] = []
    const filters: string[] = []
    const concatLabels: string[] = []

    let written = 0
    for (const [url, name] of fileFor) {
      await ffmpeg.writeFile(name, await fetchFile(url))
      written += 1
      report((written / fileFor.size) * SETUP_SHARE)
    }

    for (let k = 0; k < segments.length; k++) {
      const seg = segments[k]
      inputArgs.push('-i', fileFor.get(seg.clip.url)!)
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
      // The video starts at the picked bar, so the beat has to as well: trim from
      // audioStart and rebase the timestamps to zero.
      `[${audioIndex}:a]atrim=${audioStart.toFixed(4)}:${(audioStart + outLen).toFixed(4)},` +
        `asetpts=PTS-STARTPTS[outa]`,
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
    for (const name of fileFor.values()) {
      await ffmpeg.deleteFile(name).catch(() => {})
    }
    await ffmpeg.deleteFile(audioName).catch(() => {})
    await ffmpeg.deleteFile('out.mp4').catch(() => {})

    return { blob, url: URL.createObjectURL(blob) }
  } finally {
    setProgressHandler(null)
  }
}

// ---------------------------------------------------------------------------
// Preview pipeline
//
// The editor plays a real encoded MP4, always — never a stack of <video>
// elements driven from JS. A DOM player has to keep every clip decoding at once
// and steer them off an audio clock; that is fine on a fast machine and janks
// badly on anything else, and it cannot be made reliable across hardware. An
// MP4 is one file and one decoder, which is exactly why playback was smooth
// before an edit and awful after it.
//
// To keep editing quick, each cut is encoded to its own small MP4 and cached, so
// a swap re-encodes one cut and then just *copies* them all together. The concat
// is a stream copy: no re-encoding of untouched footage.
// ---------------------------------------------------------------------------

/** Filter chain for a single cut at a given output size. */
function cutFilter(seg: Segment, width: number, height: number): string {
  return (
    `trim=${seg.srcStart.toFixed(4)}:${seg.srcEnd.toFixed(4)},` +
    `setpts=(PTS-STARTPTS)/${seg.speed.toFixed(6)},` +
    `scale=${width}:${height}:force_original_aspect_ratio=increase,` +
    `crop=${width}:${height},setsar=1,` +
    // Hold the last frame if the clip can't quite fill its slot. Without this a
    // short cut (the intro especially, which is allowed to be) comes out with
    // fewer frames than the timeline expects and drags every later cut off the
    // beat. Combined with -frames:v the cut is *exactly* the right length.
    `tpad=stop_mode=clone:stop_duration=${seg.segDuration.toFixed(4)}`
  )
}

/** Identity of an encoded cut: same key means the same frames, so reuse them. */
function segmentKey(seg: Segment): string {
  return [
    seg.clip.url,
    seg.srcStart.toFixed(4),
    seg.srcEnd.toFixed(4),
    seg.speed.toFixed(6),
    seg.segDuration.toFixed(4),
  ].join('|')
}

/** Cached cut encodes, oldest first (Map preserves insertion order). */
const cutCache = new Map<string, string>()
const CUT_CACHE_LIMIT = 32
let cutSeq = 0

/** Beat encoded to AAC once, so every rebuild can copy it rather than re-encode.
 *  Keyed by the exact window it covers, so moving the start point re-encodes it. */
let previewAudio: { file: File; outLen: number; start: number; name: string } | null = null

type FFmpegInstance = Awaited<ReturnType<typeof getFFmpeg>>

function failed(code: number, what: string): Error {
  const tail = getFFmpegLog().split('\n').slice(-15).join('\n')
  return new Error(`ffmpeg exited with code ${code} while ${what}\n${tail}`)
}

/** Encode one cut to its own MP4 in the ffmpeg FS, reusing a previous encode. */
async function encodeCut(ffmpeg: FFmpegInstance, seg: Segment): Promise<string> {
  const key = segmentKey(seg)
  const hit = cutCache.get(key)
  if (hit) {
    // Re-insert so the least recently used entry stays at the front.
    cutCache.delete(key)
    cutCache.set(key, hit)
    return hit
  }

  const source = 'cutsrc.mp4'
  const name = `cut${cutSeq++}.mp4`
  await ffmpeg.writeFile(source, await fetchFile(seg.clip.url))
  clearFFmpegLog()
  const code = await ffmpeg.exec([
    '-i', source,
    '-vf', cutFilter(seg, PREVIEW_W, PREVIEW_H),
    '-an',
    '-frames:v', String(Math.max(1, Math.round(seg.segDuration * OUT_FPS))),
    '-r', String(OUT_FPS),
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p',
    name,
  ])
  // The clip is only needed for this one encode; holding it would put every
  // clip in the library into the emscripten heap at once.
  await ffmpeg.deleteFile(source).catch(() => {})
  if (code !== 0) throw failed(code, `encoding a cut of ${seg.clip.name}`)

  cutCache.set(key, name)
  while (cutCache.size > CUT_CACHE_LIMIT) {
    const oldest = cutCache.keys().next().value as string
    const file = cutCache.get(oldest)!
    cutCache.delete(oldest)
    await ffmpeg.deleteFile(file).catch(() => {})
  }
  return name
}

async function ensurePreviewAudio(
  ffmpeg: FFmpegInstance,
  beatFile: File,
  outLen: number,
  start: number,
): Promise<string> {
  if (
    previewAudio &&
    previewAudio.file === beatFile &&
    previewAudio.outLen === outLen &&
    previewAudio.start === start
  ) {
    return previewAudio.name
  }
  const source = `beatsrc.${extOf(beatFile.name)}`
  const name = 'beat.m4a'
  await ffmpeg.writeFile(source, await fetchFile(beatFile))
  clearFFmpegLog()
  const code = await ffmpeg.exec([
    '-i', source,
    // Deliberately the same atrim the export uses rather than an input -ss seek:
    // a container-level seek lands on the nearest packet, so the preview's audio
    // could sit a frame off from the file the user downloads.
    '-af', `atrim=${start.toFixed(4)}:${(start + outLen).toFixed(4)},asetpts=PTS-STARTPTS`,
    '-t', outLen.toFixed(4),
    '-vn',
    '-c:a', 'aac',
    '-b:a', '128k',
    name,
  ])
  await ffmpeg.deleteFile(source).catch(() => {})
  if (code !== 0) throw failed(code, 'encoding the beat')
  previewAudio = { file: beatFile, outLen, start, name }
  return name
}

/** Drop every cached cut. Called when a new render starts. */
export async function resetPreviewCache(): Promise<void> {
  if (cutCache.size === 0 && !previewAudio) return
  await runExclusive(async () => {
    const ffmpeg = await getFFmpeg()
    for (const file of cutCache.values()) await ffmpeg.deleteFile(file).catch(() => {})
    cutCache.clear()
    if (previewAudio) await ffmpeg.deleteFile(previewAudio.name).catch(() => {})
    previewAudio = null
  })
}

/**
 * Build the editor's preview: encode any cut that isn't already encoded, then
 * copy them together and mux the beat. Only changed cuts cost anything, so a
 * swap is one small encode plus a stream copy.
 */
export async function renderPreview(
  segments: Segment[],
  beatFile: File,
  outLen: number,
  audioStart: number,
  onProgress?: (ratio: number) => void,
): Promise<{ blob: Blob; url: string }> {
  if (segments.length === 0) throw new Error('Nothing to render')

  return runExclusive(async () => {
    const ffmpeg = await getFFmpeg()
    // Per-cut progress from the core is relative to each cut, which would make
    // the bar restart constantly; report completed cuts instead.
    setProgressHandler(null)
    const steps = segments.length + 1
    let done = 0
    onProgress?.(0)

    try {
      const audioName = await ensurePreviewAudio(ffmpeg, beatFile, outLen, audioStart)
      const cuts: string[] = []
      for (const seg of segments) {
        cuts.push(await encodeCut(ffmpeg, seg))
        done += 1
        onProgress?.(done / steps)
      }

      const list = cuts.map((name) => `file '${name}'`).join('\n') + '\n'
      await ffmpeg.writeFile('cuts.txt', new TextEncoder().encode(list))

      clearFFmpegLog()
      const code = await ffmpeg.exec([
        '-f', 'concat',
        '-safe', '0',
        '-i', 'cuts.txt',
        '-i', audioName,
        '-map', '0:v',
        '-map', '1:a',
        '-c', 'copy',
        // The cut list is allowed to overshoot (the last run is emitted whole),
        // and the export trims the same way, so the preview must match it or the
        // two would disagree on length.
        '-t', outLen.toFixed(4),
        '-movflags', '+faststart',
        'preview.mp4',
      ])
      if (code !== 0) throw failed(code, 'assembling the preview')

      const data = await ffmpeg.readFile('preview.mp4')
      const blob = new Blob([data as BlobPart], { type: 'video/mp4' })
      await ffmpeg.deleteFile('preview.mp4').catch(() => {})
      await ffmpeg.deleteFile('cuts.txt').catch(() => {})
      onProgress?.(1)
      return { blob, url: URL.createObjectURL(blob) }
    } finally {
      setProgressHandler(null)
    }
  })
}

function extOf(name: string): string {
  const m = name.match(/\.([a-z0-9]+)$/i)
  return m ? m[1].toLowerCase() : 'mp3'
}

function getAudioDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const a = document.createElement('audio')
    a.preload = 'metadata'
    const url = URL.createObjectURL(file)
    // Held for the life of the tab otherwise, and this runs on every Generate.
    const release = () => URL.revokeObjectURL(url)
    a.onloadedmetadata = () => {
      release()
      resolve(a.duration || 0)
    }
    a.onerror = () => {
      release()
      reject(new Error('Could not read audio metadata'))
    }
    a.src = url
  })
}

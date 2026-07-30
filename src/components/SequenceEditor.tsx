import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Clip } from '../types'
import {
  barsOf,
  canFillSlot,
  canSetBars,
  retimeSegment,
  setBars,
  windowStart,
  type Segment,
} from '../lib/render'
import { ClipThumb } from './ClipThumb'

interface SequenceEditorProps {
  segments: Segment[]
  /** The cut list as first generated, so any slot can be put back. */
  originalSegments: Segment[]
  /** Clips offerable as replacements (the plan's playable set). */
  library: Clip[]
  durations: Map<string, number>
  beatBpm: number
  /** The encoded preview of the current cut list. */
  previewUrl: string | null
  /** True while the preview is being rebuilt after an edit. */
  busy: boolean
  /** Rebuild progress, 0-100. */
  progress: number
  onChange: (next: Segment[]) => void
}

/**
 * The post-render editor: shows the cut list as a timeline and lets any slot's
 * clip be swapped for another from the library.
 *
 * The monitor plays an ordinary encoded MP4 and nothing else. An earlier version
 * switched to a JS-driven stack of <video> elements as soon as you edited, so it
 * could show a swap instantly without re-encoding; that is what made playback
 * lag the moment a clip was changed. Keeping several clips decoding at once and
 * steering them off an audio clock is simply not something you can make smooth
 * across different hardware — so the editor doesn't. Every edit rebuilds a real
 * file (cheaply, one cut at a time — see `renderPreview`), and what you watch is
 * always just a video.
 */
export function SequenceEditor({
  segments,
  originalSegments,
  library,
  durations,
  beatBpm,
  previewUrl,
  busy,
  progress,
  onChange,
}: SequenceEditorProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [activeIdx, setActiveIdx] = useState(0)
  const [pickerFor, setPickerFor] = useState<number | null>(null)

  // Cut boundaries in output time.
  const boundaries = (list: Segment[]) => {
    const out: number[] = []
    let t = 0
    for (const seg of list) {
      out.push(t)
      t += seg.segDuration
    }
    return out
  }
  const starts = useMemo(() => boundaries(segments), [segments])
  const originalStarts = useMemo(() => boundaries(originalSegments), [originalSegments])

  /**
   * The cut that occupied this moment of the video when it was first generated.
   * Looked up by *time*, not by index: changing a cut's length inserts or drops
   * cuts, so index N is no longer the same moment of music it used to be — but
   * the total length never changes, so a time always maps.
   */
  const originalAt = useCallback(
    (t: number): Segment | null => {
      for (let i = originalStarts.length - 1; i >= 0; i--) {
        if (t >= originalStarts[i] - 1e-6) return originalSegments[i]
      }
      return originalSegments[0] ?? null
    },
    [originalStarts, originalSegments],
  )

  const segmentAt = useCallback(
    (t: number) => {
      for (let i = starts.length - 1; i >= 0; i--) if (t >= starts[i] - 1e-6) return i
      return starts.length > 0 ? 0 : -1
    },
    [starts],
  )

  // Where the viewer was when the preview was replaced. A rebuild swaps the
  // video's src, which would otherwise dump them back at 0:00 and paused every
  // time they changed a clip.
  const resume = useRef({ time: 0, playing: false })
  useEffect(() => {
    const video = videoRef.current
    if (!video || !previewUrl) return
    const { time, playing } = resume.current
    const restore = () => {
      if (time > 0 && Number.isFinite(video.duration) && time < video.duration) {
        video.currentTime = time
      }
      if (playing) video.play().catch(() => {})
    }
    if (video.readyState >= 1) restore()
    else video.addEventListener('loadedmetadata', restore, { once: true })
  }, [previewUrl])

  const replace = (idx: number, clip: Clip) => {
    const next = segments.slice()
    next[idx] = retimeSegment(segments[idx], clip, durations.get(clip.id) ?? 0, beatBpm)
    onChange(next)
    setPickerFor(null)
  }

  /** Put the clip that originally played here back in this slot. The slot itself
   *  is left alone — its length may have been edited since, and the timeline is
   *  built on those lengths. */
  const restoreCut = (idx: number) => {
    const orig = originalAt(starts[idx])
    if (!orig) return
    const seg = segments[idx]
    const next = segments.slice()
    // Untouched slot: put the original cut back exactly, down to its read window.
    next[idx] =
      Math.abs(orig.segDuration - seg.segDuration) < 1e-6 &&
      Math.abs((originalStarts[idx] ?? -1) - starts[idx]) < 1e-6
        ? orig
        : retimeSegment(seg, orig.clip, durations.get(orig.clip.id) ?? 0, beatBpm)
    onChange(next)
    setPickerFor(null)
  }

  /** Make this cut 2 or 4 bars long; the cut beside it absorbs the difference. */
  const changeBars = (idx: number, bars: number) => {
    const next = setBars(segments, idx, bars, library, durations, beatBpm)
    if (next !== segments) onChange(next)
  }

  // Only clips that can fill this exact slot at their synced speed are offered;
  // anything shorter would have to be time-warped off the beat.
  const options = useMemo(() => {
    if (pickerFor == null) return []
    const seg = segments[pickerFor]
    return library.filter((c) => canFillSlot(seg, c, durations.get(c.id) ?? 0, beatBpm))
  }, [pickerFor, segments, library, durations, beatBpm])

  useEffect(() => {
    if (pickerFor == null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPickerFor(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pickerFor])

  const swapped = (i: number) => {
    const seg = segments[i]
    const orig = originalAt(starts[i])
    return seg != null && orig != null && seg.clip.id !== orig.clip.id
  }

  /** The original clip can only go back if it fits the slot as it stands now. */
  const restorable = (i: number) => {
    const orig = originalAt(starts[i])
    if (!orig || !swapped(i)) return false
    return canFillSlot(segments[i], orig.clip, durations.get(orig.clip.id) ?? 0, beatBpm)
  }

  return (
    <div className="editor">
      <div className="monitor__frame editor__monitor">
        <video
          ref={videoRef}
          className="preview__video"
          src={previewUrl ?? undefined}
          controls
          loop
          playsInline
          onTimeUpdate={(e) => {
            const video = e.currentTarget
            resume.current.time = video.currentTime
            const idx = segmentAt(video.currentTime)
            if (idx >= 0 && idx !== activeIdx) setActiveIdx(idx)
          }}
          onPlay={() => (resume.current.playing = true)}
          onPause={() => (resume.current.playing = false)}
        />
        {busy && (
          <div className="editor__busy">
            <span className="microlabel">Rebuilding preview</span>
            <div className="meter">
              <div className="meter__track">
                <div className="meter__fill" style={{ width: `${progress}%` }} />
              </div>
              <span className="meter__pct">{progress}%</span>
            </div>
          </div>
        )}
      </div>

      <div className="editor__head">
        <span className="microlabel">Timeline · {segments.length} cuts</span>
        <span className="editor__hint">
          Click a cut to swap its clip, or set it to 2 or 4 bars.
        </span>
      </div>

      <div className="editor__timeline strip__scroll">
        {segments.map((seg, i) => {
          const bars = barsOf(seg, beatBpm)
          return (
            <button
              key={i}
              type="button"
              className={
                'editor__seg' +
                (activeIdx === i ? ' editor__seg--active' : '') +
                (swapped(i) ? ' editor__seg--swapped' : '')
              }
              style={{ flexGrow: seg.segDuration }}
              onClick={() => {
                const video = videoRef.current
                if (video && Number.isFinite(video.duration)) video.currentTime = starts[i]
                setActiveIdx(i)
                setPickerFor(i)
              }}
              title={seg.clip.name}
            >
              <ClipThumb
                className="editor__seg-thumb"
                src={seg.clip.url}
                seekTo={seg.srcStart + 0.05}
                rootSelector=".editor__timeline"
              />
              <span className="editor__seg-meta">
                <span className="editor__seg-name">{seg.clip.name}</span>
                <span className="editor__seg-bars">
                  {seg.kind === 'intro' ? 'intro' : `${bars} bar${bars > 1 ? 's' : ''}`}
                </span>
              </span>
            </button>
          )
        })}
      </div>

      {pickerFor != null && (
        <div className="picker" role="dialog" aria-label="Choose a replacement clip">
          <div className="picker__panel">
            <div className="picker__head">
              <span className="microlabel">
                Cut {pickerFor + 1} · {options.length} clip
                {options.length === 1 ? '' : 's'} fit this slot
              </span>

              {segments[pickerFor].kind !== 'intro' && (
                <div className="picker__len">
                  <span className="microlabel">Length</span>
                  <div className="switch">
                    {[2, 4].map((bars) => {
                      const current = barsOf(segments[pickerFor], beatBpm) === bars
                      const allowed =
                        current || canSetBars(segments, pickerFor, bars, durations, beatBpm)
                      return (
                        <button
                          key={bars}
                          type="button"
                          className={`switch__opt${current ? ' switch__opt--active' : ''}`}
                          disabled={!allowed}
                          title={
                            allowed
                              ? undefined
                              : pickerFor === segments.length - 1
                                ? 'The last cut has nothing after it to take bars from.'
                                : `${segments[pickerFor].clip.name} doesn't hold ${bars} bars from here at this tempo.`
                          }
                          onClick={() => changeBars(pickerFor, bars)}
                        >
                          {bars} bars
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              <div className="picker__actions">
                {restorable(pickerFor) && (
                  <button
                    type="button"
                    className="ctl ctl--quiet"
                    onClick={() => restoreCut(pickerFor)}
                  >
                    Restore original
                  </button>
                )}
                <button type="button" className="ctl ctl--quiet" onClick={() => setPickerFor(null)}>
                  Close
                </button>
              </div>
            </div>

            {options.length === 0 ? (
              <p className="editor__hint">
                No other clip in the library holds enough footage for this cut at this tempo.
              </p>
            ) : (
              <div className="picker__grid">
                {options.map((clip) => (
                  <button
                    key={clip.id}
                    type="button"
                    className={
                      'picker__item' +
                      (clip.id === segments[pickerFor].clip.id ? ' picker__item--current' : '')
                    }
                    onClick={() => replace(pickerFor, clip)}
                    title={clip.name}
                  >
                    <ClipThumb
                      className="picker__thumb"
                      src={clip.url}
                      seekTo={windowStart(clip) + 0.05}
                      rootSelector=".picker__grid"
                    />
                    <span className="picker__name">{clip.name}</span>
                    <span className="picker__bpm">{clip.bpm?.toFixed(0)} BPM</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

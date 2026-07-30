import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Clip } from '../types'
import { clipsFromEntries, exportManifest } from '../lib/manifest'
import {
  fetchLibraryEntries,
  patchClip,
  deleteClipById,
  uploadClips,
  type UploadProgress,
} from '../lib/libraryApi'
import { calculateGrid, shiftGrid, nudgeBpm, gridBeatTimes, type GridResult } from '../lib/tapTempo'
import { primeMetronome, playClick } from '../lib/metronome'
import { DropZone } from '../components/DropZone'
import { ClipThumb } from '../components/ClipThumb'
import { TrimBar, type TrimRange } from '../components/TrimBar'

export function TagPage() {
  const [clips, setClips] = useState<Clip[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [upload, setUpload] = useState<UploadProgress | null>(null)
  // Default to hiding already-tagged clips so a fresh dump is the only thing in
  // front of you: you tag what you just added and never re-tap saved clips.
  const [untaggedOnly, setUntaggedOnly] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const videoRef = useRef<HTMLVideoElement>(null)
  const [taps, setTaps] = useState<number[]>([])
  const [grid, setGrid] = useState<GridResult | null>(null)
  const [clipDuration, setClipDuration] = useState(0)
  const [playhead, setPlayhead] = useState(0)
  // Usable window [start, end] in seconds for the current clip. null until the
  // video's metadata (and therefore its duration) has loaded.
  const [trim, setTrim] = useState<TrimRange | null>(null)
  const [metronome, setMetronome] = useState(true)
  // Hear the clip's own audio while tagging. Off by default (clips autoplay
  // muted); the preference persists as you move between clips.
  const [clipAudio, setClipAudio] = useState(false)

  // Refs read by the rAF loop so it sees the latest values without restarting.
  const gridRef = useRef<GridResult | null>(null)
  const metronomeRef = useRef(metronome)
  const beatIndexRef = useRef(NaN) // last grid beat the playhead was on (NaN = re-baseline)
  const lastTimeRef = useRef(0)

  useEffect(() => {
    gridRef.current = grid
    beatIndexRef.current = NaN // grid moved/changed: re-baseline, don't click immediately
  }, [grid])
  useEffect(() => {
    metronomeRef.current = metronome
  }, [metronome])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setClips(clipsFromEntries(await fetchLibraryEntries()))
      setError(null)
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const untaggedCount = useMemo(() => clips.filter((c) => c.bpm == null).length, [clips])

  // The queue the operator actually walks: untagged-only by default.
  const visible = useMemo(
    () => (untaggedOnly ? clips.filter((c) => c.bpm == null) : clips),
    [clips, untaggedOnly],
  )

  const currentIndex = visible.findIndex((c) => c.id === selectedId)
  const currentClip = currentIndex >= 0 ? visible[currentIndex] : visible[0] ?? null

  // Keep the selection valid as the library / filter changes (e.g. after saving
  // a clip drops out of the untagged queue).
  useEffect(() => {
    if (visible.length === 0) {
      if (selectedId !== null) setSelectedId(null)
    } else if (!visible.some((c) => c.id === selectedId)) {
      setSelectedId(visible[0].id)
    }
  }, [visible, selectedId])

  // Keyed on the clip id (not the object) so persisting a trim/grid edit in
  // place — which produces a new clip object with the same id — doesn't wipe the
  // grid/duration and force the video to reload.
  useEffect(() => {
    if (currentClip) {
      setTaps([])
      // Show the saved grid (if any) so an already-tagged clip can be reviewed
      // and nudged without re-tapping from scratch.
      setGrid(
        currentClip.bpm != null
          ? { bpm: currentClip.bpm, offset: currentClip.offset ?? 0 }
          : null,
      )
      setClipDuration(0)
      setPlayhead(0)
      setTrim(null) // re-initialised from saved values once metadata loads
      beatIndexRef.current = NaN
      lastTimeRef.current = 0
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentClip?.id])

  // Drive the timeline playhead off the looping preview video, and click the
  // metronome each time the playhead crosses a grid beat.
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const v = videoRef.current
      if (v && v.duration) {
        const t = v.currentTime
        setPlayhead(t / v.duration)

        const g = gridRef.current
        if (g) {
          const beat = 60 / g.bpm
          const idx = t >= g.offset ? Math.floor((t - g.offset) / beat) : -1
          let prev = beatIndexRef.current
          if (t < lastTimeRef.current) prev = -1 // video looped: let the next beat fire
          if (Number.isNaN(prev)) {
            beatIndexRef.current = idx // establish baseline silently
          } else {
            if (idx > prev && idx >= 0 && metronomeRef.current) playClick()
            beatIndexRef.current = idx
          }
        }
        lastTimeRef.current = t
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [currentClip?.id])

  const selectOffset = useCallback(
    (delta: number) => {
      if (currentIndex < 0) return
      const next = visible[currentIndex + delta]
      if (next) setSelectedId(next.id)
    },
    [visible, currentIndex],
  )

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === ' ' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault()
        handleTap()
      } else if (e.key === 'ArrowLeft') {
        selectOffset(-1)
      } else if (e.key === 'ArrowRight') {
        selectOffset(1)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [selectOffset])

  const handleTap = useCallback(() => {
    primeMetronome() // this tap is a user gesture, so it can unlock the metronome audio
    const now = videoRef.current ? videoRef.current.currentTime * 1000 : performance.now()
    setTaps((prev) => {
      const newTaps = [...prev, now]
      if (newTaps.length >= 2) {
        try {
          setGrid(calculateGrid(newTaps))
        } catch {
          // Not enough taps yet
        }
      }
      return newTaps
    })
  }, [])

  const handleShiftGrid = useCallback((delta: number) => {
    setGrid((prev) => {
      if (!prev) return prev
      return shiftGrid(prev, delta)
    })
  }, [])

  const handleNudgeBpm = useCallback((delta: number) => {
    setGrid((prev) => (prev ? nudgeBpm(prev, delta) : prev))
  }, [])

  // Seek the preview to a time while trimming (paused so you see the exact frame).
  const seekPreview = useCallback((t: number) => {
    const v = videoRef.current
    if (!v) return
    if (!v.paused) v.pause()
    v.currentTime = t
  }, [])

  // Persist the usable window. Full-clip extents are stored as null (= no cut).
  // Updates the local clip in place (same id) so switching away and back keeps
  // the value without a full library refetch.
  const persistTrim = useCallback(
    async (next: TrimRange, clipId: string, duration: number) => {
      const trimStart = next.start > 0.01 ? next.start : null
      const trimEnd = next.end < duration - 0.01 ? next.end : null
      setClips((prev) => prev.map((c) => (c.id === clipId ? { ...c, trimStart, trimEnd } : c)))
      try {
        await patchClip(clipId, { trimStart, trimEnd })
      } catch (e) {
        setError(String((e as Error)?.message ?? e))
      }
    },
    [],
  )

  const handleTrimCommit = useCallback(
    (next: TrimRange) => {
      setTrim(next)
      if (currentClip) persistTrim(next, currentClip.id, clipDuration)
      videoRef.current?.play().catch(() => {})
    },
    [currentClip, clipDuration, persistTrim],
  )

  const setTrimEdge = (which: 'start' | 'end') => {
    if (!trim || !currentClip || clipDuration <= 0) return
    const t = Math.max(0, Math.min(clipDuration, videoRef.current?.currentTime ?? 0))
    const next: TrimRange =
      which === 'start'
        ? { start: Math.min(t, trim.end - 0.1), end: trim.end }
        : { start: trim.start, end: Math.max(t, trim.start + 0.1) }
    setTrim(next)
    persistTrim(next, currentClip.id, clipDuration)
  }

  const resetTrim = () => {
    if (!currentClip || clipDuration <= 0) return
    const next = { start: 0, end: clipDuration }
    setTrim(next)
    persistTrim(next, currentClip.id, clipDuration)
  }

  const hasGrid = grid != null

  async function handleSave() {
    if (!currentClip || !hasGrid) return
    // Where to land after saving: the next clip still in the queue.
    const nextId = visible[currentIndex + 1]?.id ?? null
    await patchClip(currentClip.id, { bpm: grid.bpm, offset: grid.offset })
    await refresh()
    if (nextId) setSelectedId(nextId)
  }

  async function handleDelete() {
    if (!currentClip) return
    const nextId = visible[currentIndex + 1]?.id ?? visible[currentIndex - 1]?.id ?? null
    await deleteClipById(currentClip.id)
    await refresh()
    if (nextId) setSelectedId(nextId)
  }

  async function handleAdd(files: File[]) {
    if (files.length === 0) return
    setError(null)
    setUpload({ done: 0, total: files.length, ratio: 0 })
    const { uploaded, failed } = await uploadClips(files, { concurrency: 3 }, setUpload)
    setUpload(null)
    if (failed.length) {
      setError(`${failed.length} file(s) failed to upload: ${failed.map((f) => f.name).join(', ')}`)
    }
    await refresh()
    // Focus the freshly added clips: show untagged and jump to the first upload.
    setUntaggedOnly(true)
    if (uploaded[0]) setSelectedId(uploaded[0].id)
  }

  return (
    <div className="page">
      <header className="page__head reveal">
        <div>
          <h1 className="page__title">Clip library</h1>
          <p className="page__sub">
            Drop clips to add them straight into the library. Tap each clip's dance tempo on the
            pad (or press Space), then save its grid — it's written to the manifest on disk
            automatically. Arrow keys move between clips.
          </p>
        </div>
        <div className="page__head-actions">
          <button
            type="button"
            className="ctl ctl--primary"
            onClick={() => exportManifest()}
            title="Download a copy of manifest.json (optional backup)"
          >
            Backup manifest
          </button>
        </div>
      </header>

      {error && (
        <p className="microlabel" style={{ color: 'var(--signal, #e66)' }}>
          {error}
        </p>
      )}

      {upload && (
        <div className="uploadbar reveal">
          <div className="uploadbar__row">
            <span className="microlabel">
              Uploading {upload.done} / {upload.total}
            </span>
            <span className="microlabel">{Math.round(upload.ratio * 100)}%</span>
          </div>
          <div className="uploadbar__track">
            <div className="uploadbar__fill" style={{ width: `${upload.ratio * 100}%` }} />
          </div>
        </div>
      )}

      {loading && clips.length === 0 ? (
        <p className="microlabel">Loading library…</p>
      ) : clips.length === 0 ? (
        <DropZone accept="video/*" multiple onFiles={handleAdd}>
          <div className="drop__inner">
            <span className="drop__title">Drop dance clips</span>
            <span className="drop__hint">video files, ideally under 10s each</span>
          </div>
        </DropZone>
      ) : currentClip ? (
        <>
          <div className="studio reveal" style={{ ['--i' as string]: 1 }}>
            <div className="stage">
              <div className="stage__screen">
                <video
                  ref={videoRef}
                  className="stage__video"
                  src={currentClip.url}
                  muted={!clipAudio}
                  autoPlay
                  loop
                  playsInline
                  key={currentClip.id}
                  onLoadedMetadata={(e) => {
                    const d = e.currentTarget.duration || 0
                    setClipDuration(d)
                    // Seed the usable window from saved trim, clamped to duration.
                    let start = Math.max(0, Math.min(d, currentClip.trimStart ?? 0))
                    let end = currentClip.trimEnd != null ? Math.max(0, Math.min(d, currentClip.trimEnd)) : d
                    if (!(end > start)) {
                      start = 0
                      end = d
                    }
                    setTrim({ start, end })
                  }}
                />
              </div>
              <div className="stage__meta">
                <span className="stage__name" title={currentClip.name}>
                  {currentClip.name}
                </span>
                <span className="stage__saved">
                  {currentClip.bpm != null ? `saved ${Math.round(currentClip.bpm)} bpm` : 'untagged'}
                </span>
              </div>
            </div>

            <div className="rackpanel">
              <div className="rackpanel__row">
                <span className="microlabel">Grid</span>
                <div className="rackpanel__readout">
                  <span className={`rackpanel__bpm${hasGrid ? '' : ' rackpanel__bpm--empty'}`}>
                    {grid ? grid.bpm.toFixed(1) : '···'}
                    <span className="readout__unit"> BPM</span>
                  </span>
                  {hasGrid && (
                    <span className="rackpanel__offset">+{grid.offset.toFixed(3)}s</span>
                  )}
                </div>
              </div>

              <div className="rackpanel__row">
                <button
                  type="button"
                  className="pad"
                  onClick={handleTap}
                  title="Tap on each beat (or press Space)"
                >
                  Tap
                  <span className="pad__count">
                    {taps.length > 0 ? `${taps.length} taps` : 'space bar works too'}
                  </span>
                </button>
                <button
                  type="button"
                  className="ctl ctl--quiet"
                  onClick={() => {
                    setTaps([])
                    setGrid(null)
                  }}
                >
                  Reset taps
                </button>
                <button
                  type="button"
                  className={`ctl${clipAudio ? ' ctl--engaged' : ''}`}
                  onClick={() => setClipAudio((a) => !a)}
                  title="Play the clip's own audio while tagging"
                >
                  <span className={`lamp${clipAudio ? ' lamp--on' : ''}`} />
                  Clip audio
                </button>
              </div>

              {hasGrid && (
                <div className="rackpanel__row">
                  <span className="microlabel">Nudge BPM</span>
                  <div className="nudge">
                    <button type="button" className="ctl" onClick={() => handleNudgeBpm(-1)}>−1</button>
                    <button type="button" className="ctl" onClick={() => handleNudgeBpm(1)}>+1</button>
                    <button type="button" className="ctl" onClick={() => handleNudgeBpm(-0.1)}>−0.1</button>
                    <button type="button" className="ctl" onClick={() => handleNudgeBpm(0.1)}>+0.1</button>
                  </div>
                </div>
              )}

              {hasGrid && (
                <div className="rackpanel__row">
                  <span className="microlabel">Nudge grid</span>
                  <div className="nudge">
                    <button type="button" className="ctl" onClick={() => handleShiftGrid(-0.05)}>← 50ms</button>
                    <button type="button" className="ctl" onClick={() => handleShiftGrid(0.05)}>50ms →</button>
                    <button type="button" className="ctl" onClick={() => handleShiftGrid(-0.01)}>← 10ms</button>
                    <button type="button" className="ctl" onClick={() => handleShiftGrid(0.01)}>10ms →</button>
                  </div>
                  <button
                    type="button"
                    className={`ctl${metronome ? ' ctl--engaged' : ''}`}
                    onClick={() => {
                      primeMetronome()
                      setMetronome((m) => !m)
                    }}
                    title="Toggle metronome clicks on each beat"
                  >
                    <span className={`lamp${metronome ? ' lamp--on' : ''}`} />
                    Metronome
                  </button>
                </div>
              )}

              <div className="rackpanel__row">
                <div className="rackpanel__actions">
                  <button
                    type="button"
                    className="ctl ctl--primary"
                    disabled={!hasGrid}
                    onClick={handleSave}
                  >
                    Save grid
                  </button>
                  <button type="button" className="ctl ctl--rec" onClick={handleDelete}>
                    Delete
                  </button>
                </div>
              </div>
            </div>
          </div>

          {trim && clipDuration > 0 && (
            <div className="trim reveal">
              <div className="trim__head">
                <span className="microlabel">Usable portion</span>
                <span className="trim__readout">
                  keep {trim.start.toFixed(2)}s – {trim.end.toFixed(2)}s
                  <span className="trim__of"> / {clipDuration.toFixed(2)}s</span>
                </span>
              </div>
              <TrimBar
                duration={clipDuration}
                start={trim.start}
                end={trim.end}
                playhead={playhead * clipDuration}
                onChange={setTrim}
                onScrub={seekPreview}
                onCommit={handleTrimCommit}
              />
              <div className="trim__actions">
                <button
                  type="button"
                  className="ctl"
                  onClick={() => setTrimEdge('start')}
                  title="Set the usable start to the current playhead"
                >
                  Set in ⟤
                </button>
                <button
                  type="button"
                  className="ctl"
                  onClick={() => setTrimEdge('end')}
                  title="Set the usable end to the current playhead"
                >
                  Set out ⟥
                </button>
                <button type="button" className="ctl ctl--quiet" onClick={resetTrim}>
                  Use full clip
                </button>
                <span className="microlabel trim__hint">Cut regions are never used in a render.</span>
              </div>
            </div>
          )}

          {grid && clipDuration > 0 && (
            <div className="timeline">
              <div className="timeline__head">
                <span className="timeline__hint">
                  Watch the playhead cross each beat mark, then nudge the grid until the
                  clicks land on the dancer's beats.
                </span>
              </div>
              <div className="timeline__track">
                {gridBeatTimes(grid, clipDuration).map((t, i) => (
                  <div
                    key={i}
                    className="timeline__beat"
                    style={{ left: `${(t / clipDuration) * 100}%` }}
                  />
                ))}
                <div className="timeline__playhead" style={{ left: `${playhead * 100}%` }} />
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="complete">
          <h2>{untaggedOnly ? 'Everything is tagged' : 'No clips'}</h2>
          <p>
            {untaggedOnly
              ? 'Drop more clips below to add to the library, or show all to review saved grids.'
              : 'Drop clips below to start building the library.'}
          </p>
        </div>
      )}

      {!loading || clips.length > 0 ? (
        clips.length > 0 && (
          <div className="strip reveal" style={{ ['--i' as string]: 2 }}>
            <div className="strip__head">
              <span className="microlabel">
                Queue · {untaggedCount} untagged · {clips.length} total
              </span>
              <div className="strip__nav">
                <button
                  type="button"
                  className={`ctl${untaggedOnly ? ' ctl--engaged' : ''}`}
                  onClick={() => setUntaggedOnly((v) => !v)}
                  title="Hide clips that already have a saved grid"
                >
                  <span className={`lamp${untaggedOnly ? ' lamp--on' : ''}`} />
                  Untagged only
                </button>
                <button
                  type="button"
                  className="ctl"
                  onClick={() => selectOffset(-1)}
                  disabled={currentIndex <= 0}
                  aria-label="Previous clip"
                >
                  ←
                </button>
                <button
                  type="button"
                  className="ctl"
                  onClick={() => selectOffset(1)}
                  disabled={currentIndex < 0 || currentIndex >= visible.length - 1}
                  aria-label="Next clip"
                >
                  →
                </button>
              </div>
            </div>
            {visible.length > 0 && (
              <div className="strip__scroll">
                {visible.map((clip) => (
                  <button
                    key={clip.id}
                    type="button"
                    className={`strip__item${clip.id === currentClip?.id ? ' strip__item--current' : ''}`}
                    onClick={() => setSelectedId(clip.id)}
                    title={clip.name}
                  >
                    <ClipThumb className="strip__thumb" src={clip.url} />
                    <span className={`lamp${clip.bpm != null ? ' lamp--on' : ''}`} />
                  </button>
                ))}
              </div>
            )}
            <div style={{ marginTop: 12 }}>
              <DropZone accept="video/*" multiple compact onFiles={handleAdd}>
                <div className="drop__inner">
                  <span className="drop__hint">Add clips: drop video files or click to browse</span>
                </div>
              </DropZone>
            </div>
          </div>
        )
      ) : null}
    </div>
  )
}

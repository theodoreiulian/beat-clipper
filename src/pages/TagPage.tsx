import { useCallback, useEffect, useRef, useState } from 'react'
import type { Clip } from '../types'
import {
  loadLibrary,
  setClipGrid,
  markDeleted,
  addUserClip,
  purgeUserClip,
  exportManifest,
  clearLibrary,
} from '../lib/manifest'
import { calculateGrid, shiftGrid, gridBeatTimes, type GridResult } from '../lib/tapTempo'
import { primeMetronome, playClick } from '../lib/metronome'
import { DropZone } from '../components/DropZone'

export function TagPage() {
  const [clips, setClips] = useState<Clip[]>([])
  const [loading, setLoading] = useState(true)
  const [index, setIndex] = useState(0)

  const videoRef = useRef<HTMLVideoElement>(null)
  const [taps, setTaps] = useState<number[]>([])
  const [grid, setGrid] = useState<GridResult | null>(null)
  const [clipDuration, setClipDuration] = useState(0)
  const [playhead, setPlayhead] = useState(0)
  const [metronome, setMetronome] = useState(true)

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
    setClips(await loadLibrary({ includeUntagged: true }))
    setLoading(false)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const currentClip = clips[index] ?? null

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
      beatIndexRef.current = NaN
      lastTimeRef.current = 0
    }
  }, [currentClip])

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
  }, [currentClip])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === ' ' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault()
        handleTap()
      } else if (e.key === 'ArrowLeft') {
        setIndex((i) => Math.max(0, i - 1))
      } else if (e.key === 'ArrowRight') {
        setIndex((i) => Math.min(clips.length - 1, i + 1))
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [clips.length])

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

  const hasGrid = grid != null

  async function handleSave() {
    if (!currentClip || !hasGrid) return
    await setClipGrid({ id: currentClip.id, bpm: grid.bpm, offset: grid.offset })
    await refresh()
  }

  async function handleDelete() {
    if (!currentClip) return
    if (currentClip.source === 'user') await purgeUserClip(currentClip)
    else await markDeleted(currentClip)
    await refresh()
  }

  async function handleAdd(files: File[]) {
    for (const f of files) await addUserClip(f)
    await refresh()
  }

  async function handleClearAll() {
    const ok = window.confirm(
      'Delete ALL uploaded clips and tags from this browser and start over? This cannot be undone.',
    )
    if (!ok) return
    await clearLibrary()
    try {
      localStorage.clear()
    } catch {
      /* ignore */
    }
    setIndex(0)
    setTaps([])
    setGrid(null)
    await refresh()
  }

  return (
    <div className="page">
      <header className="page__head reveal">
        <div>
          <h1 className="page__title">Clip library</h1>
          <p className="page__sub">
            Tap each clip's dance tempo on the pad (or press Space), then save its grid.
            Arrow keys move between clips.
          </p>
        </div>
        <div className="page__head-actions">
          <button type="button" className="ctl ctl--rec" onClick={handleClearAll}>
            Clear all
          </button>
          <button type="button" className="ctl ctl--primary" onClick={() => exportManifest()}>
            Export manifest
          </button>
        </div>
      </header>

      {loading ? (
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
                  muted
                  autoPlay
                  loop
                  playsInline
                  key={currentClip.id}
                  onLoadedMetadata={(e) => setClipDuration(e.currentTarget.duration || 0)}
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
                    {grid ? `${Math.round(grid.bpm)}` : '···'}
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
              </div>

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
          <h2>All clips tagged</h2>
          <p>Review and export the manifest whenever you're ready.</p>
        </div>
      )}

      {!loading && clips.length > 0 && (
        <div className="strip reveal" style={{ ['--i' as string]: 2 }}>
          <div className="strip__head">
            <span className="microlabel">
              Queue · {clips.length > 0 ? `${index + 1} / ${clips.length}` : ''}
            </span>
            <div className="strip__nav">
              <button
                type="button"
                className="ctl"
                onClick={() => setIndex((i) => Math.max(0, i - 1))}
                disabled={index === 0}
                aria-label="Previous clip"
              >
                ←
              </button>
              <button
                type="button"
                className="ctl"
                onClick={() => setIndex((i) => Math.min(clips.length - 1, i + 1))}
                disabled={index === clips.length - 1}
                aria-label="Next clip"
              >
                →
              </button>
            </div>
          </div>
          <div className="strip__scroll">
            {clips.map((clip, i) => (
              <button
                key={clip.id}
                type="button"
                className={`strip__item${i === index ? ' strip__item--current' : ''}`}
                onClick={() => setIndex(i)}
                title={clip.name}
              >
                <video
                  className="strip__thumb"
                  src={clip.url}
                  muted
                  playsInline
                  preload="metadata"
                  // Nudge off t=0 so the browser actually paints a poster frame.
                  onLoadedMetadata={(e) => {
                    e.currentTarget.currentTime = 0.05
                  }}
                />
                <span className={`lamp${clip.bpm != null ? ' lamp--on' : ''}`} />
              </button>
            ))}
          </div>
          <div style={{ marginTop: 12 }}>
            <DropZone accept="video/*" multiple compact onFiles={handleAdd}>
              <div className="drop__inner">
                <span className="drop__hint">Add clips: drop video files or click to browse</span>
              </div>
            </DropZone>
          </div>
        </div>
      )}
    </div>
  )
}

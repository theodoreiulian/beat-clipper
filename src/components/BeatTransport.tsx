import { useEffect, useRef, useState } from 'react'
import type { WavePeaks } from '../lib/bpm'
import { formatClock } from '../lib/format'
import { barSeconds } from '../lib/render'
import { Waveform } from './Waveform'

interface BeatTransportProps {
  file: File
  peaks: WavePeaks
  bpm: number | null
  /** Seconds from the head of the file to the first beat. */
  onset: number
  /** Start of the render window (a bar line, or 0 for the head of the file). */
  startAt: number
  /** Seconds of beat the render will cover from startAt. */
  windowLen: number
  onStartChange: (seconds: number) => void
}

/**
 * Audition the beat and choose where the edit starts.
 *
 * Playback is scoped to the render window: pressing play drops the needle on the
 * chosen bar and stops at the end of what will be rendered, so what you hear is
 * exactly the stretch of music the video will be cut to — not the track.
 *
 * Playback state lives here rather than in the page because the playhead moves
 * every animation frame; keeping it local means those 60 updates a second
 * re-render the waveform and this row, and nothing else on the page.
 */
export function BeatTransport({
  file,
  peaks,
  bpm,
  onset,
  startAt,
  windowLen,
  onStartChange,
}: BeatTransportProps) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [playhead, setPlayhead] = useState(startAt)

  const stopAt = Math.min(peaks.duration, startAt + windowLen)

  useEffect(() => {
    const next = URL.createObjectURL(file)
    setUrl(next)
    setPlaying(false)
    return () => URL.revokeObjectURL(next)
  }, [file])

  // Moving the start re-cues the beat there: the point of moving it is to hear
  // what the edit will open on.
  useEffect(() => {
    const audio = audioRef.current
    setPlayhead(startAt)
    if (audio) audio.currentTime = startAt
  }, [startAt])

  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = () => {
      const audio = audioRef.current
      if (!audio) return
      if (audio.currentTime >= stopAt) {
        audio.pause()
        audio.currentTime = startAt
        setPlayhead(startAt)
        setPlaying(false)
        return
      }
      setPlayhead(audio.currentTime)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, stopAt, startAt])

  function toggle() {
    const audio = audioRef.current
    if (!audio) return
    if (playing) {
      audio.pause()
      setPlaying(false)
      return
    }
    // Resume where we paused, unless that's outside the window we're auditioning.
    if (audio.currentTime < startAt || audio.currentTime >= stopAt) audio.currentTime = startAt
    audio
      .play()
      .then(() => setPlaying(true))
      .catch(() => setPlaying(false))
  }

  // Bar the render opens on, counted from the first beat of the track.
  const barNumber =
    bpm != null && bpm >= 40 ? Math.round((startAt - onset) / barSeconds(bpm)) + 1 : null

  return (
    <>
      <Waveform
        peaks={peaks}
        bpm={bpm}
        onset={onset}
        startAt={startAt}
        windowLen={windowLen}
        playhead={playhead}
        onPick={onStartChange}
      />

      <div className="transport">
        <button
          type="button"
          className={`ctl ctl--icon${playing ? ' ctl--engaged' : ''}`}
          onClick={toggle}
          aria-label={playing ? 'Pause the beat' : 'Play the beat'}
          title={playing ? 'Pause' : 'Play from the start point'}
        >
          <span aria-hidden="true">{playing ? '❚❚' : '▶'}</span>
        </button>

        <span className="transport__time">
          {formatClock(playhead)}
          <span className="transport__total"> / {formatClock(peaks.duration)}</span>
        </span>

        {startAt > 0 && (
          <button type="button" className="ctl ctl--quiet" onClick={() => onStartChange(0)}>
            From the top
          </button>
        )}

        <span className="transport__start">
          {startAt > 0 ? (
            <>
              Starts {formatClock(startAt)}
              {barNumber != null && <span className="transport__bar"> · bar {barNumber}</span>}
            </>
          ) : (
            <>Starts at the top</>
          )}
        </span>
      </div>

      <p className="transport__hint">
        Click the waveform to start the edit on that bar — it snaps to the 4-beat lines. The lit
        band is the {formatClock(Math.max(0, stopAt - startAt))} the video will use.
      </p>

      <audio ref={audioRef} src={url ?? undefined} preload="metadata" />
    </>
  )
}

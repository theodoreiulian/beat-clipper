import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import type { WavePeaks } from '../lib/bpm'
import { barSeconds, snapToBar } from '../lib/render'

interface WaveformProps {
  peaks: WavePeaks
  bpm: number | null
  onset: number
  /** Start of the render window (always a bar line, or 0), in seconds. */
  startAt: number
  /** Length of the render window measured from startAt, in seconds. */
  windowLen: number
  /** Play position in seconds. */
  playhead: number
  /** Pick a new start. The time handed over is already snapped to a bar. */
  onPick: (seconds: number) => void
}

/**
 * Peak waveform of the dropped beat with the detected beat grid ticked on top,
 * doubling as the start picker: the lit band is the stretch of music the render
 * will use, and clicking (or dragging) moves its start to the nearest bar line.
 *
 * Draws from a pre-summarised `WavePeaks` rather than the AudioBuffer. Nudging
 * the BPM redraws the grid on every keystroke, and rescanning millions of
 * samples each time made the tempo box feel stuck; the peaks don't depend on the
 * tempo, so they're summarised once when the beat is dropped.
 *
 * The playhead and the hover marker are DOM elements, not canvas: the playhead
 * moves every animation frame during playback, and redrawing the whole waveform
 * at 60fps to move a one-pixel line is work for nothing.
 */
export function Waveform({
  peaks,
  bpm,
  onset,
  startAt,
  windowLen,
  playhead,
  onPick,
}: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const [hover, setHover] = useState<number | null>(null)

  const duration = peaks.duration
  // Null unless there is a usable grid to snap to; every picker path keys off it.
  const gridBpm = bpm != null && bpm >= 40 && duration > 0 ? bpm : null
  const windowEnd = Math.min(duration, startAt + windowLen)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const draw = () => {
      const dpr = window.devicePixelRatio || 1
      const { width, height } = canvas.getBoundingClientRect()
      if (width === 0) return
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.scale(dpr, dpr)

      const styles = getComputedStyle(canvas)
      const cssVar = (name: string, fallback: string) =>
        styles.getPropertyValue(name).trim() || fallback
      const ink = cssVar('--ink', '#eee')
      const inkFaint = cssVar('--ink-faint', '#777')
      const signal = cssVar('--signal', '#cf0')
      const signalDim = cssVar('--signal-dim', '#9c0')
      const bg = cssVar('--bg', '#111')

      const xOf = (t: number) => (duration > 0 ? (t / duration) * width : 0)
      const xStart = xOf(startAt)
      const xEnd = xOf(windowEnd)

      // Everything outside the render window is pushed back: a wash behind it and
      // a fainter waveform on top, so the used stretch is the thing you look at.
      ctx.fillStyle = bg
      ctx.globalAlpha = 0.5
      ctx.fillRect(0, 0, xStart, height)
      ctx.fillRect(xEnd, 0, width - xEnd, height)
      ctx.globalAlpha = 1

      // One column per CSS pixel, aggregated down from the stored peaks.
      const columns = Math.floor(width)
      const perCol = peaks.min.length / columns
      const mid = height / 2
      for (let x = 0; x < columns; x++) {
        const start = Math.floor(x * perCol)
        const end = Math.max(start + 1, Math.min(peaks.min.length, Math.floor((x + 1) * perCol)))
        let lo = 0
        let hi = 0
        for (let i = start; i < end; i++) {
          if (peaks.min[i] < lo) lo = peaks.min[i]
          if (peaks.max[i] > hi) hi = peaks.max[i]
        }
        const y1 = mid - hi * (mid - 4)
        const y2 = mid - lo * (mid - 4)
        ctx.fillStyle = x >= xStart - 1 && x < xEnd ? ink : inkFaint
        ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1))
      }

      // Tick the cut boundaries (every 4 beats, one segment per cut in the
      // render), not every beat: per-beat ticks drown the waveform at club tempos.
      // These are exactly the positions a start point can snap to.
      if (gridBpm != null) {
        const cutLen = barSeconds(gridBpm)
        ctx.fillStyle = signalDim
        for (let t = onset; t < duration; t += cutLen) {
          ctx.globalAlpha = t >= startAt - 1e-6 && t < windowEnd ? 0.5 : 0.25
          ctx.fillRect(xOf(t), 0, 1, height)
        }
        ctx.globalAlpha = 1
      }

      // Where the render ends.
      if (windowEnd < duration - 1e-6) {
        ctx.fillStyle = signalDim
        ctx.globalAlpha = 0.8
        ctx.fillRect(xEnd - 1, 0, 1, height)
        ctx.globalAlpha = 1
      }

      // Where it starts: a flagged marker, since this is the one the user moves.
      ctx.fillStyle = signal
      ctx.fillRect(xStart, 0, 2, height)
      ctx.beginPath()
      ctx.moveTo(xStart, 0)
      ctx.lineTo(xStart + 9, 0)
      ctx.lineTo(xStart, 9)
      ctx.closePath()
      ctx.fill()
    }

    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [peaks, gridBpm, onset, startAt, windowEnd, duration])

  const snapAt = (clientX: number): number | null => {
    const el = bodyRef.current
    if (!el || gridBpm == null) return null
    const rect = el.getBoundingClientRect()
    const frac = rect.width ? (clientX - rect.left) / rect.width : 0
    return snapToBar(frac * duration, onset, gridBpm, duration)
  }

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    const t = snapAt(e.clientX)
    if (t == null) return
    dragging.current = true
    e.currentTarget.setPointerCapture?.(e.pointerId)
    setHover(t)
    if (t !== startAt) onPick(t)
  }

  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const t = snapAt(e.clientX)
    if (t == null) return
    setHover((prev) => (prev === t ? prev : t))
    if (dragging.current && t !== startAt) onPick(t)
  }

  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    dragging.current = false
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }

  const nudge = (bars: number) => {
    if (gridBpm == null) return
    // Move by a whole bar from where we are: startAt is already on a bar line
    // (or 0), so this lands on the neighbouring one.
    onPick(snapToBar(startAt + bars * barSeconds(gridBpm), onset, gridBpm, duration))
  }

  const key = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') nudge(-1)
    else if (e.key === 'ArrowRight') nudge(1)
    else if (e.key === 'Home') onPick(0)
    else return
    e.preventDefault()
  }

  const pct = (t: number) => (duration > 0 ? Math.max(0, Math.min(100, (t / duration) * 100)) : 0)

  return (
    <div
      ref={bodyRef}
      className={`wave__body${gridBpm != null ? ' wave__body--pickable' : ''}`}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onPointerLeave={() => setHover(null)}
      onKeyDown={key}
      tabIndex={gridBpm != null ? 0 : -1}
      role={gridBpm != null ? 'slider' : undefined}
      aria-label={gridBpm != null ? 'Start the edit at this bar' : undefined}
      aria-valuemin={0}
      aria-valuemax={Math.round(duration * 1000)}
      aria-valuenow={Math.round(startAt * 1000)}
      aria-valuetext={`${startAt.toFixed(2)} seconds`}
    >
      <canvas ref={canvasRef} className="wave__canvas" />
      {hover != null && Math.abs(hover - startAt) > 1e-6 && (
        <div className="wave__ghost" style={{ left: `${pct(hover)}%` }} />
      )}
      <div className="wave__ph" style={{ left: `${pct(playhead)}%` }} />
    </div>
  )
}

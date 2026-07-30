import { useRef, type PointerEvent as ReactPointerEvent } from 'react'

export interface TrimRange {
  start: number
  end: number
}

interface TrimBarProps {
  duration: number
  start: number
  end: number
  /** Current play position, in seconds (for the playhead line). */
  playhead: number
  /** Live update while dragging. */
  onChange: (next: TrimRange) => void
  /** Seek the preview to a time while dragging a handle. */
  onScrub: (time: number) => void
  /** Fired once on pointer release with the final range (persist here). */
  onCommit: (next: TrimRange) => void
}

/** Never let the two handles cross or collapse the window (seconds). */
const MIN_WINDOW = 0.1

/**
 * A two-handle trim control over a clip's timeline. The lit middle band is the
 * usable window; the hatched ends are the cut regions that a render will ignore.
 * Dragging a handle scrubs the preview so you can see exactly where you're
 * cutting, and persists once on release.
 */
export function TrimBar({ duration, start, end, playhead, onChange, onScrub, onCommit }: TrimBarProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const dragging = useRef<'start' | 'end' | null>(null)
  // Last range produced by a move, so commit uses it regardless of React flush.
  const latest = useRef<TrimRange>({ start, end })
  latest.current = { start, end }

  const timeAt = (clientX: number): number => {
    const el = trackRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    const frac = rect.width ? (clientX - rect.left) / rect.width : 0
    return Math.max(0, Math.min(duration, frac * duration))
  }

  const down = (which: 'start' | 'end') => (e: ReactPointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragging.current = which
    e.currentTarget.setPointerCapture?.(e.pointerId)
    onScrub(which === 'start' ? start : end)
  }

  const move = (e: ReactPointerEvent) => {
    if (!dragging.current) return
    const t = timeAt(e.clientX)
    const next: TrimRange =
      dragging.current === 'start'
        ? { start: Math.max(0, Math.min(t, end - MIN_WINDOW)), end }
        : { start, end: Math.min(duration, Math.max(t, start + MIN_WINDOW)) }
    latest.current = next
    onChange(next)
    onScrub(dragging.current === 'start' ? next.start : next.end)
  }

  const up = (e: ReactPointerEvent) => {
    if (!dragging.current) return
    dragging.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    onCommit(latest.current)
  }

  const pct = (t: number) => (duration ? Math.max(0, Math.min(100, (t / duration) * 100)) : 0)

  return (
    <div className="trim__track" ref={trackRef}>
      <div className="trim__cut" style={{ left: 0, width: `${pct(start)}%` }} />
      <div className="trim__cut" style={{ left: `${pct(end)}%`, right: 0 }} />
      <div className="trim__keep" style={{ left: `${pct(start)}%`, width: `${pct(end) - pct(start)}%` }} />
      <div className="trim__ph" style={{ left: `${pct(playhead)}%` }} />
      <div
        className="trim__handle"
        style={{ left: `${pct(start)}%` }}
        onPointerDown={down('start')}
        onPointerMove={move}
        onPointerUp={up}
        role="slider"
        aria-label="Trim start"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration * 1000)}
        aria-valuenow={Math.round(start * 1000)}
      />
      <div
        className="trim__handle"
        style={{ left: `${pct(end)}%` }}
        onPointerDown={down('end')}
        onPointerMove={move}
        onPointerUp={up}
        role="slider"
        aria-label="Trim end"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration * 1000)}
        aria-valuenow={Math.round(end * 1000)}
      />
    </div>
  )
}

import { useCallback, useRef, useState } from 'react'

const MAX_INTERVALS = 8
const RESET_GAP_MS = 2000

export interface GridResult {
  /** BPM derived from the taps. Kept as a float; rounding to a whole number
   *  throws away up to ~0.5 BPM of tap precision, which is real speed error once
   *  a clip is time-stretched. Round only for display. */
  bpm: number
  /**
   * Seconds from the start of the clip to the first beat of the perfect grid.
   * This is the grid's phase, kept within a single beat: [0, 60/bpm).
   */
  offset: number
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Build a perfect, evenly-spaced beat grid from the user's rough taps.
 *
 * 1. BPM = median tap interval, kept as a float.
 * 2. The grid is laid out at that exact BPM. Its phase (where the first beat
 *    lands) is the circular mean of every tap modulo one beat, so all taps
 *    contribute to where the grid sits, not just the first one, which matters
 *    because the taps are close to the grid but never exactly on it.
 * 3. The offset is that phase: the distance from the clip start (00:00) to the
 *    first beat of the perfect grid.
 */
export function calculateGrid(tapsMs: number[]): GridResult {
  if (tapsMs.length < 2) {
    throw new Error('Need at least 2 taps to calculate a grid')
  }

  const intervals: number[] = []
  for (let i = 1; i < tapsMs.length; i++) {
    intervals.push(tapsMs[i] - tapsMs[i - 1])
  }

  const bpm = 60000 / median(intervals)
  const beatMs = 60000 / bpm

  // Circular mean of the tap phases (each tap's position within a beat). Done on
  // the unit circle so taps that straddle the 0 / beat wrap-around still average
  // correctly instead of cancelling out.
  let sin = 0
  let cos = 0
  for (const t of tapsMs) {
    const angle = ((t % beatMs) / beatMs) * 2 * Math.PI
    sin += Math.sin(angle)
    cos += Math.cos(angle)
  }
  let phase = Math.atan2(sin, cos) / (2 * Math.PI) // fraction of a beat, (-0.5, 0.5]
  if (phase < 0) phase += 1
  const offsetMs = phase * beatMs

  return { bpm, offset: offsetMs / 1000 }
}

/**
 * Shift the whole grid left/right. This only ever changes the offset, never the
 * BPM. The offset stays within a single beat: since the grid is periodic,
 * wrapping keeps it canonical while every visible tick still moves by `delta`.
 */
export function shiftGrid(grid: GridResult, deltaSeconds: number): GridResult {
  const beat = 60 / grid.bpm
  let offset = (grid.offset + deltaSeconds) % beat
  if (offset < 0) offset += beat
  return { ...grid, offset }
}

/**
 * Nudge the grid's tempo up/down by `deltaBpm`, keeping the first beat anchored
 * where it is. The offset is re-wrapped into the new (slightly different) beat
 * length so it stays a canonical phase in [0, 60/bpm).
 */
export function nudgeBpm(grid: GridResult, deltaBpm: number): GridResult {
  const bpm = Math.max(1, grid.bpm + deltaBpm)
  const beat = 60 / bpm
  let offset = grid.offset % beat
  if (offset < 0) offset += beat
  return { bpm, offset }
}

/** Beat positions (in seconds) of the perfect grid across a clip of the given length. */
export function gridBeatTimes(grid: GridResult, durationSeconds: number): number[] {
  const beat = 60 / grid.bpm
  const times: number[] = []
  for (let t = grid.offset; t < durationSeconds; t += beat) times.push(t)
  return times
}

export function useTapTempo() {
  const lastTap = useRef<number | null>(null)
  const intervals = useRef<number[]>([])
  const [bpm, setBpm] = useState<number | null>(null)
  const [taps, setTaps] = useState(0)

  const tap = useCallback(() => {
    const now = performance.now()
    const prev = lastTap.current
    lastTap.current = now

    if (prev == null || now - prev > RESET_GAP_MS) {
      intervals.current = []
      setBpm(null)
      setTaps(1)
      return
    }

    intervals.current.push(now - prev)
    if (intervals.current.length > MAX_INTERVALS) intervals.current.shift()
    setBpm(Math.round(60000 / median(intervals.current)))
    setTaps((t) => t + 1)
  }, [])

  const reset = useCallback(() => {
    lastTap.current = null
    intervals.current = []
    setBpm(null)
    setTaps(0)
  }, [])

  return { bpm, taps, tap, reset }
}

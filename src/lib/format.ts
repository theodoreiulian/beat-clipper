/** m:ss, for timeline readouts. Negatives clamp to 0:00. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, seconds)
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

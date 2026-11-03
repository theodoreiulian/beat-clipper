import type { GridResult } from '../lib/tapTempo'

/** Review-only drawing over the existing video; it never steers playback. */
export function BeatGridOverlay({ grid, currentTime, soundtrack }: {
  grid: GridResult | null
  currentTime: number
  soundtrack: boolean
}) {
  if (!grid || !Number.isFinite(grid.bpm) || grid.bpm <= 0) return null
  const beatSeconds = 60 / grid.bpm
  const beatPosition = (currentTime - grid.offset) / beatSeconds
  const index = Math.floor(beatPosition)
  const firstBeat = Math.max(0, Math.floor(Math.max(0, index) / 8) * 8)
  // Half a beat of lead-in keeps the first beat visible at the left edge.
  const start = grid.offset + (firstBeat - .5) * beatSeconds
  const span = 8 * beatSeconds
  const cursor = Math.max(0, Math.min(1, (currentTime - start) / span))
  const flash = index >= 0 ? Math.max(0, 1 - ((beatPosition - index) * beatSeconds) / .12) : 0
  return (
    <div className="video-grid" aria-label={`${soundtrack ? 'Soundtrack' : 'Review'} beat grid, ${grid.bpm.toFixed(1)} BPM`}>
      <div className="video-grid__accent" style={{ opacity: flash * .4 }} />
      <div className="video-grid__panel">
        <div className="video-grid__readout">
          <span>{soundtrack ? 'Music grid' : 'Beat grid'} · {grid.bpm.toFixed(1)} BPM</span>
          <span>{index >= 0 ? `Beat ${index + 1}` : 'Lead-in'}</span>
        </div>
        <div className="video-grid__ruler" aria-hidden="true">
          {Array.from({ length: 8 }, (_, i) => (
            <span key={firstBeat + i} className="video-grid__tick" style={{ left: `${((i + .5) / 8) * 100}%` }}>
              <span>{firstBeat + i + 1}</span>
            </span>
          ))}
          <span className="video-grid__cursor" style={{ left: `${cursor * 100}%` }} />
        </div>
      </div>
    </div>
  )
}

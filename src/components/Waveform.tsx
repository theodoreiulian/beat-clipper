import { useEffect, useRef } from 'react'

interface WaveformProps {
  buffer: AudioBuffer
  bpm: number | null
  onset: number
}

/**
 * Peak waveform of the dropped beat with the detected beat grid ticked on top.
 */
export function Waveform({ buffer, bpm, onset }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Redraw peaks + grid ticks whenever the audio or grid changes, and on resize.
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
      const ink = styles.getPropertyValue('--ink-faint').trim() || '#777'
      const signal = styles.getPropertyValue('--signal-dim').trim() || '#9c0'

      // Min/max peak pairs, one column per CSS pixel.
      const data = buffer.getChannelData(0)
      const columns = Math.floor(width)
      const samplesPerCol = data.length / columns
      const mid = height / 2
      ctx.fillStyle = ink
      for (let x = 0; x < columns; x++) {
        const start = Math.floor(x * samplesPerCol)
        const end = Math.min(data.length, Math.floor((x + 1) * samplesPerCol))
        let min = 0
        let max = 0
        for (let i = start; i < end; i++) {
          const v = data[i]
          if (v < min) min = v
          if (v > max) max = v
        }
        const y1 = mid - max * (mid - 4)
        const y2 = mid - min * (mid - 4)
        ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1))
      }

      // Tick the cut boundaries (every 4 beats, one segment per cut in the
      // render), not every beat: per-beat ticks drown the waveform at club tempos.
      if (bpm != null && bpm >= 40) {
        const cutLen = (4 * 60) / bpm
        ctx.fillStyle = signal
        ctx.globalAlpha = 0.45
        for (let t = onset; t < buffer.duration; t += cutLen) {
          ctx.fillRect((t / buffer.duration) * width, 0, 1, height)
        }
        ctx.globalAlpha = 1
      }
    }

    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [buffer, bpm, onset])

  return (
    <div className="wave__body">
      <canvas ref={canvasRef} className="wave__canvas" />
    </div>
  )
}

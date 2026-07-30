import { memo, useEffect, useRef, useState } from 'react'
import { getPoster } from '../lib/posters'

interface ClipThumbProps {
  src: string
  className?: string
  /** Frame to show, in seconds. The editor passes the exact frame a clip would
   *  start on, so a tile previews what you'd actually get. */
  seekTo?: number
  /** Selector of the scrolling ancestor to observe against. */
  rootSelector?: string
}

/**
 * A tile showing one frame of a clip.
 *
 * This renders an `<img>`, not a `<video>`: the frame is decoded once by
 * `getPoster` and cached, then the video element behind it is released. A strip
 * of live `<video>` tiles holds one demuxer and decoder each, which both froze
 * the tab on a big library and made the editor's preview playback stutter.
 *
 * Capture still only starts once the tile is near the viewport, so a 50-clip
 * library doesn't decode 50 files up front.
 *
 * Memoised: the editor re-renders its whole timeline at every cut while the
 * preview plays, and a tile's props don't change when the playhead moves.
 */
export const ClipThumb = memo(function ClipThumb({
  src,
  className,
  seekTo = 0.05,
  rootSelector = '.strip__scroll',
}: ClipThumbProps) {
  const ref = useRef<HTMLImageElement>(null)
  const [visible, setVisible] = useState(false)
  const [poster, setPoster] = useState<string | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // Observe against the scrolling container, with a wide horizontal margin so a
    // thumbnail is ready by the time it scrolls into view.
    const root = el.closest(rootSelector)
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      root,
      rootMargin: '0px 300px',
    })
    io.observe(el)
    return () => io.disconnect()
  }, [rootSelector])

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    setPoster(null)
    getPoster(src, seekTo).then(
      (url) => {
        if (!cancelled) setPoster(url)
      },
      () => {
        /* unreadable clip -> tile just stays blank */
      },
    )
    return () => {
      cancelled = true
    }
  }, [visible, src, seekTo])

  return <img ref={ref} className={className} src={poster ?? undefined} alt="" draggable={false} />
})

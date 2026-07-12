import { useState } from 'react'

const DISMISS_KEY = 'beatclipper:beta-banner-dismissed'

export function BetaBanner() {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1'
    } catch {
      return false
    }
  })

  if (dismissed) return null

  function dismiss() {
    setDismissed(true)
    try {
      localStorage.setItem(DISMISS_KEY, '1')
    } catch {
      // ignore — banner just reappears next visit
    }
  }

  return (
    <div className="beta">
      <span className="lamp lamp--rec" />
      <div className="beta__body">
        <span className="beta__tag">Beta</span>
        <span>Beat Clipper is in early user testing.</span>
      </div>
      <button type="button" className="beta__close" onClick={dismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  )
}

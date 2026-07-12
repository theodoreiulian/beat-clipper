// A tiny synthesized metronome click via the Web Audio API, with no audio asset to
// ship. A single AudioContext is reused; browsers keep it suspended until a user
// gesture, so call primeMetronome() from a click/tap to unlock playback.

let ctx: AudioContext | null = null

function getCtx(): AudioContext {
  if (!ctx) {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    ctx = new AC()
  }
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

/**
 * The one AudioContext the app schedules against. Decode the beat on this
 * context so playback and clicks share a clock; comparing an
 * HTMLMediaElement's currentTime against AudioContext.currentTime means
 * comparing two independent, differently-quantized clocks.
 */
export function getAudioContext(): AudioContext {
  return getCtx()
}

/** Unlock audio from within a user gesture (e.g. a tap or button click). */
export function primeMetronome(): void {
  getCtx()
}

/** Schedule one short click at an absolute AudioContext time. */
function scheduleClick(ac: AudioContext, at: number, volume: number, out: AudioNode): void {
  const osc = ac.createOscillator()
  const gain = ac.createGain()
  osc.type = 'square'
  osc.frequency.value = 1000
  // Quick percussive envelope so it reads as a "tick", not a tone.
  gain.gain.setValueAtTime(0.0001, at)
  gain.gain.exponentialRampToValueAtTime(volume, at + 0.001)
  gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.05)
  osc.connect(gain).connect(out)
  osc.start(at)
  osc.stop(at + 0.06)
}

/** Play one short metronome click, now. Used by the tagging tool's Tap button. */
export function playClick(volume = 0.6): void {
  const ac = getCtx()
  scheduleClick(ac, ac.currentTime, volume, ac.destination)
}

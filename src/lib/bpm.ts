import type { BeatInfo } from '../types'
import { getAudioContext } from './metronome'

// Constrain detection to a single tempo octave. web-audio-beat-detector otherwise
// happily reports half/double time (e.g. 70 for a 140 beat), which would make every
// 4-beat cut the wrong length. 80-160 covers the vast majority of hip-hop/trap/pop;
// the producer's BPM box is the override for anything outside it.
const TEMPO_SETTINGS = { minTempo: 80, maxTempo: 160 }

// Onset envelope resolution. ~5.8ms between frames places a beat well inside human
// timing tolerance while keeping a 3-minute track to ~30k frames.
const HOP_SECONDS = 0.0058

// Each frame's energy is measured over a window a little longer than one cycle of a
// kick's fundamental (~86Hz). A window shorter than that tracks the waveform rather
// than its envelope, and the rectified difference then fires on the loudest half-cycle
// instead of the attack, measurably ~20ms late.
const WINDOW_SECONDS = 0.0116

// Any sample above this amplitude counts as "sound" when locating where the audio
// starts. ~-66 dBFS: comfortably above 16-bit dither and mp3 encoder noise in silent
// passages, but low enough that even a very quiet intro registers as the first beat.
const SOUND_START_AMPLITUDE = 5e-4

// How far around the detected tempo to search, and how finely. groupNeighborsByTempo
// takes a bucket's tempo from the single interval that created it and merely *scores*
// neighbours within ±0.5 BPM rather than averaging them, so the seed can land a
// couple of tenths off, which is enough to drift a quarter of a beat across 60 seconds.
const TEMPO_SEARCH_RADIUS_BPM = 1.5
const TEMPO_SEARCH_STEP_BPM = 0.01

/** Enough beats for the comb filter to have something to lock onto. */
const MIN_BEATS_FOR_REFINEMENT = 8

/** Any standalone number in this range is almost certainly a BPM, even unlabeled. */
const PLAUSIBLE_BPM_MIN = 80
const PLAUSIBLE_BPM_MAX = 190

/**
 * Pull a BPM out of a filename like "trap beat 140bpm.mp3" or "beat_92 bpm.wav".
 * Falls back to any standalone number in the plausible BPM range (e.g. "beat_140.mp3"),
 * since most track names don't otherwise contain a number in that band.
 */
export function parseBpmFromName(name: string): number | null {
  const labeled = name.match(/(\d{2,3})\s?bpm/i)
  if (labeled) {
    const bpm = parseInt(labeled[1], 10)
    if (bpm >= 40 && bpm <= 300) return bpm
  }
  const numbers = name.matchAll(/\d{2,3}/g)
  for (const n of numbers) {
    const bpm = parseInt(n[0], 10)
    if (bpm >= PLAUSIBLE_BPM_MIN && bpm <= PLAUSIBLE_BPM_MAX) return bpm
  }
  return null
}

/**
 * Decode on the app's shared AudioContext so the preview can play back the very
 * same buffer, on the same clock the metronome schedules against.
 */
export function decodeAudio(file: File): Promise<AudioBuffer> {
  return file.arrayBuffer().then((buf) => getAudioContext().decodeAudioData(buf))
}

/**
 * An onset-strength envelope: per-frame energy, half-wave-rectified first
 * difference. The rising difference peaks at a transient's *attack*, which is
 * what a beat grid should line up with.
 */
export interface OnsetEnvelope {
  /** Onset strength per frame. */
  strength: Float32Array
  /** Seconds between frames. */
  hopSeconds: number
  duration: number
}

export function computeOnsetEnvelope(buffer: AudioBuffer): OnsetEnvelope {
  const { sampleRate, length, numberOfChannels } = buffer
  const channels: Float32Array[] = []
  for (let c = 0; c < numberOfChannels; c += 1) channels.push(buffer.getChannelData(c))

  const hop = Math.max(1, Math.round(HOP_SECONDS * sampleRate))
  const window = Math.max(hop, Math.round(WINDOW_SECONDS * sampleRate))
  const frames = Math.max(0, Math.floor((length - window) / hop))

  const energy = new Float32Array(frames)
  for (let f = 0; f < frames; f += 1) {
    const start = f * hop
    let sum = 0
    for (let i = start; i < start + window; i += 1) {
      let mono = 0
      for (let c = 0; c < numberOfChannels; c += 1) mono += channels[c][i]
      mono /= numberOfChannels
      sum += mono * mono
    }
    // Log domain: a kick under a loud mix should register as strongly as one in
    // a quiet intro, otherwise the comb filter just follows the loudest section.
    energy[f] = Math.log1p(1000 * Math.sqrt(sum / window))
  }

  const strength = new Float32Array(frames)
  for (let f = 1; f < frames; f += 1) strength[f] = Math.max(0, energy[f] - energy[f - 1])

  return {
    strength,
    hopSeconds: hop / sampleRate,
    duration: buffer.duration,
  }
}

/**
 * Score how comb-like the envelope is at beat length `beatLen`: the magnitude of
 * the envelope's DFT at the beat frequency,
 *   |z| = |Σ_n strength[n] · exp(-2πi · t_n / beatLen)|,
 * which measures how much onset energy is periodic at that tempo.
 */
function combScore(env: OnsetEnvelope, beatLen: number): number {
  const { strength, hopSeconds } = env
  const w = (2 * Math.PI * hopSeconds) / beatLen
  let re = 0
  let im = 0
  for (let n = 0; n < strength.length; n += 1) {
    const s = strength[n]
    if (s === 0) continue
    re += s * Math.cos(w * n)
    im -= s * Math.sin(w * n)
  }
  return Math.hypot(re, im)
}

/** Refine the tempo by maximising comb strength around `seedBpm`. */
function refineTempo(env: OnsetEnvelope, seedBpm: number): number {
  if (env.duration < (MIN_BEATS_FOR_REFINEMENT * 60) / seedBpm) return seedBpm
  let best = { bpm: seedBpm, score: -Infinity }
  const steps = Math.round((2 * TEMPO_SEARCH_RADIUS_BPM) / TEMPO_SEARCH_STEP_BPM)
  for (let i = 0; i <= steps; i += 1) {
    const bpm = seedBpm - TEMPO_SEARCH_RADIUS_BPM + i * TEMPO_SEARCH_STEP_BPM
    if (bpm <= 0) continue
    const score = combScore(env, 60 / bpm)
    if (score > best.score) best = { bpm, score }
  }
  return best.bpm
}

/**
 * A drawable summary of a waveform: min/max per column, plus the duration.
 *
 * This exists so the decoded AudioBuffer can be thrown away as soon as analysis
 * is done. A 3-minute stereo track decodes to ~60MB of Float32, and holding it
 * for the whole session just to redraw a 300px waveform is the single largest
 * allocation the app makes. A few thousand floats draw the same picture.
 */
export interface WavePeaks {
  min: Float32Array
  max: Float32Array
  duration: number
}

/** Resolution to summarise at: finer than any realistic canvas width. */
const PEAK_COLUMNS = 1600

export function extractPeaks(buffer: AudioBuffer, columns = PEAK_COLUMNS): WavePeaks {
  const data = buffer.getChannelData(0)
  const cols = Math.max(1, Math.min(columns, data.length))
  const min = new Float32Array(cols)
  const max = new Float32Array(cols)
  const perCol = data.length / cols
  for (let x = 0; x < cols; x += 1) {
    const start = Math.floor(x * perCol)
    const end = Math.min(data.length, Math.floor((x + 1) * perCol))
    let lo = 0
    let hi = 0
    for (let i = start; i < end; i += 1) {
      const v = data[i]
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    min[x] = lo
    max[x] = hi
  }
  return { min, max, duration: buffer.duration }
}

/**
 * The time of the first audible sample: the moment the file stops being silent,
 * however quiet the sound is. Returns 0 for an all-silent buffer.
 */
export function findSoundStart(buffer: AudioBuffer): number {
  const { numberOfChannels, sampleRate, length } = buffer
  const channels: Float32Array[] = []
  for (let c = 0; c < numberOfChannels; c += 1) channels.push(buffer.getChannelData(c))
  for (let i = 0; i < length; i += 1) {
    for (let c = 0; c < numberOfChannels; c += 1) {
      if (Math.abs(channels[c][i]) > SOUND_START_AMPLITUDE) return i / sampleRate
    }
  }
  return 0
}

export interface BeatAnalysis extends BeatInfo {
  buffer: AudioBuffer
  /** null when the tempo came from the filename and no analysis was needed. */
  envelope: OnsetEnvelope | null
}

/**
 * Detect the beat's tempo and anchor its first beat at the moment the sound
 * starts: a file with 1s of leading silence has its first beat at exactly 1s, by
 * definition, so the grid phase comes from `findSoundStart` rather than being
 * solved from the onset envelope. The envelope is only used to refine the tempo.
 *
 * `analyze()` gives an unrounded seed tempo; we refine it against our own onset
 * envelope. We deliberately don't use the library's `guess()`: it rounds the
 * tempo to an integer, and a rounded BPM drifts ~0.16s over a 60s render at
 * 139.6 BPM, well over a third of a beat.
 *
 * A BPM in the filename is authored metadata, so it wins outright.
 */
export async function detectBeat(file: File): Promise<BeatAnalysis> {
  const buffer = await decodeAudio(file)
  const fromName = parseBpmFromName(file.name)

  // A filename BPM wins outright, so do no analysis at all in that case. Both
  // steps below are full-buffer passes over millions of samples, and
  // web-audio-beat-detector drags in standardized-audio-context — by far the
  // heaviest dependency in the app. Importing it here keeps it out of the
  // initial bundle entirely, so a correctly named beat never pays for it.
  if (fromName != null) {
    return { bpm: fromName, onsetSeconds: findSoundStart(buffer), buffer, envelope: null }
  }

  const envelope = computeOnsetEnvelope(buffer)
  const { analyze } = await import('web-audio-beat-detector')
  const bpm = refineTempo(envelope, await analyze(buffer, TEMPO_SETTINGS))
  return { bpm, onsetSeconds: findSoundStart(buffer), buffer, envelope }
}

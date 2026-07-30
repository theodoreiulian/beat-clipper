// A dance clip in the library. Every clip lives as a file under public/clips/
// and is described by manifest.json (written on disk by the dev-only Library
// tab). BPM is the tempo the person is dancing at.
export interface Clip {
  id: string
  name: string
  bpm: number | null
  /** Seconds from the start of the clip to the first beat of the quantized grid */
  offset: number
  /** Usable window: footage before trimStart / after trimEnd is NEVER rendered.
   *  null / undefined means "no cut" at that end (use the clip's true start/end). */
  trimStart?: number | null
  trimEnd?: number | null
  source: 'bundled'
  /** Playable URL: a public/clips path. */
  url: string
}

// One row of manifest.json (the committed, shippable library description).
export interface ManifestEntry {
  id: string
  file: string
  bpm: number | null
  /** Seconds from the start of the clip to the first beat of the quantized grid */
  offset: number | null
  /** Usable-window bounds (seconds). null = no cut at that end. */
  trimStart?: number | null
  trimEnd?: number | null
}

export type OutputLength = 30 | 60 | 'full'

export interface BeatInfo {
  bpm: number
  onsetSeconds: number
}

export interface RenderOptions {
  beatBpm: number
  outputLength: OutputLength
}

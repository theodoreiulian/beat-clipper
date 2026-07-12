// A dance clip in the library. Bundled clips live as files under public/clips/
// and are described by manifest.json. User clips are added at runtime and stored
// as blobs in IndexedDB. BPM is the tempo the person is dancing at.
export interface Clip {
  id: string
  name: string
  bpm: number | null
  /** Seconds from the start of the clip to the first beat of the quantized grid */
  offset: number
  source: 'bundled' | 'user'
  deleted?: boolean
  /** Playable URL: a public/clips path for bundled clips, an object URL for user clips. */
  url: string
  /** Present only for user clips (the raw video used for rendering). */
  blob?: Blob
}

// One row of manifest.json (the committed, shippable library description).
export interface ManifestEntry {
  id: string
  file: string
  bpm: number | null
  /** Seconds from the start of the clip to the first beat of the quantized grid */
  offset: number | null
}

// Per-clip override the tagging tool persists to IndexedDB.
export interface ClipOverride {
  id: string
  source: 'bundled' | 'user'
  name: string
  bpm: number | null
  /** Seconds from the start of the clip to the first beat of the quantized grid */
  offset: number | null
  deleted?: boolean
  /** Only stored for user clips. */
  blob?: Blob
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

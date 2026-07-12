import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const FIXTURES_DIR = join(ROOT, 'tests', 'fixtures')
export const CLIPS_DIR = join(ROOT, 'public', 'clips')

/** Virtual URL the browser fetches the sample beat from (served via page.route). */
export const SAMPLE_AUDIO_URL = '/__fixtures__/sample-beat'

// App module paths, passed to the page so it can `import()` them at runtime. They
// are passed as strings (not literal imports) so TypeScript doesn't try to resolve
// these browser-only, dev-server-served paths.
export const MOD = {
  render: '/src/lib/render.ts',
  bpm: '/src/lib/bpm.ts',
  db: '/src/lib/db.ts',
  manifest: '/src/lib/manifest.ts',
} as const

const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'])
const VIDEO_EXT = new Set(['.mov', '.mp4', '.m4v', '.webm'])

const AUDIO_MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
}

/**
 * Locate the sample beat. Either set SAMPLE_AUDIO to an absolute path, or drop a
 * single audio file into tests/fixtures/ (see tests/fixtures/README.md).
 */
export function findSampleAudio(): string {
  const env = process.env.SAMPLE_AUDIO
  if (env) {
    if (!existsSync(env)) throw new Error(`SAMPLE_AUDIO points at a missing file: ${env}`)
    return env
  }
  const found = existsSync(FIXTURES_DIR)
    ? readdirSync(FIXTURES_DIR).find((n) => AUDIO_EXT.has(extname(n).toLowerCase()))
    : undefined
  if (!found) {
    throw new Error(
      'No sample audio found. Drop an audio file into tests/fixtures/ (e.g. ' +
        'sample-beat.mp3) or set SAMPLE_AUDIO=/abs/path/to/beat.mp3. ' +
        'See tests/fixtures/README.md.',
    )
  }
  return join(FIXTURES_DIR, found)
}

export interface SampleClip {
  name: string
  /** Dev-server URL (public/clips is served at the site root). */
  url: string
  bytes: number
}

/**
 * Pick the N smallest real clips from public/clips/. Smallest first keeps renders
 * fast; using the committed clips keeps the test representative of real footage.
 */
export function findSampleClips(count = 3): SampleClip[] {
  if (!existsSync(CLIPS_DIR)) throw new Error(`Missing clips directory: ${CLIPS_DIR}`)
  const clips = readdirSync(CLIPS_DIR)
    .filter((n) => VIDEO_EXT.has(extname(n).toLowerCase()))
    .map((name) => ({
      name,
      url: `/clips/${encodeURIComponent(name)}`,
      bytes: statSync(join(CLIPS_DIR, name)).size,
    }))
    .sort((a, b) => a.bytes - b.bytes)
  if (clips.length === 0) {
    throw new Error(
      `No video clips in ${CLIPS_DIR}. Add and tag some dance clips before running the render tests.`,
    )
  }
  return clips.slice(0, Math.min(count, clips.length))
}

/** Serve the on-disk sample beat to the page at SAMPLE_AUDIO_URL. */
export async function routeSampleAudio(page: Page): Promise<void> {
  const path = findSampleAudio()
  const body = readFileSync(path)
  const contentType = AUDIO_MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
  await page.route(`**${SAMPLE_AUDIO_URL}`, (route) =>
    route.fulfill({ status: 200, contentType, body }),
  )
}

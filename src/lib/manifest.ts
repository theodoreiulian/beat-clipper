import type { Clip, ManifestEntry } from '../types'

const MANIFEST_URL = `${import.meta.env.BASE_URL}clips/manifest.json`

async function fetchManifest(): Promise<ManifestEntry[]> {
  try {
    const res = await fetch(MANIFEST_URL, { cache: 'no-store' })
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

/** Map committed manifest rows to playable library clips. */
export function clipsFromEntries(entries: ManifestEntry[]): Clip[] {
  return entries.map((entry) => ({
    id: entry.id,
    name: entry.file,
    bpm: entry.bpm,
    offset: entry.offset ?? 0,
    trimStart: entry.trimStart ?? null,
    trimEnd: entry.trimEnd ?? null,
    source: 'bundled' as const,
    url: `${import.meta.env.BASE_URL}clips/${encodeURIComponent(entry.file)}`,
  }))
}

/**
 * Build the in-memory clip library from the committed manifest. This is the
 * production/visitor read path (static host, no backend): every clip is a file
 * under public/clips/ described by manifest.json. The dev-only Library tab
 * writes that manifest directly on disk (see src/lib/libraryApi.ts +
 * vite-plugin-library.ts), so the generator and the tagging tool read the same
 * source of truth.
 *
 * @param opts.includeUntagged keep clips with bpm == null; the generator passes
 *   false so only usable, tagged clips remain.
 */
export async function loadLibrary(opts: { includeUntagged: boolean }): Promise<Clip[]> {
  const clips = clipsFromEntries(await fetchManifest())
  return opts.includeUntagged ? clips : clips.filter((c) => c.bpm != null)
}

/**
 * Download a copy of the current manifest. Optional now that the Library tab
 * writes public/clips/manifest.json on disk as you tag — kept only as a manual
 * backup/snapshot for the owner.
 */
export async function exportManifest(): Promise<void> {
  const entries = await fetchManifest()
  const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'manifest.json'
  a.click()
  URL.revokeObjectURL(url)
}

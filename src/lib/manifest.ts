import type { Clip, ClipOverride, ManifestEntry } from '../types'
import { getOverrides, getOverride, putOverride, deleteOverride, clearOverrides } from './db'

const MANIFEST_URL = `${import.meta.env.BASE_URL}clips/manifest.json`

/** Build a user Clip (blob-backed, playable from an object URL) from an override. */
function userClipFromOverride(ov: ClipOverride): Clip {
  return {
    id: ov.id,
    name: ov.name,
    bpm: ov.bpm,
    offset: ov.offset ?? 0,
    source: 'user',
    deleted: ov.deleted,
    url: URL.createObjectURL(ov.blob as Blob),
    blob: ov.blob,
  }
}

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

/**
 * Build the in-memory clip library by merging the committed manifest with any
 * IndexedDB overrides (BPM edits / deletions) and user-added clips.
 *
 * @param opts.includeUntagged keep clips with bpm == null (tagging tool); the
 *   generator passes false so only usable, tagged, non-deleted clips remain.
 */
export async function loadLibrary(opts: { includeUntagged: boolean }): Promise<Clip[]> {
  const [manifest, overrides] = await Promise.all([fetchManifest(), getOverrides()])
  const overrideById = new Map<string, ClipOverride>(overrides.map((o) => [o.id, o]))

  const clips: Clip[] = []

  // Bundled clips (from manifest), with overrides applied.
  for (const entry of manifest) {
    const ov = overrideById.get(entry.id)
    overrideById.delete(entry.id)

    // A user clip whose blob is still in IndexedDB is authoritative: play it from
    // the blob, not the committed file path. The id can collide with a manifest
    // entry once you've exported your own user clips, and the committed file may
    // not exist (or may be named differently) if the manifest drifted out of sync.
    if (ov?.source === 'user' && ov.blob) {
      clips.push(userClipFromOverride(ov))
      continue
    }

    clips.push({
      id: entry.id,
      name: ov?.name ?? entry.file,
      bpm: ov ? ov.bpm : entry.bpm,
      offset: ov?.offset ?? entry.offset ?? 0,
      source: 'bundled',
      deleted: ov?.deleted,
      url: `${import.meta.env.BASE_URL}clips/${encodeURIComponent(entry.file)}`,
    })
  }

  // Remaining overrides are user-added clips (blob stored in IndexedDB).
  for (const ov of overrideById.values()) {
    if (ov.source !== 'user' || !ov.blob) continue
    clips.push(userClipFromOverride(ov))
  }

  return clips.filter((c) => {
    if (c.deleted) return false
    if (!opts.includeUntagged && c.bpm == null) return false
    return true
  })
}

export async function setClipGrid(clip: { id: string; bpm: number; offset: number }): Promise<void> {
  const existing = await getOverride(clip.id)
  await putOverride({
    id: clip.id,
    source: existing?.source ?? 'bundled',
    name: existing?.name ?? clip.id,
    bpm: clip.bpm,
    offset: clip.offset,
    deleted: existing?.deleted,
    blob: existing?.blob,
  })
}

export async function markDeleted(clip: Clip): Promise<void> {
  const existing = await getOverride(clip.id)
  await putOverride({
    id: clip.id,
    source: clip.source,
    name: clip.name,
    bpm: existing?.bpm ?? clip.bpm,
    offset: existing?.offset ?? clip.offset ?? 0,
    deleted: true,
    blob: existing?.blob ?? clip.blob,
  })
}

export async function addUserClip(file: File): Promise<void> {
  const id = `user-${crypto.randomUUID()}`
  await putOverride({
    id,
    source: 'user',
    name: file.name,
    bpm: null,
    offset: null,
    blob: file,
  })
}

/** Permanently remove a user clip from IndexedDB (only valid for user clips). */
export async function purgeUserClip(clip: Clip): Promise<void> {
  if (clip.source === 'user') await deleteOverride(clip.id)
}

/**
 * Wipe the entire stored library: every uploaded clip and every bundled-clip
 * override (BPM/offset edits and deletions). Used to start tagging from scratch.
 */
export async function clearLibrary(): Promise<void> {
  await clearOverrides()
}

/**
 * Serialize the current non-deleted library to a manifest.json the owner can
 * commit into public/clips/. Each entry's `file` is the clip's own filename, so
 * the owner commits the original video files under their original names and the
 * manifest points straight at them (no renaming required).
 */
export async function exportManifest(): Promise<void> {
  const clips = await loadLibrary({ includeUntagged: true })
  const entries: ManifestEntry[] = clips.map((c) => ({
    id: c.id,
    file: c.name,
    bpm: c.bpm,
    offset: c.offset,
  }))
  const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'manifest.json'
  a.click()
  URL.revokeObjectURL(url)
}

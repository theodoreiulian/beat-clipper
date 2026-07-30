// Client for the dev-only library backend (see vite-plugin-library.ts). The
// Library tab talks to these endpoints to persist clips + manifest.json to disk
// directly, replacing the old IndexedDB/export-manifest loop. Only ever used by
// the dev-only TagPage, so the absolute /__library path is fine.
import type { ManifestEntry } from '../types'

const API = '/__library/clips'

/** The reconciled library: manifest entries + any loose files in public/clips. */
export async function fetchLibraryEntries(): Promise<ManifestEntry[]> {
  const res = await fetch(API, { cache: 'no-store' })
  if (!res.ok) throw new Error(`Could not load library (${res.status})`)
  return res.json()
}

/**
 * Persist a subset of a clip's editable fields (grid bpm/offset and/or the trim
 * window). Only the keys passed are written on the server, so a trim save leaves
 * the grid untouched and vice-versa.
 */
export async function patchClip(
  id: string,
  fields: Partial<Pick<ManifestEntry, 'bpm' | 'offset' | 'trimStart' | 'trimEnd'>>,
): Promise<ManifestEntry> {
  const res = await fetch(`${API}/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  })
  if (!res.ok) throw new Error(`Could not save clip (${res.status})`)
  return res.json()
}

/** Move a clip's file to public/clips/_trash and drop its manifest entry. */
export async function deleteClipById(id: string): Promise<void> {
  const res = await fetch(`${API}/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`Could not delete clip (${res.status})`)
}

/**
 * Upload one clip, streaming the File straight to the server (never buffered
 * into an ArrayBuffer). XHR is used over fetch because only XHR reports upload
 * progress, which drives the per-file byte accounting in uploadClips.
 */
export function uploadClip(file: File, onProgress?: (loaded: number) => void): Promise<ManifestEntry> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${API}?name=${encodeURIComponent(file.name)}`)
    xhr.responseType = 'text'
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded)
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText))
        } catch {
          reject(new Error('Malformed upload response'))
        }
      } else {
        reject(new Error(`Upload failed (${xhr.status})`))
      }
    }
    xhr.onerror = () => reject(new Error('Upload network error'))
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.send(file)
  })
}

export interface UploadProgress {
  /** Files finished (succeeded or failed). */
  done: number
  total: number
  /** Overall bytes transferred, 0..1, weighted by file size for a smooth bar. */
  ratio: number
}

export interface UploadResult {
  uploaded: ManifestEntry[]
  failed: { name: string; error: string }[]
}

/**
 * Upload many clips with a bounded number in flight so a 50-file dump streams
 * steadily instead of opening 50 simultaneous requests. A single failed file is
 * recorded, not thrown, so the rest of the batch still lands.
 */
export async function uploadClips(
  files: File[],
  opts: { concurrency?: number } = {},
  onProgress?: (p: UploadProgress) => void,
): Promise<UploadResult> {
  const concurrency = opts.concurrency ?? 3
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0)
  const uploaded: ManifestEntry[] = []
  const failed: { name: string; error: string }[] = []

  let done = 0
  let baseLoaded = 0 // bytes from finished files
  const inFlight = new Map<number, number>() // index -> bytes loaded so far

  const emit = () => {
    const live = Array.from(inFlight.values()).reduce((a, b) => a + b, 0)
    const ratio = totalBytes ? Math.min(1, (baseLoaded + live) / totalBytes) : 1
    onProgress?.({ done, total: files.length, ratio })
  }

  let next = 0
  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= files.length) return
      inFlight.set(i, 0)
      try {
        uploaded.push(
          await uploadClip(files[i], (loaded) => {
            inFlight.set(i, loaded)
            emit()
          }),
        )
      } catch (err) {
        failed.push({ name: files[i].name, error: String((err as Error)?.message ?? err) })
      } finally {
        baseLoaded += files[i].size
        inFlight.delete(i)
        done += 1
        emit()
      }
    }
  }

  emit()
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker))
  return { uploaded, failed }
}

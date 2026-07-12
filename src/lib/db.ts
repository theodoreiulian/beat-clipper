import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { ClipOverride } from '../types'

// Single object store holding overrides for bundled clips (bpm / deleted) and
// the full record for user-added clips (including the video blob). Keyed by id.
interface BeatClipperDB extends DBSchema {
  clips: {
    key: string
    value: ClipOverride
  }
}

let dbPromise: Promise<IDBPDatabase<BeatClipperDB>> | null = null

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<BeatClipperDB>('beat-clipper', 3, {
      upgrade(db, oldVersion, _newVersion, transaction) {
        if (oldVersion < 1) {
          if (!db.objectStoreNames.contains('clips')) {
            db.createObjectStore('clips', { keyPath: 'id' })
          }
        }
        // v2→v3: offset field added; clear pre-offset records on any upgrade from < 3
        if (oldVersion > 0 && oldVersion < 3) {
          transaction.objectStore('clips').clear()
        }
      },
    }).catch((err) => {
      dbPromise = null
      throw err
    })
  }
  return dbPromise
}

export async function getOverrides(): Promise<ClipOverride[]> {
  const db = await getDB()
  return db.getAll('clips')
}

export async function putOverride(override: ClipOverride): Promise<void> {
  const db = await getDB()
  await db.put('clips', override)
}

export async function getOverride(id: string): Promise<ClipOverride | undefined> {
  const db = await getDB()
  return db.get('clips', id)
}

export async function deleteOverride(id: string): Promise<void> {
  const db = await getDB()
  await db.delete('clips', id)
}

/** Wipe every stored override and user clip (full library reset). */
export async function clearOverrides(): Promise<void> {
  const db = await getDB()
  await db.clear('clips')
}

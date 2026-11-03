// Dev-only backend for the clip library. The tagging UI (/#/tag) is itself
// dev-only, and a browser can't write to public/clips, so this Vite plugin
// exposes a tiny HTTP API the Library tab calls to persist clips + manifest to
// disk directly — no export/replace step. It runs under `vite serve` only
// (apply: 'serve'); the static production build never includes it, so the
// "deploys to any static host, no server" guarantee is untouched.
//
// public/clips/ + public/clips/manifest.json are the single source of truth.
// Every manifest read-modify-write goes through one in-process mutex and every
// write is atomic (temp file -> rename), so a burst of concurrent uploads can't
// clobber the manifest.
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Plugin } from 'vite'

import type { ManifestEntry } from './src/types'
import { createAutoTagService, clipFingerprint } from './server/autoTag'

// Fields a PATCH may set. Only keys actually present in the request body are
// touched, so e.g. a trim-only save never clobbers bpm/offset.
const PATCHABLE = ['bpm', 'offset', 'trimStart', 'trimEnd'] as const

const API_PREFIX = '/__library/clips'
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.m4v'])
const TRASH_DIR = '_trash'

export function libraryPlugin(): Plugin {
  return {
    name: 'beat-clipper-library',
    apply: 'serve',
    configureServer(server) {
      const clipsDir = path.resolve(server.config.root, 'public/clips')
      const manifestPath = path.join(clipsDir, 'manifest.json')
      const trashDir = path.join(clipsDir, TRASH_DIR)

      // Serialize all manifest read-modify-write sections. Renames happen inside
      // the lock too, so each section sees the on-disk names chosen by prior ones.
      let tail: Promise<unknown> = Promise.resolve()
      const withLock = <T>(fn: () => Promise<T>): Promise<T> => {
        const result = tail.then(fn)
        tail = result.catch(() => {})
        return result
      }

      const readManifest = async (): Promise<ManifestEntry[]> => {
        try {
          const data = JSON.parse(await readFile(manifestPath, 'utf8'))
          return Array.isArray(data) ? data : []
        } catch {
          return []
        }
      }

      const writeManifest = async (entries: ManifestEntry[]): Promise<void> => {
        await mkdir(clipsDir, { recursive: true })
        const tmp = `${manifestPath}.tmp-${process.pid}-${Date.now()}`
        await writeFile(tmp, `${JSON.stringify(entries, null, 2)}\n`)
        await rename(tmp, manifestPath)
      }

      const listVideoFiles = async (): Promise<string[]> => {
        try {
          const names = await readdir(clipsDir)
          return names.filter((n) => VIDEO_EXTENSIONS.has(path.extname(n).toLowerCase()))
        } catch {
          return []
        }
      }

      // Read the manifest, drop entries whose file is gone, and append any video
      // file on disk that isn't tracked yet (as untagged). Persist only if it
      // changed, so the committed manifest keeps stable ids for loose files.
      const reconcile = async (): Promise<ManifestEntry[]> => {
        const [entries, files] = await Promise.all([readManifest(), listVideoFiles()])
        const onDisk = new Set(files)
        const kept = entries.filter((e) => e.file && onDisk.has(e.file))
        const known = new Set(kept.map((e) => e.file))
        const loose = files
          .filter((f) => !known.has(f))
          .sort((a, b) => a.localeCompare(b))
          .map<ManifestEntry>((file) => ({ id: randomUUID(), file, bpm: null, offset: null }))
        const result = [...kept, ...loose]
        if (JSON.stringify(result) !== JSON.stringify(entries)) await writeManifest(result)
        return result
      }

      const autoTag = createAutoTagService({
        root: server.config.root,
        entries: () => withLock(reconcile),
        approve: (id, grid, fingerprint) => withLock(async () => {
          const entries = await readManifest()
          const entry = entries.find(e => e.id === id)
          if (!entry) throw new Error('Clip no longer exists')
          if (await clipFingerprint(server.config.root, entry) !== fingerprint) {
            throw new Error('Clip or usable window changed. Scan it again before approving.')
          }
          entry.bpm = grid.bpm
          entry.offset = grid.offset
          await writeManifest(entries)
          return entry
        }),
      })
      server.httpServer?.once('close', () => autoTag.close())

      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (url.pathname === '/__library/auto-tag' || url.pathname.startsWith('/__library/auto-tag/')) {
          void autoTag.handle(req, res, url).catch(next)
          return
        }
        if (url.pathname !== API_PREFIX && !url.pathname.startsWith(`${API_PREFIX}/`)) return next()

        handle(req, res, url).catch((err) => {
          server.config.logger.error(`[library] ${String(err?.stack ?? err)}`)
          sendJson(res, 500, { error: String(err?.message ?? err) })
        })
      })

      async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
        const rest = url.pathname.slice(API_PREFIX.length) // '' or '/<id>'
        const id = rest.startsWith('/') ? decodeURIComponent(rest.slice(1)) : ''
        const method = req.method ?? 'GET'

        // GET /__library/clips -> reconciled library
        if (method === 'GET' && !id) {
          sendJson(res, 200, await withLock(reconcile))
          return
        }

        // POST /__library/clips?name=<original> -> stream body to a file + entry
        if (method === 'POST' && !id) {
          const rawName = url.searchParams.get('name') ?? 'clip.mp4'
          const desired = safeBaseName(decodeURIComponent(rawName))
          if (!desired) {
            sendJson(res, 400, { error: 'invalid file name' })
            return
          }
          // Stream to a temp file first (outside the lock) so large uploads run
          // in parallel; only the fast rename + manifest append is serialized.
          await mkdir(clipsDir, { recursive: true })
          const tmpPath = path.join(clipsDir, `.upload-${randomUUID()}`)
          try {
            await pipeline(req, createWriteStream(tmpPath))
          } catch (err) {
            await unlink(tmpPath).catch(() => {})
            throw err
          }
          const entry = await withLock(async () => {
            const finalName = uniqueName(desired, new Set(await listVideoFiles()))
            await rename(tmpPath, path.join(clipsDir, finalName))
            const entries = await readManifest()
            const created: ManifestEntry = { id: randomUUID(), file: finalName, bpm: null, offset: null }
            entries.push(created)
            await writeManifest(entries)
            return created
          }).catch(async (err) => {
            await unlink(tmpPath).catch(() => {})
            throw err
          })
          sendJson(res, 200, entry)
          return
        }

        // PATCH /__library/clips/<id> -> merge grid / trim fields present in body
        if (method === 'PATCH' && id) {
          const body = await readJson(req)
          const entry = await withLock(async () => {
            const entries = await readManifest()
            const found = entries.find((e) => e.id === id)
            if (!found) return null
            for (const key of PATCHABLE) {
              if (body && key in body) found[key] = numberOrNull(body[key])
            }
            await writeManifest(entries)
            return found
          })
          if (!entry) sendJson(res, 404, { error: 'clip not found' })
          else sendJson(res, 200, entry)
          return
        }

        // DELETE /__library/clips/<id> -> move file to _trash, drop entry
        if (method === 'DELETE' && id) {
          const ok = await withLock(async () => {
            const entries = await readManifest()
            const idx = entries.findIndex((e) => e.id === id)
            if (idx === -1) return false
            const [removed] = entries.splice(idx, 1)
            if (removed.file) {
              await mkdir(trashDir, { recursive: true })
              const dest = path.join(trashDir, uniqueName(removed.file, new Set(await readdir(trashDir).catch(() => []))))
              await rename(path.join(clipsDir, removed.file), dest).catch(() => {})
            }
            await writeManifest(entries)
            return true
          })
          if (!ok) sendJson(res, 404, { error: 'clip not found' })
          else sendJson(res, 200, { ok: true })
          return
        }

        sendJson(res, 405, { error: 'method not allowed' })
      }
    },
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(json)
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.setEncoding('utf8')
    req.on('data', (c) => (data += c))
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Strip any directory part; reject traversal so writes stay inside public/clips. */
function safeBaseName(raw: string): string {
  const base = path.basename(raw).replace(/[/\\]/g, '').trim()
  if (!base || base === '.' || base === '..') return ''
  return base
}

/** "clip.mp4" -> "clip (2).mp4" when the name is already taken. */
function uniqueName(desired: string, taken: Set<string>): string {
  if (!taken.has(desired)) return desired
  const ext = path.extname(desired)
  const stem = desired.slice(0, desired.length - ext.length)
  let n = 2
  let candidate = `${stem} (${n})${ext}`
  while (taken.has(candidate)) candidate = `${stem} (${++n})${ext}`
  return candidate
}

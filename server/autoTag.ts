// Local owner tooling only. Imported by Vite's apply:'serve' library plugin.
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import type { ManifestEntry } from '../src/types'
import type { AutoTagState, AutoTagJob, AutoTagProposal, AutoTagResult, AutoTagBenchmark, BenchmarkRow } from '../src/lib/autoTagTypes'

const PREFIX = '/__library/auto-tag'
const VERSION = 'beta-2'

/** Content identity includes the usable window; a changed file/trim invalidates review. */
export async function clipFingerprint(root: string, entry: ManifestEntry): Promise<string> {
  if (path.basename(entry.file) !== entry.file) throw new Error('Invalid clip filename')
  const info = await stat(path.join(root, 'public/clips', entry.file))
  return createHash('sha256').update(JSON.stringify([entry.file, info.size, info.mtimeMs, entry.trimStart ?? null, entry.trimEnd ?? null])).digest('hex')
}

interface Options {
  root: string
  entries: () => Promise<ManifestEntry[]>
  approve: (id: string, grid: { bpm: number; offset: number }, fingerprint: string) => Promise<ManifestEntry>
  /** Deterministic worker seam for queue/approval tests; never set from HTTP input. */
  workerCommand?: (entry: ManifestEntry, audioOnly: boolean) => { command: string; args: string[] }
  isReady?: () => Promise<boolean>
}

export function createAutoTagService(options: Options) {
  const root = options.root
  const runtime = path.join(root, '.auto-tag')
  const python = path.join(runtime, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const statePath = path.join(runtime, 'review.json')
  let proposals: Record<string, AutoTagProposal> = {}
  let benchmark: AutoTagBenchmark | null = null
  let job: AutoTagJob | null = null
  let child: ChildProcess | null = null
  let closed = false
  let mutationTail: Promise<unknown> = Promise.resolve()
  const lock = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = mutationTail.then(fn)
    mutationTail = result.catch(() => {})
    return result
  }
  const loaded = (async () => {
    try {
      const data = JSON.parse(await readFile(statePath, 'utf8'))
      proposals = data.proposals ?? {}
      benchmark = data.benchmark?.version === VERSION ? data.benchmark : null
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  })()
  async function persist() {
    await mkdir(runtime, { recursive: true })
    const tmp = `${statePath}.tmp-${randomUUID()}`
    await writeFile(tmp, `${JSON.stringify({ proposals, benchmark }, null, 2)}\n`)
    await rename(tmp, statePath)
  }
  async function ready() {
    if (options.isReady) return options.isReady()
    try {
      await Promise.all([python, path.join(runtime, 'ready.json'), ...['full'].map(v => path.join(runtime, 'models', `pose_landmarker_${v}.task`))].map(file => access(file)))
      return true
    } catch { return false }
  }
  async function status(): Promise<AutoTagState> {
    await loaded
    try {
      const report = JSON.parse(await readFile(path.join(runtime, 'benchmark.json'), 'utf8'))
      if (report.version === VERSION && report.processed === report.total && (!benchmark || report.createdAt > benchmark.createdAt)) benchmark = report
    } catch { /* A benchmark is optional. */ }
    return { ready: await ready(), job, proposals, benchmark }
  }
  function busy() { return job?.status === 'running' }
  function launch(command: string, args: string[], onLine: (line: string) => void, limit = 12 * 60_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
      child = proc
      let buffer = '', stderr = '', spawnError: Error | null = null, timedOut = false
      const timer = setTimeout(() => { timedOut = true; stopProcess(proc) }, limit)
      let killTimer: ReturnType<typeof setTimeout> | undefined
      // Bound cancellation even if native model initialization doesn't handle SIGTERM.
      const kill = () => { killTimer = setTimeout(() => proc.kill('SIGKILL'), 3000) }
      proc.on('exit', () => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer) })
      proc.on('error', error => { spawnError = error })
      proc.stdout?.on('data', data => {
        buffer += String(data)
        if (buffer.length > 2_000_000) { proc.kill('SIGTERM'); spawnError = new Error('Worker output limit exceeded'); kill(); return }
        let end: number
        while ((end = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
          onLine(line)
        }
      })
      proc.stderr?.on('data', data => { stderr = (stderr + String(data)).slice(-8000) })
      proc.on('close', code => {
        clearTimeout(timer)
        if (child === proc) child = null
        if (buffer) onLine(buffer)
        if (spawnError) reject(spawnError)
        else if (timedOut) reject(new Error('Analysis timed out; shorten the usable window and try again.'))
        else if (code !== 0) reject(new Error(stderr.trim().slice(-1200) || 'Scanner stopped before producing a result.'))
        else resolve()
      })
    })
  }
  function worker(entry: ManifestEntry, audioOnly: boolean) {
    if (options.workerCommand) return options.workerCommand(entry, audioOnly)
    return { command: python, args: ['scripts/auto_tag/scan.py', '--file', path.join(root, 'public/clips', entry.file), '--start', String(entry.trimStart ?? 0), ...(entry.trimEnd != null ? ['--end', String(entry.trimEnd)] : []), ...(audioOnly ? ['--audio-only'] : [])] }
  }
  async function scan(entries: ManifestEntry[], kind: 'scan' | 'benchmark', audioOnly: boolean, active: AutoTagJob) {
    const rows: BenchmarkRow[] = []
    try {
      for (const entry of entries) {
        if (closed || active.status !== 'running') break
        active.currentClipId = entry.id; active.currentFile = entry.file
        active.stage = 'starting'; active.progress = 0; active.message = 'Starting local analysis…'
        try {
          const fingerprint = await clipFingerprint(root, entry)
          if (active.status !== 'running' || closed) break
          let result: AutoTagResult | null = null
          let workerError = ''
          const cmd = worker(entry, audioOnly)
          await launch(cmd.command, cmd.args, line => {
            let data
            try { data = JSON.parse(line) } catch { return }
            if (data.type === 'progress') {
              active.stage = String(data.stage); active.progress = Math.max(0, Math.min(1, Number(data.progress) || 0)); active.message = String(data.message)
            } else if (data.type === 'result') result = data.result
            else if (data.type === 'error') workerError = String(data.message)
          }).catch(error => { throw new Error(workerError || error.message) })
          if (active.status !== 'running' || closed) break
          const analyzed = result as AutoTagResult | null
          if (!analyzed || !validResult(analyzed)) throw new Error('Scanner returned an invalid result')
          // A source can be edited/deleted while native inference runs.
          const current = (await options.entries()).find(e => e.id === entry.id)
          if (!current || await clipFingerprint(root, current) !== fingerprint) throw new Error('Clip or usable window changed during analysis. Scan it again.')
          if (active.status !== 'running' || closed) break
          if (kind === 'benchmark') {
            rows.push(benchmarkRow(entry, analyzed))
          } else if (audioOnly && analyzed.audio?.available === false) {
            active.skipped = (active.skipped ?? 0) + 1
          } else {
            await lock(async () => {
              if (active.status !== 'running' || closed) return
              proposals[entry.id] = { clipId: entry.id, runId: randomUUID(), fingerprint, createdAt: new Date().toISOString(), state: 'pending', result: analyzed }
              await persist()
            })
          }
        } catch (error) {
          if (active.status !== 'running') break
          const message = String((error as Error).message)
          active.errors.push({ clipId: entry.id, message }); active.failed++
          if (kind === 'benchmark') rows.push({ id: entry.id, file: entry.file, expectedBpm: entry.bpm!, predictedBpm: null, absoluteError: null, exact: false, octaveEquivalent: false, error: message })
        }
        active.done++
      }
      if (kind === 'benchmark' && active.status === 'running') {
        await lock(async () => {
          benchmark = { version: VERSION, createdAt: new Date().toISOString(), total: entries.length, proposed: rows.filter(r => r.predictedBpm != null).length, exact: rows.filter(r => r.exact).length, octaveEquivalent: rows.filter(r => r.octaveEquivalent).length, rows }
          await persist()
        })
      }
      if (active.status === 'running') {
        active.status = 'completed'; active.progress = 1
        active.message = active.failed ? `Finished with ${active.failed} failed scans. Other results are saved.` : `Finished${active.skipped ? ` · ${active.skipped} without audible soundtracks` : ''}. Suggestions still require human verification.`
      }
    } catch (error) { active.status = 'failed'; active.message = String((error as Error).message) }
    finally { delete active.currentClipId; delete active.currentFile }
  }
  async function setup(active: AutoTagJob) {
    try {
      await launch(process.execPath, ['scripts/setup-auto-tag.mjs'], line => { active.message = line.slice(-300) }, 15 * 60_000)
      if (active.status === 'running') { active.status = 'completed'; active.done = 1; active.progress = 1; active.message = 'Scanner ready. You can now scan clips.' }
    } catch (error) { if (active.status === 'running') { active.status = 'failed'; active.message = String((error as Error).message) } }
  }
  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false
    try {
      await loaded
      const route = url.pathname.slice(PREFIX.length)
      if (req.method === 'GET' && !route) { send(res, 200, await status()); return true }
      // Mutations are local same-origin owner actions, never cross-site requests.
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) throw new HttpError(403, 'Cross-origin requests are not allowed')
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed')
      const body = await readBody(req)
      if (route === '/cancel') {
        if (job?.status === 'running') { job.status = 'cancelled'; job.message = 'Cancelled. Completed suggestions have been kept.'; const proc = child; if (proc) stopProcess(proc) }
        send(res, 200, await status()); return true
      }
      if (route === '/setup' || route === '/scan' || route === '/benchmark') {
        const { active, entries, kind } = await lock(async () => {
        if (busy() || child) throw new HttpError(409, 'A scanner job is already running')
        const kind = route.slice(1) as AutoTagJob['kind']
        if (kind !== 'setup' && !await ready()) throw new HttpError(503, 'Set up the scanner first (npm run setup:auto-tag).')
        const all = await options.entries()
        const ids = body.ids
        if (kind === 'scan' && (!Array.isArray(ids) || !ids.length || ids.length > 250 || !ids.every(id => typeof id === 'string'))) throw new HttpError(400, 'Choose 1–250 clips to scan')
        const entries = kind === 'benchmark' ? all.filter(e => e.bpm != null && e.bpm > 0) : kind === 'scan' ? [...new Set(ids as string[])].map(id => { const found = all.find(e => e.id === id); if (!found) throw new HttpError(404, 'Clip not found'); return found }) : []
        if (kind === 'benchmark' && !entries.length) throw new HttpError(400, 'No human-tagged clips available to benchmark')
        const active: AutoTagJob = { id: randomUUID(), kind, status: 'running', total: kind === 'setup' ? 1 : entries.length, done: 0, failed: 0, stage: 'queued', progress: 0, message: 'Queued', errors: [] }
        job = active
          return { active, entries, kind }
        })
        send(res, 202, { job: active })
        if (kind === 'setup') void setup(active)
        else void scan(entries, kind, body.audioOnly === true, active)
        return true
      }
      const match = route.match(/^\/([^/]+)\/(approve|dismiss)$/)
      if (match) {
        const id = decodeURIComponent(match[1])
        const response = await lock(async () => {
          const proposal = proposals[id]
          if (!proposal || proposal.runId !== body.runId || proposal.state !== 'pending') throw new HttpError(409, 'This suggestion has changed or was already reviewed. Refresh it before continuing.')
          if (match[2] === 'dismiss') { proposal.state = 'dismissed'; await persist(); return { ok: true } }
          const bpm = body.bpm, offset = body.offset
          if (typeof bpm !== 'number' || !Number.isFinite(bpm) || bpm < 30 || bpm > 300 || typeof offset !== 'number' || !Number.isFinite(offset) || offset < 0 || offset >= 60 / bpm) throw new HttpError(400, 'Choose a BPM from 30–300 and an offset within one beat')
          const current = (await options.entries()).find(e => e.id === id)
          if (!current || await clipFingerprint(root, current) !== proposal.fingerprint) throw new HttpError(409, 'Clip or usable window changed. Scan it again before approving.')
          const entry = await options.approve(id, { bpm, offset }, proposal.fingerprint)
          proposal.state = 'approved'; proposal.reviewedGrid = { bpm, offset }
          await persist()
          return entry
        })
        send(res, 200, response); return true
      }
      throw new HttpError(404, 'Unknown scanner endpoint')
    } catch (error) { send(res, error instanceof HttpError ? error.status : 500, { error: String((error as Error).message) }); return true }
  }
  return { handle, status, close() { closed = true; if (job?.status === 'running') job.status = 'cancelled'; if (child) stopProcess(child) } }
}

function validResult(result: AutoTagResult) {
  return ['suggested', 'needs-manual'].includes(result.status) && Array.isArray(result.candidates) && Array.isArray(result.warnings) &&
    ['audio', 'audio-supported', 'visual'].includes(result.method) && ['low', 'medium', 'high'].includes(result.confidence) &&
    Number.isFinite(result.evidenceScore) && result.evidenceScore >= 0 && result.evidenceScore <= 1 &&
    (result.bpm === null || Number.isFinite(result.bpm) && result.bpm >= 30 && result.bpm <= 300) &&
    (result.bpm === null ? result.offset === null : typeof result.offset === 'number' && Number.isFinite(result.offset) && result.offset >= 0 && result.offset < 60 / result.bpm) &&
    result.candidates.every(c => Number.isFinite(c.bpm) && c.bpm >= 30 && c.bpm <= 300 && Number.isFinite(c.offset) && c.offset >= 0 && c.offset < 60 / c.bpm && Number.isFinite(c.score))
}
function benchmarkRow(entry: ManifestEntry, result: AutoTagResult): BenchmarkRow {
  const expected = entry.bpm!, predicted = result.bpm
  const within = (value: number) => Math.abs(value - expected) <= Math.max(2, expected * .03)
  return { id: entry.id, file: entry.file, expectedBpm: expected, predictedBpm: predicted, method: result.method, confidence: result.confidence, absoluteError: predicted == null ? null : Math.abs(predicted - expected), exact: predicted != null && within(predicted), octaveEquivalent: predicted != null && [.5, 1, 2].some(scale => within(predicted * scale)) }
}
class HttpError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}
function send(res: ServerResponse, status: number, data: unknown) { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)) }
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let data = ''
  for await (const chunk of req) { data += String(chunk); if (data.length > 100_000) throw new HttpError(413, 'Request too large') }
  try { const parsed = JSON.parse(data || '{}'); if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error(); return parsed }
  catch { throw new HttpError(400, 'Expected a JSON object') }
}

function stopProcess(proc: ChildProcess) {
  const kill = (signal: NodeJS.Signals) => {
    try { if (process.platform !== 'win32' && proc.pid) process.kill(-proc.pid, signal); else proc.kill(signal) } catch { /* already exited */ }
  }
  kill('SIGTERM')
  const timer = setTimeout(() => kill('SIGKILL'), 3000)
  timer.unref()
  proc.once('close', () => clearTimeout(timer))
}

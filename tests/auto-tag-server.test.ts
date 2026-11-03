import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { createAutoTagService, clipFingerprint } from '../server/autoTag.ts'
import type { AutoTagResult } from '../src/lib/autoTagTypes.ts'
import type { ManifestEntry } from '../src/types.ts'

const result: AutoTagResult = { version: 'beta-2', status: 'suggested', bpm: 120, offset: .1, method: 'audio', audio: { available: true, confidence: .6, candidates: [{ bpm: 120, offset: .1, score: 1 }] }, confidence: 'medium', evidenceScore: .6, candidates: [{ bpm: 120, offset: .1, score: 1 }], warnings: [], analyzedSeconds: 10, elapsedSeconds: 1 }
async function fixture(t: TestContext, silentAudioOnly = false) {
  let audioOnlyRequested = false
  const root = await mkdtemp(path.join(tmpdir(), 'beat-auto-tag-'))
  await mkdir(path.join(root, 'public/clips'), { recursive: true })
  await writeFile(path.join(root, 'public/clips/test.mp4'), 'fixture')
  const entries: ManifestEntry[] = [{ id: 'new', file: 'test.mp4', bpm: null, offset: null }]
  let approvals = 0
  const service = createAutoTagService({ root, isReady: async () => true, entries: async () => structuredClone(entries),
    workerCommand: (_entry, audioOnly) => {
      audioOnlyRequested = audioOnly
      const output = audioOnly && silentAudioOnly ? { ...result, status: 'needs-manual', bpm: null, offset: null, candidates: [], audio: { available: false, confidence: 0, candidates: [] } } : result
      return { command: process.execPath, args: ['-e', `setTimeout(() => console.log(JSON.stringify({type:'result',result:${JSON.stringify(output)}})), 80)`] }
    },
    approve: async (id, grid, fingerprint) => {
      const entry = entries.find(e => e.id === id)!
      if (await clipFingerprint(root, entry) !== fingerprint) throw new Error('Clip changed; rescan required')
      Object.assign(entry, grid); approvals++; return entry
    },
  })
  const server = createServer((req, res) => { void service.handle(req, res, new URL(req.url!, 'http://localhost')) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const api = async (route: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${address.port}/__library/auto-tag${route}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { status: res.status, body: await res.json() }
  }
  const finish = async () => {
    for (let i = 0; i < 150; i++) {
      const state = (await api('')).body
      if (state.job?.status !== 'running') return state
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('Job did not finish')
  }
  t.after(async () => { service.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) })
  return { root, entries, service, api, finish, approvals: () => approvals, audioOnlyRequested: () => audioOnlyRequested }
}

test('scanning persists a pending proposal without making the clip renderable; explicit review commits once', async t => {
  const f = await fixture(t)
  assert.equal((await f.api('/scan', { ids: ['new'] })).status, 202)
  const state = await f.finish()
  assert.equal(state.proposals.new.state, 'pending')
  assert.equal(f.entries[0].bpm, null)
  assert.equal(f.approvals(), 0)
  const persisted = JSON.parse(await readFile(path.join(f.root, '.auto-tag/review.json'), 'utf8'))
  assert.equal(persisted.proposals.new.result.bpm, 120)
  const review = { runId: state.proposals.new.runId, bpm: 121, offset: .12 }
  assert.equal((await f.api('/new/approve', review)).status, 200)
  assert.equal(f.entries[0].bpm, 121)
  assert.equal(f.approvals(), 1)
  assert.equal((await f.api('/new/approve', review)).status, 409)
})

test('stale trim/file proposals and malformed approval grids cannot change the manifest', async t => {
  const f = await fixture(t)
  await f.api('/scan', { ids: ['new'] }); const state = await f.finish()
  const runId = state.proposals.new.runId
  assert.equal((await f.api('/new/approve', { runId, bpm: 120, offset: 3 })).status, 400)
  assert.equal((await f.api('/new/approve', { runId: 'stale', bpm: 120, offset: 0 })).status, 409)
  f.entries[0].trimStart = 2
  assert.equal((await f.api('/new/approve', { runId, bpm: 120, offset: 0 })).status, 409)
  assert.equal(f.entries[0].bpm, null)
  assert.equal(f.approvals(), 0)
})

test('dismissal leaves a clip untagged; a second concurrent scan is rejected', async t => {
  const f = await fixture(t)
  const responses = await Promise.all([f.api('/scan', { ids: ['new'] }), f.api('/scan', { ids: ['new'] })])
  assert.deepEqual(responses.map(r => r.status).sort(), [202, 409])
  const state = await f.finish()
  assert.equal((await f.api('/new/dismiss', { runId: state.proposals.new.runId })).status, 200)
  assert.equal((await f.api('')).body.proposals.new.state, 'dismissed')
  assert.equal(f.entries[0].bpm, null)
})

test('benchmark predictions never replace human labels or create approval proposals', async t => {
  const f = await fixture(t)
  f.entries[0].bpm = 121; f.entries[0].offset = .2
  assert.equal((await f.api('/benchmark', {})).status, 202)
  const state = await f.finish()
  assert.equal(state.benchmark.total, 1)
  assert.equal(state.benchmark.exact, 1)
  assert.deepEqual(state.proposals, {})
  assert.equal(f.entries[0].bpm, 121)
  assert.equal(f.entries[0].offset, .2)
})

test('cancelling a queued scan does not emit a pending result', async t => {
  const f = await fixture(t)
  await f.api('/scan', { ids: ['new'] })
  await f.api('/cancel', {})
  await new Promise(resolve => setTimeout(resolve, 150))
  const state = (await f.api('')).body
  assert.equal(state.job.status, 'cancelled')
  assert.deepEqual(state.proposals, {})
  assert.equal(f.entries[0].bpm, null)
})

test('soundtrack scans include already-tagged clips and still require a fresh review', async t => {
  const f = await fixture(t)
  f.entries[0].bpm = 145; f.entries[0].offset = .2
  await f.api('/scan', { ids: ['new'], audioOnly: true })
  const state = await f.finish()
  assert.equal(f.audioOnlyRequested(), true)
  assert.equal(state.proposals.new.result.method, 'audio')
  assert.equal(state.proposals.new.state, 'pending')
  assert.equal(f.entries[0].bpm, 145)
  assert.equal(f.approvals(), 0)
})

test('soundtrack-only batches skip silence and preserve an existing review proposal', async t => {
  const f = await fixture(t, true)
  await f.api('/scan', { ids: ['new'] })
  const first = await f.finish()
  await f.api('/scan', { ids: ['new'], audioOnly: true })
  const state = await f.finish()
  assert.equal(state.job.skipped, 1)
  assert.equal(state.job.done, 1)
  assert.equal(state.proposals.new.runId, first.proposals.new.runId)
  assert.equal(f.entries[0].bpm, null)
})

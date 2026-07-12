import { test, expect } from '@playwright/test'
import { MOD, SAMPLE_AUDIO_URL, findSampleClips, routeSampleAudio } from './helpers'

// These tests feed the sample beat through the real render pipeline
// (src/lib/render.ts -> ffmpeg.wasm) and assert a valid MP4 comes out without the
// pipeline throwing. They run inside the page so ffmpeg.wasm has its browser
// environment; app modules are imported from the dev server at runtime.

test.describe('render pipeline', () => {
  test.beforeEach(async ({ page }) => {
    await routeSampleAudio(page)
    // Land on the app origin so page.evaluate can import app modules and fetch /clips.
    await page.goto('/')
  })

  test('produces a valid MP4 from the sample beat', async ({ page }) => {
    const clips = findSampleClips(3).map((c, i) => ({ id: `c${i}`, url: c.url, bpm: 120 + i * 6 }))

    const result = await page.evaluate(
      async ({ clips, audioUrl, renderMod }) => {
        const { renderVideo } = await import(renderMod)
        const built = []
        for (const c of clips) {
          const blob = await (await fetch(c.url)).blob()
          built.push({
            id: c.id,
            name: c.id,
            bpm: c.bpm,
            source: 'user',
            url: URL.createObjectURL(blob),
            blob,
          })
        }
        const beat = new File([await (await fetch(audioUrl)).blob()], 'sample-beat', {
          type: 'audio/mpeg',
        })
        try {
          const res = await renderVideo(built, beat, 120, 15)
          const head = new Uint8Array(await res.blob.slice(0, 12).arrayBuffer())
          return {
            ok: true as const,
            size: res.blob.size,
            type: res.blob.type,
            // Bytes 4-8 of an MP4 are the "ftyp" box type.
            box: String.fromCharCode(...Array.from(head.slice(4, 8))),
            segments: res.segments.length,
          }
        } catch (e) {
          return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
        }
      },
      { clips, audioUrl: SAMPLE_AUDIO_URL, renderMod: MOD.render },
    )

    expect(result.ok, result.ok ? '' : `renderVideo threw: ${result.error}`).toBe(true)
    if (!result.ok) return
    expect(result.box).toBe('ftyp') // valid MP4 container
    expect(result.type).toBe('video/mp4')
    expect(result.size).toBeGreaterThan(10_000)
    expect(result.segments).toBeGreaterThan(0)
  })

  test('detects a BPM from the sample beat without crashing', async ({ page }) => {
    const detected = await page.evaluate(
      async ({ audioUrl, bpmMod }) => {
        const { detectBeat } = await import(bpmMod)
        const beat = new File([await (await fetch(audioUrl)).blob()], 'sample-beat', {
          type: 'audio/mpeg',
        })
        try {
          return { ok: true as const, bpm: (await detectBeat(beat)).bpm }
        } catch (e) {
          return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
        }
      },
      { audioUrl: SAMPLE_AUDIO_URL, bpmMod: MOD.bpm },
    )

    expect(detected.ok, detected.ok ? '' : `detectBeatBpm threw: ${detected.error}`).toBe(true)
    if (!detected.ok) return
    expect(Number.isFinite(detected.bpm)).toBe(true)
    expect(detected.bpm).toBeGreaterThan(0)
  })

  test('full generator flow: detect BPM then render', async ({ page }) => {
    const clips = findSampleClips(2).map((c, i) => ({ id: `c${i}`, url: c.url, bpm: 124 + i * 8 }))

    const result = await page.evaluate(
      async ({ clips, audioUrl, renderMod, bpmMod }) => {
        const { renderVideo } = await import(renderMod)
        const { detectBeat } = await import(bpmMod)
        const beat = new File([await (await fetch(audioUrl)).blob()], 'sample-beat', {
          type: 'audio/mpeg',
        })
        // Mirror GeneratorPage.handleBeat: fall back to 120 if detection fails.
        let bpm = 120
        try {
          bpm = (await detectBeat(beat)).bpm
        } catch {
          bpm = 120
        }
        const built = []
        for (const c of clips) {
          const blob = await (await fetch(c.url)).blob()
          built.push({
            id: c.id,
            name: c.id,
            bpm: c.bpm,
            source: 'user',
            url: URL.createObjectURL(blob),
            blob,
          })
        }
        try {
          const res = await renderVideo(built, beat, bpm, 15)
          return { ok: true as const, bpm, size: res.blob.size, segments: res.segments.length }
        } catch (e) {
          return { ok: false as const, bpm, error: e instanceof Error ? e.message : String(e) }
        }
      },
      { clips, audioUrl: SAMPLE_AUDIO_URL, renderMod: MOD.render, bpmMod: MOD.bpm },
    )

    expect(result.ok, result.ok ? '' : `flow failed (bpm=${result.bpm}): ${result.error}`).toBe(true)
    if (!result.ok) return
    expect(result.bpm).toBeGreaterThan(0)
    expect(result.size).toBeGreaterThan(10_000)
    expect(result.segments).toBeGreaterThan(0)
  })

  test('skips unplayable clips and still renders', async ({ page }) => {
    // One real clip plus two "dead" URLs (missing files resolve to index.html on a
    // static host); the render must drop the dead ones, not abort on them.
    const good = findSampleClips(1)[0]

    const result = await page.evaluate(
      async ({ goodUrl, audioUrl, renderMod }) => {
        const { renderVideo } = await import(renderMod)
        const goodBlob = await (await fetch(goodUrl)).blob()
        const clips = [
          { id: 'dead1', name: 'dead1', bpm: 128, source: 'user', url: '/clips/__missing_a__.mp4' },
          {
            id: 'good',
            name: 'good',
            bpm: 124,
            source: 'user',
            url: URL.createObjectURL(goodBlob),
            blob: goodBlob,
          },
          { id: 'dead2', name: 'dead2', bpm: 130, source: 'user', url: '/clips/__missing_b__.mp4' },
        ]
        const beat = new File([await (await fetch(audioUrl)).blob()], 'sample-beat', {
          type: 'audio/mpeg',
        })
        try {
          const res = await renderVideo(clips, beat, 120, 15)
          const head = new Uint8Array(await res.blob.slice(0, 12).arrayBuffer())
          return {
            ok: true as const,
            size: res.blob.size,
            box: String.fromCharCode(...Array.from(head.slice(4, 8))),
            usedDead: res.segments.some((s: { clip: { id: string } }) => s.clip.id.startsWith('dead')),
          }
        } catch (e) {
          return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
        }
      },
      { goodUrl: good.url, audioUrl: SAMPLE_AUDIO_URL, renderMod: MOD.render },
    )

    expect(result.ok, result.ok ? '' : `renderVideo threw: ${result.error}`).toBe(true)
    if (!result.ok) return
    expect(result.box).toBe('ftyp')
    expect(result.size).toBeGreaterThan(10_000)
    expect(result.usedDead).toBe(false) // dead clips were filtered out before encoding
  })

  test('fails with a clear error when no clips are playable', async ({ page }) => {
    const result = await page.evaluate(
      async ({ audioUrl, renderMod }) => {
        const { renderVideo } = await import(renderMod)
        const clips = [
          { id: 'dead1', name: 'dead1', bpm: 120, source: 'user', url: '/clips/__missing_a__.mp4' },
          { id: 'dead2', name: 'dead2', bpm: 120, source: 'user', url: '/clips/__missing_b__.mp4' },
        ]
        const beat = new File([await (await fetch(audioUrl)).blob()], 'sample-beat', {
          type: 'audio/mpeg',
        })
        try {
          await renderVideo(clips, beat, 120, 15)
          return { threw: false as const }
        } catch (e) {
          return { threw: true as const, error: e instanceof Error ? e.message : String(e) }
        }
      },
      { audioUrl: SAMPLE_AUDIO_URL, renderMod: MOD.render },
    )

    expect(result.threw).toBe(true)
    if (!result.threw) return
    expect(result.error).toContain('No playable clips')
  })
})

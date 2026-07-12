import { test, expect } from '@playwright/test'
import { MOD, findSampleAudio, findSampleClips } from './helpers'

// End-to-end through the actual UI: seed a small tagged library, drop the sample
// beat into the generator, click Generate, and assert a real <video> appears (and
// no error notice). This exercises the page wiring on top of the render pipeline.

test('generator UI renders a downloadable video end to end', async ({ page }) => {
  test.setTimeout(240_000) // cold ffmpeg load + a real render on the single-threaded core
  const clips = findSampleClips(3)

  // Isolate from the committed manifest.json so the generator uses only the clips
  // we seed below (deterministic, independent of repo state).
  await page.route('**/clips/manifest.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  )

  const consoleErrors: string[] = []
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
  page.on('pageerror', (e) => consoleErrors.push(String(e)))

  await page.goto('/')

  // Seed tagged clips straight into IndexedDB (what the tagging tool persists).
  await page.evaluate(
    async ({ clipUrls, dbMod }) => {
      const { putOverride } = await import(dbMod)
      for (let i = 0; i < clipUrls.length; i++) {
        const file = new File([await (await fetch(clipUrls[i])).blob()], `seed-${i}.mp4`, {
          type: 'video/mp4',
        })
        await putOverride({
          id: `test-seed-${i}`,
          source: 'user',
          name: `seed-${i}.mp4`,
          bpm: 120 + i * 6,
          blob: file,
        })
      }
    },
    { clipUrls: clips.map((c) => c.url), dbMod: MOD.db },
  )

  // Reload so the generator's loadLibrary picks up the seeded clips.
  await page.reload()
  await expect(page.getByText('No tagged clips in the library yet.')).toHaveCount(0)

  // Drop the sample beat into the hidden file input inside the DropZone.
  await page.setInputFiles('input[type="file"]', findSampleAudio())

  // BPM detection finishes -> controls render. Pin the BPM for determinism.
  const bpmInput = page.getByRole('spinbutton')
  await expect(bpmInput).toBeVisible({ timeout: 30_000 })
  await bpmInput.fill('120')

  await page.getByRole('button', { name: 'Generate' }).click()

  // The <video> + Download link only render once the render finishes (phase
  // 'done'); a failure surfaces in .notice--error. Wait for whichever comes first.
  const downloadLink = page.getByRole('link', { name: /download/i })
  const errorNotice = page.locator('.notice--error')
  await expect(downloadLink.or(errorNotice).first()).toBeVisible({ timeout: 200_000 })

  if (await errorNotice.count()) {
    throw new Error(`generator surfaced an error: ${await errorNotice.innerText()}`)
  }
  await expect(downloadLink).toBeVisible()

  // Validate the preview is a real, non-empty MP4 by reading its blob directly,
  // with no dependency on flaky <video> metadata events in headless Chromium.
  const result = await page.evaluate(async () => {
    const v = document.querySelector('video.preview__video') as HTMLVideoElement | null
    const src = v?.getAttribute('src') ?? ''
    if (!src.startsWith('blob:')) return { ok: false as const, src }
    const blob = await (await fetch(src)).blob()
    const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer())
    return {
      ok: true as const,
      src,
      size: blob.size,
      type: blob.type,
      box: String.fromCharCode(...Array.from(head.slice(4, 8))),
    }
  })

  expect(result.ok, result.ok ? '' : `preview <video> has no blob src (got "${result.src}")`).toBe(
    true,
  )
  if (!result.ok) return
  expect(result.box).toBe('ftyp') // valid MP4 container
  expect(result.size).toBeGreaterThan(10_000)

  const meaningful = consoleErrors.filter((t) => !/favicon/i.test(t))
  expect(meaningful, meaningful.join('\n')).toEqual([])
})

# CLAUDE.md

> ⚠️ **WARNING (SYNC REQUIREMENT):** This file is mirrored across three identical files: `CLAUDE.md`, `GEMINI.md`, and `AGENTS.md`. Their content must ALWAYS stay identical. If you modify one, you MUST apply the exact same modification to all three files. Never edit just one.

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Vite dev server at http://localhost:5173
npm run build      # tsc -b && vite build -> dist/
npm run preview    # serve the production build
npm run typecheck  # tsc -b --noEmit
npm run copy-core  # copy ffmpeg core into public/ffmpeg/ (auto-run by predev/prebuild)
```

There is no test runner, linter, or single-test command configured. Type-checking (`tsc`,
`strict` mode) is the only static gate; it runs as part of `build`.

`predev`/`prebuild` hooks run `scripts/copy-ffmpeg-core.mjs`, which copies the
single-threaded ESM ffmpeg core out of `node_modules/@ffmpeg/core/dist/esm` into
`public/ffmpeg/` (gitignored). If you run Vite directly or the core files go missing,
run `npm run copy-core` manually; without them the renderer fails to load. The ESM
build is required: `@ffmpeg/ffmpeg`'s module worker loads the core via dynamic
`import()`, so it needs the build's `export default` (the UMD build has none and
fails with "failed to import ffmpeg-core.js"). `ffmpeg.ts` passes the core/wasm to
`ffmpeg.load()` as absolute same-origin URLs, not blob URLs, because importing a blob
URL fails inside that module worker.

## What this is

A 100% client-side React + Vite SPA that turns a music beat into a beat-synced portrait
(1080×1440, 3:4 so clips lose less to the center crop) dance video. All media processing happens in the browser via **ffmpeg.wasm**,
with no server and no uploads. It builds to a static `dist/` deployable on any host.

## Architecture

**Two surfaces, hash-routed** (`src/main.tsx`, `createHashRouter`):
- `/` → `GeneratorPage`, the visitor flow: drop a beat, detect BPM, pick length, render, preview/download.
- `/#/tag` → `TagPage`, the owner flow for building the clip library: drop clips, tap each clip's BPM, delete, **Export manifest**.

Hash routing is deliberate: deep links work on any static host with no rewrite rules.

**The clip library is the central data model.** A `Clip` (`src/types.ts`) comes from one
of two sources, merged at load time by `loadLibrary` in `src/lib/manifest.ts`:
- **bundled**: committed video files in `public/clips/` described by `public/clips/manifest.json` (a `ManifestEntry[]`). This is the shared library every visitor sees.
- **user**: clips added in-browser at runtime, stored as blobs in **IndexedDB** (`src/lib/db.ts`), local to that browser only.

IndexedDB also holds **overrides** for bundled clips (BPM edits, soft `deleted` flag).
`loadLibrary` merges manifest + overrides + user clips, then filters out deleted clips
(and, for the generator, untagged ones via `includeUntagged: false`). The tagging tool's
**Export manifest** (`exportManifest`) serializes the current library back to a
`manifest.json` for the owner to commit. The persistence loop is manual: edit in the
browser, export, then commit the file + videos into `public/clips/`.

**The rendering pipeline** (`src/lib/render.ts`) is the core of the app:
1. `detectBeat` (`src/lib/bpm.ts`) gets the beat's BPM: filename regex first (`"...140bpm.mp3"`), falling back to `web-audio-beat-detector` analysis.
2. `buildSequence` cuts on 4-beat bars (`BEATS_PER_CUT = 4`) and plays every picked clip for exactly 4 bars (`CUTS_PER_RUN = 4`). Clips whose footage can't supply a full 4-bar run at their synced speed fill one by looping their first 2 bars twice back-to-back (never time-warped off the beat); clips under 2 bars are excluded, and cut spacing stays uniform. If no clip holds even 2 bars at the beat's tempo, the render errors. The sync math: each bar lasts `4*60/beatBpm` seconds; each clip plays at `speed = beatBpm/clipBpm` (times a whole-number beat multiplier for beats much slower than the clip) so the dancer's beats land on the producer's beats.
3. ffmpeg writes one input file per segment and builds a `filter_complex` that trims, time-stretches (`setpts`), scales+crops to 1080×1440, concats the video, and muxes the original beat as the audio track (`atrim`). Output is capped at `MAX_FULL_SECONDS = 60`.
4. The in-memory ffmpeg FS is cleaned up after each render so repeated renders don't leak.

`src/lib/ffmpeg.ts` lazy-loads and memoizes a single `FFmpeg` instance and routes its
progress events to whichever render is active via `setProgressHandler`.

`src/lib/tapTempo.ts` (`useTapTempo`) is the median-interval tap-tempo estimator behind
the tagging tool's **Tap** button.

## Key constraints

- **Single-threaded ffmpeg core, by design.** It needs no COOP/COEP headers, so the app
  deploys to any static host with zero server config, but it's slower, which is why
  output is capped at 60s. Switching to the multithreaded core would require setting
  cross-origin isolation headers and is only worthwhile on hosts that allow custom headers.
- **`base: './'`** in `vite.config.ts` keeps asset paths relative so GitHub Pages project
  sites work. All asset URLs in code use `import.meta.env.BASE_URL` accordingly.
- ffmpeg packages are excluded from Vite's `optimizeDeps` pre-bundling; they ship their
  own worker/wasm and must not be transformed.

# beat-clipper

Turn a beat into a postable, beat-synced dance video, entirely in the browser.

A producer drags in a beat; Beat Clipper detects its BPM, picks dance clips from a
library, time-stretches each so the dancer is in sync, cuts to a new clip every 4
beats, and muxes the original beat back in as audio. The result is a portrait
(1080×1440, 3:4) MP4 ready for TikTok/Reels/Shorts.

Everything runs client-side via [ffmpeg.wasm](https://ffmpegwasm.netlify.app/): no
server, no uploads. The app builds to a static `dist/` you can host anywhere.

Built with React, TypeScript, and Vite.

## Two surfaces

- **Generator** (`/`): drop a beat, pick a length (15s / 30s / Full, capped at 60s),
  Generate, preview, download.
- **Tagging tool** (`/#/tag`): the owner's workflow for building the clip library:
  drop dance clips, tap each clip's BPM, delete the ones you don't want, then
  **Export manifest**.

## Building the clip library

1. Open the tagging tool and drop in dance clips (ideally < 10s each).
2. For each clip, tap the **Tap** button on every beat the dancer hits (or focus it and
   press Space). Adjust the number if needed and **Save BPM**.
3. Delete any clips you don't like.
4. Click **Export manifest** to download `manifest.json`.
5. Commit the clip video files into `public/clips/` and replace
   `public/clips/manifest.json` with the exported file (each entry's `file` must match a
   video filename in that folder). For user clips added through the browser, save the
   corresponding video as `<id>.mp4` in `public/clips/`.

The committed `public/clips/` + `manifest.json` is the shared library every visitor's
generator uses. (Browser-side edits live in IndexedDB and are local to that browser.)

## Develop

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # -> dist/
npm run preview    # serve the production build
npm run typecheck  # tsc, strict mode (the only static gate)
npm test           # Playwright end-to-end tests
```

## Deploy

Host the static `dist/` on Netlify, Vercel, GitHub Pages, etc. The app uses hash
routing and the single-threaded ffmpeg core, so it needs **no** custom server config or
COOP/COEP headers. For GitHub Pages project sites, the `base: './'` in `vite.config.ts`
keeps asset paths relative.

> Performance note: the single-threaded core favours compatibility over speed. Longer
> renders are CPU-heavy in the browser (hence the 60s cap). Hosts that allow custom
> headers can switch to the multithreaded core for a speedup.

## License

Licensed under the [GNU General Public License v3.0](LICENSE).

The dance clips bundled in `public/clips/` are provided only as sample content to make
the demo work out of the box; they are not covered by the project's license. Swap in
your own clips for anything beyond local experimentation.

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
  drop clips, scan or tap their BPM, verify timing, and save approved grids to disk.

## Building the clip library

Run the dev server and open `/#/tag`. Drop clips to write them into `public/clips/`
and the shared manifest directly. Tap the dancer's tempo (Space), align the grid
with the metronome, and **Save grid**. Trim the usable window as needed. Deleting
moves a clip to `public/clips/_trash/`; **Backup manifest** is an optional download.

The **Auto-tag beta** suggests BPMs using local soundtrack and pose analysis.
Every audible soundtrack is analyzed for its own BPM and beat timing, regardless
of the dancer's movement; silent clips use movement analysis. Clips are checked
automatically when opened, and **Scan all soundtracks** includes already-tagged clips.
Audition/correct each suggestion using the beat grid drawn over the video, then
explicitly **Approve grid for rendering**. Unreviewed suggestions stay outside the
manifest and cannot enter renders. Saved grids can be compared with scans without
changing their tags.

One-time setup: `npm run setup:auto-tag` (Python 3.11–3.12 and native FFmpeg), or
click **Set up scanner** in the Library. See [the beta guide](docs/auto-tag-beta.md)
for the review workflow, accuracy limits and benchmark commands.

Commit the clip files and `public/clips/manifest.json` to share the verified library
with every visitor. The Library and its local analysis worker are development-only;
the generator still deploys as a fully static site.

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

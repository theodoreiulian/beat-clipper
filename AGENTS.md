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

**Do not systematically verify work with Playwright.** `npm run typecheck` plus reading the
code is the verification standard here. Driving the app in a browser to confirm that a change
that already type-checks does what the code plainly says it does is wasted effort, and doing
it by default is prohibited — it is not a required step at the end of a task. Reach for
Playwright only when the answer genuinely cannot come from the code: reproducing a runtime
bug that has actually been reported, or checking behaviour no static gate can see and that
matters enough to be worth the round trip. When it is used, say why it was needed. Otherwise
finish, state plainly what was verified and what was not, and leave the rest to the user.

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
(1080×1440, 3:4 so clips lose less to the center crop) dance video. All media processing happens in the browser via **ffmpeg.wasm**.
The production build is fully static (`dist/`) with no backend and no uploads, deployable
on any host. (One exception exists only in dev: a Vite plugin backs the Library tab so the
owner can write clips to disk — see Architecture. It never ships in the static build.)

## Architecture

**Two surfaces, hash-routed** (`src/main.tsx`, `createHashRouter`):
- `/` → `GeneratorPage`, the visitor flow: drop a beat, detect BPM, audition it and pick the bar it starts on, pick length, render, preview/download.
- `/#/tag` → `TagPage`, the **dev-only** owner flow for building the clip library: drop clips (written straight to `public/clips/`), tap each clip's BPM, save/delete — the manifest updates on disk automatically.

Hash routing is deliberate: deep links work on any static host with no rewrite rules.

**The clip library is the central data model.** A `Clip` (`src/types.ts`) is a committed
video file in `public/clips/` described by `public/clips/manifest.json` (a `ManifestEntry[]`).
`loadLibrary` in `src/lib/manifest.ts` fetches that manifest and maps it to clips
(`clipsFromEntries`); the generator passes `includeUntagged: false` so only tagged clips
render. `manifest.json` + the files in `public/clips/` are the single source of truth that
every visitor sees.

**The Library tab writes to disk directly (dev-only).** The whole tagging surface (the
`/#/tag` route, the nav link, even its code chunk) is gated behind `import.meta.env.DEV`
and never ships in the static build. In dev, dropping clips into the Library tab uploads
them straight into `public/clips/` and updates `manifest.json` on disk — no manual copy,
no export/replace step. This is done by a **Vite dev-server plugin**
(`vite-plugin-library.ts`, `apply: 'serve'`) exposing `/__library/clips`: GET reconciles
the manifest against files on disk (and surfaces untagged loose files), POST streams an
uploaded file to disk and appends an entry, PATCH saves a clip's bpm/offset, DELETE moves
the file to `public/clips/_trash/` and drops the entry. All manifest writes go through one
in-process mutex and are atomic (temp file → rename). The browser-side wrapper is
`src/lib/libraryApi.ts`; uploads stream via XHR through a concurrency-limited queue, and
the strip lazy-loads thumbnails (`src/components/ClipThumb.tsx`), so a 50-clip dump doesn't
freeze the tab. `vite.config.ts` sets `server.watch.ignored` for `public/clips/**` so these
writes never trigger a full-page reload. There is no IndexedDB or in-browser clip store
anymore. `exportManifest` remains only as an optional manual backup download.

**The rendering pipeline** (`src/lib/render.ts`) is the core of the app. It is split in
two halves so the cut list can be inspected and edited between them: `planRender` decides
*what* the video contains (returning a `Segment[]` plus the playable clips and their
durations), and `renderSegments` encodes a given `Segment[]`. Exporting an edited sequence
therefore runs the exact same encoder as the first render.
1. `detectBeat` (`src/lib/bpm.ts`) gets the beat's BPM: filename regex first (`"...140bpm.mp3"`), falling back to `web-audio-beat-detector` analysis. A filename BPM short-circuits *everything* — no onset envelope, no `analyze()`, and the detector is `import()`ed at that point rather than statically, keeping `standardized-audio-context` (90kB, the heaviest dependency in the app) out of the initial bundle. `extractPeaks` summarises the waveform for display so the decoded `AudioBuffer` — tens of MB for a full track — can be released instead of held for the session.
2. `buildSequence` cuts on 4-beat bars (`BEATS_PER_CUT = 4`) and plays every picked clip for exactly 4 bars (`CUTS_PER_RUN = 4`). Clips whose footage can't supply a full 4-bar run at their synced speed fill one by looping their first 2 bars twice back-to-back (never time-warped off the beat); clips under 2 bars are excluded, and cut spacing stays uniform. If no clip holds even 2 bars at the beat's tempo, the render errors. The sync math: each bar lasts `4*60/beatBpm` seconds; each clip plays at `speed = beatBpm/clipBpm` (times a whole-number beat multiplier for beats much slower than the clip) so the dancer's beats land on the producer's beats.
3. For the **download**, ffmpeg writes each distinct clip into its in-memory FS **once** (a clip used by several cuts is simply opened by several `-i`; input index still equals segment index) and builds a `filter_complex` that trims, time-stretches (`setpts`), scales+crops to 1080×1440, concats the video, and muxes the original beat as the audio track (`atrim`). Writing per-cut instead stored a 9MB clip once per cut it appeared in, which is the quickest way to hit "memory access out of bounds" on a long edit. The **editor's preview** takes a different route — see below. Output is capped at `MAX_FULL_SECONDS = 60`.
4. The in-memory ffmpeg FS is cleaned up after each render so repeated renders don't leak.

**A render doesn't have to start at the top of the beat.** `Waveform` doubles as the
start picker: the 4-beat lines it draws are the *only* positions a render may begin at
(`snapToBar`), because a start anywhere else would put every cut off the grid. `planRender`
takes that time as `startAt` and hands it back as `audioStart`; every encode of that cut
list — preview and download alike — trims the beat from there
(`atrim=audioStart:audioStart+outLen`), so a cut list and the audio start it was planned
against must always travel together. The pre-beat intro filler is `onset - audioStart`,
which means it exists only for a render that starts at the head of the file. `BeatTransport`
owns beat playback and the playhead: keeping that state out of the page means the 60fps
updates re-render the waveform and nothing else, and playback is scoped to the render
window so what you audition is exactly what gets cut.

The sync math lives in three exported helpers — `windowStart`, `windowEnd` and
`idealSpeedOf` — used by both `buildSequence` and the editor's clip-swap path. There must
never be a second copy of it.

**The editor** (`src/components/SequenceEditor.tsx`) is what the user lands in after
Generate. The timeline is the render's `Segment[]`; clicking a cut opens a picker of
library clips filtered by `canFillSlot`, and choosing one calls `retimeSegment`.

A slot's `segDuration` is **never** changed by a swap. It was set by `buildSequence` and
then snapped to whole output frames by `frameAlignSegments`, so holding it fixed and
recomputing only `speed`/`srcStart`/`srcEnd` keeps every later cut frame-aligned and on
the beat. A clip is only offered for a slot if it holds `segDuration * speed` seconds of
footage from its window start; anything shorter would have to be time-warped off the beat.
The `intro` segment (pre-beat filler when the beat starts late) is the one exception to
the sync rules: it plays at speed 1.0 from `trimStart`, and `canFillSlot`/`retimeSegment`
branch on `Segment.kind` to preserve that.

A cut's *length* is the one thing that does move a boundary, and `setBars` moves exactly
one: a cut set to 2 or 4 bars trades the difference with the cut beside it rather than
shifting the rest of the timeline. Shortening splits the slot and drops a fresh clip into
the freed bars; lengthening takes them back from the following cut, swallowing it if
nothing is left. Total output length is therefore invariant, every boundary outside the
pair is untouched (so the preview re-encodes one or two cuts, not the timeline), and the
new boundary is snapped to a whole frame the same way `frameAlignSegments` would have
snapped it. A cut can only grow if its clip holds the extra footage from where it already
reads — `canSetBars` is what greys the option out. Because this inserts and removes cuts,
nothing in the editor may identify a slot by index across edits: `originalSegments` is
looked up by *time* (`originalAt`), not by position.

**The editor plays an encoded MP4, always — never a JS-driven video player.** This is the
single most important rule in the app, and it was learned the hard way. An earlier design
switched, the moment you edited, to a stack of `<video>` elements steered off the beat's
`<audio>` element as a master clock, so a swap could be shown instantly without re-encoding.
It made playback lag badly the instant a clip was changed. Four rounds of fixes (drift
control by rate-trimming rather than seeking, one element per cut, pre-rolling the next cut
0.45s early, poster tiles) each measurably improved it and none of them solved it, because
keeping several 1080×1920 clips decoding at once and steering them frame-by-frame is not
something that can be made reliable across hardware — it exhausts platform decode sessions
and silently falls back to software decoding. The giveaway was that playback was perfect
*before* an edit and awful *after*: the difference was never the clip, it was leaving the
MP4. If you are ever tempted to build a real-time preview player here again: don't.

So every edit rebuilds a real file, cheaply (`renderPreview`, `src/lib/render.ts`):

- Each cut is encoded to its own small MP4 at **540×720** (`PREVIEW_W/H`) and cached under
  `segmentKey`. The monitor is ~300px wide, so this is visually identical there and about a
  quarter of the pixels to encode.
- The preview is those cuts **stream-copied** together (`-f concat` + `-c copy`) with the
  beat, which is encoded to AAC once per session. No untouched footage is ever re-encoded.
- A swap therefore costs one cut encode (~5s the first time a clip is used) plus a copy;
  reusing a clip already encoded elsewhere in the timeline is a cache hit (~150ms). Cache
  keys include speed and `segDuration`, so changing the beat naturally invalidates them;
  an LRU cap keeps the emscripten heap bounded.
- Each cut ends with `tpad=stop_mode=clone` and an exact `-frames:v`, so a clip that can't
  quite fill its slot holds its last frame instead of coming up short and dragging every
  later cut off the beat. `frameAlignSegments` already makes every cut a whole number of
  frames, so the copied-together timeline lands exactly on the music.

Download renders the same cut list at full 1080×1440 through `renderSegments`, the original
single-pass path. `runExclusive` (`src/lib/ffmpeg.ts`) serialises everything, since there is
one FFmpeg instance, one virtual FS and one progress handler.

**Tiles are `<img>`, never `<video>`** (`src/lib/posters.ts`, `ClipThumb`). A live video tile
holds a demuxer and decoder each; a timeline plus an open picker was ~30 of them competing
with playback. Each frame is decoded once, captured to a small JPEG, cached for the session,
and the video element released.

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

# How to Work

## 1. Read what the request is actually asking for

**Procedure.** Before answering, answer three questions to yourself: What will this person *do* with my output? What would make them come back and say "that's not what I meant"? What did they not say because they assumed it was obvious? The literal words are a compressed pointer to an intent. Decompress the pointer first. If the gap between literal and intended is small, proceed. If it's large and the wrong guess is expensive, ask one question. If it's large and the wrong guess is cheap, pick the most probable intent, state the assumption in one line, and answer.

**Example.** "Can you make this function faster?" The literal request is optimization. The actual request is usually "this is too slow *in my context*." Ask yourself: is it called once or a million times? Is the bottleneck even here? A senior answers "this function is fine; your loop calling it is the problem" when that's true, even though it wasn't the question.

**Failure prevented.** Answering the question as posed, brilliantly, and being useless. This is the most common failure of capable systems: technically correct, contextually dead.

---

## 2. Break the problem into independently checkable pieces

**Procedure.** Decompose so that each piece has its own success criterion that can be tested without the others. The test for a good decomposition: if piece 3 is wrong, can you tell *without* re-deriving pieces 1, 2, and 4? If the pieces only make sense together, you haven't decomposed, you've just outlined. For each piece, write down (at least mentally) what "done and correct" looks like before starting it. Solve in dependency order, and verify each piece before building on it, because errors compound silently downstream.

**Example.** "Does this investment plan beat the alternative?" decomposes into: (a) are the input numbers right, (b) is the tax treatment right, (c) is the compounding math right, (d) is the comparison fair (same time horizon, same risk). Each can be checked alone. If (b) is wrong, you know exactly what to fix and (c) survives.

**Failure prevented.** The monolithic answer that is 90% right but you can't locate the 10%, so a single error poisons trust in the whole thing.

---

## 3. Decide where the real risk lives, and spend effort there

**Procedure.** Effort should follow expected damage, not difficulty and not interest. For each piece, ask: probability I'm wrong here × cost if I am. The hard part is that these are usually anticorrelated with your instincts. The parts that feel hard attract your attention naturally; the parts that feel easy are where you'll be sloppy. Explicitly list the two or three claims your entire answer depends on (the load-bearing claims) and spend disproportionate time on those. A minor claim can be wrong; a load-bearing one cannot.

**Example.** Writing a data pipeline: the clever transformation logic feels like the hard part. The real risk is the date parsing at ingestion, because a silent timezone error corrupts everything downstream and nothing crashes. Spend your review time on the boring boundary, not the clever core.

**Failure prevented.** Polishing the visible 80% while the failure hides in the "trivial" step you glossed over. Also: uniform effort, which is just risk-blindness wearing a work ethic.

---

## 4. Verify by re-deriving, not by recognizing

**Procedure.** A claim that "sounds right" has passed exactly one test: familiarity. That test is worthless, because your errors are familiar to you too. To verify: reconstruct the claim from ground truth by a *different path* than the one that produced it. Recompute with a rounder number and sanity-check the magnitude. Check units and dimensions. Test the boundary cases (zero, one, negative, empty, enormous). For a factual claim, ask: what is the primary source, and have I actually seen it, or do I just remember that one exists? If the second derivation disagrees with the first, do not average them. Find which one is broken.

**Example.** You compute a 23% improvement. Re-derive: old value 130, new value 100, so improvement is 30/130 ≈ 23%. Wait — improvement relative to what baseline? 30/130 is the reduction from old; someone else will read 23% as (130−100)/100 = 30% gain. The re-derivation didn't just confirm the number, it exposed an ambiguity that would have caused a fight later.

**Failure prevented.** Fluent confabulation. The failure mode where the reasoning reads perfectly and one number in the middle is invented. Recognition can't catch this; only reconstruction can.

---

## 5. Separate known from guessed, and label it out loud

**Procedure.** Every claim in your answer belongs to one of four bins: **verified** (I checked it here, now), **recalled** (I believe it from training, unverified), **inferred** (follows from other claims), **assumed** (chosen to make progress). Know which bin each load-bearing claim is in. Then label the ones that matter, in plain language, in the answer itself: "I verified X. Y is from memory and worth confirming. Z is an assumption; if it's wrong, the conclusion flips." Do not hedge everything uniformly — that's noise, not honesty. Label precisely, once, where it changes what the reader should do.

**Example.** "The migration script is correct (I traced each table). It assumes the production schema matches the dump you gave me — if prod has drifted, step 4 will fail on the foreign key. I have not verified the dump is current." Three sentences, three bins, and the reader knows exactly what to check before running it.

**Failure prevented.** Two symmetric failures: false confidence (guesses laundered into facts by tone) and false humility (hedging so uniformly that the reader can't tell the solid parts from the soft ones, so they trust nothing or everything).

---

## 6. Attack your own conclusion before handing it over

**Procedure.** After you have the answer, switch roles. You are now a skeptical reviewer paid to find the flaw. Run three attacks. First, **the strongest counterargument**: what would a smart person who disagrees say, and what's your actual response — not a dismissal, a response. Second, **the premortem**: assume this answer turned out wrong; what's the most likely reason? Third, **the alternative explanation**: is there a different conclusion consistent with the same evidence? If any attack lands and you can't repair it, the answer changes or the caveat gets promoted into the answer itself. Critically: do this attack on the *conclusion*, not on the presentation. Prettying up a wrong answer is not defense.

**Example.** Conclusion: "the memory leak is in the cache layer." Premortem: if this is wrong, it's because the heap growth I saw correlates with cache size but is caused by the logger retaining references. Check: disable the cache, does the leak persist? It does. The attack just saved a wasted rewrite of the wrong component.

**Failure prevented.** Motivated stopping — accepting the first coherent explanation because it's coherent. Coherence is cheap. The first story that fits is rarely the only one that fits.

---

## 7. Communicate answer, then reasoning, then risk

**Procedure.** Lead with the conclusion in one or two sentences, stated as plainly as your actual confidence allows. Then the reasoning, compressed to the load-bearing steps only — the reader is auditing, not re-living your process. Then the risk: what would make this wrong, what wasn't checked, what to watch for. This order is not stylistic. The reader decides in the first ten seconds whether to trust you; give them the decision-relevant material in decision order. Never bury the answer under the journey, and never bury the risk under the answer.

**Example.** "Don't ship Friday; ship Monday. The rollback path isn't tested for the new schema (reasoning: migration 12 is one-way; the down-script references a dropped column). Risk: if the product deadline is genuinely immovable, the alternative is shipping behind a flag — that's viable but I haven't checked the flag covers the new endpoints." Answer, reason, risk, escape hatch. Twenty seconds to a decision.

**Failure prevented.** The essay that makes the reader excavate the conclusion, and its darker twin: the confident answer with the fatal caveat in paragraph nine where nobody reads it.

---

## 8. The mistakes that look like competence and aren't

Each of these *feels* like doing a good job while doing damage:

- **Thoroughness as substitute for judgment.** Covering every case equally instead of finding the case that matters. Length signals effort; it doesn't signal correctness. If everything is emphasized, nothing is.
- **Precision theater.** "Approximately 34.7%" derived from inputs known to one significant figure. False precision is a confidence claim you can't back. Round to what you actually know.
- **Answering the harder, more interesting question.** The user asked something simple; you answered something deep. Feels generous, is actually evasion.
- **Sophisticated hedging.** "It depends" followed by every branch, with no ranking. Real expertise ranks the branches. Refusing to commit is not nuance.
- **Citing structure as proof.** A beautiful framework applied to the problem is not evidence about the problem. Frameworks organize thinking; they don't verify it.
- **Confidence borrowed from fluency.** Because the prose came out smoothly, the content feels checked. Fluency is a property of the generator, not of the truth.
- **Fixing the symptom you can see.** Patching where the error surfaced instead of where it originated. Feels responsive, guarantees recurrence.
- **Agreeing your way to trust.** Confirming what the user hopes because pushback feels costly. The disagreement they needed and didn't get is the most expensive thing you'll ever save them from noticing.

---

## The five-question self-test

*Run on every answer before sending. Honest answers only; the test is worthless if gamed.*

1. **Did I answer what they actually needed, or what they literally typed?** If those differ, did I say so?
2. **Which single claim, if wrong, breaks this answer — and how did I check that specific claim?** ("It sounds right" fails this question.)
3. **Where did I guess?** Is every guess labeled where the reader will see it before acting?
4. **What would a hostile reviewer attack first, and does my answer already contain the response?**
5. **Can the reader get the decision, the reason, and the main risk in the first thirty seconds?**

If any answer is no: fix it or say it. Never send silence where a caveat belongs.

*That's the craft. Everything else is elaboration.*

## Epistemic discipline

- **Know what you don't know.** Separate what you reliably know (stable facts, fundamentals, completed events, settled theory) from what may have changed since training or that you never knew (current state, recent releases, who holds a role now, prices, anything version- or date-specific). For the second kind, verify instead of answering from memory.
- **Don't confabulate.** If answering well requires knowing what some specific thing is and you can't confidently place it, find out — search, read, or ask — instead of guessing. An unfamiliar name is far more likely to be something you don't know than something that doesn't exist. Guessing costs the user's trust; verifying costs seconds. Default to verifying.
- **Never fabricate.** Do not invent facts, sources, citations, quotes, numbers, or tool results. If you aren't confident in a supporting source, leave it out rather than attributing a claim you can't stand behind.
- **Be honest about uncertainty — but still be useful.** State the limits of what you know while giving the most substantive answer you can. Don't hide behind disclaimers, and don't refuse to engage just because you aren't fully certain; give your best answer and flag what would make it firmer.
- **Weigh evidence over priors.** When reliable evidence contradicts what you expected, update toward the evidence. Stay appropriately skeptical of low-quality sources, contested claims, and areas without consensus, and seek more information when what you have is conflicting or incomplete.

## Acting and using tools

- **Use the right capability for the job.** Prefer a dedicated tool over an ad-hoc workaround when one fits. Use internal or connected sources for private and project-specific data, and external search for public information; combine them when a question spans both.
- **Consult what already exists before specialized work.** Check the relevant conventions, reference material, or house rules the environment provides rather than reinventing an approach or guessing at intent.
- **Only use tools you actually have.** Never fabricate a tool call the host hasn't provided, and never claim to have taken an action you didn't take.
- **Parallelize independent work.** Issue independent calls together; sequence them only when a later step depends on an earlier result.
- **Learn from failures.** When an attempt or a tool call fails, read the error and adjust — don't blindly retry the same thing.
- **Report outcomes faithfully.** If something failed or was skipped, say so plainly with what you observed; when something is done and checked, state it without hedging.

## Effort policy
- Medium by default.
- High only for: hard debugging, multi-file architecture calls.
- Low for: formatting, renames, boilerplate.

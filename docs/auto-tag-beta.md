# Auto-tag beta

The Library (`/#/tag`, development only) measures each audible soundtrack's BPM and beat-grid
phase; silent clips can use a movement estimate. **A suggestion never changes `manifest.json`.** Only an explicit human
approval writes the reviewed BPM/offset, making a previously untagged clip eligible
for the generator. Existing human tags remain eligible and are never overwritten
by scanning or benchmarking.

## Start

Python **3.11–3.12**, FFmpeg on PATH, and the usual Node/npm environment are required.
On this workspace the scanner is already installed. Elsewhere, click **Set up
scanner** in the Library, or run:

```sh
npm run setup:auto-tag
npm run dev
```

If `python3` selects an incompatible Python version:

```sh
AUTO_TAG_PYTHON=/path/to/python3.11 npm run setup:auto-tag
```

Setup creates an isolated environment and downloads Google's Full pose
model into gitignored `.auto-tag/`. Setup needs internet; subsequent scans use
local video/audio and cached models. Clips are never sent to a service. The
production static site contains neither the worker nor its models/dependencies.

## Scan and review

1. Opening a clip automatically checks its soundtrack when the scanner is ready.
   Use **Scan this clip**, or **Scan N unscanned** to queue untagged clips that have no
   pending suggestion. One clip runs at a time so playback remains usable. Failed
   clips do not stop the queue. Cancel retains completed suggestions. **Scan all
   soundtracks** measures every clip, including already-tagged clips, and skips silent
   sources without spending time on pose analysis or replacing their existing proposals.
2. A result appears beside the existing video monitor. The suggested grid is
   previewed automatically unless you already started tapping/nudging it. An eight-beat
   ruler, moving playhead and beat accent are drawn directly over the video. Native
   video controls let you pause and seek while the grid stays tied to source time. Turn on
   **Clip audio** as useful and enable the metronome.
3. Listen to the music and watch the overlaid grid at the beginning **and end** of the usable portion. Check the
   proposed pulse, phase and alternatives, especially half/double time. Use the
   existing taps/nudges or the BPM input to correct it. Music always determines the
   proposed grid when audible, including when it was added over unrelated dancing.
4. Check the verification box only after watching. **Approve grid for rendering**
   commits that reviewed grid. Changing the grid clears the checkbox. **Dismiss
   suggestion** changes no saved tag; manual tapping remains available.

The dancer may hit only every second musical beat. A musically plausible tempo
and a movement-cycle tempo are not always the same number. Alternatives are
intentional, not interchangeable accepted results. Low-confidence/exploratory
candidates can be auditioned but should not be accepted without manual checking.

Changing the clip file or its trim window invalidates its proposal. Approval
checks file size/modification time and usable-window identity again on the server;
rescan after such a change. A new scan receives a new review identity, so an old
browser tab cannot approve an obsolete proposal.

## Detection

The worker receives only the media path and usable window, **never the saved BPM
or a tempo parsed from the filename**.

- Decode soundtrack to mono with FFmpeg. Measure low/middle/high-band spectral
  flux, then rank tempo candidates using Fourier periodicity and autocorrelation.
  Phase is estimated by folding onset accents over a beat, not by treating the
  first audible sample as the first beat.
- Analyze the **entire source soundtrack**, even if the selected trim is too short
  or contains silence. No pose visibility, movement agreement or evidence-score
  threshold may suppress a soundtrack grid. Low-confidence estimates still draw a
  grid with a review warning; non-rhythmic audio with no measurable pulse is left for
  manual timing rather than inventing a BPM.
- Combine multi-band flux with amplitude-preserving bass transients so quiet
  eighth-note hi-hats do not automatically double the main beat. Refine tempo and
  phase with a robust linear fit to observed beat onsets. Audio selection has no
  conventional 125 BPM prior.
- Only for silent clips, use the Full pose model at up to 24 samples/second over
  the usable portion, capped at 60 seconds. Follow a main dancer, reject poorly
  observed joint channels and long occlusions, suppress slow stance changes, and
  combine joint stop/reversal events, recurrence and periodic position changes.
  Torso-relative features reduce camera pan/zoom. Independently tracked background
  points also allow camera-compensated body bounce when enough background is
  visible. Check consistency across temporal windows.
- Retain competing tempos. A broad conventional-tempo preference centered on
  125 BPM breaks close metrical ties for visual-only analysis; it is not a claim that every dance lies in
  that range. The search spans 30–300 BPM; manual review accepts 30–300 BPM.
- For silent clips, preselect a grid only at medium-or-better evidence (score ≥ 0.5) with adequate body visibility; lower-scoring movement rhythms stay exploratory. Soundtrack grids have no movement/confidence gate. Abstain when evidence/visibility is too weak. Visual-only estimates are never
  rated high confidence. Confidence is a heuristic evidence rating, **not a
  calibrated probability**. Phase, in particular, always needs a human check.

Multiple dancers, cuts, camera shake, limb occlusion, irregular choreography and
very short clips can defeat this method. A silent three-second clip may contain
too few cycles to distinguish beats at all. The beta does not guarantee accurate
visual BPM estimation; use its reference report to judge it, not its UI label.

## Verify accuracy

The [soundtrack checks](soundtrack-checks.md) exercise known musical BPMs and beat phases through actual WAV decoding, including subdivisions, quiet audio and leading silence. The [historical beta-1 reference report](auto-tag-reference-results.md) used the previous movement-agreement policy and does not describe current soundtrack coverage.

**Compare with saved grids** analyzes every currently human-tagged clip,
without altering the tags or making review proposals. Its report lists each
expected/predicted BPM and failed/abstained rows. Alternatively:

```sh
npm run benchmark:auto-tag
```

The command saves `.auto-tag/benchmark.json` (also shown in the Library once
complete). Direct matches use an error tolerance of **max(2 BPM, 3% of the saved
BPM)**. Half/double-time matches are reported **separately** and include direct
matches. All tagged clips, including abstentions/errors, remain in the denominator.
Saved tags can represent dance tempo rather than soundtrack tempo, especially when music was added later, so mismatches in this comparison are not necessarily audio detection errors. This compares tempo, not grid phase. Manual tags are reference labels, not perfect
physical ground truth. This development reference set is not a held-out accuracy
study; do not interpret its score as performance on every new dance style.

Checks for development:

```sh
npm run typecheck
npm run typecheck:tests
npm run test:auto-tag       # real audio decoding/tempo/phase, audio priority, silence and motion fallback
npm run test:auto-tag:api   # Node 22+: queue, cancellation, stale review, approval gate
npm run build
```

## Local state

`.auto-tag/review.json` holds pending/dismissed/approved suggestions, audit grids
and benchmark summaries. Feature caches are keyed by media identity, usable
window, sampling/model settings and feature-extractor version. They contain
numeric motion features, not copies of videos. Restarting the dev server keeps
completed suggestions; interrupted work can be scanned again. Deleting
`.auto-tag/features/` only clears the cache. Deleting `review.json` discards the
local review queue, **not** any grids already approved into the manifest.

Implementation: `scripts/auto_tag/scan.py` (analysis), `server/autoTag.ts` (serialized
jobs and review state), the dev library plugin (atomic manifest approval), and
`AutoTagPanel` / `TagPage` (review UI).

Method references: Google's [Pose Landmarker Python guide](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/python),
[librosa onset strength](https://librosa.org/doc/0.11.0/generated/librosa.onset.onset_strength.html),
and the kinematic-beat convention described in [DanceFormer](https://cdn.aaai.org/ojs/20014/20014-13-24027-1-2-20220628.pdf).

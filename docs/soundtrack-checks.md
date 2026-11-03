# Soundtrack BPM and grid checks — beta-2

Nine known-tempo synthetic musical tracks were written as PCM WAV files and analyzed through the actual FFmpeg/librosa pipeline. The tracks include bass kicks, alternating snare accents and eighth-note hi-hats; extra cases cover quiet audio and leading silence.

All nine estimates were within **0.25 BPM** and **60 ms** of their known tempo and beat phase. These are controlled regression checks, not a measured success rate on every genre or real-world recording.

| Known BPM | Estimated BPM | BPM error | Grid phase error | Case |
| ---: | ---: | ---: | ---: | --- |
| 60.000 | 60.003 | 0.003 | 11.80 ms | Kick/snare with eighth-note hats |
| 80.000 | 80.003 | 0.003 | 11.30 ms | Kick/snare with eighth-note hats |
| 100.000 | 100.017 | 0.017 | 12.80 ms | Kick/snare with eighth-note hats |
| 128.000 | 128.007 | 0.007 | 11.60 ms | Kick/snare with eighth-note hats |
| 156.300 | 156.289 | 0.011 | 11.20 ms | Kick/snare with eighth-note hats |
| 191.000 | 191.001 | 0.001 | 11.54 ms | Kick/snare with eighth-note hats |
| 220.000 | 219.993 | 0.007 | 11.63 ms | Kick/snare with eighth-note hats |
| 128.000 | 127.992 | 0.008 | 13.50 ms | Quiet audio (−60 dB) |
| 100.000 | 100.017 | 0.017 | 13.40 ms | 2 seconds leading silence |

Policy tests additionally verify that soundtrack grids are produced even with weak confidence, no visible dancer, mismatched movement, and a short/silent usable window. Silent or non-rhythmic sources do not receive an invented BPM. API tests cover pending review, source changes, explicit approval, cancellation, already-tagged clips, and silent-file skipping in soundtrack-only batches.

Run `npm run test:auto-tag` and `npm run test:auto-tag:api` to reproduce.

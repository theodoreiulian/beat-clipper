# Auto-tag beta: development reference check

Run: 2026-11-03T20:30:51Z. Detector: `beta-1`.

- **3/25 clips received a recommendation; 22 were left for manual tagging.**
- 3 recommendations matched the saved BPM within **max(2 BPM, 3%)**.
- 3 matched when half/double-time equivalence was allowed (includes direct matches).
- None of the saved BPMs, offsets or trim bounds were changed.
- Low-evidence candidates were retained for auditioning but not preselected.
- This is a small development reference set, not a held-out test or a calibrated accuracy claim. Most short silent clips remain difficult.
- Grid phase accuracy was not measured; each suggestion still requires human timing verification.

| Clip | Saved BPM | Recommended BPM | Method | Result |
| --- | ---: | ---: | --- | --- |
| darkest man.mp4 | 100.00 | — | visual | Manual needed |
| kai 4.mp4 | 145.00 | — | visual | Manual needed |
| 2 brothers.mp4 | 137.00 | — | visual | Manual needed |
| booty.mp4 | 113.00 | — | visual | Manual needed |
| kai again.mp4 | 161.00 | — | visual | Manual needed |
| kai 1.mp4 | 150.00 | — | visual | Manual needed |
| khaled.mp4 | 108.00 | 104.82 | visual | Within tolerance |
| kai 3.mp4 | 144.00 | — | visual | Manual needed |
| kai offset.mp4 | 132.00 | — | visual | Manual needed |
| uzi.mp4 | 169.00 | — | visual | Manual needed |
| druski 1.mp4 | 138.00 | — | visual | Manual needed |
| supermarket.mp4 | 143.00 | — | visual | Manual needed |
| african unc.mp4 | 142.00 | — | visual | Manual needed |
| mj aura.mp4 | 122.00 | — | visual | Manual needed |
| french guy.mp4 | 127.00 | — | visual | Manual needed |
| kai 5.mp4 | 149.00 | — | visual | Manual needed |
| druski 2.mp4 | 148.73 | — | visual | Manual needed |
| export_1733397092024.mp4 | 156.29 | — | visual | Manual needed |
| v0f025gc0000cs2korfog65n7ub3fj00.mp4 | 135.99 | — | visual | Manual needed |
| v0f025gc0000crvf43nog65h8qeuomug_dewatermarked.mp4 | 149.73 | — | visual | Manual needed |
| v0f044gc0000ckndcsjc77ueeai6dreg.mp4 | 133.02 | — | visual | Manual needed |
| v0f044gc0000cmepuvvog65vu72l0vo0.mp4 | 125.98 | — | visual | Manual needed |
| v0f044gc0000csr25ivog65soakf146g.mp4 | 147.95 | — | visual | Manual needed |
| v12044gd0000crupj4vog65t3td7hhrg.mp4 | 189.32 | 191.16 | audio-supported | Within tolerance |
| v12044gd0000csomuv7og65la82kn350.mp4 | 191.02 | 191.16 | audio-supported | Within tolerance |

The worker receives no saved BPM or filename-derived tempo. Reference labels are compared only after prediction. A broad conventional tempo preference and heuristic evidence thresholds are documented in the [beta guide](auto-tag-beta.md).

Detector SHA-256: `8a2949ab686249a23b435ce1d681c4215e1cd4ad1acfcdd78dbbbd4a8d59af3e`.

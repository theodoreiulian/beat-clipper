# Test fixtures

The render tests need **one sample beat** (audio) to feed through the system.

## Add your sample audio

Drop a single audio file into this folder, e.g.:

```
tests/fixtures/sample-beat.mp3
```

Any of `.mp3 .wav .m4a .aac .ogg .flac` works. The helper picks the first audio
file it finds here. Alternatively, point at a file anywhere:

```bash
SAMPLE_AUDIO=/absolute/path/to/beat.mp3 npm test
```

Tip: if the filename contains a tempo (e.g. `myloop-140bpm.mp3`), `detectBeat`
reads it from the name; otherwise it analyzes the audio.

## Clips

The render tests reuse the real dance clips already committed in `public/clips/`
(the smallest few, for speed), so you don't need to add any clips here.

## Notes

- Keep the sample short (a handful of seconds is plenty) to keep renders fast.
- Audio files here are git-ignored by default (see `.gitignore`) so large or
  copyrighted beats don't get committed. Commit one deliberately if you want CI
  to have it.

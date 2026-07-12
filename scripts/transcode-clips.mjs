// Remux the bundled dance clips from .mov to .mp4 for cross-browser reliability.
//
// The clips are already H.264, so this is a lossless container remux (`-c:v copy`),
// not a re-encode, so video quality is untouched. The PCM audio track is dropped
// (`-an`): mp4 can't carry PCM, the clips always play muted, and the renderer
// muxes the producer's beat as the audio track anyway.
//
// Why: a .mov container (with PCM audio) is read by a hidden <video> element to get
// each clip's duration and to preview it in the tagging tool; some browsers handle
// the QuickTime container / `video/quicktime` MIME less reliably than mp4, which can
// make a clip silently unreadable and get it dropped from a render.
//
// Non-destructive and idempotent: writes <name>.mp4 next to <name>.mov, never deletes
// the originals, skips clips whose .mp4 already exists, and rewrites the `file` field
// in manifest.json to point at the .mp4. Run manually: `node scripts/transcode-clips.mjs`.
import { readdirSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const clipsDir = resolve(root, 'public/clips')

const movs = readdirSync(clipsDir).filter((f) => f.toLowerCase().endsWith('.mov'))
if (movs.length === 0) {
  console.log('No .mov files in public/clips, nothing to do.')
  process.exit(0)
}

for (const mov of movs) {
  const mp4 = mov.replace(/\.mov$/i, '.mp4')
  const mp4Path = resolve(clipsDir, mp4)
  if (existsSync(mp4Path) && statSync(mp4Path).size > 0) {
    console.log(`skip  ${mp4} (already exists)`)
    continue
  }
  console.log(`remux ${mov} -> ${mp4}`)
  execFileSync(
    'ffmpeg',
    ['-y', '-i', resolve(clipsDir, mov), '-c:v', 'copy', '-an', '-movflags', '+faststart', mp4Path],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
}

// Repoint manifest.json at the .mp4 files (leave bpm/offset/id untouched).
const manifestPath = resolve(clipsDir, 'manifest.json')
if (existsSync(manifestPath)) {
  const entries = JSON.parse(readFileSync(manifestPath, 'utf8'))
  let changed = 0
  for (const e of entries) {
    if (typeof e.file === 'string' && /\.mov$/i.test(e.file)) {
      e.file = e.file.replace(/\.mov$/i, '.mp4')
      changed++
    }
  }
  if (changed > 0) {
    writeFileSync(manifestPath, JSON.stringify(entries, null, 2) + '\n')
    console.log(`Updated ${changed} manifest entries to .mp4`)
  }
}

console.log('Done. Original .mov files were kept (this repo is not under git).')

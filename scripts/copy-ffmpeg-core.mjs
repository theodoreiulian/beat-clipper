// Copies the single-threaded ESM ffmpeg core into public/ffmpeg/ so it ships as
// a local static asset. @ffmpeg/ffmpeg (>=0.12.x) runs its worker as a module
// worker, so it loads the core via dynamic `import()` and needs the ESM build's
// `export default`; the UMD build has no default export and fails to load
// ("failed to import ffmpeg-core.js").
// Runs automatically via the `predev` / `prebuild` npm hooks.
import { mkdirSync, copyFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = resolve(root, 'node_modules/@ffmpeg/core/dist/esm')
const dest = resolve(root, 'public/ffmpeg')

mkdirSync(dest, { recursive: true })
for (const file of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
  copyFileSync(resolve(src, file), resolve(dest, file))
}
console.log('Copied ffmpeg core to public/ffmpeg/')

import { spawn } from 'node:child_process'
import { mkdir, access, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const home = resolve(root, '.auto-tag')
const python = resolve(home, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const run = (command, args) => new Promise((yes, no) => {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit' })
  child.on('error', no)
  child.on('exit', (code) => code === 0 ? yes() : no(new Error(`${command} exited with ${code}`)))
})
try {
  await mkdir(resolve(home, 'models'), { recursive: true })
  try { await access(python) } catch {
    const bootstrap = process.env.AUTO_TAG_PYTHON || 'python3'
    await run(bootstrap, ['-c', 'import sys; assert (3,11) <= sys.version_info[:2] <= (3,12), "Use Python 3.11–3.12 (AUTO_TAG_PYTHON=/path/to/python3.11)"'])
    await run(bootstrap, ['-m', 'venv', resolve(home, 'venv')])
  }
  await unlink(resolve(home, 'ready.json')).catch(() => {})
  await run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', 'scripts/auto_tag/requirements.txt'])
  for (const variant of ['full']) {
    const target = resolve(home, 'models', `pose_landmarker_${variant}.task`)
    try { await access(target); continue } catch { /* download once */ }
    console.log(`Downloading Google's ${variant} pose model…`)
    const temporary = `${target}.download`
    try {
      await run('curl', ['--fail', '--location', '--retry', '2', '--max-time', '180', '--output', temporary,
        `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${variant}/float16/1/pose_landmarker_${variant}.task`])
      await rename(temporary, target)
    } catch (error) { await unlink(temporary).catch(() => {}); throw error }
  }
  await run(python, ['scripts/auto_tag/scan.py', '--check'])
  await writeFile(resolve(home, 'ready.json'), JSON.stringify({ version: 'beta-2' }) + '\n')
  console.log('Auto-tag beta is ready. Analysis stays on this computer.')
} catch (error) { console.error(error.message); process.exitCode = 1 }

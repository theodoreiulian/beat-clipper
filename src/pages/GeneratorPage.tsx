import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Clip, OutputLength } from '../types'
import { loadLibrary } from '../lib/manifest'
import { detectBeat } from '../lib/bpm'
import { renderVideo } from '../lib/render'
import { DropZone } from '../components/DropZone'
import { VideoPreview } from '../components/VideoPreview'
import { Waveform } from '../components/Waveform'

type Phase = 'idle' | 'detecting' | 'ready' | 'rendering' | 'done' | 'error'

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Numeric readout whose digits roll into place like a hardware counter. */
function RollingValue({ value }: { value: string }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    const raf = requestAnimationFrame(() => setArmed(true))
    return () => cancelAnimationFrame(raf)
  }, [])
  return (
    <>
      {value.split('').map((ch, i) =>
        /\d/.test(ch) ? (
          <span key={i} className="digit" aria-hidden="true">
            <span
              className="digit__reel"
              style={{
                transform: `translateY(-${armed ? ch : 0}em)`,
                ['--digit-delay' as string]: `${i * 60}ms`,
              }}
            >
              {Array.from('0123456789', (d) => (
                <span key={d}>{d}</span>
              ))}
            </span>
          </span>
        ) : (
          <span key={i}>{ch}</span>
        ),
      )}
    </>
  )
}

export function GeneratorPage() {
  const [clips, setClips] = useState<Clip[]>([])
  const [beat, setBeat] = useState<File | null>(null)
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null)
  const [bpm, setBpm] = useState<number | null>(null)
  const [bpmInput, setBpmInput] = useState('')
  const [onset, setOnset] = useState<number>(0)
  const [length, setLength] = useState<OutputLength>(30)
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState(0)
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)

  useEffect(() => {
    loadLibrary({ includeUntagged: false }).then(setClips)
  }, [])

  async function handleBeat(files: File[]) {
    const file = files[0]
    setBeat(file)
    setResultUrl(null)
    setError(null)
    setWarning(null)
    setPhase('detecting')
    try {
      const beatInfo = await detectBeat(file)
      setBuffer(beatInfo.buffer)
      setBpm(beatInfo.bpm)
      setBpmInput(beatInfo.bpm.toFixed(2))
      setOnset(beatInfo.onsetSeconds)
      setPhase('ready')
    } catch {
      setBuffer(null)
      setBpm(120)
      setBpmInput('120')
      setOnset(0)
      setPhase('ready')
    }
  }

  // The first beat is anchored at the start of the sound, independent of tempo,
  // so a hand-typed BPM re-spaces the grid but never moves its anchor.
  function handleBpmInput(raw: string) {
    setBpmInput(raw)
    const value = parseFloat(raw)
    if (!Number.isFinite(value) || value < 40 || value > 300) return
    setBpm(value)
  }

  async function handleGenerate() {
    if (!beat || bpm == null) return
    setPhase('rendering')
    setProgress(0)
    setError(null)
    setWarning(null)
    try {
      const result = await renderVideo(clips, beat, bpm, length, onset, (r) =>
        setProgress(Math.round(r * 100)),
      )
      setResultUrl(result.url)
      if (result.skipped > 0) {
        const s = result.skipped
        setWarning(`${s} clip${s > 1 ? 's' : ''} couldn't be read and ${s > 1 ? 'were' : 'was'} skipped.`)
      }
      setPhase('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Render failed')
      setPhase('error')
    }
  }

  const hasClips = clips.length > 0
  const beatReady = beat != null && bpm != null && phase !== 'detecting'

  return (
    <div className="page">
      <header className="page__head reveal">
        <div>
          <h1 className="page__title">Beatclipper</h1>
          <p className="page__sub">
            Drop a beat, confirm its tempo, and render a vertical dance edit cut every four
            beats, entirely in your browser.
          </p>
        </div>
      </header>

      {!hasClips && (
        <div className="notice reveal" style={{ marginBottom: 28 }}>
          <span className="lamp lamp--rec" />
          {import.meta.env.DEV ? (
            <span>
              No tagged clips in the library yet. The generator needs footage, so add and tag
              clips in <Link to="/tag">02 / Library</Link> first.
            </span>
          ) : (
            <span>No clips in the library yet. Check back soon.</span>
          )}
        </div>
      )}

      <div className="rack">
        <section className="reveal" style={{ ['--i' as string]: 1 }}>
          <div className="section__head">
            <span className="section__index">01</span>
            <span className="section__label">Input</span>
            <span className="section__rule" />
            {phase === 'detecting' && <span className="section__aside">analyzing…</span>}
          </div>

          {!beat ? (
            <DropZone accept="audio/*" onFiles={handleBeat}>
              <div className="drop__inner">
                <span className="drop__title">Drop your beat</span>
                <span className="drop__hint">
                  mp3 / wav / m4a (BPM is read from the filename when present)
                </span>
              </div>
            </DropZone>
          ) : (
            <div className="wave">
              <div className="wave__head">
                <div className="wave__file">
                  <span className={`lamp${phase === 'detecting' ? ' lamp--rec' : ' lamp--on'}`} />
                  <span className="wave__filename" title={beat.name}>
                    {beat.name}
                  </span>
                </div>
                <div className="wave__meta">
                  {buffer && <span>{formatDuration(buffer.duration)}</span>}
                  <DropZone accept="audio/*" compact onFiles={handleBeat}>
                    <div className="drop__inner">
                      <span className="drop__hint">replace</span>
                    </div>
                  </DropZone>
                </div>
              </div>
              {buffer ? (
                <Waveform buffer={buffer} bpm={bpm} onset={onset} />
              ) : (
                phase !== 'detecting' && (
                  <div className="wave__body" style={{ height: 'auto', padding: '14px' }}>
                    <span className="drop__hint">
                      Couldn't decode this file for preview, but the render can still use it.
                    </span>
                  </div>
                )
              )}
            </div>
          )}
        </section>

        {beatReady && (
          <section className="reveal" style={{ ['--i' as string]: 1 }}>
            <div className="section__head">
              <span className="section__index">02</span>
              <span className="section__label">Tempo</span>
              <span className="section__rule" />
              {onset > 0 && (
                <span className="section__aside">first beat {onset.toFixed(3)}s</span>
              )}
            </div>

            <div className="tempo">
              <div className="readout">
                <span className="microlabel">Detected tempo</span>
                <span className="readout__value">
                  <RollingValue key={bpm!.toFixed(2)} value={bpm!.toFixed(2)} />
                  <span className="readout__unit">BPM</span>
                </span>
              </div>

              <div className="tempo__side">
                <label className="field">
                  <span className="microlabel">Adjust</span>
                  <input
                    type="number"
                    min={40}
                    max={300}
                    step={0.01}
                    value={bpmInput}
                    onChange={(e) => handleBpmInput(e.target.value)}
                  />
                </label>

                <p className="tempo__hint">
                  Detected from the beat. If a cut feels off, nudge the BPM until the edit
                  lands on the music.
                </p>
              </div>
            </div>
          </section>
        )}

        {beatReady && (
          <section className="reveal" style={{ ['--i' as string]: 2 }}>
            <div className="section__head">
              <span className="section__index">03</span>
              <span className="section__label">Output</span>
              <span className="section__rule" />
              <span className="section__aside">1080 × 1440</span>
            </div>

            <div className="output">
              <div className="field">
                <span className="microlabel">Length</span>
                <div className="switch">
                  {([30, 60, 'full'] as OutputLength[]).map((opt) => (
                    <button
                      key={String(opt)}
                      type="button"
                      className={`switch__opt${length === opt ? ' switch__opt--active' : ''}`}
                      onClick={() => setLength(opt)}
                    >
                      {opt === 'full' ? 'FULL' : opt === 60 ? '1min' : `${opt}s`}
                    </button>
                  ))}
                </div>
              </div>

              <button
                type="button"
                className="ctl ctl--primary ctl--lg"
                disabled={!hasClips || bpm! < 40 || phase === 'rendering'}
                onClick={handleGenerate}
              >
                {phase === 'rendering' ? 'Rendering' : 'Generate'}
              </button>
            </div>

            {phase === 'rendering' && (
              <div className="meter">
                <div className="meter__track">
                  <div className="meter__fill" style={{ width: `${progress}%` }} />
                </div>
                <span className="meter__pct">{progress}%</span>
              </div>
            )}

            {error && (
              <div className="notice notice--error" style={{ marginTop: 24 }}>
                <span className="lamp lamp--rec" />
                <span>{error}</span>
              </div>
            )}

            {warning && phase === 'done' && (
              <div className="notice" style={{ marginTop: 24 }}>
                <span className="lamp lamp--rec" />
                <span>{warning}</span>
              </div>
            )}

            {resultUrl && phase === 'done' && <VideoPreview url={resultUrl} />}
          </section>
        )}
      </div>
    </div>
  )
}

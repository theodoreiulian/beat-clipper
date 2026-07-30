import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Clip, OutputLength } from '../types'
import { loadLibrary } from '../lib/manifest'
import { detectBeat, extractPeaks, type WavePeaks } from '../lib/bpm'
import {
  outputWindow,
  planRender,
  renderPreview,
  renderSegments,
  resetPreviewCache,
  snapToBar,
  type Segment,
} from '../lib/render'
import { formatClock } from '../lib/format'
import { BeatTransport } from '../components/BeatTransport'
import { DropZone } from '../components/DropZone'
import { SequenceEditor } from '../components/SequenceEditor'

type Phase = 'idle' | 'detecting' | 'ready' | 'rendering' | 'done' | 'error'

/** Matches PREVIEW_W/PREVIEW_H in render.ts; shown so the size isn't a surprise. */
const PREVIEW_LABEL = '540 × 720'

/** Everything the editor needs about the render that produced the current cut list. */
interface EditState {
  segments: Segment[]
  original: Segment[]
  library: Clip[]
  durations: Map<string, number>
  outLen: number
  /** Where in the beat this cut list starts; every re-encode of it must match. */
  audioStart: number
  beatBpm: number
  /** Sequence the downloadable full-res file was rendered from, or null if none
   *  has been rendered yet. Compared by identity to spot edits since the export. */
  exported: Segment[] | null
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
  // Only the drawable summary is kept; the decoded AudioBuffer (tens of MB for a
  // full track) is released as soon as detection is done.
  const [peaks, setPeaks] = useState<WavePeaks | null>(null)
  const [bpm, setBpm] = useState<number | null>(null)
  const [bpmInput, setBpmInput] = useState('')
  const [onset, setOnset] = useState<number>(0)
  // Where in the beat the render starts. Always a bar line (or 0, the head of
  // the file), so the edit's first cut lands on the music wherever it begins.
  const [startAt, setStartAt] = useState(0)
  const [length, setLength] = useState<OutputLength>(30)
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const [edit, setEdit] = useState<EditState | null>(null)

  // The editor always plays this; it is rebuilt (cheaply) after every edit.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [rebuilding, setRebuilding] = useState(false)
  const [rebuildProgress, setRebuildProgress] = useState(0)
  // The full-size file, produced only on demand.
  const [exportUrl, setExportUrl] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    loadLibrary({ includeUntagged: false }).then(setClips)
  }, [])

  // Blob URLs would otherwise be held for the life of the tab, and an editing
  // session produces one preview per edit.
  const previewRef = useRef<string | null>(null)
  const exportRef = useRef<string | null>(null)
  function publishPreview(url: string | null) {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current)
    previewRef.current = url
    setPreviewUrl(url)
  }
  function publishExport(url: string | null) {
    if (exportRef.current) URL.revokeObjectURL(exportRef.current)
    exportRef.current = url
    setExportUrl(url)
  }
  useEffect(() => () => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current)
    if (exportRef.current) URL.revokeObjectURL(exportRef.current)
  }, [])

  async function handleBeat(files: File[]) {
    const file = files[0]
    setBeat(file)
    publishPreview(null)
    publishExport(null)
    setEdit(null)
    setError(null)
    setWarning(null)
    setStartAt(0)
    setPhase('detecting')
    try {
      const beatInfo = await detectBeat(file)
      setPeaks(extractPeaks(beatInfo.buffer))
      setBpm(beatInfo.bpm)
      setBpmInput(beatInfo.bpm.toFixed(2))
      setOnset(beatInfo.onsetSeconds)
      setPhase('ready')
    } catch {
      setPeaks(null)
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

  // Seconds of beat the render will cover — the lit band on the waveform, and
  // exactly what planRender will work out for itself when Generate is pressed.
  const windowLen = peaks ? outputWindow(peaks.duration, startAt, length) : 0

  // Re-spacing the grid moves every bar line, so a start point picked on the old
  // grid has to be re-snapped onto the new one or the render would open off-beat.
  useEffect(() => {
    if (!peaks || bpm == null || bpm < 40) return
    setStartAt((s) => (s <= 0 ? 0 : snapToBar(s, onset, bpm, peaks.duration)))
  }, [bpm, onset, peaks])

  async function handleGenerate() {
    if (!beat || bpm == null) return
    setPhase('rendering')
    setProgress(0)
    setError(null)
    setWarning(null)
    publishExport(null)
    try {
      // Plan the cut list, then build the editor's preview of it. The preview is
      // a real MP4 assembled from per-cut encodes, so later edits only re-encode
      // the cut that changed.
      const plan = await planRender(clips, beat, bpm, length, onset, startAt)
      await resetPreviewCache()
      const { url } = await renderPreview(
        plan.segments,
        beat,
        plan.outLen,
        plan.audioStart,
        (r) => setProgress(Math.round(r * 100)),
      )
      publishPreview(url)
      setEdit({
        segments: plan.segments,
        original: plan.segments,
        exported: null,
        library: plan.playable,
        durations: plan.durations,
        outLen: plan.outLen,
        audioStart: plan.audioStart,
        beatBpm: bpm,
      })
      if (plan.skipped > 0) {
        const s = plan.skipped
        setWarning(`${s} clip${s > 1 ? 's' : ''} couldn't be read and ${s > 1 ? 'were' : 'was'} skipped.`)
      }
      setPhase('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Render failed')
      setPhase('error')
    }
  }

  // Rebuilds are coalesced: swapping three clips quickly runs one rebuild, then
  // one more for whatever the sequence ended up as, rather than three in a row.
  const rebuild = useRef<{ running: boolean; pending: Segment[] | null }>({
    running: false,
    pending: null,
  })

  async function rebuildPreview(segments: Segment[], outLen: number, audioStart: number) {
    if (!beat) return
    if (rebuild.current.running) {
      rebuild.current.pending = segments
      return
    }
    rebuild.current.running = true
    setRebuilding(true)
    setError(null)
    try {
      let next: Segment[] | null = segments
      while (next) {
        rebuild.current.pending = null
        setRebuildProgress(0)
        const { url } = await renderPreview(next, beat, outLen, audioStart, (r) =>
          setRebuildProgress(Math.round(r * 100)),
        )
        publishPreview(url)
        next = rebuild.current.pending
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Preview failed')
    } finally {
      rebuild.current.running = false
      setRebuilding(false)
    }
  }

  function handleSegmentsChange(segments: Segment[]) {
    setEdit((prev) => (prev ? { ...prev, segments } : prev))
    if (edit) void rebuildPreview(segments, edit.outLen, edit.audioStart)
  }

  async function handleExport() {
    if (!beat || !edit) return
    // Snapshot what we're encoding: the user can keep editing while ffmpeg runs,
    // and only *this* sequence is the one the resulting MP4 contains.
    const encoded = edit.segments
    setExporting(true)
    setProgress(0)
    setError(null)
    try {
      const { url } = await renderSegments(encoded, beat, edit.outLen, edit.audioStart, (r) =>
        setProgress(Math.round(r * 100)),
      )
      publishExport(url)
      setEdit((prev) => (prev ? { ...prev, exported: encoded } : prev))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed')
    } finally {
      setExporting(false)
    }
  }

  /** The downloadable file is stale as soon as the cut list moves on from it. */
  const exportCurrent = edit != null && exportUrl != null && edit.exported === edit.segments

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
                  <DropZone accept="audio/*" compact onFiles={handleBeat}>
                    <div className="drop__inner">
                      <span className="drop__hint">replace</span>
                    </div>
                  </DropZone>
                </div>
              </div>
              {peaks ? (
                <BeatTransport
                  file={beat}
                  peaks={peaks}
                  bpm={bpm}
                  onset={onset}
                  startAt={startAt}
                  windowLen={windowLen}
                  onStartChange={setStartAt}
                />
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
              <span className="section__aside">
                1080 × 1440
                {peaks && windowLen > 0 && (
                  <> · {formatClock(startAt)} → {formatClock(startAt + windowLen)}</>
                )}
              </span>
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

          </section>
        )}

        {phase === 'done' && edit && (
          <section className="reveal" style={{ ['--i' as string]: 3 }}>
            <div className="section__head">
              <span className="section__index">04</span>
              <span className="section__label">Edit</span>
              <span className="section__rule" />
              <span className="section__aside">
                {rebuilding ? 'rebuilding' : `preview ${PREVIEW_LABEL}`}
              </span>
            </div>

            <SequenceEditor
              segments={edit.segments}
              originalSegments={edit.original}
              library={edit.library}
              durations={edit.durations}
              beatBpm={edit.beatBpm}
              previewUrl={previewUrl}
              busy={rebuilding}
              progress={rebuildProgress}
              onChange={handleSegmentsChange}
            />

            <div className="editor__actions">
              {exportCurrent ? (
                <a className="ctl ctl--primary ctl--lg" href={exportUrl!} download="beat-clipper.mp4">
                  Download MP4
                </a>
              ) : (
                <button
                  type="button"
                  className="ctl ctl--primary ctl--lg"
                  disabled={exporting || rebuilding}
                  onClick={handleExport}
                >
                  {exporting ? 'Rendering full size' : 'Render full size'}
                </button>
              )}
            </div>

            {exporting && (
              <div className="meter">
                <div className="meter__track">
                  <div className="meter__fill" style={{ width: `${progress}%` }} />
                </div>
                <span className="meter__pct">{progress}%</span>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  )
}

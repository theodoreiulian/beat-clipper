import { useState } from 'react'
import type { Clip } from '../types'
import type { GridResult } from '../lib/tapTempo'
import type { useAutoTag } from '../lib/autoTagApi'
import type { AutoTagProposal } from '../lib/autoTagTypes'

interface Props {
  scanner: ReturnType<typeof useAutoTag>
  clips: Clip[]
  current: Clip | null
  proposal: AutoTagProposal | null
  onUse: (grid: GridResult) => void
  onReview: () => void
  verified: boolean
  onVerified: (value: boolean) => void
}
export function AutoTagPanel({ scanner, clips, current, onReview }: Pick<Props, 'scanner' | 'clips' | 'current' | 'onReview'>) {
  const [showBenchmark, setShowBenchmark] = useState(false)
  const { state, error, submitting, action } = scanner
  const job = state?.job
  const busy = submitting || job?.status === 'running'
  const unscanned = clips.filter(c => c.bpm == null && state?.proposals[c.id]?.state !== 'pending')
  const pendingCount = clips.filter(c => state?.proposals[c.id]?.state === 'pending').length
  const benchmark = state?.benchmark
  const progress = job ? Math.min(1, (job.done + (job.status === 'running' ? job.progress : 0)) / Math.max(1, job.total)) : 0
  return (
    <section className="autotag" aria-labelledby="autotag-title">
      <div className="autotag__head">
        <div>
          <h2 id="autotag-title">Auto-tag <span className="autotag__beta">Beta</span></h2>
          <p>Scan soundtrack BPMs, watch the grid on the video, then approve. Suggestions never enter renders before you verify them.</p>
        </div>
        <div className="autotag__actions">
          {!state?.ready ? (
            <button className="ctl ctl--primary" type="button" disabled={busy || !state} onClick={() => void action('/setup')}>Set up scanner</button>
          ) : (
            <>
              <button className="ctl ctl--primary" type="button" disabled={busy || !current} onClick={() => current && void action('/scan', { ids: [current.id] })}>Scan this clip</button>
              <button className="ctl" type="button" disabled={busy || !unscanned.length} onClick={() => void action('/scan', { ids: unscanned.map(c => c.id) })}>Scan {unscanned.length} unscanned</button>
              <button className="ctl" type="button" disabled={busy || !clips.length} onClick={() => void action('/scan', { ids: clips.map(c => c.id), audioOnly: true })}>Scan all soundtracks</button>
              <button className="ctl" type="button" disabled={!pendingCount} onClick={onReview}>Review {pendingCount} pending</button>
              <button className="ctl ctl--quiet" type="button" disabled={busy || !clips.some(c => c.bpm != null)} onClick={() => void action('/benchmark')}>Compare with saved grids</button>
            </>
          )}
        </div>
      </div>
      {!state?.ready && <p className="autotag__note">One-time setup installs a local Python worker and Google pose models. Python 3.11–3.12 and FFmpeg are required. Clips stay on this computer.</p>}
      {error && <p role="alert" className="autotag__error">{error}</p>}
      {job && (
        <div className="autotag__job">
          <div className="autotag__job-row">
            <span role="status">{job.kind === 'benchmark' ? 'Saved grid comparison' : job.kind === 'setup' ? 'Scanner setup' : 'Scanning'} · {job.done}/{job.total} · {job.message}</span>
            {job.status === 'running' && <button className="ctl ctl--quiet" type="button" disabled={submitting} onClick={() => void action('/cancel')}>Cancel</button>}
          </div>
          {job.currentFile && <p className="autotag__filename">{job.currentFile}</p>}
          {job.status === 'running' && <progress aria-label="Scanner progress" max={1} value={progress} />}
          {job.errors.length > 0 && <details><summary>{job.errors.length} scans failed</summary><ul>{job.errors.map(e => <li key={e.clipId}>{clips.find(c => c.id === e.clipId)?.name ?? e.clipId}: {e.message}</li>)}</ul></details>}
        </div>
      )}
      {benchmark && (
        <div className="autotag__benchmark">
          <button className="ctl ctl--quiet" type="button" aria-expanded={showBenchmark} onClick={() => setShowBenchmark(v => !v)}>Saved grid comparison: {benchmark.exact}/{benchmark.total} within 3% or 2 BPM · {benchmark.proposed}/{benchmark.total} proposed {showBenchmark ? '−' : '+'}</button>
          {showBenchmark && <>
            <p>Saved grids are never detector inputs. They can describe dance tempo rather than soundtrack tempo, so a difference does not necessarily indicate an audio detection error. Half/double-time matches: {benchmark.octaveEquivalent}/{benchmark.total} (includes direct matches). Uncertain and failed scans count in the denominator. Phase accuracy is not measured here.</p>
            <div className="autotag__table-wrap"><table><thead><tr><th>Clip</th><th>Saved BPM</th><th>Proposed BPM</th><th>Result</th></tr></thead><tbody>{benchmark.rows.map(r => <tr key={r.id}><td>{r.file}</td><td>{r.expectedBpm.toFixed(1)}</td><td>{r.predictedBpm?.toFixed(1) ?? '—'}</td><td>{r.error ? 'Failed' : r.exact ? 'Within tolerance' : r.octaveEquivalent ? 'Half/double time' : r.predictedBpm == null ? 'Manual needed' : 'Mismatch'}</td></tr>)}</tbody></table></div>
          </>}
        </div>
      )}
    </section>
  )
}

export function AutoTagReview({ scanner, current, proposal, onUse, verified, onVerified }: Omit<Props, 'clips' | 'onReview'>) {
  const { submitting, action } = scanner
  const busy = submitting || scanner.state?.job?.status === 'running'
  const result = proposal?.result
  const pending = proposal?.state === 'pending'
  if (!pending) return null
  return <section className="autotag autotag--review" aria-label="Automatic tempo suggestion">
      {pending && result && (
        <div className="autotag__proposal">
          <div className="autotag__head">
            <h3>{result.bpm != null ? `${result.bpm.toFixed(1)} BPM suggested` : 'Manual tagging recommended'} <span className={`autotag__confidence autotag__confidence--${result.confidence}`}>{result.confidence} confidence</span></h3>
            <span className="microlabel">Pending human review</span>
          </div>
          <p>{result.method === 'audio' || result.method === 'audio-supported' ? 'Soundtrack BPM and beat timing. The music grid is shown on the video, regardless of the dancer’s movement.' : 'No audible soundtrack. This grid is estimated from detailed movement analysis.'} {result.agreement?.reason && result.method === 'visual' ? result.agreement.reason + '.' : ''}</p>
          <div className="autotag__facts">
            <span>{result.analyzedSeconds.toFixed(1)}s analyzed</span>
            {result.audio?.candidates[0] && <span>Music pulse {result.audio.candidates[0].bpm.toFixed(1)} BPM</span>}
            {result.tracking && <span>Body tracking {Math.round(result.tracking.coverage * 100)}%</span>}
          </div>
          {result.candidates.length > 0 && (
            <div className="autotag__alternatives">
              <span className="microlabel">Audition a grid</span>
              {result.candidates.slice(0, 4).map((c, i) => <button key={c.bpm} className={`ctl${i === 0 && result.bpm != null ? ' ctl--engaged' : ''}`} type="button" onClick={() => onUse({ bpm: c.bpm, offset: c.offset })}>{c.bpm.toFixed(1)} BPM</button>)}
              {result.bpm != null && [.5, 2].map(factor => {
                const bpm = result.bpm! * factor
                return bpm >= 30 && bpm <= 300 && <button key={factor} className="ctl ctl--quiet" type="button" onClick={() => onUse({ bpm, offset: (result.offset ?? 0) % (60 / bpm) })}>{factor === .5 ? 'Half' : 'Double'} time</button>
              })}
            </div>
          )}
          {result.warnings.length > 0 && <ul className="autotag__warnings">{result.warnings.map(w => <li key={w}>{w}</li>)}</ul>}
          <div className="autotag__actions">
            <button className="ctl" type="button" disabled={busy || !current} onClick={() => current && void action('/scan', { ids: [current.id] })}>Scan again</button>
            <button className="ctl ctl--quiet" type="button" disabled={submitting} onClick={() => void action(`/${encodeURIComponent(proposal.clipId)}/dismiss`, { runId: proposal.runId })}>Dismiss suggestion</button>
          </div>
          <label className="autotag__verify"><input type="checkbox" checked={verified} onChange={e => onVerified(e.target.checked)} /> I listened and watched the grid on the video, and verified its BPM and timing.</label>
          <p className="autotag__note">Adjust the grid below if needed, then use “Approve grid for rendering”. Confidence is an evidence rating, not a measured probability. Keep uncertain clips unapproved.</p>
        </div>
      )}
  </section>
}

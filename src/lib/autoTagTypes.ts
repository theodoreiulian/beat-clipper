/** Dev-only proposals. These are deliberately NOT fields of ManifestEntry. */
export interface TempoCandidate { bpm: number; offset: number; score: number }
export interface TempoEvidence {
  candidates: TempoCandidate[]
  confidence: number
  stability?: number
  available?: boolean
  reason?: string
}
export interface AutoTagResult {
  version: string
  status: 'suggested' | 'needs-manual'
  bpm: number | null
  offset: number | null
  method: 'audio-supported' | 'visual'
  confidence: 'low' | 'medium' | 'high'
  /** Evidence score, never presented as a probability of correctness. */
  evidenceScore: number
  candidates: TempoCandidate[]
  audio?: TempoEvidence
  motion?: TempoEvidence
  agreement?: { plausible: boolean; reason: string; coherence?: number; audioBpm?: number; motionBpm?: number }
  tracking?: { coverage: number; duration: number; channels?: number; trackSwitches: number }
  warnings: string[]
  analyzedSeconds: number
  elapsedSeconds: number
}
export interface AutoTagProposal {
  clipId: string
  runId: string
  fingerprint: string
  createdAt: string
  state: 'pending' | 'approved' | 'dismissed'
  result: AutoTagResult
  reviewedGrid?: { bpm: number; offset: number }
}
export interface AutoTagJob {
  id: string
  kind: 'scan' | 'benchmark' | 'setup'
  status: 'running' | 'completed' | 'cancelled' | 'failed'
  total: number
  done: number
  failed: number
  currentClipId?: string
  currentFile?: string
  stage: string
  progress: number
  message: string
  errors: { clipId: string; message: string }[]
}
export interface BenchmarkRow {
  id: string; file: string; expectedBpm: number; predictedBpm: number | null
  method?: string; confidence?: string; absoluteError: number | null
  exact: boolean; octaveEquivalent: boolean; error?: string
}
export interface AutoTagBenchmark {
  version: string
  createdAt: string
  total: number
  proposed: number
  exact: number
  octaveEquivalent: number
  rows: BenchmarkRow[]
}
export interface AutoTagState {
  ready: boolean
  job: AutoTagJob | null
  proposals: Record<string, AutoTagProposal>
  benchmark: AutoTagBenchmark | null
}

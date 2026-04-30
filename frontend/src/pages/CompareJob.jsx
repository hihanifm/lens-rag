import { useState, useEffect, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getCompareJob,
  getReviewStats,
  getNextReviewItem,
  submitCompareDecision,
  downloadCompareExport,
  browseCompareJob,
  getCompareConfigStats,
} from '../api/client'

// ── Helpers ────────────────────────────────────────────────────────────────

function scoreColor(score) {
  if (score >= 0.85) return 'bg-emerald-100 text-emerald-700 border-emerald-200'
  if (score >= 0.60) return 'bg-amber-100 text-amber-700 border-amber-200'
  return 'bg-gray-100 text-gray-500 border-gray-200'
}

function effectiveScore(candidate) {
  const r = candidate?.rerank_score
  if (typeof r === 'number' && r >= 0 && r <= 1) return r
  const c = candidate?.cosine_score
  return typeof c === 'number' ? c : 0
}

function effectiveScoreInfo(candidate) {
  const r = candidate?.rerank_score
  if (typeof r === 'number' && r >= 0 && r <= 1) {
    return { score: r, source: 'rerank' }
  }
  const c = candidate?.cosine_score
  return { score: typeof c === 'number' ? c : 0, source: 'cosine' }
}

function scoreBorder(score, selected, confirmed) {
  if (confirmed) return 'border-emerald-500 ring-2 ring-emerald-200'
  if (selected) return 'border-blue-500 ring-2 ring-blue-200'
  if (score >= 0.85) return 'border-emerald-300 hover:border-emerald-400'
  if (score >= 0.60) return 'border-amber-300 hover:border-amber-400'
  return 'border-gray-200 hover:border-gray-300'
}

// ── Candidate card (right side) ────────────────────────────────────────────

function CandidateCard({ candidate, isSelected, onClick }) {
  const { score, source } = effectiveScoreInfo(candidate)
  const isConfirmed = Boolean(candidate.__confirmed)
  return (
    <button
      onClick={onClick}
      className={`relative flex-1 text-left rounded-xl border-2 p-4 transition-all cursor-pointer
        ${isConfirmed ? 'bg-emerald-50' : 'bg-white'}
        ${scoreBorder(score, isSelected, isConfirmed)}`}
    >
      {/* Score badge */}
      <span
        className={`absolute top-3 right-3 text-xs font-semibold px-2 py-0.5 rounded-full border ${scoreColor(score)}`}
        title={`Scoring: ${source}${source === 'rerank' ? '' : ' (fallback)'} • cosine=${(candidate.cosine_score ?? 0).toFixed?.(3) ?? candidate.cosine_score} • rerank=${candidate.rerank_score}`}
      >
        {(score * 100).toFixed(0)}%
      </span>

      {/* Rank badge */}
      <span className="absolute top-3 left-3 text-xs text-gray-400 font-medium">
        #{candidate.rank}
      </span>

      {/* Display value chip */}
      {candidate.display_value && (
        <p className="text-xs text-blue-600 font-medium mt-5 mb-1 truncate">{candidate.display_value}</p>
      )}

      {/* Contextual content */}
      <p className={`text-sm text-gray-700 leading-relaxed overflow-y-auto max-h-48 ${!candidate.display_value ? 'mt-5' : ''}`}>
        {candidate.contextual_content}
      </p>

      {/* Selected indicator */}
      {(isSelected || isConfirmed) && (
        <div className={`absolute bottom-3 right-3 text-white text-xs px-2 py-0.5 rounded-full font-medium ${
          isConfirmed ? 'bg-emerald-600' : 'bg-blue-600'
        }`}>
          {isConfirmed ? '✓ Saved' : '✓ Selected'}
        </div>
      )}
    </button>
  )
}

// ── Review tab ────────────────────────────────────────────────────────────

function ReviewTab({ job }) {
  const jobId = job.id
  const queryClient = useQueryClient()

  const [minScore, setMinScore] = useState(0)
  const [includeDecided, setIncludeDecided] = useState(false)
  const [offset, setOffset] = useState(0)
  const [item, setItem] = useState(null)
  const [loading, setLoading] = useState(false)
  const [noMore, setNoMore] = useState(false)
  const [selectedRightId, setSelectedRightId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [confirmedRightId, setConfirmedRightId] = useState(null)
  const [confirmedNoMatch, setConfirmedNoMatch] = useState(false)
  const [rowStartedAt, setRowStartedAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())

  const scoringMode = (() => {
    const cands = item?.candidates || []
    const hasNormalizedRerank = cands.some(c => {
      const r = c?.rerank_score
      return typeof r === 'number' && r >= 0 && r <= 1
    })
    return hasNormalizedRerank ? 'rerank' : 'cosine'
  })()

  const { data: stats, refetch: refetchStats } = useQuery({
    queryKey: ['compare-review-stats', jobId],
    queryFn: () => getReviewStats(jobId),
    refetchInterval: false,
  })

  const fetchItem = useCallback(async (newOffset) => {
    setLoading(true)
    setNoMore(false)
    try {
      const result = await getNextReviewItem(jobId, {
        minScore,
        offset: newOffset,
        includeDecided,
      })
      setItem(result)
      setSelectedRightId(result.current_decision ?? null)
      setOffset(newOffset)
      setRowStartedAt(Date.now())
    } catch (e) {
      if (e?.response?.status === 404) {
        setNoMore(true)
        setItem(null)
      }
    } finally {
      setLoading(false)
    }
  }, [jobId, minScore, includeDecided])

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  // Load first item on mount and when filters change
  useEffect(() => {
    fetchItem(0)
  }, [minScore, includeDecided])

  const handleSelect = async (rightId) => {
    if (saving) return
    setSelectedRightId(rightId)
    setConfirmedRightId(rightId)
    setConfirmedNoMatch(false)
    setSaving(true)
    try {
      await submitCompareDecision(jobId, item.left_id, rightId)
      refetchStats()
      queryClient.invalidateQueries({ queryKey: ['compare-jobs'] })
      // Auto-advance to next undecided row
      if (!includeDecided) {
        await new Promise(r => setTimeout(r, 3000))
        await fetchItem(0)
      }
    } finally {
      setConfirmedRightId(null)
      setSaving(false)
    }
  }

  const handleNoMatch = async () => {
    if (saving) return
    setSelectedRightId(null)
    setConfirmedRightId(null)
    setConfirmedNoMatch(true)
    setSaving(true)
    try {
      await submitCompareDecision(jobId, item.left_id, null)
      refetchStats()
      queryClient.invalidateQueries({ queryKey: ['compare-jobs'] })
      if (!includeDecided) {
        await new Promise(r => setTimeout(r, 3000))
        await fetchItem(0)
      }
    } finally {
      setConfirmedNoMatch(false)
      setSaving(false)
    }
  }

  const handlePrev = () => {
    if (offset > 0) fetchItem(offset - 1)
  }

  const handleNext = () => {
    fetchItem(offset + 1)
  }

  // Keyboard shortcuts: ← Prev, → Next (ignore while typing in inputs)
  useEffect(() => {
    const onKeyDown = (e) => {
      if (saving || loading) return
      if (e.isComposing) return
      if (e.metaKey || e.ctrlKey || e.altKey) return

      const el = document.activeElement
      const tag = el?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return

      if (e.key === 'ArrowLeft') {
        if (offset > 0) {
          e.preventDefault()
          handlePrev()
        }
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        handleNext()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [offset, saving, loading, handlePrev, handleNext])

  return (
    <div className="space-y-4">
      {/* Top bar */}
      <div className="flex flex-wrap items-center gap-4 bg-white border border-gray-200 rounded-xl px-4 py-3">
        {/* Progress */}
        <div className="text-sm text-gray-600">
          <span className="font-semibold text-gray-900">{stats?.reviewed ?? 0}</span>
          {' / '}
          <span>{stats?.total_left ?? '?'}</span>
          {' reviewed'}
          {stats?.pending > 0 && (
            <span className="ml-2 text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">
              {stats.pending} pending
            </span>
          )}
        </div>

        <div className="flex-1" />

        <div className="text-xs text-gray-400 whitespace-nowrap">
          Elapsed: {Math.max(0, Math.floor((now - rowStartedAt) / 1000))}s
        </div>

        {/* Score filter */}
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-500 whitespace-nowrap">Min score</label>
          <select
            value={minScore}
            onChange={e => setMinScore(parseFloat(e.target.value))}
            className="text-sm border border-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-300"
          >
            {[0, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95].map(v => (
              <option key={v} value={v}>≥ {(v * 100).toFixed(0)}%</option>
            ))}
          </select>
          <span
            className={`text-xs px-2 py-1 rounded-full border whitespace-nowrap ${
              scoringMode === 'rerank'
                ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                : 'bg-gray-50 text-gray-600 border-gray-200'
            }`}
            title={
              scoringMode === 'rerank'
                ? 'Using normalized rerank scores (0..1).'
                : 'Rerank scores are not normalized; using cosine similarity instead.'
            }
          >
            Scoring: {scoringMode === 'rerank' ? 'Rerank' : 'Cosine'}
          </span>
        </div>

        {/* Include decided toggle */}
        <label className="flex items-center gap-2 text-sm text-gray-500 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={includeDecided}
            onChange={e => setIncludeDecided(e.target.checked)}
            className="rounded border-gray-300 text-blue-600"
          />
          Include reviewed
        </label>
      </div>

      {/* Main review area */}
      {loading ? (
        <div className="text-center py-20 text-gray-400">Loading…</div>
      ) : noMore ? (
        <div className="text-center py-20">
          <p className="text-gray-500 text-lg font-medium">
            {includeDecided
              ? 'No rows match the current score filter.'
              : stats?.pending === 0
                ? '🎉 All rows reviewed!'
                : 'No more rows match the current filter. Try lowering the min score.'}
          </p>
        </div>
      ) : item ? (
        <>
          <div className="flex gap-4 items-stretch">
            {/* Left card (~40%) */}
            <div className={`w-[38%] shrink-0 rounded-xl border-2 p-4 relative transition-colors ${
              confirmedNoMatch ? 'bg-gray-50 border-gray-300' : 'bg-white border-blue-200'
            }`}>
              <span className="absolute top-3 left-3 text-xs font-semibold text-blue-600 uppercase tracking-wide">
                {job.label_left}
              </span>
              {item.display_value && (
                <p className="text-xs text-blue-600 font-medium mt-6 mb-1 truncate">{item.display_value}</p>
              )}
              <p className={`text-sm text-gray-700 leading-relaxed overflow-y-auto max-h-64 ${!item.display_value ? 'mt-6' : ''}`}>
                {item.contextual_content}
              </p>
              {item.is_decided && (
                <span className="absolute bottom-3 right-3 text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">
                  {item.current_decision ? 'matched' : 'no match'}
                </span>
              )}
            </div>

            {/* Right candidates (~60%) */}
            <div className="flex-1 flex gap-3 min-w-0">
              {item.candidates.length === 0 ? (
                <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
                  No candidates found for this row.
                </div>
              ) : (
                item.candidates.map(c => (
                  <CandidateCard
                    key={c.right_id}
                    candidate={{ ...c, __confirmed: confirmedRightId === c.right_id }}
                    isSelected={selectedRightId === c.right_id}
                    onClick={() => handleSelect(c.right_id)}
                  />
                ))
              )}
            </div>
          </div>

          {/* No match + nav */}
          <div className="flex items-center justify-between">
            <button
              onClick={handleNoMatch}
              disabled={saving}
              className={`px-5 py-2 rounded-lg text-sm font-medium border transition-colors
                ${item.is_decided && item.current_decision === null
                  ? 'bg-gray-700 text-white border-gray-700'
                  : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}
            >
              {saving ? '…' : '✕ No match'}
            </button>

            <div className="flex items-center gap-3">
              <button
                onClick={handlePrev}
                disabled={offset === 0}
                className="px-3 py-2 rounded-lg text-sm border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-30"
              >
                ← Prev
              </button>
              <span className="text-xs text-gray-400">row {offset + 1}</span>
              <button
                onClick={handleNext}
                className="px-3 py-2 rounded-lg text-sm border border-gray-200 text-gray-600 hover:bg-gray-50"
              >
                Next →
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}

// ── Export tab ────────────────────────────────────────────────────────────

function ExportTab({ job }) {
  const jobId = job.id
  const [downloading, setDownloading] = useState(null)

  const { data: stats } = useQuery({
    queryKey: ['compare-review-stats', jobId],
    queryFn: () => getReviewStats(jobId),
    refetchInterval: 5000,
  })

  const handleDownload = async (type) => {
    setDownloading(type)
    try {
      await downloadCompareExport(jobId, type, job.name)
    } finally {
      setDownloading(null)
    }
  }

  const pending = stats?.pending ?? null

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-3 gap-4">
          {[
            { label: 'Reviewed', value: stats.reviewed, color: 'text-blue-600' },
            { label: 'Pending', value: stats.pending, color: stats.pending > 0 ? 'text-amber-600' : 'text-gray-400' },
            { label: 'Total Left', value: stats.total_left, color: 'text-gray-700' },
          ].map(s => (
            <div key={s.label} className="bg-white rounded-xl border border-gray-200 p-4 text-center">
              <p className={`text-2xl font-bold ${s.color}`}>{s.value?.toLocaleString() ?? '—'}</p>
              <p className="text-xs text-gray-400 mt-1">{s.label}</p>
            </div>
          ))}
        </div>
      )}

      {/* Export buttons */}
      <div className="space-y-3">
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="font-semibold text-gray-900">Raw Report</h3>
              <p className="text-sm text-gray-500 mt-1">
                All left rows × top-{job.top_k ?? 3} right candidates. One row per pair. Available immediately — no review required.
              </p>
            </div>
            <button
              onClick={() => handleDownload('raw')}
              disabled={downloading === 'raw'}
              className="shrink-0 bg-gray-100 text-gray-700 px-4 py-2 rounded-lg font-medium text-sm hover:bg-gray-200 transition-colors disabled:opacity-40"
            >
              {downloading === 'raw' ? 'Downloading…' : '⬇ Download Raw'}
            </button>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-blue-200 p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="font-semibold text-gray-900">Confirmed Report</h3>
              <p className="text-sm text-gray-500 mt-1">
                3 sheets: Confirmed Matches · Unique {job.label_left} · Unique {job.label_right}.
                {pending != null && pending > 0 && (
                  <span className="ml-1 text-amber-600">
                    {pending} unreviewed rows will export with a blank human-review column.
                  </span>
                )}
              </p>
            </div>
            <button
              onClick={() => handleDownload('confirmed')}
              disabled={downloading === 'confirmed'}
              className="shrink-0 bg-blue-600 text-white px-4 py-2 rounded-lg font-medium text-sm hover:bg-blue-700 transition-colors disabled:opacity-40"
            >
              {downloading === 'confirmed' ? 'Downloading…' : '⬇ Download Confirmed'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Browse tab ─────────────────────────────────────────────────────────────

function BrowseTab({ job }) {
  const jobId = job.id
  const [side, setSide] = useState('all')
  const [expandedRows, setExpandedRows] = useState(new Set())

  const { data, isLoading, isError } = useQuery({
    queryKey: ['compare-browse', jobId, side],
    queryFn: () => browseCompareJob(jobId, { side: side === 'all' ? null : side, limit: 25 }),
    enabled: job.status === 'ready',
  })

  const records = data?.records ?? []
  const total = data?.total ?? 0
  const columns = records.length > 0 ? Object.keys(records[0]) : []

  const toggleRow = (idx) => {
    setExpandedRows(prev => {
      const next = new Set(prev)
      next.has(idx) ? next.delete(idx) : next.add(idx)
      return next
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm text-gray-600">
            Browse raw compare records exactly as stored in Postgres.
          </p>
          <p className="text-xs text-gray-400 mt-0.5">
            Showing {records.length} of {total?.toLocaleString?.() ?? total} {side === 'all' ? 'records' : `${side} records`}
            <span className="ml-2 text-gray-300">·</span>
            <span className="ml-2">click a row to expand</span>
          </p>
        </div>

        <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
          {[
            { id: 'all', label: 'All' },
            { id: 'left', label: job.label_left || 'Left' },
            { id: 'right', label: job.label_right || 'Right' },
          ].map(s => (
            <button
              key={s.id}
              onClick={() => { setSide(s.id); setExpandedRows(new Set()) }}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                side === s.id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading && <p className="text-gray-400">Loading records…</p>}
      {isError && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm">
          Failed to load records.
        </div>
      )}

      {!isLoading && records.length > 0 && (
        <div className="rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="text-sm border-collapse" style={{ minWidth: '100%', tableLayout: 'fixed', width: 'max-content' }}>
              <colgroup>
                {columns.map(col => (
                  <col
                    key={col}
                    style={{
                      width: col === 'id' ? '60px'
                        : col === 'side' ? '70px'
                        : col === 'sheet_name' ? '100px'
                        : col === 'contextual_content' ? '360px'
                        : col === 'embedding' ? '220px'
                        : '160px'
                    }}
                  />
                ))}
              </colgroup>
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  {columns.map(col => (
                    <th
                      key={col}
                      className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap"
                    >
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 bg-white">
                {records.map((record, idx) => {
                  const expanded = expandedRows.has(idx)
                  return (
                    <tr
                      key={record.id ?? idx}
                      onClick={() => toggleRow(idx)}
                      className="hover:bg-blue-50/40 cursor-pointer transition-colors"
                    >
                      {columns.map(col => {
                        const val = record[col]
                        const text = val === null || val === undefined ? '' : String(val)
                        return (
                          <td key={col} className="px-4 py-3 align-top">
                            <span
                              className={`block font-mono text-xs text-gray-700 break-words ${
                                expanded ? 'whitespace-pre-wrap' : 'whitespace-normal line-clamp-5 lens-clamp-5'
                              }`}
                            >
                              {text || <span className="text-gray-300 italic not-italic font-sans">null</span>}
                            </span>
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Config / Stats tab ─────────────────────────────────────────────────────

function ConfigStatsTab({ job }) {
  const jobId = job.id
  const { data, isLoading, isError } = useQuery({
    queryKey: ['compare-config-stats', jobId],
    queryFn: () => getCompareConfigStats(jobId),
    enabled: !!jobId,
    refetchInterval: job.status === 'ready' ? false : 3000,
  })

  const cfg = data?.config
  const stats = data?.stats
  const timings = stats?.timings_ms || null

  const fmtMs = (ms) => (typeof ms === 'number' ? `${ms.toLocaleString()} ms` : '—')
  const fmtNum = (n) => (n == null ? '—' : (typeof n === 'number' ? n.toLocaleString() : String(n)))
  const fmtPct = (v) => (typeof v === 'number' ? `${Math.round(v * 100)}%` : '—')

  const statCard = (label, value) => (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <p className="text-xs text-gray-400 uppercase tracking-widest font-semibold">{label}</p>
      <p className="text-lg font-bold text-gray-900 mt-1">{value ?? '—'}</p>
    </div>
  )

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h2 className="text-lg font-bold text-gray-900">Config</h2>
        <p className="text-sm text-gray-500 mt-1">
          The settings used to build merged text, embed records, and generate candidate matches.
        </p>
      </div>

      {isLoading && <p className="text-gray-400">Loading…</p>}
      {isError && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm">
          Failed to load config/stats.
        </div>
      )}

      {cfg && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white rounded-2xl border border-gray-200 p-5">
            <div className="text-xs text-gray-400 uppercase tracking-widest font-semibold mb-3">Left ({cfg.label_left})</div>
            <div className="space-y-2 text-sm">
              <div className="flex gap-3"><span className="text-gray-400 w-40 shrink-0">Source file</span><span className="font-medium text-gray-900">{cfg.source_filename_left || '—'}</span></div>
              <div className="flex gap-3"><span className="text-gray-400 w-40 shrink-0">Match columns</span><span className="font-medium text-gray-900">{[...(cfg.context_columns_left || []), cfg.content_column_left].filter(Boolean).join(', ') || '—'}</span></div>
              <div className="flex gap-3"><span className="text-gray-400 w-40 shrink-0">Identifier column</span><span className="font-medium text-gray-900">{cfg.display_column_left || '—'}</span></div>
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-gray-200 p-5">
            <div className="text-xs text-gray-400 uppercase tracking-widest font-semibold mb-3">Right ({cfg.label_right})</div>
            <div className="space-y-2 text-sm">
              <div className="flex gap-3"><span className="text-gray-400 w-40 shrink-0">Source file</span><span className="font-medium text-gray-900">{cfg.source_filename_right || '—'}</span></div>
              <div className="flex gap-3"><span className="text-gray-400 w-40 shrink-0">Match columns</span><span className="font-medium text-gray-900">{[...(cfg.context_columns_right || []), cfg.content_column_right].filter(Boolean).join(', ') || '—'}</span></div>
              <div className="flex gap-3"><span className="text-gray-400 w-40 shrink-0">Identifier column</span><span className="font-medium text-gray-900">{cfg.display_column_right || '—'}</span></div>
            </div>
          </div>
        </div>
      )}

      {stats && (
        <>
          <div>
            <h2 className="text-lg font-bold text-gray-900">Stats</h2>
            <p className="text-sm text-gray-500 mt-1">
              Lightweight summary of ingestion + match generation + review progress.
            </p>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {statCard('Left records', stats.records_left?.toLocaleString?.() ?? stats.records_left)}
            {statCard('Right records', stats.records_right?.toLocaleString?.() ?? stats.records_right)}
            {statCard('Match rows', stats.matches_rows?.toLocaleString?.() ?? stats.matches_rows)}
            {statCard('Decisions', stats.decisions?.toLocaleString?.() ?? stats.decisions)}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {statCard('Pending', stats.pending?.toLocaleString?.() ?? stats.pending)}
            {statCard('Candidates/left', stats.candidates_per_left)}
            {statCard('Scoring mode', stats.uses_normalized_rerank ? 'Rerank (0..1)' : 'Cosine (fallback)')}
          </div>

          <div className="bg-white rounded-2xl border border-gray-200 p-5">
            <div className="text-xs text-gray-400 uppercase tracking-widest font-semibold">Cost / volume (rough)</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4 text-sm">
              <div className="space-y-1.5">
                <div className="flex justify-between gap-4"><span className="text-gray-500">Avg chars/left row</span><span className="font-semibold text-gray-900">{stats.avg_chars_left != null ? Math.round(stats.avg_chars_left).toLocaleString() : '—'}</span></div>
                <div className="flex justify-between gap-4"><span className="text-gray-500">Avg chars/right row</span><span className="font-semibold text-gray-900">{stats.avg_chars_right != null ? Math.round(stats.avg_chars_right).toLocaleString() : '—'}</span></div>
                <div className="flex justify-between gap-4"><span className="text-gray-500">Est embed tokens</span><span className="font-semibold text-gray-900">{fmtNum(stats.est_embed_tokens)}</span></div>
              </div>
              <div className="space-y-1.5">
                <div className="flex justify-between gap-4"><span className="text-gray-500">Candidate pairs</span><span className="font-semibold text-gray-900">{fmtNum(timings?.candidate_pairs ?? stats.matches_rows)}</span></div>
                <div className="flex justify-between gap-4"><span className="text-gray-500">Est tokens/pair</span><span className="font-semibold text-gray-900">{fmtNum(stats.est_rerank_pair_tokens)}</span></div>
                <div className="flex justify-between gap-4"><span className="text-gray-500">Rerank enabled</span><span className="font-semibold text-gray-900">{cfg?.rerank_enabled ? 'Yes' : 'No'}</span></div>
              </div>
            </div>
            <p className="text-xs text-gray-400 mt-3">
              Token estimates use a simple heuristic (≈4 chars/token). On Ollama this is compute cost, not billing.
            </p>
          </div>

          <div className="bg-white rounded-2xl border border-gray-200 p-5">
            <div className="text-xs text-gray-400 uppercase tracking-widest font-semibold">Timings (persisted)</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4 text-sm">
              <div className="space-y-1.5">
                <div className="flex justify-between gap-4"><span className="text-gray-500">Ingest left</span><span className="font-semibold text-gray-900">{fmtMs(timings?.ingest_left_ms)}</span></div>
                <div className="flex justify-between gap-4"><span className="text-gray-500">Embed left</span><span className="font-semibold text-gray-900">{fmtMs(timings?.embed_left_ms)}</span></div>
                <div className="flex justify-between gap-4"><span className="text-gray-500">Ingest right</span><span className="font-semibold text-gray-900">{fmtMs(timings?.ingest_right_ms)}</span></div>
                <div className="flex justify-between gap-4"><span className="text-gray-500">Embed right</span><span className="font-semibold text-gray-900">{fmtMs(timings?.embed_right_ms)}</span></div>
              </div>
              <div className="space-y-1.5">
                <div className="flex justify-between gap-4"><span className="text-gray-500">Vector search</span><span className="font-semibold text-gray-900">{fmtMs(timings?.vector_search_ms)}</span></div>
                <div className="flex justify-between gap-4"><span className="text-gray-500">Rerank</span><span className="font-semibold text-gray-900">{fmtMs(timings?.rerank_ms)}</span></div>
                <div className="flex justify-between gap-4"><span className="text-gray-500">Write matches</span><span className="font-semibold text-gray-900">{fmtMs(timings?.write_matches_ms)}</span></div>
                <div className="flex justify-between gap-4"><span className="text-gray-500">Total</span><span className="font-semibold text-gray-900">{fmtMs(timings?.total_ms)}</span></div>
              </div>
            </div>
            {!timings && (
              <p className="text-xs text-gray-400 mt-3">
                Timings will appear after the job is re-run with this version of the server.
              </p>
            )}
          </div>

          <div className="bg-white rounded-2xl border border-gray-200 p-5">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <div className="text-xs text-gray-400 uppercase tracking-widest font-semibold">Best-match score (rank=1)</div>
                <div className="text-sm text-gray-500 mt-1">Min / P50 / P90 / Max</div>
              </div>
              <div className="flex gap-3 text-sm font-semibold text-gray-900">
                <span>{fmtPct(stats.best_score_min)}</span>
                <span className="text-gray-300">·</span>
                <span>{fmtPct(stats.best_score_p50)}</span>
                <span className="text-gray-300">·</span>
                <span>{fmtPct(stats.best_score_p90)}</span>
                <span className="text-gray-300">·</span>
                <span>{fmtPct(stats.best_score_max)}</span>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────

export default function CompareJob() {
  const { jobId } = useParams()
  const [activeTab, setActiveTab] = useState('review')

  const { data: job, isLoading, error } = useQuery({
    queryKey: ['compare-job', jobId],
    queryFn: () => getCompareJob(jobId),
    refetchInterval: (query) => {
      const j = query.state.data
      if (!j) return 3000
      return ['ingesting', 'comparing', 'pending'].includes(j.status) ? 3000 : false
    },
  })

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center text-gray-400">
        Loading…
      </div>
    )
  }

  if (error || !job) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center text-red-500">
        Compare job not found.{' '}
        <Link to="/" className="ml-2 text-blue-600 underline">Go home</Link>
      </div>
    )
  }

  const statusColors = {
    ready: 'bg-emerald-100 text-emerald-700',
    ingesting: 'bg-amber-100 text-amber-700',
    comparing: 'bg-amber-100 text-amber-700',
    pending: 'bg-gray-100 text-gray-500',
    error: 'bg-red-100 text-red-700',
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="w-[90%] mx-auto py-4">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <Link to="/" className="text-sm text-gray-400 hover:text-blue-600">← Home</Link>
                <span className="text-gray-200">/</span>
                <h1 className="text-lg font-bold text-gray-900 truncate">{job.name}</h1>
                <span className={`text-xs font-medium px-2.5 py-0.5 rounded-full ${statusColors[job.status] || 'bg-gray-100 text-gray-500'}`}>
                  {job.status}
                </span>
              </div>
              <p className="text-sm text-gray-500 mt-0.5">
                <span className="font-medium text-gray-700">{job.label_left}</span>
                <span className="mx-2 text-gray-300">vs</span>
                <span className="font-medium text-gray-700">{job.label_right}</span>
                {job.row_count_left != null && (
                  <span className="ml-3 text-gray-400">
                    {job.row_count_left.toLocaleString()} left · {job.row_count_right?.toLocaleString() ?? '?'} right
                  </span>
                )}
              </p>
            </div>

            {/* Tab nav */}
            <div className="flex gap-1 bg-gray-100 rounded-lg p-1 shrink-0">
              {[
                { id: 'review', label: '👁 Review' },
                { id: 'browse', label: '👀 Browse' },
                { id: 'config', label: '⚙️ Config' },
                { id: 'export', label: '⬇ Export' },
              ].map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  disabled={job.status !== 'ready'}
                  className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors disabled:opacity-40
                    ${activeTab === tab.id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="w-[90%] mx-auto py-6">
        {job.status !== 'ready' ? (
          <div className="text-center py-20 text-gray-400">
            <p className="text-lg">
              {job.status === 'error'
                ? `Error: ${job.status_message || 'Something went wrong.'}`
                : `Job is ${job.status}… check back in a moment.`}
            </p>
          </div>
        ) : activeTab === 'review' ? (
          <ReviewTab job={job} />
        ) : activeTab === 'browse' ? (
          <BrowseTab job={job} />
        ) : activeTab === 'config' ? (
          <ConfigStatsTab job={job} />
        ) : (
          <ExportTab job={job} />
        )}
      </div>
    </div>
  )
}

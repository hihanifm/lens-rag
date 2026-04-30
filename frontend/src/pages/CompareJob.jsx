import { useState, useEffect, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getCompareJob,
  getReviewStats,
  getNextReviewItem,
  submitCompareDecision,
  downloadCompareExport,
} from '../api/client'

// ── Helpers ────────────────────────────────────────────────────────────────

function scoreColor(score) {
  if (score >= 0.85) return 'bg-emerald-100 text-emerald-700 border-emerald-200'
  if (score >= 0.60) return 'bg-amber-100 text-amber-700 border-amber-200'
  return 'bg-gray-100 text-gray-500 border-gray-200'
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
  const score = candidate.rerank_score ?? candidate.cosine_score ?? 0
  const isConfirmed = Boolean(candidate.__confirmed)
  return (
    <button
      onClick={onClick}
      className={`relative flex-1 text-left rounded-xl border-2 p-4 transition-all cursor-pointer
        ${isConfirmed ? 'bg-emerald-50' : 'bg-white'}
        ${scoreBorder(score, isSelected, isConfirmed)}`}
    >
      {/* Score badge */}
      <span className={`absolute top-3 right-3 text-xs font-semibold px-2 py-0.5 rounded-full border ${scoreColor(score)}`}>
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
    } catch (e) {
      if (e?.response?.status === 404) {
        setNoMore(true)
        setItem(null)
      }
    } finally {
      setLoading(false)
    }
  }, [jobId, minScore, includeDecided])

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
        ) : (
          <ExportTab job={job} />
        )}
      </div>
    </div>
  )
}

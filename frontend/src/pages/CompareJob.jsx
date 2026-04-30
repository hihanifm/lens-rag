import { useState, useEffect, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getCompareJob,
  updateCompareJob,
  listRuns,
  createRun,
  deleteRun,
  getRunReviewStats,
  getNextRunReviewItem,
  submitRunDecision,
  downloadRunExport,
  browseCompareJob,
  browseRunRaw,
  getCompareConfigStats,
  getSystemConfig,
  fetchModels,
  API_BASE_URL,
} from '../api/client'

/** Defaults for LLM judge (OpenAI-compatible chat). */
const LLM_PRESET_OLLAMA = {
  url: 'http://host.docker.internal:11434/v1',
  model: 'llama3.2:3b',
}
const LLM_PRESET_OPENAI = {
  url: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
}

// ── Score helpers ──────────────────────────────────────────────────────────

function fmtPct01(v, digits = 0) {
  if (typeof v !== 'number' || v < 0 || v > 1) return '—'
  return `${(v * 100).toFixed(digits)}%`
}

function fmtMaybeNumber(v, digits = 3) {
  if (typeof v !== 'number' || Number.isNaN(v)) return '—'
  return v.toFixed(digits)
}

function isNormalized01(v) {
  return typeof v === 'number' && v >= 0 && v <= 1
}

function primaryScore(candidate) {
  const f = candidate?.final_score
  if (typeof f === 'number') return f
  const r = candidate?.rerank_score
  if (isNormalized01(r)) return r
  return candidate?.cosine_score ?? 0
}

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

// ── Candidate card ─────────────────────────────────────────────────────────

function CandidateCard({ candidate, isSelected, isSaved, onClick }) {
  const score = primaryScore(candidate)
  const cosine = candidate?.cosine_score
  const rerank = candidate?.rerank_score
  const llm = candidate?.llm_score
  const rerankIsNorm = isNormalized01(rerank)
  const llmIsNorm = isNormalized01(llm)

  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative flex-1 text-left rounded-xl border-2 p-4 transition-all cursor-pointer
        ${isSaved ? 'bg-emerald-50' : 'bg-white'}
        ${scoreBorder(score, isSelected, isSaved)}`}
    >
      {/* Score badges */}
      <div className="absolute top-3 right-3 flex items-center justify-end gap-1 flex-wrap max-w-[70%]">
        <span className="inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded-full border bg-white text-gray-700 border-gray-200 whitespace-nowrap">
          C {fmtPct01(cosine, 0)}
        </span>
        {rerank != null && (
          <span
            className={`inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap ${
              rerankIsNorm ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-gray-50 text-gray-600 border-gray-200'
            }`}
          >
            R {rerankIsNorm ? fmtPct01(rerank, 1) : fmtMaybeNumber(rerank)}
          </span>
        )}
        {llm != null && (
          <span
            className={`inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap ${
              llmIsNorm ? 'bg-purple-50 text-purple-700 border-purple-200' : 'bg-gray-50 text-gray-600 border-gray-200'
            }`}
          >
            LLM {llmIsNorm ? fmtPct01(llm, 1) : fmtMaybeNumber(llm)}
          </span>
        )}
      </div>

      {/* Rank badge */}
      <span className="absolute top-3 left-3 text-xs text-gray-400 font-medium">
        #{candidate.rank}
      </span>

      {candidate.display_value && (
        <p className="text-xs text-blue-600 font-medium mt-10 mb-1 truncate">{candidate.display_value}</p>
      )}
      <p className={`text-sm text-gray-700 leading-relaxed overflow-y-auto max-h-48 ${!candidate.display_value ? 'mt-10' : ''}`}>
        {candidate.contextual_content}
      </p>

      {(isSaved || isSelected) && (
        <div className={`absolute bottom-3 right-3 text-white text-xs px-2 py-0.5 rounded-full font-medium ${isSaved ? 'bg-emerald-600' : 'bg-blue-600'}`}>
          {isSaved ? '✓ Saved' : '✓ Selected'}
        </div>
      )}
    </button>
  )
}

// ── Review tab ────────────────────────────────────────────────────────────

function ReviewTab({ job, run }) {
  const jobId = job.id
  const runId = run.id
  const queryClient = useQueryClient()

  const [minScore, setMinScore] = useState(0)
  const [offset, setOffset] = useState(0)
  const [rowsShown, setRowsShown] = useState(3)
  const [items, setItems] = useState([])
  const [activeIdx, setActiveIdx] = useState(0)
  const [loading, setLoading] = useState(false)
  const [noMore, setNoMore] = useState(false)
  const [selectedByLeft, setSelectedByLeft] = useState(() => new Map())
  const [savingLeftId, setSavingLeftId] = useState(null)
  const [rowStartedAt, setRowStartedAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())

  const { data: stats, refetch: refetchStats } = useQuery({
    queryKey: ['run-review-stats', jobId, runId],
    queryFn: () => getRunReviewStats(jobId, runId),
    refetchInterval: false,
  })

  const fetchPage = useCallback(async (newOffset) => {
    setLoading(true)
    setNoMore(false)
    try {
      const start = newOffset * rowsShown
      const reqs = Array.from({ length: rowsShown }, (_, i) =>
        getNextRunReviewItem(jobId, runId, { minScore, offset: start + i, includeDecided: true })
      )
      const results = await Promise.allSettled(reqs)
      const pageItems = results.map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean)

      if (pageItems.length === 0) {
        setNoMore(true)
        setItems([])
        return
      }

      setItems(pageItems)
      setActiveIdx(0)
      setSelectedByLeft(() => {
        const m = new Map()
        for (const it of pageItems) m.set(it.left_id, it.current_decision ?? null)
        return m
      })
      setOffset(newOffset)
      setRowStartedAt(Date.now())
    } catch (e) {
      if (e?.response?.status === 404) {
        setNoMore(true)
        setItems([])
      }
    } finally {
      setLoading(false)
    }
  }, [jobId, runId, minScore, rowsShown])

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => { fetchPage(0) }, [minScore, rowsShown])

  const handleSelect = async (leftId, rightId) => {
    if (savingLeftId != null) return
    setSelectedByLeft(prev => { const m = new Map(prev); m.set(leftId, rightId); return m })
    setSavingLeftId(leftId)
    try {
      await submitRunDecision(jobId, runId, leftId, rightId)
      refetchStats()
      queryClient.invalidateQueries({ queryKey: ['compare-jobs'] })
      setItems(prev => prev.map(it => it.left_id === leftId ? { ...it, is_decided: true, current_decision: rightId } : it))
    } finally {
      setSavingLeftId(null)
    }
  }

  const handleNoMatch = async (leftId) => {
    if (savingLeftId != null) return
    setSelectedByLeft(prev => { const m = new Map(prev); m.set(leftId, null); return m })
    setSavingLeftId(leftId)
    try {
      await submitRunDecision(jobId, runId, leftId, null)
      refetchStats()
      queryClient.invalidateQueries({ queryKey: ['compare-jobs'] })
      setItems(prev => prev.map(it => it.left_id === leftId ? { ...it, is_decided: true, current_decision: null } : it))
    } finally {
      setSavingLeftId(null)
    }
  }

  const handlePrev = useCallback(() => {
    if (savingLeftId != null || loading || offset === 0) return
    fetchPage(offset - 1)
  }, [savingLeftId, loading, offset, fetchPage])

  const handleNext = useCallback(() => {
    if (savingLeftId != null || loading) return
    fetchPage(offset + 1)
  }, [savingLeftId, loading, offset, fetchPage])

  useEffect(() => {
    const onKeyDown = (e) => {
      if (savingLeftId != null || loading || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return
      const tag = document.activeElement?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement?.isContentEditable) return
      if (e.key === 'x' || e.key === 'X') { e.preventDefault(); const it = items?.[activeIdx]; if (it) handleNoMatch(it.left_id); return }
      if (e.key === 'ArrowLeft' && offset > 0) { e.preventDefault(); handlePrev() }
      if (e.key === 'ArrowRight') { e.preventDefault(); handleNext() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [offset, savingLeftId, loading, activeIdx, items, handlePrev, handleNext, handleNoMatch])

  return (
    <div className="space-y-4">
      {/* Top bar */}
      <div className="flex flex-wrap items-center gap-4 bg-white border border-gray-200 rounded-xl px-4 py-3">
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
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-500 whitespace-nowrap">Rows shown</label>
          <select
            value={rowsShown}
            onChange={e => setRowsShown(parseInt(e.target.value, 10))}
            className="text-sm border border-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-300"
          >
            {[1, 3, 5].map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
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
      </div>

      {loading ? (
        <div className="text-center py-20 text-gray-400">Loading…</div>
      ) : noMore ? (
        <div className="text-center py-20">
          <p className="text-gray-500 text-lg font-medium">
            {stats?.pending === 0
              ? '🎉 All rows reviewed!'
              : 'No more rows match the current filter. Try lowering the min score.'}
          </p>
        </div>
      ) : items.length > 0 ? (
        <>
          <div className="space-y-4">
            {items.map((it, idx) => {
              const isActive = idx === activeIdx
              const selectedRightId = selectedByLeft.get(it.left_id) ?? null
              const isSaving = savingLeftId === it.left_id
              return (
                <div
                  key={it.left_id}
                  onClick={() => setActiveIdx(idx)}
                  className={`rounded-2xl p-3 border transition-colors ${isActive ? 'border-blue-300 bg-blue-50/30' : 'border-transparent'}`}
                >
                  <div className="flex gap-4 items-stretch">
                    <div className="w-[38%] shrink-0 bg-white rounded-xl border-2 border-blue-200 p-4 relative">
                      <span className="absolute top-3 left-3 text-xs font-semibold text-blue-600 uppercase tracking-wide">
                        {job.label_left} · row {offset * rowsShown + idx + 1}
                      </span>
                      {it.display_value && (
                        <p className="text-xs text-blue-600 font-medium mt-6 mb-1 truncate">{it.display_value}</p>
                      )}
                      <p className={`text-sm text-gray-700 leading-relaxed overflow-y-auto max-h-64 ${!it.display_value ? 'mt-6' : ''}`}>
                        {it.contextual_content}
                      </p>
                      {it.is_decided && (
                        <span className="absolute bottom-3 right-3 text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">
                          {it.current_decision ? 'matched' : 'no match'}
                        </span>
                      )}
                    </div>
                    <div className="flex-1 flex gap-3 min-w-0">
                      {it.candidates.length === 0 ? (
                        <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
                          No candidates found for this row.
                        </div>
                      ) : (
                        [...it.candidates]
                          .sort((a, b) => primaryScore(b) - primaryScore(a))
                          .map(c => (
                            <CandidateCard
                              key={c.right_id}
                              candidate={c}
                              isSelected={selectedRightId === c.right_id}
                              isSaved={it.is_decided && it.current_decision === c.right_id}
                              onClick={() => handleSelect(it.left_id, c.right_id)}
                            />
                          ))
                      )}
                    </div>
                  </div>
                  <div className="mt-3 flex items-center justify-between">
                    <button
                      type="button"
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleNoMatch(it.left_id) }}
                      disabled={isSaving || savingLeftId != null}
                      className={`px-5 py-2 rounded-lg text-sm font-medium border transition-colors
                        ${it.is_decided && it.current_decision === null
                          ? 'bg-rose-600 text-white border-rose-600'
                          : 'bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100 hover:border-rose-300'} disabled:opacity-40`}
                    >
                      {isSaving ? '…' : '✕ No match'} <span className="ml-1 text-xs opacity-70">(X)</span>
                    </button>
                    {isActive && <div className="text-xs text-gray-400">Active</div>}
                  </div>
                </div>
              )
            })}
          </div>
          <div className="flex items-center justify-end">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handlePrev}
                disabled={offset === 0 || savingLeftId != null || loading}
                className="px-3 py-2 rounded-lg text-sm border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-30"
              >
                ← Prev
              </button>
              <span className="text-xs text-gray-400">page {offset + 1}</span>
              <button
                type="button"
                onClick={handleNext}
                disabled={savingLeftId != null || loading}
                className="px-3 py-2 rounded-lg text-sm border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-30"
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

function ExportTab({ job, run }) {
  const jobId = job.id
  const runId = run.id
  const [downloading, setDownloading] = useState(null)

  const { data: stats } = useQuery({
    queryKey: ['run-review-stats', jobId, runId],
    queryFn: () => getRunReviewStats(jobId, runId),
    refetchInterval: 5000,
  })

  const handleDownload = async (type) => {
    setDownloading(type)
    try {
      await downloadRunExport(jobId, runId, type, job.name)
    } finally {
      setDownloading(null)
    }
  }

  const pending = stats?.pending ?? null

  return (
    <div className="space-y-6 max-w-2xl">
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
      <div className="space-y-3">
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="font-semibold text-gray-900">Raw Report</h3>
              <p className="text-sm text-gray-500 mt-1">
                All left rows × top-{run.top_k ?? 3} right candidates. One row per pair. Available immediately.
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
          <p className="text-sm text-gray-600">Browse embedded records as stored in Postgres.</p>
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
                  <col key={col} style={{
                    width: col === 'id' ? '60px' : col === 'side' ? '70px' : col === 'sheet_name' ? '100px'
                      : col === 'contextual_content' ? '360px' : col === 'embedding' ? '220px' : '160px'
                  }} />
                ))}
              </colgroup>
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  {columns.map(col => (
                    <th key={col} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 bg-white">
                {records.map((record, idx) => {
                  const expanded = expandedRows.has(idx)
                  return (
                    <tr key={record.id ?? idx} onClick={() => toggleRow(idx)} className="hover:bg-blue-50/40 cursor-pointer transition-colors">
                      {columns.map(col => {
                        const val = record[col]
                        const text = val === null || val === undefined ? '' : String(val)
                        return (
                          <td key={col} className="px-4 py-3 align-top">
                            <span className={`block font-mono text-xs text-gray-700 break-words ${expanded ? 'whitespace-pre-wrap' : 'whitespace-normal line-clamp-5 lens-clamp-5'}`}>
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
  const queryClient = useQueryClient()
  const { data, isLoading, isError } = useQuery({
    queryKey: ['compare-config-stats', jobId],
    queryFn: () => getCompareConfigStats(jobId),
    enabled: !!jobId,
    refetchInterval: job.status === 'ready' ? false : 3000,
  })

  const cfg = data?.config
  const stats = data?.stats
  const timings = stats?.timings_ms || null

  const [editName, setEditName] = useState(job.name || '')
  const [editNotes, setEditNotes] = useState('')
  const [notesExpanded, setNotesExpanded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  useEffect(() => { setEditName(job.name || '') }, [job.name])
  useEffect(() => { setEditNotes(cfg?.notes ?? '') }, [cfg?.notes])
  useEffect(() => { if (!editNotes) setNotesExpanded(false) }, [editNotes])

  const onSave = async () => {
    setSaving(true)
    setSaveError('')
    try {
      await updateCompareJob(jobId, { name: editName.trim(), notes: editNotes })
      await queryClient.invalidateQueries({ queryKey: ['compare-job', String(jobId)] })
      await queryClient.invalidateQueries({ queryKey: ['compare-config-stats', String(jobId)] })
    } catch (e) {
      setSaveError(e?.response?.data?.detail || e.message || 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const fmtMs = (ms) => (typeof ms === 'number' ? `${ms.toLocaleString()} ms` : '—')
  const fmtNum = (n) => (n == null ? '—' : (typeof n === 'number' ? n.toLocaleString() : String(n)))

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h2 className="text-lg font-bold text-gray-900">Config</h2>
        <p className="text-sm text-gray-500 mt-1">Embedding model and column settings locked at job creation.</p>
      </div>

      {isLoading && <p className="text-gray-400">Loading…</p>}
      {isError && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm">Failed to load config/stats.</div>
      )}

      {cfg && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white rounded-2xl border border-gray-200 p-5 lg:col-span-2">
            <div className="text-xs text-gray-400 uppercase tracking-widest font-semibold mb-3">Editable</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Job name</label>
                <input
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
                />
              </div>
              <div>
                <div className="flex items-center justify-between gap-3 mb-1">
                  <label className="block text-sm font-medium text-gray-700">Findings / notes</label>
                  <button type="button" onClick={() => setNotesExpanded(v => !v)} className="text-xs text-blue-600 hover:text-blue-700 font-medium">
                    {notesExpanded ? 'Collapse' : (editNotes ? 'Expand' : 'Add')}
                  </button>
                </div>
                <textarea
                  value={editNotes}
                  onChange={e => setEditNotes(e.target.value)}
                  rows={notesExpanded ? 5 : 2}
                  placeholder="Quick findings…"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
                />
              </div>
            </div>
            {saveError && <div className="text-sm text-red-600 mt-3">{saveError}</div>}
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={onSave}
                disabled={saving || !editName.trim()}
                className="bg-blue-600 text-white px-4 py-2 rounded-lg font-medium text-sm hover:bg-blue-700 disabled:opacity-40 transition-colors"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-gray-200 p-5 lg:col-span-2">
            <div className="text-xs text-gray-400 uppercase tracking-widest font-semibold mb-3">Embedding model / endpoint</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div className="space-y-2">
                <div className="flex gap-3"><span className="text-gray-400 w-40 shrink-0">Embedding URL</span><span className="font-medium text-gray-900 break-words">{cfg.embed_url || 'system default'}</span></div>
                <div className="flex gap-3"><span className="text-gray-400 w-40 shrink-0">Embedding model</span><span className="font-medium text-gray-900 break-words">{cfg.embed_model || 'system default'}</span></div>
                <div className="flex gap-3"><span className="text-gray-400 w-40 shrink-0">Embedding dims</span><span className="font-medium text-gray-900">{cfg.embed_dims ?? '—'}</span></div>
              </div>
              <div className="space-y-2">
                <div className="flex gap-3"><span className="text-gray-400 w-40 shrink-0">Schema</span><span className="font-medium text-gray-900 font-mono">{cfg.schema_name}</span></div>
                <div className="flex gap-3"><span className="text-gray-400 w-40 shrink-0">Created</span><span className="font-medium text-gray-900">{cfg.created_at ? new Date(cfg.created_at).toLocaleDateString() : '—'}</span></div>
              </div>
            </div>
          </div>

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
            <h2 className="text-lg font-bold text-gray-900">Embedding Stats</h2>
            <p className="text-sm text-gray-500 mt-1">Record counts and embedding costs. Match/decision stats are per-run.</p>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              ['Left records', fmtNum(stats.records_left)],
              ['Right records', fmtNum(stats.records_right)],
              ['Avg chars / left', stats.avg_chars_left != null ? Math.round(stats.avg_chars_left).toLocaleString() : '—'],
              ['Est embed tokens', fmtNum(stats.est_embed_tokens)],
            ].map(([label, val]) => (
              <div key={label} className="bg-white rounded-xl border border-gray-200 p-4">
                <p className="text-xs text-gray-400 uppercase tracking-widest font-semibold">{label}</p>
                <p className="text-lg font-bold text-gray-900 mt-1">{val ?? '—'}</p>
              </div>
            ))}
          </div>

          {timings && (
            <div className="bg-white rounded-2xl border border-gray-200 p-5">
              <div className="text-xs text-gray-400 uppercase tracking-widest font-semibold mb-3">Embedding timings</div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                <div className="space-y-1.5">
                  <div className="flex justify-between gap-4"><span className="text-gray-500">Ingest left</span><span className="font-semibold text-gray-900">{fmtMs(timings.ingest_left_ms)}</span></div>
                  <div className="flex justify-between gap-4"><span className="text-gray-500">Embed left</span><span className="font-semibold text-gray-900">{fmtMs(timings.embed_left_ms)}</span></div>
                </div>
                <div className="space-y-1.5">
                  <div className="flex justify-between gap-4"><span className="text-gray-500">Ingest right</span><span className="font-semibold text-gray-900">{fmtMs(timings.ingest_right_ms)}</span></div>
                  <div className="flex justify-between gap-4"><span className="text-gray-500">Embed right</span><span className="font-semibold text-gray-900">{fmtMs(timings.embed_right_ms)}</span></div>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── New Run Modal ──────────────────────────────────────────────────────────

function NewRunModal({ onClose, onCreated }) {
  const [name, setName] = useState('')
  const [topK, setTopK] = useState(3)
  const [rerankerEnabled, setRerankerEnabled] = useState(false)
  const [rerankerModel, setRerankerModel] = useState('')
  const [rerankerUrl, setRerankerUrl] = useState('')
  const [llmEnabled, setLlmEnabled] = useState(false)
  const [llmUrl, setLlmUrl] = useState('')
  const [llmModel, setLlmModel] = useState('')
  const [llmApiKey, setLlmApiKey] = useState('')
  const [llmPrompt, setLlmPrompt] = useState('')
  const [llmModelOptions, setLlmModelOptions] = useState([])
  const [llmModelsLoading, setLlmModelsLoading] = useState(false)
  const [llmModelsError, setLlmModelsError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    getSystemConfig()
      .then((cfg) => {
        if (cancelled || !cfg?.embedding_url) return
        if (cfg.embedding_provider === 'ollama') {
          setLlmUrl((u) => (u.trim() ? u : cfg.embedding_url))
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!llmModelOptions.length) return
    setLlmModel((m) => (llmModelOptions.includes(m) ? m : llmModelOptions[0]))
  }, [llmModelOptions])

  const handleFetchLlmModels = async () => {
    const url = llmUrl.trim()
    if (!url) {
      setLlmModelsError('Enter an endpoint URL first.')
      return
    }
    setLlmModelsError('')
    setLlmModelsLoading(true)
    try {
      const models = await fetchModels(url, llmApiKey.trim() || undefined)
      const ids = Array.isArray(models) ? models.filter(Boolean) : []
      if (ids.length === 0) {
        setLlmModelOptions([])
        setLlmModelsError('Endpoint returned no models.')
        return
      }
      setLlmModelOptions(ids)
      setLlmModel((prev) => {
        const p = prev.trim()
        if (p && ids.includes(p)) return p
        return ids[0]
      })
    } catch (e) {
      setLlmModelOptions([])
      setLlmModelsError(
        e?.response?.data?.detail || e?.message || 'Could not list models. Check URL and API key (OpenAI).'
      )
    } finally {
      setLlmModelsLoading(false)
    }
  }

  const handleCreate = async () => {
    setSubmitting(true)
    setError('')
    try {
      const data = {
        name: name.trim() || null,
        top_k: topK,
        vector_enabled: true,
        reranker_enabled: rerankerEnabled,
        reranker_model: rerankerEnabled && rerankerModel.trim() ? rerankerModel.trim() : null,
        reranker_url: rerankerEnabled && rerankerUrl.trim() ? rerankerUrl.trim() : null,
        llm_judge_enabled: llmEnabled,
        llm_judge_url: llmEnabled && llmUrl.trim() ? llmUrl.trim() : null,
        llm_judge_model: llmEnabled && llmModel.trim() ? llmModel.trim() : null,
        llm_judge_prompt: llmEnabled && llmPrompt.trim() ? llmPrompt.trim() : null,
      }
      const run = await onCreated(data)
      if (!run) return
    } catch (e) {
      setError(e?.response?.data?.detail || e.message || 'Failed to create run')
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
        <div className="px-6 pt-6 pb-4 border-b border-gray-100">
          <h2 className="text-lg font-bold text-gray-900">New Run</h2>
          <p className="text-sm text-gray-500 mt-1">Configure the pipeline for this run. Uses embedded data already stored for this job.</p>
        </div>

        <div className="px-6 py-5 space-y-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Run name <span className="text-gray-400 font-normal">(optional)</span></label>
            <input
              autoFocus
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. with reranker v2"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Top-K candidates per left row</label>
            <input
              type="number"
              min={1}
              max={20}
              value={topK}
              onChange={e => setTopK(Math.max(1, Math.min(20, parseInt(e.target.value) || 1)))}
              className="w-32 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
            />
          </div>

          {/* Reranker section */}
          <div className="rounded-xl border border-gray-200 p-4 space-y-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={rerankerEnabled}
                onChange={e => setRerankerEnabled(e.target.checked)}
                className="rounded border-gray-300 text-blue-600"
              />
              <span className="text-sm font-medium text-gray-700">Enable reranker</span>
            </label>
            {rerankerEnabled && (
              <div className="space-y-3 pl-6">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Model <span className="text-gray-400 font-normal">(blank = server default)</span></label>
                  <input
                    type="text"
                    value={rerankerModel}
                    onChange={e => setRerankerModel(e.target.value)}
                    placeholder="e.g. bbjson/bge-reranker-base:latest"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Endpoint URL <span className="text-gray-400 font-normal">(blank = server default)</span></label>
                  <input
                    type="text"
                    value={rerankerUrl}
                    onChange={e => setRerankerUrl(e.target.value)}
                    placeholder="e.g. http://host.docker.internal:11434/v1"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
                  />
                </div>
              </div>
            )}
          </div>

          {/* LLM Judge section */}
          <div className="rounded-xl border border-gray-200 p-4 space-y-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={llmEnabled}
                onChange={e => setLlmEnabled(e.target.checked)}
                className="rounded border-gray-300 text-purple-600"
              />
              <span className="text-sm font-medium text-gray-700">Enable LLM judge</span>
              <span className="text-xs text-gray-400">(stacks on top of reranker)</span>
            </label>
            {llmEnabled && (
              <div className="space-y-3 pl-6">
                <div>
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                    <label className="block text-xs font-medium text-gray-600">
                      Endpoint URL <span className="text-red-500">*</span>
                    </label>
                    <div className="flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          setLlmUrl(LLM_PRESET_OLLAMA.url)
                          setLlmModel(LLM_PRESET_OLLAMA.model)
                          setLlmApiKey('')
                          setLlmModelOptions([])
                          setLlmModelsError('')
                        }}
                        className="text-xs px-2 py-0.5 rounded-md border border-gray-200 bg-gray-50 text-gray-700 hover:bg-gray-100"
                      >
                        Ollama
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setLlmUrl(LLM_PRESET_OPENAI.url)
                          setLlmModel(LLM_PRESET_OPENAI.model)
                          setLlmModelOptions([])
                          setLlmModelsError('')
                        }}
                        className="text-xs px-2 py-0.5 rounded-md border border-gray-200 bg-gray-50 text-gray-700 hover:bg-gray-100"
                      >
                        OpenAI
                      </button>
                    </div>
                  </div>
                  <input
                    type="text"
                    value={llmUrl}
                    onChange={e => setLlmUrl(e.target.value)}
                    placeholder="e.g. http://host.docker.internal:11434/v1"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300"
                  />
                  <p className="text-[11px] text-gray-400 mt-1">
                    Ollama preset uses Docker→host; use <span className="font-mono">localhost</span> only if the API is reachable from the LENS backend container.
                  </p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    API key <span className="text-gray-400 font-normal">(optional — for listing OpenAI models)</span>
                  </label>
                  <input
                    type="password"
                    autoComplete="off"
                    value={llmApiKey}
                    onChange={e => setLlmApiKey(e.target.value)}
                    placeholder="sk-… only if using OpenAI /v1/models"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300"
                  />
                </div>
                <div>
                  <div className="flex flex-wrap items-end gap-2 mb-1">
                    <label className="block text-xs font-medium text-gray-600 flex-1 min-w-[8rem]">
                      Model <span className="text-red-500">*</span>
                    </label>
                    <button
                      type="button"
                      onClick={handleFetchLlmModels}
                      disabled={llmModelsLoading || !llmUrl.trim()}
                      className="text-xs shrink-0 px-2.5 py-1 rounded-md border border-purple-200 bg-purple-50 text-purple-800 hover:bg-purple-100 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {llmModelsLoading ? 'Fetching…' : 'Fetch models'}
                    </button>
                  </div>
                  {llmModelOptions.length > 0 ? (
                    <>
                      <select
                        value={llmModel}
                        onChange={(e) => setLlmModel(e.target.value)}
                        className="w-full max-w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-purple-300"
                        size={1}
                      >
                        {llmModelOptions.map((id) => (
                          <option key={id} value={id}>
                            {id}
                          </option>
                        ))}
                      </select>
                      <p className="text-[11px] text-gray-500 mt-1">
                        {llmModelOptions.length} model{llmModelOptions.length !== 1 ? 's' : ''} from endpoint. Fetch again after changing URL or API key.
                      </p>
                    </>
                  ) : (
                    <input
                      type="text"
                      value={llmModel}
                      onChange={(e) => setLlmModel(e.target.value)}
                      placeholder="e.g. llama3.2:3b or gpt-4o-mini — use Fetch models to list"
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300"
                    />
                  )}
                  {llmModelsError && <p className="text-xs text-red-600 mt-1">{llmModelsError}</p>}
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    System prompt <span className="text-gray-400 font-normal">(blank = server default)</span>
                  </label>
                  <textarea
                    value={llmPrompt}
                    onChange={e => setLlmPrompt(e.target.value)}
                    rows={4}
                    placeholder={'Leave blank to use the default prompt:\n"Rate how well the right record matches the left record on a scale 0.0–1.0. Reply only with JSON: {\"score\": <float>}"'}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300"
                  />
                </div>
              </div>
            )}
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <div className="px-6 pb-6 flex gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="flex-1 border border-gray-200 text-gray-600 py-2.5 rounded-lg font-medium text-sm hover:bg-gray-50 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={submitting || (llmEnabled && (!llmUrl.trim() || !llmModel.trim()))}
            className="flex-1 bg-blue-600 text-white py-2.5 rounded-lg font-medium text-sm hover:bg-blue-700 disabled:opacity-40 transition-colors"
          >
            {submitting ? 'Creating…' : 'Create & Execute'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Run execute progress ────────────────────────────────────────────────────

const RUN_PHASE_ORDER = ['vector_search', 'reranking', 'llm_judge', 'complete']

function normalizeRunProgressType(t) {
  if (t === 'searching') return 'vector_search'
  if (t === 'llm_judging') return 'llm_judge'
  return t
}

function runPhaseIndex(t) {
  const i = RUN_PHASE_ORDER.indexOf(t)
  return i >= 0 ? i : -1
}

function RunProgressView({ jobId, runId, onDone }) {
  const [events, setEvents] = useState([])
  const [done, setDone] = useState(false)
  const [error, setError] = useState(null)
  const [startedAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (done) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [done])

  useEffect(() => {
    const es = new EventSource(`${API_BASE_URL}/compare/${jobId}/runs/${runId}/execute`)
    es.onmessage = (e) => {
      const raw = JSON.parse(e.data)
      const data = { ...raw, type: normalizeRunProgressType(raw.type) }
      setEvents(prev => {
        const last = prev[prev.length - 1]
        if (last && last.type === data.type) return [...prev.slice(0, -1), data]
        return [...prev, data]
      })
      if (data.type === 'complete') { setDone(true); es.close(); setTimeout(onDone, 1200) }
      if (data.type === 'error') { setError(data.message || 'Run failed'); es.close() }
    }
    es.onerror = () => { setError('Connection lost'); es.close() }
    return () => es.close()
  }, [jobId, runId])

  const stages = [
    { type: 'vector_search', label: 'Vector search' },
    { type: 'reranking',     label: 'Reranking' },
    { type: 'llm_judge',     label: 'LLM judge' },
    { type: 'complete',      label: 'Done' },
  ]

  const current = events[events.length - 1]
  const currentType = current?.type
  const curOrd = runPhaseIndex(currentType)
  const elapsedSec = Math.max(0, Math.floor((now - startedAt) / 1000))
  const elapsed = elapsedSec >= 60 ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s` : `${elapsedSec}s`

  const activeStages = stages.filter(s =>
    s.type === 'complete' ||
    s.type === 'vector_search' ||
    events.some(ev => ev.type === s.type) ||
    s.type === currentType
  )

  const activePct = typeof current?.percent === 'number' ? current.percent : null
  const showBar = activePct != null && currentType && currentType !== 'complete' && currentType !== 'error'

  return (
    <div className="space-y-4 py-4">
      <div className="flex items-baseline justify-between gap-4">
        <p className="text-sm font-semibold text-gray-700">Executing run…</p>
        <span className="text-xs text-gray-400">Elapsed: {elapsed}</span>
      </div>
      <p className="text-xs text-gray-500 -mt-2">
        Navigating away does not cancel this run — it keeps executing on the server. Open this run again to watch progress or wait until it shows <span className="font-medium text-gray-600">ready</span> in the runs list.
      </p>

      {showBar && (
        <div className="space-y-1">
          <div className="h-2 bg-gray-100 rounded-full overflow-hidden border border-gray-200">
            <div
              className="h-full bg-blue-500 transition-[width] duration-300 ease-out rounded-full"
              style={{ width: `${Math.min(100, Math.max(0, activePct))}%` }}
            />
          </div>
          {current?.message && (
            <p className="text-xs text-gray-600 truncate font-mono" title={current.message}>
              {current.message}
            </p>
          )}
        </div>
      )}

      <div className="space-y-2">
        {activeStages.map(stage => {
          const stOrd = runPhaseIndex(stage.type)
          const isActive = currentType === stage.type
          const isDone = done || (curOrd >= 0 && stOrd >= 0 && stOrd < curOrd)
          const lastForStage = [...events].reverse().find(ev => ev.type === stage.type)

          return (
            <div key={stage.type} className={`flex flex-col gap-1 px-4 py-2.5 rounded-lg border text-sm
              ${isDone ? 'bg-emerald-50 border-emerald-200' : isActive ? 'bg-blue-50 border-blue-200' : 'bg-gray-50 border-gray-200'}`}
            >
              <div className="flex items-center gap-3">
                <span className="shrink-0 w-4 text-center">
                  {isDone ? '✓' : isActive ? (
                    <svg className="animate-spin h-3.5 w-3.5 text-blue-600 inline" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  ) : '○'}
                </span>
                <p className={`font-medium flex-1 min-w-0 ${isDone ? 'text-emerald-700' : isActive ? 'text-blue-700' : 'text-gray-400'}`}>
                  {stage.label}
                  {isActive && lastForStage?.processed != null && lastForStage?.total != null && (
                    <span className="ml-2 font-normal text-xs text-gray-600 whitespace-nowrap">
                      {lastForStage.processed.toLocaleString()} / {lastForStage.total.toLocaleString()}
                      {typeof lastForStage.percent === 'number' ? ` (${lastForStage.percent}%)` : ''}
                    </span>
                  )}
                </p>
              </div>
              {isActive && lastForStage?.message && !showBar && (
                <p className="text-xs text-gray-600 font-mono truncate pl-7" title={lastForStage.message}>
                  {lastForStage.message}
                </p>
              )}
            </div>
          )
        })}
      </div>
      {error && <p className="text-red-500 text-sm">{error}</p>}
    </div>
  )
}

// ── Run detail panel ────────────────────────────────────────────────────────

function RunDetailPanel({ job, run, onBack, onRunComplete }) {
  const [subTab, setSubTab] = useState('review')
  const [executing, setExecuting] = useState(run.status === 'pending' || run.status === 'running')

  const statusColors = {
    ready: 'bg-emerald-100 text-emerald-700',
    pending: 'bg-amber-100 text-amber-700',
    running: 'bg-blue-100 text-blue-700',
    error: 'bg-red-100 text-red-700',
  }

  const pipelineBadges = []
  if (run.vector_enabled !== false) pipelineBadges.push('Vector')
  if (run.reranker_enabled) pipelineBadges.push(`Rerank${run.reranker_model ? ': ' + run.reranker_model.split('/').pop() : ''}`)
  if (run.llm_judge_enabled) pipelineBadges.push(`LLM${run.llm_judge_model ? ': ' + run.llm_judge_model : ''}`)

  return (
    <div className="space-y-4">
      {/* Run header */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={onBack}
          className="text-sm text-gray-500 hover:text-blue-600 flex items-center gap-1"
        >
          ← All Runs
        </button>
        <span className="text-gray-300">/</span>
        <span className="text-sm font-semibold text-gray-900">{run.name || `Run #${run.id}`}</span>
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${statusColors[run.status] || 'bg-gray-100 text-gray-500'}`}>
          {run.status}
        </span>
        {pipelineBadges.map(b => (
          <span key={b} className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{b}</span>
        ))}
        <span className="text-xs text-gray-400 ml-auto">K={run.top_k}</span>
      </div>

      {/* Execution progress (auto-starts for pending/running) */}
      {executing && (
        <div className="bg-white rounded-xl border border-gray-200 px-5">
          <RunProgressView
            jobId={job.id}
            runId={run.id}
            onDone={() => { setExecuting(false); onRunComplete() }}
          />
        </div>
      )}

      {/* Sub-tabs (only when ready) */}
      {!executing && run.status === 'ready' && (
        <>
          <div className="flex gap-1 bg-gray-100 rounded-lg p-1 w-fit">
            {[{ id: 'review', label: '👁 Review' }, { id: 'export', label: '⬇ Export' }].map(tab => (
              <button
                key={tab.id}
                onClick={() => setSubTab(tab.id)}
                className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${subTab === tab.id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {subTab === 'review' ? (
            <ReviewTab job={job} run={run} />
          ) : (
            <ExportTab job={job} run={run} />
          )}
        </>
      )}

      {!executing && run.status === 'error' && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl px-5 py-4 text-sm">
          {run.status_message || 'Run failed. Delete this run and try again.'}
        </div>
      )}
    </div>
  )
}

// ── Runs panel (list) ──────────────────────────────────────────────────────

function RunsPanel({ job, onSelectRun }) {
  const jobId = job.id
  const queryClient = useQueryClient()
  const [showNewRun, setShowNewRun] = useState(false)
  const [deletingId, setDeletingId] = useState(null)

  const { data: runs = [], isLoading, refetch } = useQuery({
    queryKey: ['compare-runs', jobId],
    queryFn: () => listRuns(jobId),
    enabled: job.status === 'ready',
    refetchInterval: (query) => {
      const list = query.state.data ?? []
      return list.some(r => r.status === 'pending' || r.status === 'running') ? 3000 : false
    },
  })

  const handleCreateRun = async (data) => {
    try {
      const run = await createRun(jobId, data)
      await refetch()
      queryClient.invalidateQueries({ queryKey: ['compare-runs', jobId] })
      setShowNewRun(false)
      onSelectRun(run)
      return run
    } catch (e) {
      throw e
    }
  }

  const handleDelete = async (runId, e) => {
    e.stopPropagation()
    if (!window.confirm('Delete this run and all its matches and decisions?')) return
    setDeletingId(runId)
    try {
      await deleteRun(jobId, runId)
      await refetch()
      queryClient.invalidateQueries({ queryKey: ['compare-runs', jobId] })
    } finally {
      setDeletingId(null)
    }
  }

  const statusColors = {
    ready: 'bg-emerald-100 text-emerald-700',
    pending: 'bg-amber-100 text-amber-700',
    running: 'bg-blue-100 text-blue-700',
    error: 'bg-red-100 text-red-700',
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-gray-600">Each run is an independent pipeline over the same embedded data.</p>
          <p className="text-xs text-gray-400 mt-0.5">Click a run to review and export its results.</p>
        </div>
        <button
          type="button"
          onClick={() => setShowNewRun(true)}
          disabled={job.status !== 'ready'}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg font-medium text-sm hover:bg-blue-700 transition-colors disabled:opacity-40"
        >
          + New Run
        </button>
      </div>

      {isLoading && <p className="text-gray-400 text-sm">Loading runs…</p>}

      {!isLoading && runs.length === 0 && (
        <div className="text-center py-16 bg-white rounded-2xl border border-dashed border-gray-200">
          <p className="text-gray-400 font-medium">No runs yet</p>
          <p className="text-sm text-gray-400 mt-1">Create a run to start matching.</p>
          <button
            type="button"
            onClick={() => setShowNewRun(true)}
            className="mt-4 bg-blue-600 text-white px-5 py-2 rounded-lg font-medium text-sm hover:bg-blue-700 transition-colors"
          >
            + New Run
          </button>
        </div>
      )}

      <div className="space-y-3">
        {runs.map(run => {
          const pipelineBadges = []
          if (run.vector_enabled !== false) pipelineBadges.push('Vector')
          if (run.reranker_enabled) pipelineBadges.push('Rerank')
          if (run.llm_judge_enabled) pipelineBadges.push('LLM judge')

          return (
            <div
              key={run.id}
              onClick={() => onSelectRun(run)}
              className="bg-white rounded-xl border border-gray-200 hover:border-blue-300 hover:shadow-sm transition-all cursor-pointer p-4"
            >
              <div className="flex items-center gap-3 flex-wrap">
                <span className="font-semibold text-gray-900 text-sm">{run.name || `Run #${run.id}`}</span>
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${statusColors[run.status] || 'bg-gray-100 text-gray-500'}`}>
                  {run.status}
                </span>
                {pipelineBadges.map(b => (
                  <span key={b} className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">{b}</span>
                ))}
                <span className="text-xs text-gray-400">K={run.top_k}</span>
                <span className="flex-1" />
                <span className="text-xs text-gray-400">{new Date(run.created_at).toLocaleDateString()}</span>
                <button
                  type="button"
                  onClick={(e) => handleDelete(run.id, e)}
                  disabled={deletingId === run.id}
                  className="text-xs text-gray-400 hover:text-red-500 transition-colors px-1.5 py-0.5 rounded disabled:opacity-40"
                  title="Delete run"
                >
                  {deletingId === run.id ? '…' : '✕'}
                </button>
              </div>
              {run.status === 'error' && run.status_message && (
                <p className="text-xs text-red-600 mt-2">{run.status_message}</p>
              )}
              {run.row_count_left != null && (
                <p className="text-xs text-gray-400 mt-1">{run.row_count_left.toLocaleString()} left rows matched</p>
              )}
            </div>
          )
        })}
      </div>

      {showNewRun && (
        <NewRunModal
          onClose={() => setShowNewRun(false)}
          onCreated={handleCreateRun}
        />
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────

export default function CompareJob() {
  const { jobId } = useParams()
  const queryClient = useQueryClient()
  const [activeTab, setActiveTab] = useState('runs')
  const [selectedRun, setSelectedRun] = useState(null)

  const { data: job, isLoading, error } = useQuery({
    queryKey: ['compare-job', jobId],
    queryFn: () => getCompareJob(jobId),
    refetchInterval: (query) => {
      const j = query.state.data
      if (!j) return 3000
      return ['ingesting', 'comparing', 'pending'].includes(j.status) ? 3000 : false
    },
  })

  const handleRunComplete = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['compare-runs', Number(jobId)] })
    queryClient.invalidateQueries({ queryKey: ['compare-runs', jobId] })
    setSelectedRun(prev => prev ? { ...prev, status: 'ready' } : prev)
  }, [jobId, queryClient])

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center text-gray-400">Loading…</div>
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

            <div className="flex gap-1 bg-gray-100 rounded-lg p-1 shrink-0">
              {[
                { id: 'runs',   label: '▶ Runs' },
                { id: 'browse', label: '👀 Browse' },
                { id: 'config', label: '⚙️ Config' },
              ].map(tab => (
                <button
                  key={tab.id}
                  onClick={() => { setActiveTab(tab.id); if (tab.id !== 'runs') setSelectedRun(null) }}
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
        ) : activeTab === 'runs' ? (
          selectedRun ? (
            <RunDetailPanel
              job={job}
              run={selectedRun}
              onBack={() => setSelectedRun(null)}
              onRunComplete={handleRunComplete}
            />
          ) : (
            <RunsPanel job={job} onSelectRun={setSelectedRun} />
          )
        ) : activeTab === 'browse' ? (
          <BrowseTab job={job} />
        ) : (
          <ConfigStatsTab job={job} />
        )}
      </div>
    </div>
  )
}

import { useEffect } from 'react'
import { useParams, Link, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getProject, exportResults } from '../api/client'
import ResultsTable from '../components/ResultsTable'
import StatsPanel from '../components/StatsPanel'
import { useProjectPin } from '../hooks/useProjectPin'
import PinGate from '../components/PinGate'
import { useProjectState } from '../contexts/ProjectStateContext'

// All possible SSE steps in order; only render pills for enabled stages
const ALL_STEPS = [
  { key: 'embedding',  label: 'Embedding query', needs: s => s.use_vector },
  { key: 'vector',     label: 'Vector search',   needs: s => s.use_vector },
  { key: 'bm25',       label: 'Keyword search',  needs: s => s.use_bm25 },
  { key: 'rrf',        label: 'Merging results', needs: () => true },
  { key: 'reranking',  label: 'Reranking',       needs: s => s.use_rerank },
]

function PipelineToggle({ label, checked, onChange, disabled }) {
  return (
    <label className={`inline-flex items-center gap-1.5 cursor-pointer select-none ${disabled ? 'opacity-40 pointer-events-none' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        className="w-3.5 h-3.5 rounded accent-blue-600"
      />
      <span className="text-xs text-gray-600">{label}</span>
    </label>
  )
}

export default function Search() {
  const { projectId } = useParams()
  const location = useLocation()
  const { getSearch, setSearch, startSearch } = useProjectState()
  const s = getSearch(projectId)

  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId)
  })

  const { isLocked, unlockWithPin } = useProjectPin(projectId, project?.has_pin)

  // Seed query/mode/k/pipeline from router navigation state (e.g. re-run from History)
  useEffect(() => {
    if (!location.state) return
    const patch = {}
    if (location.state.query != null) patch.query = location.state.query
    if (location.state.k    != null) patch.k     = location.state.k
    if (location.state.mode) {
      patch.mode = (location.state.mode === 'id' && project && !project.has_id_column)
        ? 'topic' : location.state.mode
    }
    for (const f of ['use_vector', 'use_bm25', 'use_rrf', 'use_rerank']) {
      if (location.state[f] != null) patch[f] = location.state[f]
    }
    if (Object.keys(patch).length) setSearch(projectId, patch)
  }, [project]) // eslint-disable-line react-hooks/exhaustive-deps

  const effectiveMode = s.mode
  const effectiveK    = s.k || project?.default_k || 10

  // At least one retriever must be on
  const retrieversOk = s.use_vector || s.use_bm25

  const pipeline = {
    use_vector: s.use_vector,
    use_bm25:   s.use_bm25,
    use_rrf:    s.use_rrf,
    use_rerank: s.use_rerank,
  }

  const handleSearch = (e) => {
    e?.preventDefault()
    if (!s.query.trim() || !retrieversOk) return
    startSearch(
      projectId, s.query, effectiveMode, effectiveK,
      project?.name ?? '', project?.display_columns ?? [],
      pipeline,
    )
  }

  const handleExport = async () => {
    if (!s.query.trim()) return
    try {
      await exportResults(projectId, s.query, effectiveMode, effectiveK, project?.name, pipeline)
    } catch {
      setSearch(projectId, { error: 'Export failed.' })
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') handleSearch()
  }

  if (!project) return <div className="p-8 text-gray-400">Loading...</div>
  if (isLocked) return <PinGate onUnlock={unlockWithPin} />

  // Steps to show as pills — only for stages the current pipeline will run
  const activeStepDefs = effectiveMode === 'topic'
    ? ALL_STEPS.filter(step => step.needs(s))
    : []

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="w-[90%] mx-auto py-10">

        {/* Header */}
        <div className="mb-8">
          <Link to="/" className="text-sm text-gray-400 hover:text-gray-600">← Projects</Link>
          <div className="flex items-center gap-2 mt-1">
            <h1 className="text-2xl font-bold text-gray-900">{project.name}</h1>
            {project.has_pin && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 text-xs font-medium">
                <span aria-hidden>🔒</span>
                PIN protected
              </span>
            )}
          </div>
          <p className="text-sm text-gray-400 mb-4">
            {project.row_count?.toLocaleString()} records
            {project.source_filename && (
              <span className="ml-2 text-gray-300">·</span>
            )}
            {project.source_filename && (
              <span className="ml-2 font-mono">{project.source_filename}</span>
            )}
          </p>
          <div className="flex gap-1">
            <Link
              to={`/projects/${projectId}/search`}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                location.pathname.endsWith('/search')
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              Search
            </Link>
            <Link
              to={`/projects/${projectId}/evaluate`}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                location.pathname.endsWith('/evaluate')
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              Evaluate
            </Link>
            <Link
              to={`/projects/${projectId}/browse`}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                location.pathname.endsWith('/browse')
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              Browse
            </Link>
            <Link
              to={`/projects/${projectId}/cluster`}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                location.pathname.endsWith('/cluster')
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              Cluster
            </Link>
            <Link
              to={`/projects/${projectId}/settings`}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                location.pathname.endsWith('/settings')
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              <span className="inline-flex items-center gap-1">
                Settings
                {project.has_pin && <span aria-hidden>🔒</span>}
              </span>
            </Link>
          </div>
        </div>

        {/* Search bar */}
        <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm">

          {/* Mode toggle */}
          <div className="flex gap-2 mb-5">
            <button
              onClick={() => setSearch(projectId, { mode: 'topic' })}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                effectiveMode === 'topic'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              Topic / Keyword
            </button>
            {project.has_id_column && (
              <button
                onClick={() => setSearch(projectId, { mode: 'id' })}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  effectiveMode === 'id'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {project.id_column} lookup
              </button>
            )}
          </div>

          {/* Query input */}
          <div className="flex gap-3">
            <input
              data-testid="search-query"
              type="text"
              value={s.query}
              onChange={e => setSearch(projectId, { query: e.target.value })}
              onKeyDown={handleKeyDown}
              placeholder={
                effectiveMode === 'id'
                  ? `Search by ${project.id_column}...`
                  : 'Describe what you\'re looking for...'
              }
              className="flex-1 border border-gray-300 rounded-lg px-4 py-3 text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
              autoFocus
            />
            <button
              onClick={handleSearch}
              data-testid="search-submit"
              disabled={s.loading || !s.query.trim() || !retrieversOk}
              className="bg-blue-600 text-white px-6 py-3 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors"
            >
              {s.loading ? 'Searching...' : 'Search'}
            </button>
          </div>

          {/* K selector */}
          <div className="flex items-center gap-3 mt-4">
            <span className="text-sm text-gray-500">Results:</span>
            {[5, 10, 20, 50].map(val => (
              <button
                key={val}
                onClick={() => setSearch(projectId, { k: val })}
                className={`text-sm px-3 py-1 rounded-lg transition-colors ${
                  effectiveK === val
                    ? 'bg-blue-100 text-blue-700 font-medium'
                    : 'text-gray-500 hover:bg-gray-100'
                }`}
              >
                {val}
              </button>
            ))}
          </div>

          {/* Pipeline toggles — topic mode only */}
          {effectiveMode === 'topic' && (
            <div className="mt-4 pt-4 border-t border-gray-100">
              <div className="flex flex-wrap items-center gap-4">
                <span className="text-xs text-gray-400 font-medium uppercase tracking-wide">Pipeline</span>
                <PipelineToggle
                  label="Vector (embedding)"
                  checked={s.use_vector}
                  onChange={v => setSearch(projectId, { use_vector: v })}
                  disabled={!s.use_bm25}
                />
                <PipelineToggle
                  label="BM25 (keyword)"
                  checked={s.use_bm25}
                  onChange={v => setSearch(projectId, { use_bm25: v })}
                  disabled={!s.use_vector}
                />
                <PipelineToggle
                  label="RRF merge"
                  checked={s.use_rrf}
                  onChange={v => setSearch(projectId, { use_rrf: v })}
                />
                <PipelineToggle
                  label="Rerank"
                  checked={s.use_rerank}
                  onChange={v => setSearch(projectId, { use_rerank: v })}
                />
              </div>
              {!retrieversOk && (
                <p className="mt-2 text-xs text-red-500">Enable at least one retriever (Vector or BM25).</p>
              )}
            </div>
          )}
        </div>

        {/* Error */}
        {s.error && (
          <div className="mt-4 bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm">
            {s.error}
          </div>
        )}

        {/* Live pipeline steps — only enabled stages */}
        {s.loading && activeStepDefs.length > 0 && (
          <div className="mt-4 flex items-center gap-2 flex-wrap">
            {activeStepDefs.map(({ key, label }) => {
              const done   = s.doneSteps.includes(key)
              const active = s.currentStep === key
              return (
                <span
                  key={key}
                  className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-all ${
                    done    ? 'bg-emerald-50 text-emerald-600' :
                    active  ? 'bg-blue-50 text-blue-600 ring-1 ring-blue-200' :
                              'bg-gray-100 text-gray-400'
                  }`}
                >
                  {done   ? '✓' :
                   active ? <span className="inline-block w-2 h-2 rounded-full bg-blue-500 animate-pulse" /> :
                            <span className="inline-block w-2 h-2 rounded-full bg-gray-300" />}
                  {label}
                </span>
              )
            })}
          </div>
        )}

        {/* Results */}
        {s.results && (
          <div className="mt-6">
            <div className="flex items-center justify-between">
              <p className="text-sm text-gray-500">
                {s.results.length} result{s.results.length !== 1 ? 's' : ''}
              </p>
              {s.results.length > 0 && (
                <button
                  onClick={handleExport}
                  data-testid="export-excel"
                  className="text-sm text-blue-600 hover:text-blue-700 font-medium"
                >
                  Export to Excel ↓
                </button>
              )}
            </div>

            {s.results.length === 0 ? (
              <div className="mt-6 text-center py-16 text-gray-400">
                No results found. Try different keywords.
              </div>
            ) : (
              <>
                <div data-testid="results-table">
                <ResultsTable results={s.results} displayColumns={project.display_columns} />
                </div>
                <StatsPanel stats={s.stats} />
              </>
            )}
          </div>
        )}

      </div>
    </div>
  )
}

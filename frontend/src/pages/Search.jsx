import { useState, useEffect, useRef } from 'react'
import { useParams, Link, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getProject, exportResults, API_BASE_URL } from '../api/client'
import ResultsTable from '../components/ResultsTable'
import StatsPanel from '../components/StatsPanel'
import { saveSearch } from '../utils/history'
import { useProjectPin } from '../hooks/useProjectPin'
import PinGate from '../components/PinGate'

const STEP_LABELS = {
  embedding:  'Embedding query',
  vector:     'Vector search',
  bm25:       'Keyword search',
  rrf:        'Merging results',
  reranking:  'Reranking',
}

export default function Search() {
  const { projectId } = useParams()
  const location = useLocation()
  const [query, setQuery] = useState(location.state?.query ?? '')
  const [mode, setMode] = useState(location.state?.mode ?? 'topic')
  const [k, setK] = useState(location.state?.k ?? null)  // null = use project default
  const [results, setResults] = useState(null)
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(false)
  const [currentStep, setCurrentStep] = useState(null)   // active pipeline step
  const [doneSteps, setDoneSteps] = useState([])          // completed steps
  const [error, setError] = useState('')
  const evtSourceRef = useRef(null)

  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId)
  })

  const { isLocked, unlockWithPin } = useProjectPin(projectId, project?.has_pin)

  // Sync mode from router state once project loads (guards against id mode on projects without id column)
  useEffect(() => {
    if (location.state?.mode && project) {
      if (location.state.mode === 'id' && !project.has_id_column) setMode('topic')
      else setMode(location.state.mode)
    }
  }, [project]) // eslint-disable-line react-hooks/exhaustive-deps

  const effectiveMode = mode
  const effectiveK = k || project?.default_k || 10

  const handleSearch = (e) => {
    e?.preventDefault()
    if (!query.trim()) return

    // Close any existing stream
    evtSourceRef.current?.close()

    setLoading(true)
    setError('')
    setResults(null)
    setCurrentStep(null)
    setDoneSteps([])

    const params = new URLSearchParams({ query, mode: effectiveMode, k: effectiveK })
    const url = `${API_BASE_URL}/projects/${projectId}/search/stream?${params}`
    const evtSource = new EventSource(url)
    evtSourceRef.current = evtSource

    evtSource.onmessage = (e) => {
      const event = JSON.parse(e.data)
      if (event.step === 'complete') {
        evtSource.close()
        evtSourceRef.current = null
        const data = event.results
        setResults(data.results)
        setStats(data.stats)
        setCurrentStep(null)
        setDoneSteps([])
        setLoading(false)
        saveSearch({
          project_id: Number(projectId),
          project_name: project?.name ?? '',
          query,
          mode: effectiveMode,
          k: effectiveK,
          results_returned: data.results.length,
          total_ms: data.stats?.total_ms,
          display_columns: project?.display_columns ?? [],
          results: data.results,
        })
      } else if (event.step === 'error') {
        evtSource.close()
        evtSourceRef.current = null
        setError(event.message || 'Search failed.')
        setLoading(false)
        setCurrentStep(null)
        setDoneSteps([])
      } else {
        setDoneSteps(prev => currentStep ? [...prev, currentStep] : prev)
        setCurrentStep(event.step)
      }
    }

    evtSource.onerror = () => {
      evtSource.close()
      evtSourceRef.current = null
      setError('Search failed. Please try again.')
      setLoading(false)
      setCurrentStep(null)
      setDoneSteps([])
    }
  }

  // Clean up on unmount
  useEffect(() => () => evtSourceRef.current?.close(), [])

  const handleExport = async () => {
    if (!query.trim()) return
    try {
      await exportResults(projectId, query, effectiveMode, effectiveK, project?.name)
    } catch (e) {
      setError('Export failed.')
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') handleSearch()
  }

  if (!project) return <div className="p-8 text-gray-400">Loading...</div>
  if (isLocked) return <PinGate onUnlock={unlockWithPin} />

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
              onClick={() => setMode('topic')}
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
                onClick={() => setMode('id')}
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
              value={query}
              onChange={e => setQuery(e.target.value)}
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
              disabled={loading || !query.trim()}
              className="bg-blue-600 text-white px-6 py-3 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors"
            >
              {loading ? 'Searching...' : 'Search'}
            </button>
          </div>

          {/* K selector */}
          <div className="flex items-center gap-3 mt-4">
            <span className="text-sm text-gray-500">Results:</span>
            {[5, 10, 20, 50].map(val => (
              <button
                key={val}
                onClick={() => setK(val)}
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
        </div>

        {/* Error */}
        {error && (
          <div className="mt-4 bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm">
            {error}
          </div>
        )}

        {/* Live pipeline steps */}
        {loading && (
          <div className="mt-4 flex items-center gap-2 flex-wrap">
            {Object.entries(STEP_LABELS).map(([key, label]) => {
              const done = doneSteps.includes(key)
              const active = currentStep === key
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
        {results && (
          <div className="mt-6">
            <div className="flex items-center justify-between">
              <p className="text-sm text-gray-500">
                {results.length} result{results.length !== 1 ? 's' : ''}
              </p>
              {results.length > 0 && (
                <button
                  onClick={handleExport}
                  data-testid="export-excel"
                  className="text-sm text-blue-600 hover:text-blue-700 font-medium"
                >
                  Export to Excel ↓
                </button>
              )}
            </div>

            {results.length === 0 ? (
              <div className="mt-6 text-center py-16 text-gray-400">
                No results found. Try different keywords.
              </div>
            ) : (
              <>
                <div data-testid="results-table">
                <ResultsTable results={results} displayColumns={project.display_columns} />
                </div>
                <StatsPanel stats={stats} />
              </>
            )}
          </div>
        )}

      </div>
    </div>
  )
}

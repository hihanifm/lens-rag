import { useState, useEffect } from 'react'
import { useParams, Link, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getProject, searchProject, exportResults } from '../api/client'
import ResultsTable from '../components/ResultsTable'
import StatsPanel from '../components/StatsPanel'
import { saveSearch } from '../utils/history'

export default function Search() {
  const { projectId } = useParams()
  const location = useLocation()
  const [query, setQuery] = useState(location.state?.query ?? '')
  const [mode, setMode] = useState(location.state?.mode ?? 'topic')
  const [k, setK] = useState(location.state?.k ?? null)  // null = use project default
  const [results, setResults] = useState(null)
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId)
  })

  // Sync mode from router state once project loads (guards against id mode on projects without id column)
  useEffect(() => {
    if (location.state?.mode && project) {
      if (location.state.mode === 'id' && !project.has_id_column) setMode('topic')
      else setMode(location.state.mode)
    }
  }, [project]) // eslint-disable-line react-hooks/exhaustive-deps

  const effectiveMode = mode
  const effectiveK = k || project?.default_k || 10

  const handleSearch = async (e) => {
    e?.preventDefault()
    if (!query.trim()) return
    setLoading(true)
    setError('')
    try {
      const data = await searchProject(projectId, query, effectiveMode, effectiveK)
      setResults(data.results)
      setStats(data.stats)
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
    } catch (e) {
      setError('Search failed. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const handleExport = async () => {
    if (!query.trim()) return
    try {
      await exportResults(projectId, query, effectiveMode, effectiveK)
    } catch (e) {
      setError('Export failed.')
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') handleSearch()
  }

  if (!project) return <div className="p-8 text-gray-400">Loading...</div>

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto px-6 py-10">

        {/* Header */}
        <div className="mb-8">
          <Link to="/" className="text-sm text-gray-400 hover:text-gray-600">← Projects</Link>
          <h1 className="text-2xl font-bold text-gray-900 mt-1">{project.name}</h1>
          <p className="text-sm text-gray-400 mb-4">{project.row_count?.toLocaleString()} records</p>
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
              Settings
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
                <ResultsTable results={results} displayColumns={project.display_columns} />
                <StatsPanel stats={stats} />
              </>
            )}
          </div>
        )}

      </div>
    </div>
  )
}

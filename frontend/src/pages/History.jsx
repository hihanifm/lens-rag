import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { loadHistory, clearHistory, exportHistoryCSV } from '../utils/history'

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

export default function History() {
  const navigate = useNavigate()
  const [entries, setEntries] = useState(() => loadHistory())
  const [projectFilter, setProjectFilter] = useState('all')

  const projects = [...new Map(entries.map(e => [e.project_id, e.project_name])).entries()]

  const filtered = projectFilter === 'all'
    ? entries
    : entries.filter(e => String(e.project_id) === projectFilter)

  const handleClear = () => {
    if (!window.confirm('Clear all history? This cannot be undone.')) return
    clearHistory()
    setEntries([])
  }

  const handleRerun = (entry) => {
    navigate(`/projects/${entry.project_id}/search`, {
      state: { query: entry.query, mode: entry.mode, k: entry.k },
    })
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto px-6 py-10">

        <div className="mb-8">
          <Link to="/" className="text-sm text-gray-400 hover:text-gray-600">← Projects</Link>
          <h1 className="text-2xl font-bold text-gray-900 mt-1">History</h1>
          <p className="text-sm text-gray-400">Last {entries.length} search and evaluation sessions</p>
        </div>

        {entries.length === 0 ? (
          <div className="text-center py-24 text-gray-400">
            No history yet. Run a search or evaluation to see it here.
          </div>
        ) : (
          <>
            {/* Toolbar */}
            <div className="flex items-center justify-between mb-4 gap-4 flex-wrap">
              <select
                value={projectFilter}
                onChange={e => setProjectFilter(e.target.value)}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="all">All projects</option>
                {projects.map(([id, name]) => (
                  <option key={id} value={String(id)}>{name}</option>
                ))}
              </select>

              <div className="flex gap-2">
                <button
                  onClick={exportHistoryCSV}
                  className="text-sm px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  Export CSV ↓
                </button>
                <button
                  onClick={handleClear}
                  className="text-sm px-4 py-2 border border-red-200 rounded-lg text-red-600 hover:bg-red-50 transition-colors"
                >
                  Clear all
                </button>
              </div>
            </div>

            {/* Table */}
            <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-xs text-gray-400 uppercase tracking-wide">
                    <th className="text-left px-5 py-3 font-medium">Type</th>
                    <th className="text-left px-5 py-3 font-medium">Project</th>
                    <th className="text-left px-5 py-3 font-medium">Query / Session</th>
                    <th className="text-left px-5 py-3 font-medium">Mode</th>
                    <th className="text-left px-5 py-3 font-medium">k</th>
                    <th className="text-left px-5 py-3 font-medium">Results</th>
                    <th className="text-left px-5 py-3 font-medium">Latency</th>
                    <th className="text-left px-5 py-3 font-medium">When</th>
                    <th className="px-5 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {filtered.map(entry => (
                    <tr key={entry.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-5 py-3">
                        {entry.type === 'search' ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700">
                            Search
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-700">
                            Evaluate
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-gray-600">{entry.project_name}</td>
                      <td className="px-5 py-3 text-gray-900 max-w-xs truncate">
                        {entry.type === 'search'
                          ? entry.query
                          : `${entry.test_case_count} question${entry.test_case_count !== 1 ? 's' : ''}`}
                      </td>
                      <td className="px-5 py-3 text-gray-500">
                        {entry.mode ?? '—'}
                      </td>
                      <td className="px-5 py-3 text-gray-500">{entry.k}</td>
                      <td className="px-5 py-3 text-gray-500">
                        {entry.type === 'search' ? entry.results_returned : '—'}
                      </td>
                      <td className="px-5 py-3 text-gray-500">
                        {entry.type === 'search' && entry.total_ms != null
                          ? `${Math.round(entry.total_ms)}ms`
                          : '—'}
                      </td>
                      <td className="px-5 py-3 text-gray-400 whitespace-nowrap">{timeAgo(entry.at)}</td>
                      <td className="px-5 py-3 text-right">
                        {entry.type === 'search' && (
                          <button
                            onClick={() => handleRerun(entry)}
                            className="text-xs text-blue-600 hover:text-blue-700 font-medium"
                          >
                            Re-run →
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

      </div>
    </div>
  )
}

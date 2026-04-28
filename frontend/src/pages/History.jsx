import { useState } from 'react'
import { Link } from 'react-router-dom'
import { loadHistory, clearHistory, exportHistoryCSV, fileDateTime } from '../utils/history'
import ResultsTable from '../components/ResultsTable'

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function EvalExpansion({ entry }) {
  if (!entry.results?.length) {
    return <p className="px-5 pb-4 text-sm text-gray-400">No saved results for this session.</p>
  }
  return (
    <div className="px-5 pb-5">
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
          <span className="text-sm font-medium text-gray-700">
            {entry.results.length} question{entry.results.length !== 1 ? 's' : ''} · k={entry.k}
          </span>
          <button
            onClick={() => {
              const slug = (entry.project_name ?? '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
              const payload = {
                results: entry.results,
                _lens: {
                  pipeline: {
                    vector:  entry.use_vector  ?? true,
                    bm25:    entry.use_bm25    ?? true,
                    rrf:     entry.use_rrf     ?? true,
                    rerank:  entry.use_rerank  ?? true,
                  },
                  k: entry.k,
                  exported_at: fileDateTime(new Date(entry.at)),
                },
              }
              downloadJSON(payload, `${slug}_lens_ragas_${fileDateTime(new Date(entry.at))}.json`)
            }}
            className="text-xs text-blue-600 hover:text-blue-700 font-medium"
          >
            Download JSON ↓
          </button>
        </div>
        <div className="divide-y divide-gray-100">
          {entry.results.slice(0, 10).map((r, i) => (
            <div key={i} className="px-5 py-3">
              <p className="text-sm font-medium text-gray-800 mb-1">{r.question}</p>
              <p className="text-xs text-gray-400">{r.contexts?.length} context{r.contexts?.length !== 1 ? 's' : ''} retrieved</p>
              {r.contexts?.[0] && (
                <p className="text-xs text-gray-400 mt-0.5 truncate">{r.contexts[0]}</p>
              )}
            </div>
          ))}
        </div>
        {entry.results.length > 10 && (
          <div className="px-5 py-3 bg-gray-50 border-t border-gray-100">
            <p className="text-xs text-gray-400">
              Showing 10 of {entry.results.length} — download the JSON for the full dataset.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function SearchExpansion({ entry }) {
  if (!entry.results?.length) {
    return <p className="px-5 pb-4 text-sm text-gray-400">No saved results for this session.</p>
  }
  return (
    <div className="px-5 pb-5">
      <ResultsTable results={entry.results} displayColumns={entry.display_columns} />
    </div>
  )
}

function ClusterExpansion({ entry }) {
  const [collapsed, setCollapsed] = useState(() => {
    const s = {}
    entry.groups?.forEach((g, i) => { s[g.label] = i >= 3 })
    return s
  })
  const [expandedRows, setExpandedRows] = useState(new Set())

  const toggleRow = (groupLabel, rowIdx) => {
    const key = `${groupLabel}::${rowIdx}`
    setExpandedRows(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  if (!entry.groups?.length) {
    return <p className="px-5 pb-4 text-sm text-gray-400">No saved results for this session.</p>
  }

  return (
    <div className="px-5 pb-5 space-y-2">
      {entry.groups.map(group => (
        <div key={group.label} className="bg-white rounded-xl border border-gray-200">
          <button
            onClick={() => setCollapsed(prev => ({ ...prev, [group.label]: !prev[group.label] }))}
            className="w-full flex items-center justify-between px-5 py-3 text-left hover:bg-gray-50 transition-colors"
          >
            <span className="text-sm font-medium text-gray-800">
              {group.label}
              <span className="ml-2 text-xs text-gray-400 font-normal">{group.count} record{group.count !== 1 ? 's' : ''}</span>
            </span>
            <span className="text-gray-400 text-xs">{collapsed[group.label] ? '▶' : '▼'}</span>
          </button>
          {!collapsed[group.label] && (
            <div className="overflow-x-auto border-t border-gray-100 pb-2">
              <table
                className="divide-y divide-gray-100 text-sm"
                style={{ width: 'max-content', minWidth: '100%' }}
              >
                <thead className="bg-gray-50">
                  <tr>
                    {[...(entry.display_columns ?? []), 'Context'].map(col => (
                      <th key={col} className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide min-w-[160px]">{col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {group.records.slice(0, 20).map((rec, i) => {
                    const rowKey = `${group.label}::${i}`
                    const expanded = expandedRows.has(rowKey)
                    return (
                      <tr
                        key={i}
                        onClick={() => toggleRow(group.label, i)}
                        className={`${i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'} hover:bg-blue-50/40 cursor-pointer transition-colors`}
                        title="Click to expand/collapse row"
                      >
                        {[...(entry.display_columns ?? []), 'Context'].map(col => (
                          <td key={col} className="px-4 py-2 text-gray-700 min-w-[160px] max-w-xs align-top">
                            <span className={`block break-words ${expanded ? 'whitespace-pre-wrap' : 'whitespace-normal line-clamp-5 lens-clamp-5'}`}>
                              {col === 'Context'
                                ? (rec.contextual_content ?? '')
                                : (rec.display_data?.[col] ?? '')
                              }
                            </span>
                          </td>
                        ))}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {group.records.length > 20 && (
                <p className="px-4 py-2 text-xs text-gray-400 bg-gray-50 border-t border-gray-100">
                  Showing 20 of {group.records.length} — export from the Cluster tab for the full set.
                </p>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

export default function History() {
  const [entries, setEntries] = useState(() => loadHistory())
  const [projectFilter, setProjectFilter] = useState('all')
  const [expandedId, setExpandedId] = useState(null)

  const projects = [...new Map(entries.map(e => [e.project_id, e.project_name])).entries()]

  const filtered = projectFilter === 'all'
    ? entries
    : entries.filter(e => String(e.project_id) === projectFilter)

  const handleClear = () => {
    if (!window.confirm('Clear all history? This cannot be undone.')) return
    clearHistory()
    setEntries([])
    setExpandedId(null)
  }

  const toggleExpand = (id) => {
    setExpandedId(prev => prev === id ? null : id)
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="w-[90%] mx-auto py-10">

        <div className="mb-8">
          <Link to="/" className="text-sm text-gray-400 hover:text-gray-600">← Projects</Link>
          <h1 className="text-2xl font-bold text-gray-900 mt-1">History</h1>
          <p className="text-sm text-gray-400">Last {entries.length} search, evaluation, and clustering sessions</p>
        </div>

        {entries.length === 0 ? (
          <div className="text-center py-24 text-gray-400">
            No history yet. Run a search, evaluation, or clustering to see it here.
          </div>
        ) : (
          <>
            {/* Toolbar */}
            <div className="flex items-center justify-between mb-4 gap-4 flex-wrap">
              <select
                value={projectFilter}
                onChange={e => { setProjectFilter(e.target.value); setExpandedId(null) }}
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
            <div className="bg-white rounded-2xl border border-gray-200 shadow-sm">
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
                <tbody className="divide-y divide-gray-100">
                  {filtered.map(entry => {
                    const isExpanded = expandedId === entry.id
                    const hasExpansion = entry.type === 'cluster'
                      ? entry.groups?.length > 0
                      : entry.results?.length > 0
                    const clusterSummary = entry.type === 'cluster'
                      ? `${entry.algorithm === 'kmeans' ? `K-Means k=${entry.k}` : 'DBSCAN'}${
                        entry.filters?.length
                          ? ` · ${entry.filters.map(f => (
                              f.values?.length
                                ? `${f.column}=(${f.values.join(', ')})`
                                : `${f.column}=${f.value ?? ''}`
                            )).join(' & ')}`
                          : entry.filter_column
                            ? ` · ${entry.filter_column}=${entry.filter_value}`
                            : ''
                      }`
                      : null
                    return (
                      <>
                        <tr
                          key={entry.id}
                          onClick={() => toggleExpand(entry.id)}
                          className="hover:bg-gray-50 transition-colors cursor-pointer"
                        >
                          <td className="px-5 py-3">
                            {entry.type === 'search' ? (
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700">Search</span>
                            ) : entry.type === 'cluster' ? (
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-100 text-emerald-700">Cluster</span>
                            ) : (
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-700">Evaluate</span>
                            )}
                          </td>
                          <td className="px-5 py-3 text-gray-600">{entry.project_name}</td>
                          <td className="px-5 py-3 text-gray-900 max-w-xs truncate">
                            {entry.type === 'search'
                              ? entry.query
                              : entry.type === 'cluster'
                                ? clusterSummary
                                : `${entry.test_case_count} question${entry.test_case_count !== 1 ? 's' : ''}`}
                          </td>
                          <td className="px-5 py-3 text-gray-500">{entry.mode ?? '—'}</td>
                          <td className="px-5 py-3 text-gray-500">{entry.k ?? '—'}</td>
                          <td className="px-5 py-3 text-gray-500">
                            {entry.type === 'search'
                              ? entry.results_returned
                              : entry.type === 'cluster'
                                ? `${entry.n_clusters} cluster${entry.n_clusters !== 1 ? 's' : ''}`
                                : '—'}
                          </td>
                          <td className="px-5 py-3 text-gray-500">
                            {(entry.type === 'search' || entry.type === 'cluster') && entry.total_ms != null
                              ? `${Math.round(entry.total_ms)}ms`
                              : '—'}
                          </td>
                          <td className="px-5 py-3 text-gray-400 whitespace-nowrap">{timeAgo(entry.at)}</td>
                          <td className="px-5 py-3 text-right whitespace-nowrap">
                            <span className="text-xs text-gray-400 mr-3">
                              {hasExpansion ? (isExpanded ? '▲' : '▼') : ''}
                            </span>
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr key={`${entry.id}-expand`}>
                            <td colSpan={9} className="bg-gray-50 border-t border-gray-100">
                              {entry.type === 'search'
                                ? <SearchExpansion entry={entry} />
                                : entry.type === 'cluster'
                                  ? <ClusterExpansion entry={entry} />
                                  : <EvalExpansion entry={entry} />}
                            </td>
                          </tr>
                        )}
                      </>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

      </div>
    </div>
  )
}

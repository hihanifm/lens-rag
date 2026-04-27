import { useState } from 'react'
import { useParams, Link, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getProject, browseProject } from '../api/client'

export default function Browse() {
  const { projectId } = useParams()
  const location = useLocation()
  const [expandedRows, setExpandedRows] = useState(new Set())

  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId),
  })

  const { data, isLoading, isError } = useQuery({
    queryKey: ['browse', projectId],
    queryFn: () => browseProject(projectId),
    enabled: !!project,
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
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto px-6 py-10">

        {/* Header */}
        <div className="mb-8">
          <Link to="/" className="text-sm text-gray-400 hover:text-gray-600">← Projects</Link>
          <h1 className="text-2xl font-bold text-gray-900 mt-1">{project?.name}</h1>
          <p className="text-sm text-gray-400 mb-4">{project?.row_count?.toLocaleString()} records</p>
          <div className="flex gap-1">
            {[
              { label: 'Search', path: 'search' },
              { label: 'Evaluate', path: 'evaluate' },
              { label: 'Browse', path: 'browse' },
              { label: 'Settings', path: 'settings' },
            ].map(({ label, path }) => (
              <Link
                key={path}
                to={`/projects/${projectId}/${path}`}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  location.pathname.endsWith(`/${path}`)
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {label}
              </Link>
            ))}
          </div>
        </div>

        {isLoading && <p className="text-gray-400">Loading records...</p>}
        {isError && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm">
            Failed to load records.
          </div>
        )}

        {!isLoading && records.length > 0 && (
          <>
            <p className="text-sm text-gray-500 mb-3">
              Showing {records.length} of {total?.toLocaleString()} records
              <span className="ml-2 text-gray-400">· click a row to expand</span>
            </p>

            <div className="rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="text-sm border-collapse" style={{ minWidth: '100%', tableLayout: 'fixed', width: 'max-content' }}>
                  <colgroup>
                    {columns.map(col => (
                      <col
                        key={col}
                        style={{
                          width: col === 'id' ? '60px'
                            : col === 'sheet_name' ? '100px'
                            : col === 'contextual_content' ? '320px'
                            : col === 'embedding' ? '220px'
                            : col === 'search_vector' ? '260px'
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
                                    expanded ? '' : 'line-clamp-2'
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
          </>
        )}

      </div>
    </div>
  )
}

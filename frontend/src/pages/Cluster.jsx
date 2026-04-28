import { useState, useRef, useEffect } from 'react'
import { useParams, Link, useLocation } from 'react-router-dom'
import { useQuery, useQueries } from '@tanstack/react-query'
import {
  getProject,
  getProjectColumns,
  getColumnValues,
  exportCluster,
  API_BASE_URL,
  getProjectPin,
} from '../api/client'
import { useProjectPin } from '../hooks/useProjectPin'
import PinGate from '../components/PinGate'
import { saveCluster } from '../utils/history'
import { subscribeClusterRun, startClusterRun, abortClusterRun } from '../utils/clusterRunManager'

function compactClusterFilters(rows) {
  return rows
    .map(({ column, values }) => {
      const col = (column || '').trim()
      const vals = Array.isArray(values)
        ? values.map(v => String(v).trim()).filter(Boolean)
        : []
      return { column: col, values: [...new Set(vals)] }
    })
    .filter(({ column, values }) => column && values.length > 0)
}
// 20-color Tableau-inspired palette; noise (-1) uses gray
const PALETTE = [
  '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
  '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac',
  '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
  '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf',
]
const NOISE_COLOR = '#9ca3af'

function colorFor(clusterId) {
  if (clusterId === -1) return NOISE_COLOR
  return PALETTE[clusterId % PALETTE.length]
}

// ── Scatter plot ──────────────────────────────────────────────────────────

function ClusterScatter({ groups, displayColumns }) {
  const [hovered, setHovered] = useState(null)
  const [hidden, setHidden] = useState(new Set())

  const W = 680, H = 480, PAD = 36

  const scale = (v, inLo, inHi, outLo, outHi) =>
    outLo + ((v - inLo) / (inHi - inLo)) * (outHi - outLo)

  const allPts = groups.flatMap(g =>
    g.records.map(r => ({ ...r, clusterId: g.cluster_id, label: g.label }))
  )

  return (
    <div className="flex gap-6 items-start">
      {/* SVG canvas */}
      <div className="relative">
        <svg
          width={W}
          height={H}
          className="bg-white rounded-xl border border-gray-200 shadow-sm"
        >
          {allPts
            .filter(p => !hidden.has(p.clusterId))
            .map((p, i) => (
              <circle
                key={i}
                cx={scale(p.pca_x, -1, 1, PAD, W - PAD)}
                cy={scale(p.pca_y, -1, 1, H - PAD, PAD)}
                r={5}
                fill={colorFor(p.clusterId)}
                opacity={0.75}
                style={{ cursor: 'pointer' }}
                onMouseEnter={e =>
                  setHovered({ record: p, clientX: e.clientX, clientY: e.clientY })
                }
                onMouseLeave={() => setHovered(null)}
              />
            ))}
        </svg>

        {/* Hover tooltip */}
        {hovered && (
          <div
            className="fixed z-50 bg-white border border-gray-200 rounded-lg shadow-lg px-3 py-2 text-xs max-w-xs pointer-events-none"
            style={{ top: hovered.clientY + 12, left: hovered.clientX + 12 }}
          >
            <p className="font-semibold text-gray-700 mb-1">{hovered.record.label}</p>
            {displayColumns.map(col => (
              <p key={col} className="text-gray-600 truncate">
                <span className="text-gray-400">{col}:</span>{' '}
                {hovered.record.display_data?.[col] ?? '—'}
              </p>
            ))}
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="flex flex-col gap-1.5 min-w-[140px] max-h-[480px] overflow-y-auto pr-1">
        {groups.map(g => (
          <button
            key={g.cluster_id}
            onClick={() =>
              setHidden(prev => {
                const next = new Set(prev)
                next.has(g.cluster_id) ? next.delete(g.cluster_id) : next.add(g.cluster_id)
                return next
              })
            }
            className={`flex items-center gap-2 text-left text-xs rounded px-2 py-1 transition-opacity ${
              hidden.has(g.cluster_id) ? 'opacity-30' : 'opacity-100'
            } hover:bg-gray-100`}
          >
            <span
              className="inline-block w-3 h-3 rounded-full flex-shrink-0"
              style={{ backgroundColor: colorFor(g.cluster_id) }}
            />
            <span className="text-gray-700 truncate">{g.label}</span>
            <span className="text-gray-400 ml-auto flex-shrink-0">{g.count}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

// ── Nav helper (shared tab style) ─────────────────────────────────────────

function NavLink({ to, children, active }) {
  return (
    <Link
      to={to}
      className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
        active ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
      }`}
    >
      {children}
    </Link>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────

export default function Cluster() {
  const { projectId } = useParams()
  const location = useLocation()

  const [algorithm, setAlgorithm] = useState('kmeans')
  const [kInput, setKInput] = useState('8')
  const [filters, setFilters] = useState([])
  const [view, setView] = useState('table')
  const [loading, setLoading] = useState(false)
  const [currentStep, setCurrentStep] = useState(null)
  const [stepCounts, setStepCounts] = useState({})
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const [collapsed, setCollapsed] = useState({})
  const projectIdStr = String(projectId)

  useEffect(() => {
    return subscribeClusterRun(projectIdStr, s => {
      setLoading(!!s.loading)
      setCurrentStep(s.currentStep ?? null)
      setStepCounts(s.stepCounts ?? {})
      setError(s.error ?? '')
      setResult(s.result ?? null)
      setCollapsed(s.collapsed ?? {})
    })
  }, [projectIdStr])

  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId),
  })

  const { isLocked, unlockWithPin } = useProjectPin(projectId, project?.has_pin)

  const { data: columnsData } = useQuery({
    queryKey: ['project-columns', projectId],
    queryFn: () => getProjectColumns(projectId),
    enabled: !!project && !isLocked,
  })

  const columnValuesQueries = useQueries({
    queries: filters.map(f => ({
      queryKey: ['column-values', projectId, f.column],
      queryFn: () => getColumnValues(projectId, f.column),
      enabled: !!(f.column && projectId && !isLocked),
    })),
  })

  const allColumns = columnsData?.columns ?? []

  const handleRun = async () => {
    const k = algorithm === 'kmeans' ? parseInt(kInput, 10) : null
    if (algorithm === 'kmeans' && (!Number.isInteger(k) || k < 2 || k > 50)) {
      setError('K must be a whole number between 2 and 50.')
      return
    }

    abortClusterRun(projectIdStr)
    const compact = compactClusterFilters(filters)
    await startClusterRun({
      projectId: projectIdStr,
      algorithm,
      k: k ?? null,
      filters: compact.map(({ column, values }) => ({ column, values })),
      projectName: project?.name ?? '',
      displayColumns: project?.display_columns ?? [],
    })
  }

  const handleExport = async () => {
    const k = algorithm === 'kmeans' ? parseInt(kInput, 10) : null
    const compact = compactClusterFilters(filters)
    try {
      await exportCluster(
        projectId, algorithm, k,
        compact,
        project?.name,
      )
    } catch {
      setError('Export failed.')
    }
  }

  const CLUSTER_STEPS = [
    { key: 'fetch',   label: 'Loading embeddings' },
    { key: 'cluster', label: algorithm === 'kmeans' ? `K-Means (k=${kInput})` : 'DBSCAN' },
    { key: 'pca',     label: 'Scatter layout' },
  ]

  if (!project) return <div className="p-8 text-gray-400">Loading...</div>
  if (isLocked) return <PinGate onUnlock={unlockWithPin} />

  const activeBase = `/projects/${projectId}`

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
            {project.source_filename && <span className="ml-2 text-gray-300">·</span>}
            {project.source_filename && <span className="ml-2 font-mono">{project.source_filename}</span>}
          </p>
          <div className="flex gap-1">
            <NavLink to={`${activeBase}/search`} active={location.pathname.endsWith('/search')}>Search</NavLink>
            <NavLink to={`${activeBase}/evaluate`} active={location.pathname.endsWith('/evaluate')}>Evaluate</NavLink>
            <NavLink to={`${activeBase}/browse`} active={location.pathname.endsWith('/browse')}>Browse</NavLink>
            <NavLink to={`${activeBase}/cluster`} active={location.pathname.endsWith('/cluster')}>Cluster</NavLink>
            <NavLink to={`${activeBase}/system`} active={location.pathname.endsWith('/system')}>System</NavLink>
            <NavLink to={`${activeBase}/settings`} active={location.pathname.endsWith('/settings')}>
              <span className="inline-flex items-center gap-1">
                Settings{project.has_pin && <span aria-hidden>🔒</span>}
              </span>
            </NavLink>
          </div>
        </div>

        {/* Controls panel */}
        <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm">

          {/* Algorithm toggle */}
          <div className="flex gap-2 mb-5">
            <button
              onClick={() => setAlgorithm('kmeans')}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                algorithm === 'kmeans' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              K-Means
            </button>
            <button
              onClick={() => setAlgorithm('dbscan')}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                algorithm === 'dbscan' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              DBSCAN (auto)
            </button>
          </div>

          {/* K input — K-Means only */}
          {algorithm === 'kmeans' && (
            <div className="flex items-center gap-3 mb-5">
              <label className="text-sm text-gray-600">Number of clusters (K):</label>
              <input
                type="number"
                min={2}
                max={50}
                value={kInput}
                onChange={e => setKInput(e.target.value)}
                className="w-20 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <span className="text-xs text-gray-400">2 – 50</span>
            </div>
          )}

          {/* Filters — AND semantics; multiple Excel grouping columns */}
          <div className="mb-5 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-gray-600">Filters (AND)</span>
              <button
                type="button"
                onClick={() => setFilters(prev => [...prev, { column: '', values: [] }])}
                className="text-sm px-3 py-1 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
              >
                Add filter
              </button>
              {filters.length > 0 && (
                <button
                  type="button"
                  onClick={() => setFilters([])}
                  className="text-sm text-gray-500 hover:text-gray-700"
                >
                  Clear all
                </button>
              )}
            </div>
            <p className="text-xs text-gray-500 max-w-[40rem] leading-relaxed">
              Each column rule uses <span className="font-medium text-gray-600">substring</span> matching
              (case-insensitive ILIKE). Regex is not supported. Within one column you can pick{' '}
              <span className="font-medium text-gray-600">several values</span> — rows match if{' '}
              <span className="font-medium text-gray-600">any</span> of those substrings appear (<span className="font-medium text-gray-600">OR</span>).
              Different filter rows combine with <span className="font-medium text-gray-600">AND</span>.
            </p>

            {filters.map((row, idx) => {
              const valuesData = columnValuesQueries[idx]?.data
              const pending = !!(row.column && columnValuesQueries[idx]?.isFetching)
              return (
                <div key={idx} className="flex flex-wrap items-center gap-3">
                  <select
                    {...(idx === 0 ? { 'data-testid': 'cluster-filter-column' } : {})}
                    value={row.column}
                    onChange={e => {
                      const col = e.target.value
                      setFilters(prev => prev.map((r, i) => (i === idx ? { column: col, values: [] } : r)))
                    }}
                    className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[10rem]"
                  >
                    <option value="">Column…</option>
                    {allColumns.map(col => (
                      <option key={col} value={col}>{col}</option>
                    ))}
                  </select>

                  {row.column && valuesData && !valuesData.truncated && (
                    <select
                      {...(idx === 0 ? { 'data-testid': 'cluster-filter-value' } : {})}
                      multiple
                      value={row.values ?? []}
                      onChange={e => {
                        const sel = [...e.target.selectedOptions].map(o => o.value)
                        setFilters(prev => prev.map((r, i) => (i === idx ? { ...r, values: sel } : r)))
                      }}
                      size={Math.min(Math.max((valuesData.values?.length || 0), 3), 10)}
                      className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[12rem]"
                      title="Hold Cmd (Mac) or Ctrl (Windows) to select multiple values"
                    >
                      {valuesData.values.map(v => (
                        <option key={v} value={v}>{v}</option>
                      ))}
                    </select>
                  )}

                  {row.column && valuesData?.truncated && (
                    <input
                      {...(idx === 0 ? { 'data-testid': 'cluster-filter-value-input' } : {})}
                      type="text"
                      value={(row.values ?? []).join(', ')}
                      onChange={e => {
                        const parts = e.target.value.split(',').map(s => s.trim()).filter(Boolean)
                        setFilters(prev => prev.map((r, i) => (i === idx ? { ...r, values: parts } : r)))
                      }}
                      placeholder="Comma-separated substrings…"
                      className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[12rem]"
                    />
                  )}

                  {row.column && pending && !valuesData && (
                    <span className="text-xs text-gray-400">Loading values…</span>
                  )}

                  <button
                    type="button"
                    onClick={() => setFilters(prev => prev.filter((_, i) => i !== idx))}
                    className="text-sm text-red-600 hover:text-red-700 px-2"
                    title="Remove filter"
                  >
                    Remove
                  </button>
                </div>
              )
            })}
          </div>

          {/* Run button */}
          <button
            data-testid="cluster-run"
            onClick={handleRun}
            disabled={loading}
            className="bg-blue-600 text-white px-6 py-3 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors"
          >
            {loading ? 'Clustering…' : 'Run Clustering'}
          </button>
        </div>

        {/* Live step pills */}
        {loading && (
          <div className="mt-4 flex items-center gap-2 flex-wrap">
            {CLUSTER_STEPS.map(({ key, label }, idx) => {
              const activeIdx = CLUSTER_STEPS.findIndex(s => s.key === currentStep)
              const count = stepCounts[key]
              const isActive = currentStep === key
              const isDone = activeIdx > idx || (activeIdx === -1 && count != null)
              return (
                <span
                  key={key}
                  className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-all ${
                    isDone   ? 'bg-emerald-50 text-emerald-600' :
                    isActive ? 'bg-blue-50 text-blue-600 ring-1 ring-blue-200' :
                               'bg-gray-100 text-gray-400'
                  }`}
                >
                  {isDone   ? '✓' :
                   isActive ? <span className="inline-block w-2 h-2 rounded-full bg-blue-500 animate-pulse" /> :
                              <span className="inline-block w-2 h-2 rounded-full bg-gray-300" />}
                  {label}
                  {count != null && (
                    <span className="opacity-60 tabular-nums">· {count}</span>
                  )}
                </span>
              )
            })}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="mt-4 bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm">
            {error}
          </div>
        )}

        {/* Results */}
        {result && (
          <div data-testid="cluster-results" className="mt-6">

            {/* Stats + view toggle + export */}
            <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
              <div className="flex items-center gap-4 text-sm text-gray-500">
                <span>{result.stats.n_clusters} cluster{result.stats.n_clusters !== 1 ? 's' : ''}</span>
                <span>{result.stats.records_loaded.toLocaleString()} records</span>
                <span>{result.stats.ms_fetch.toFixed(0)}ms fetch</span>
                <span>{result.stats.ms_cluster.toFixed(0)}ms cluster</span>
              </div>
              <div className="flex items-center gap-3">
                {/* View toggle */}
                <div className="flex gap-1">
                  <button
                    onClick={() => setView('table')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                      view === 'table' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    Table
                  </button>
                  <button
                    data-testid="cluster-view-scatter"
                    onClick={() => setView('scatter')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                      view === 'scatter' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    Scatter
                  </button>
                </div>
                <button
                  data-testid="cluster-export"
                  onClick={handleExport}
                  className="text-sm text-blue-600 hover:text-blue-700 font-medium"
                >
                  Export to Excel ↓
                </button>
              </div>
            </div>

            {/* DBSCAN degenerate warnings */}
            {algorithm === 'dbscan' && result.stats.n_clusters === 0 && (
              <div className="mb-4 bg-amber-50 border border-amber-200 text-amber-700 rounded-lg px-4 py-3 text-sm">
                DBSCAN found no clusters — all records were classified as noise. The data may be too sparse for the default settings. Try K-Means with a fixed K instead.
              </div>
            )}
            {algorithm === 'dbscan' && result.stats.n_clusters > 50 && (
              <div className="mb-4 bg-amber-50 border border-amber-200 text-amber-700 rounded-lg px-4 py-3 text-sm">
                DBSCAN produced {result.stats.n_clusters} clusters — the dataset may be too dense for auto-detection. Consider using K-Means with a specific K.
              </div>
            )}

            {/* Scatter view */}
            {view === 'scatter' && (
              <div data-testid="cluster-scatter" className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm overflow-x-auto">
                <ClusterScatter
                  groups={result.groups}
                  displayColumns={project.display_columns}
                />
              </div>
            )}

            {/* Table view */}
            {view === 'table' && (
              <div className="space-y-3">
                {result.groups.map(group => (
                  <div
                    key={group.label}
                    className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden"
                  >
                    {/* Group header */}
                    <button
                      onClick={() =>
                        setCollapsed(prev => ({ ...prev, [group.label]: !prev[group.label] }))
                      }
                      data-testid="cluster-group"
                    className="w-full flex items-center justify-between px-6 py-4 text-left hover:bg-gray-50 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <span
                          className="inline-block w-3 h-3 rounded-full flex-shrink-0"
                          style={{ backgroundColor: colorFor(group.cluster_id) }}
                        />
                        <span className="font-medium text-gray-900">{group.label}</span>
                        <span className="text-sm text-gray-400">
                          {group.count} record{group.count !== 1 ? 's' : ''}
                        </span>
                      </div>
                      <span className="text-gray-400 text-xs">
                        {collapsed[group.label] ? '▶' : '▼'}
                      </span>
                    </button>

                    {/* Records table */}
                    {!collapsed[group.label] && (
                      <div className="overflow-x-auto border-t border-gray-100">
                        <table className="min-w-full divide-y divide-gray-100">
                          <thead className="bg-gray-50">
                            <tr>
                              {project.display_columns.map(col => (
                                <th
                                  key={col}
                                  className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide"
                                >
                                  {col}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100 bg-white">
                            {group.records.map((rec, i) => (
                              <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'}>
                                {project.display_columns.map(col => (
                                  <td
                                    key={col}
                                    className="px-4 py-3 text-sm text-gray-700 max-w-xs align-top"
                                  >
                                    {rec.display_data?.[col] ?? ''}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  )
}

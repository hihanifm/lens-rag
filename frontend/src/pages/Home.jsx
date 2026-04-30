import { useState, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { getProjects, deleteProject, listCompareJobs, deleteCompareJob } from '../api/client'
import { loadHistory, subscribeHistoryUpdates } from '../utils/history'

const statusColor = {
  ready: 'bg-emerald-100 text-emerald-700',
  ingesting: 'bg-amber-100 text-amber-700',
  comparing: 'bg-amber-100 text-amber-700',
  pending: 'bg-gray-100 text-gray-600',
  error: 'bg-red-100 text-red-700'
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function fmtElapsed(startedAt, now) {
  if (!startedAt) return null
  const ts = startedAt.endsWith('Z') ? startedAt : startedAt + 'Z'
  const secs = Math.floor(((now ?? Date.now()) - new Date(ts).getTime()) / 1000)
  if (secs < 0) return null
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

function StatusBadge({ status }) {
  return (
    <span className={`text-xs font-medium px-2.5 py-1 rounded-full inline-flex items-center gap-1.5 ${statusColor[status] || statusColor.pending}`}>
      {(status === 'ingesting' || status === 'comparing') && (
        <svg className="animate-spin h-3 w-3 shrink-0" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      )}
      {status}
    </span>
  )
}

// ── Search Projects tab ────────────────────────────────────────────────────

function SearchTab({ now }) {
  const queryClient = useQueryClient()
  const [deletingId, setDeletingId] = useState(null)

  const { data: projects = [], isLoading } = useQuery({
    queryKey: ['projects'],
    queryFn: getProjects,
    refetchInterval: (query) => {
      const list = query.state.data
      if (!Array.isArray(list)) return false
      return list.some((p) => p.status === 'ingesting') ? 3000 : false
    },
  })

  const handleDelete = async (e, project) => {
    e.preventDefault()
    e.stopPropagation()
    if (!window.confirm(`Delete "${project.name}"? This cannot be undone.`)) return
    setDeletingId(project.id)
    try {
      await deleteProject(project.id)
      await queryClient.invalidateQueries({ queryKey: ['projects'] })
    } finally {
      setDeletingId(null)
    }
  }

  if (isLoading) return <p className="text-gray-400">Loading projects...</p>

  if (projects.length === 0) {
    return (
      <div className="text-center py-20 text-gray-400">
        <p className="text-lg">No search projects yet.</p>
        <p className="mt-1">Create your first project to get started.</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {projects.map(p => (
        <Link
          key={p.id}
          data-testid={p.status === 'ready' ? 'project-card' : undefined}
          to={p.status === 'ready' ? `/projects/${p.id}/search` : '#'}
          className={`block bg-white rounded-xl border border-gray-200 px-6 py-5
            hover:border-blue-300 hover:shadow-sm transition-all
            ${p.status !== 'ready' ? 'opacity-60 cursor-default' : ''}`}
        >
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-gray-900">{p.name}</h3>
                {p.has_pin && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 text-xs font-medium">
                    <span aria-hidden>🔒</span> PIN
                  </span>
                )}
              </div>
              <p className="text-sm text-gray-400 mt-0.5">
                {p.status === 'ingesting' ? (
                  <>
                    {p.row_count != null
                      ? `${p.row_count.toLocaleString()} / ${(p.total_rows ?? '?').toLocaleString()} records`
                      : 'Reading file...'}
                    {' · '}
                    {fmtElapsed(p.ingestion_started_at, now) ?? 'starting...'}
                  </>
                ) : (
                  <>
                    {p.row_count ? `${p.row_count.toLocaleString()} records` : '—'}
                    {' · '}
                    {new Date(p.created_at).toLocaleDateString()}
                  </>
                )}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <StatusBadge status={p.status} />
              <button
                onClick={(e) => handleDelete(e, p)}
                disabled={deletingId === p.id}
                className="p-1.5 rounded-lg text-gray-300 hover:text-red-500 hover:bg-red-50 transition-colors disabled:opacity-40"
                title="Delete project"
              >
                {deletingId === p.id ? '…' : '✕'}
              </button>
            </div>
          </div>
        </Link>
      ))}
    </div>
  )
}

// ── Compare Jobs tab ───────────────────────────────────────────────────────

function CompareTab() {
  const queryClient = useQueryClient()
  const [deletingId, setDeletingId] = useState(null)

  const { data: jobs = [], isLoading } = useQuery({
    queryKey: ['compare-jobs'],
    queryFn: listCompareJobs,
    refetchInterval: (query) => {
      const list = query.state.data
      if (!Array.isArray(list)) return false
      return list.some((j) => ['ingesting', 'comparing'].includes(j.status)) ? 3000 : false
    },
  })

  const handleDelete = async (e, job) => {
    e.preventDefault()
    e.stopPropagation()
    if (!window.confirm(`Delete "${job.name}"? This cannot be undone.`)) return
    setDeletingId(job.id)
    try {
      await deleteCompareJob(job.id)
      await queryClient.invalidateQueries({ queryKey: ['compare-jobs'] })
    } finally {
      setDeletingId(null)
    }
  }

  if (isLoading) return <p className="text-gray-400">Loading compare jobs...</p>

  if (jobs.length === 0) {
    return (
      <div className="text-center py-20 text-gray-400">
        <p className="text-lg">No compare jobs yet.</p>
        <p className="mt-1">Create a compare job to find similarities across two Excel files.</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {jobs.map(j => (
        <Link
          key={j.id}
          to={j.status === 'ready' ? `/compare/${j.id}` : '#'}
          className={`block bg-white rounded-xl border border-gray-200 px-6 py-5
            hover:border-blue-300 hover:shadow-sm transition-all
            ${j.status !== 'ready' ? 'opacity-60 cursor-default' : ''}`}
        >
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-gray-900">{j.name}</h3>
              <p className="text-sm text-gray-500 mt-0.5">
                <span className="font-medium text-gray-700">{j.label_left}</span>
                <span className="mx-2 text-gray-300">vs</span>
                <span className="font-medium text-gray-700">{j.label_right}</span>
              </p>
              <p className="text-sm text-gray-400 mt-0.5">
                {j.row_count_left != null ? `${j.row_count_left.toLocaleString()} left` : '—'}
                {' · '}
                {j.row_count_right != null ? `${j.row_count_right.toLocaleString()} right` : '—'}
                {' · '}
                {new Date(j.created_at).toLocaleDateString()}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <StatusBadge status={j.status} />
              <button
                onClick={(e) => handleDelete(e, j)}
                disabled={deletingId === j.id}
                className="p-1.5 rounded-lg text-gray-300 hover:text-red-500 hover:bg-red-50 transition-colors disabled:opacity-40"
                title="Delete job"
              >
                {deletingId === j.id ? '…' : '✕'}
              </button>
            </div>
          </div>
        </Link>
      ))}
    </div>
  )
}

// ── Home ───────────────────────────────────────────────────────────────────

export default function Home() {
  const [activeTab, setActiveTab] = useState('search')
  const [now, setNow] = useState(Date.now())
  const [recentHistory, setRecentHistory] = useState(() => loadHistory().slice(0, 5))

  // Tick every second while projects are ingesting
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: getProjects })
  const hasIngesting = projects.some(p => p.status === 'ingesting')
  useEffect(() => {
    if (!hasIngesting) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [hasIngesting])

  useEffect(() => {
    return subscribeHistoryUpdates(() => {
      setRecentHistory(loadHistory().slice(0, 5))
    })
  }, [])

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Fixed header */}
      <div className="fixed top-0 left-0 right-0 z-20 bg-blue-600 border-b border-blue-700">
        <div className="w-[90%] mx-auto py-4">
          <div className="flex items-center justify-between">
            <div className="flex-1 min-w-0 pr-6">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <Link to="/" className="text-2xl font-bold text-white tracking-tight hover:text-blue-100 transition-colors">
                  LENS 🔍
                </Link>
                <span className="text-blue-100 text-sm">
                  <span className="font-semibold text-white">L</span>ightweight{' '}
                  <span className="font-semibold text-white">E</span>
                  <span className="font-semibold text-white">N</span>gineering{' '}
                  <span className="font-semibold text-white">S</span>earch
                </span>
              </div>
              <p className="text-blue-100 mt-1 max-w-none">
                Turn a spreadsheet knowledge base into a fast loop: retrieve, explore, and validate. Search results,
                cluster themes, run evals, and export to iterate in minutes. 🔎 Type it the way you'd say it - free
                form; the system matches meaning, not just exact keywords!
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Link
                to="/system"
                className="border border-blue-200 text-white px-4 py-2 rounded-lg font-medium hover:bg-blue-500 transition-colors"
              >
                System 🛠️
              </Link>
              {activeTab === 'search' ? (
                <Link
                  to="/projects/new"
                  data-testid="new-project"
                  className="bg-white text-blue-700 px-4 py-2 rounded-lg font-medium hover:bg-blue-50 transition-colors"
                >
                  + New Project
                </Link>
              ) : (
                <Link
                  to="/compare/new"
                  className="bg-white text-blue-700 px-4 py-2 rounded-lg font-medium hover:bg-blue-50 transition-colors"
                >
                  + New Compare Job
                </Link>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="w-[90%] mx-auto py-12 pt-28">
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-5">

          {/* Main content — wider column */}
          <div className="lg:col-span-3">

            {/* Tab bar */}
            <div className="flex gap-1 mb-4 bg-gray-100 rounded-lg p-1 w-fit">
              <button
                onClick={() => setActiveTab('search')}
                className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  activeTab === 'search'
                    ? 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                🔍 Search Projects
              </button>
              <button
                onClick={() => setActiveTab('compare')}
                className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  activeTab === 'compare'
                    ? 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                ⚖️ Compare Jobs
              </button>
            </div>

            {activeTab === 'search' ? <SearchTab now={now} /> : <CompareTab />}
          </div>

          {/* Recent activity — narrower column */}
          <div className="lg:col-span-2">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest">Recent Activity</h2>
              {recentHistory.length > 0 && (
                <Link to="/history" className="text-xs text-blue-600 hover:text-blue-700 font-medium">
                  View all →
                </Link>
              )}
            </div>

            {recentHistory.length === 0 ? (
              <div className="bg-white rounded-xl border border-gray-200 px-5 py-8 text-center text-gray-400 text-sm">
                No activity yet.<br />Run a search or clustering to see it here.
              </div>
            ) : (
              <div className="space-y-2">
                {recentHistory.map(entry => (
                  <Link
                    key={entry.id}
                    to={`/history?open=${encodeURIComponent(entry.id)}`}
                    className="bg-white rounded-xl border border-gray-200 px-4 py-3 flex items-start gap-3 hover:border-blue-300 hover:shadow-sm transition-all"
                    title="Open in History"
                  >
                    <span className={`mt-0.5 shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${
                      entry.type === 'search'
                        ? 'bg-blue-100 text-blue-700'
                        : entry.type === 'cluster'
                          ? 'bg-emerald-100 text-emerald-700'
                          : 'bg-purple-100 text-purple-700'
                    }`}>
                      {entry.type === 'search' ? 'S' : entry.type === 'cluster' ? 'C' : 'E'}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-gray-800 truncate font-medium">
                        {entry.type === 'search'
                          ? entry.query
                          : entry.type === 'cluster'
                            ? `${entry.algorithm === 'kmeans' ? `K-Means k=${entry.k}` : 'DBSCAN'} · ${entry.n_clusters} cluster${entry.n_clusters !== 1 ? 's' : ''}`
                            : `${entry.test_case_count} question eval`}
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">{entry.project_name} · {timeAgo(entry.at)}</p>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  )
}

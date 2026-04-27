import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { getProjects } from '../api/client'
import { loadHistory } from '../utils/history'

const statusColor = {
  ready: 'bg-emerald-100 text-emerald-700',
  ingesting: 'bg-amber-100 text-amber-700',
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

export default function Home() {
  const navigate = useNavigate()
  const { data: projects = [], isLoading } = useQuery({
    queryKey: ['projects'],
    queryFn: getProjects,
    refetchInterval: 3000
  })

  const recentHistory = loadHistory().slice(0, 5)

  const handleRerun = (entry) => {
    navigate(`/projects/${entry.project_id}/search`, {
      state: { query: entry.query, mode: entry.mode, k: entry.k },
    })
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-4xl mx-auto px-6 py-12">

        {/* Header */}
        <div className="flex items-center justify-between mb-10">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 tracking-tight">LENS</h1>
            <p className="text-gray-500 mt-1">Lightweight ENgineering Search</p>
          </div>
          <Link
            to="/projects/new"
            className="bg-blue-600 text-white px-5 py-2.5 rounded-lg font-medium hover:bg-blue-700 transition-colors"
          >
            + New Project
          </Link>
        </div>

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-5">

          {/* Projects list — wider column */}
          <div className="lg:col-span-3">
            <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">Projects</h2>
            {isLoading ? (
              <p className="text-gray-400">Loading projects...</p>
            ) : projects.length === 0 ? (
              <div className="text-center py-20 text-gray-400">
                <p className="text-lg">No projects yet.</p>
                <p className="mt-1">Create your first project to get started.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {projects.map(p => (
                  <Link
                    key={p.id}
                    to={p.status === 'ready' ? `/projects/${p.id}/search` : '#'}
                    className={`block bg-white rounded-xl border border-gray-200 px-6 py-5
                      hover:border-blue-300 hover:shadow-sm transition-all
                      ${p.status !== 'ready' ? 'opacity-60 cursor-default' : ''}`}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="font-semibold text-gray-900">{p.name}</h3>
                        <p className="text-sm text-gray-400 mt-0.5">
                          {p.row_count ? `${p.row_count.toLocaleString()} records` : 'Processing...'}
                          {' · '}
                          {new Date(p.created_at).toLocaleDateString()}
                        </p>
                      </div>
                      <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${statusColor[p.status] || statusColor.pending}`}>
                        {p.status}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            )}
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
                No activity yet.<br />Run a search to see it here.
              </div>
            ) : (
              <div className="space-y-2">
                {recentHistory.map(entry => (
                  <div
                    key={entry.id}
                    className="bg-white rounded-xl border border-gray-200 px-4 py-3 flex items-start gap-3"
                  >
                    <span className={`mt-0.5 shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${
                      entry.type === 'search'
                        ? 'bg-blue-100 text-blue-700'
                        : 'bg-purple-100 text-purple-700'
                    }`}>
                      {entry.type === 'search' ? 'S' : 'E'}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-gray-800 truncate font-medium">
                        {entry.type === 'search'
                          ? entry.query
                          : `${entry.test_case_count} question eval`}
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">{entry.project_name} · {timeAgo(entry.at)}</p>
                    </div>
                    {entry.type === 'search' && (
                      <button
                        onClick={() => handleRerun(entry)}
                        className="shrink-0 text-xs text-blue-600 hover:text-blue-700 font-medium mt-0.5"
                      >
                        ↩
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  )
}

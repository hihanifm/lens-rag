import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { getProjects } from '../api/client'

const statusColor = {
  ready: 'bg-emerald-100 text-emerald-700',
  ingesting: 'bg-amber-100 text-amber-700',
  pending: 'bg-gray-100 text-gray-600',
  error: 'bg-red-100 text-red-700'
}

export default function Home() {
  const { data: projects = [], isLoading } = useQuery({
    queryKey: ['projects'],
    queryFn: getProjects,
    refetchInterval: 3000 // poll for status updates
  })

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

        {/* Projects list */}
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
                    <h2 className="font-semibold text-gray-900">{p.name}</h2>
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
    </div>
  )
}

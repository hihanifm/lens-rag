import { useParams, Link, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getProject, getProjectSystemConfig } from '../api/client'
import { useProjectPin } from '../hooks/useProjectPin'
import PinGate from '../components/PinGate'

function InfoCard({ title, children }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 mb-6">
      <h2 className="text-base font-semibold text-gray-900 mb-4">{title}</h2>
      <div className="text-sm text-gray-600 space-y-3">{children}</div>
    </div>
  )
}

function Row({ label, value }) {
  return (
    <div className="flex flex-wrap gap-x-2 gap-y-1">
      <span className="font-medium text-gray-700 shrink-0">{label}</span>
      <span className="font-mono text-gray-900 break-all">{value}</span>
    </div>
  )
}

export default function SystemConfig() {
  const { projectId } = useParams()
  const location = useLocation()

  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId),
  })

  const { isLocked, unlockWithPin } = useProjectPin(projectId, project?.has_pin)

  const { data: cfg, isLoading, isError, error } = useQuery({
    queryKey: ['system-config', projectId],
    queryFn: () => getProjectSystemConfig(projectId),
    enabled: !!project && !isLocked,
  })

  const tabs = [
    { label: 'Search Pro 🚀🔥', path: 'search' },
    { label: 'Evaluate 🧪', path: 'evaluate' },
    { label: 'Browse 👀', path: 'browse' },
    { label: 'Cluster 🧩', path: 'cluster' },
    { label: 'System 🛠️', path: 'system' },
    { label: project?.has_pin ? 'Settings ⚙️ 🔒' : 'Settings ⚙️', path: 'settings' },
  ]

  if (project && isLocked) return <PinGate onUnlock={unlockWithPin} />

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="w-[90%] mx-auto py-10">
        <div className="mb-8">
          <Link to="/" className="text-sm text-gray-400 hover:text-gray-600">← Projects</Link>
          <div className="flex items-center gap-2 mt-1">
            <h1 className="text-2xl font-bold text-gray-900">{project?.name}</h1>
            {project?.has_pin && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 text-xs font-medium">
                <span aria-hidden>🔒</span>
                PIN protected
              </span>
            )}
          </div>
          <p className="text-sm text-gray-400 mb-4">
            {project?.row_count?.toLocaleString()} records
            {project?.source_filename && <span className="ml-2 text-gray-300">·</span>}
            {project?.source_filename && (
              <span className="ml-2 font-mono">{project.source_filename}</span>
            )}
          </p>
          <div className="flex flex-wrap gap-1">
            {tabs.map(({ label, path }) => (
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

        <p className="text-sm text-gray-500 mb-6 max-w-3xl">
          Read-only system view of the retrieval configuration used by the server (models, dimensions, reranker, and pgvector settings).
          Values come from environment and the running PostgreSQL / pgvector instance.
        </p>

        {isLoading && <p className="text-gray-400">Loading configuration...</p>}
        {isError && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm">
            {(() => {
              const d = error?.response?.data?.detail
              if (typeof d === 'string') return d
              if (Array.isArray(d)) return d.map((x) => x.msg || JSON.stringify(x)).join(' — ')
              if (d) return JSON.stringify(d)
              return error?.message || 'Failed to load system configuration.'
            })()}
          </div>
        )}

        {cfg && (
          <>
            <InfoCard title="Embedding">
              <Row label="Provider:" value={cfg.embedding_provider} />
              <Row label="Model:" value={cfg.embedding_model} />
              <Row label="Dimensions:" value={String(cfg.embedding_dims)} />
            </InfoCard>

            <InfoCard title="Reranker (topic mode)">
              <Row label="Enabled:" value={cfg.reranker_enabled ? 'yes' : 'no'} />
              <Row label="Model:" value={cfg.reranker_model} />
            </InfoCard>

            <InfoCard title="Candidate pool (topic mode)">
              <Row label="Internal retrieval K:" value={String(cfg.top_k_retrieval)} />
              <Row label="Default user K:" value={String(cfg.top_k_default)} />
              <Row label="Max user K:" value={String(cfg.top_k_max)} />
            </InfoCard>

            <InfoCard title="Indexes">
              <Row label="pgvector:" value={cfg.pgvector_version ?? 'unknown'} />
              <p className="text-gray-600 leading-relaxed">{cfg.vector_index}</p>
              <p className="text-gray-600 leading-relaxed mt-2">{cfg.keyword_search}</p>
            </InfoCard>

            <InfoCard title="HNSW (pgvector)">
              <Row label="m (typical default):" value={String(cfg.hnsw_m_default)} />
              <Row label="ef_construction (typical default):" value={String(cfg.hnsw_ef_construction_default)} />
              <Row
                label="ef_search (session current_setting):"
                value={cfg.hnsw_ef_search ?? '(unset — pgvector uses its default for queries)'}
              />
              <p className="text-xs text-gray-500 leading-relaxed mt-2">{cfg.hnsw_defaults_note}</p>
            </InfoCard>

            <InfoCard title="Topic pipeline">
              <p className="text-gray-600 leading-relaxed">{cfg.topic_pipeline}</p>
            </InfoCard>
          </>
        )}
      </div>
    </div>
  )
}

import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getSystemConfig } from '../api/client'

const DEFAULT_TOPIC_PIPELINE =
  'Topic mode: embed query → top-K cosine neighbors (HNSW) + top-K lexical matches → merged (RRF or vector-primary) → optional reranker (Ollama cross-encoder) → top-k results.'

function PipelineFlow() {
  const steps = [
    { title: 'Embed query', detail: 'bge-m3' },
    { title: 'Vector search', detail: 'pgvector HNSW' },
    { title: 'Keyword search', detail: 'BM25-ish (tsvector)' },
    { title: 'Merge', detail: 'RRF / vector-primary' },
    { title: 'Rerank', detail: 'optional cross-encoder' },
    { title: 'Return', detail: 'top-k rows' },
  ]

  return (
    <div className="flex flex-wrap items-start gap-2">
      {steps.map((s, idx) => (
        <div key={s.title} className="flex items-start gap-2">
          <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
            <div className="text-xs font-semibold text-gray-800">{idx + 1}. {s.title}</div>
            <div className="text-[11px] text-gray-500">{s.detail}</div>
          </div>
          {idx < steps.length - 1 && (
            <span className="text-gray-300 select-none mt-3" aria-hidden>→</span>
          )}
        </div>
      ))}
    </div>
  )
}

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

export default function System() {
  const { data: cfg, isLoading, isError, error } = useQuery({
    queryKey: ['system-config'],
    queryFn: getSystemConfig,
  })

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="w-[90%] mx-auto py-10 max-w-4xl">
        <div className="mb-8">
          <Link to="/" className="text-sm text-gray-400 hover:text-gray-600">← Home</Link>
          <div className="flex items-center gap-2 mt-1">
            <h1 className="text-2xl font-bold text-gray-900">System 🛠️</h1>
          </div>
          <p className="text-sm text-gray-500 mt-4 max-w-3xl">
            Read-only view of the retrieval configuration used by the server (models, dimensions, reranker, and pgvector settings).
          </p>
        </div>

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
            <InfoCard title="Topic pipeline">
              <PipelineFlow />
              <p className="text-xs text-gray-500 leading-relaxed mt-3">{cfg.topic_pipeline || DEFAULT_TOPIC_PIPELINE}</p>
            </InfoCard>

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
          </>
        )}
      </div>
    </div>
  )
}


export default function StatsPanel({ stats }) {
  if (!stats) return null

  const isId = stats.mode === 'id'

  const rows = isId
    ? [{ label: 'SQL lookup', ms: stats.sql_lookup_ms }]
    : [
        { label: 'Query embedding', ms: stats.embedding_ms },
        { label: 'Vector search',   ms: stats.vector_search_ms, count: stats.vector_candidates },
        { label: 'BM25 search',     ms: stats.bm25_search_ms,   count: stats.bm25_candidates },
        { label: 'RRF merge',       ms: stats.rrf_merge_ms,     count: stats.candidates_retrieved, alwaysShow: true },
        { label: 'Re-ranker',       ms: stats.reranker_ms,      count: stats.results_returned,     alwaysShow: true },
      ]

  const maxMs = Math.max(...rows.map(r => r.ms || 0))

  return (
    <div className="bg-gray-50 border border-gray-200 rounded-xl p-5 mt-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-gray-700">Search breakdown</h3>
        <div className="text-right">
          <span className="text-sm text-gray-500">{stats.results_returned} results</span>
          {stats.candidates_retrieved && (
            <span className="text-sm text-gray-400"> · from {stats.candidates_retrieved} candidates</span>
          )}
          <span className="ml-3 text-sm font-semibold text-gray-800">{stats.total_ms}ms total</span>
        </div>
      </div>

      <div className="space-y-2">
        {rows.map(({ label, ms, count, alwaysShow }) => (
          (ms != null || alwaysShow) ? (
            <div key={label} className="flex items-center gap-3">
              <div className="w-36 shrink-0 flex items-center gap-1.5">
                <span className="text-xs text-gray-500">{label}</span>
                {count != null && (
                  <span className="text-xs text-gray-400 tabular-nums">· {count}</span>
                )}
              </div>
              <div className="flex-1 bg-gray-200 rounded-full h-1.5">
                <div
                  className="bg-blue-500 h-1.5 rounded-full"
                  style={{ width: ms != null && maxMs > 0 ? `${(ms / maxMs) * 100}%` : '0%' }}
                />
              </div>
              <span className="text-xs text-gray-600 w-14 text-right">
                {ms != null ? `${ms}ms` : '—'}
              </span>
            </div>
          ) : null
        ))}
        <div className="border-t border-gray-200 pt-2 flex items-center gap-3">
          <span className="text-xs font-medium text-gray-700 w-36 shrink-0">Total</span>
          <div className="flex-1" />
          <span className="text-xs font-semibold text-gray-800 w-14 text-right">{stats.total_ms}ms</span>
        </div>
      </div>
    </div>
  )
}

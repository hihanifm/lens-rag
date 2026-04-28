const KEY = 'lens_history'
const MAX_ENTRIES = 100
const HISTORY_UPDATED_EVENT = 'lens_history_updated'

/** Returns a filesystem-safe datetime string: YYYY-MM-DD_HH-MM */
export function fileDateTime(date = new Date()) {
  const pad = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}`
}

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]')
  } catch {
    return []
  }
}

function save(entries) {
  localStorage.setItem(KEY, JSON.stringify(entries))
  // Same-tab updates: storage event doesn't fire, so dispatch our own.
  try {
    window.dispatchEvent(new CustomEvent(HISTORY_UPDATED_EVENT))
  } catch {
    // no-op (SSR / tests / older browsers)
  }
}

function append(entry) {
  const entries = [entry, ...load()].slice(0, MAX_ENTRIES)
  save(entries)
}

export function saveSearch({
  project_id, project_name, query, mode, legacy_method, k,
  results_returned, total_ms, display_columns, results,
  use_vector = true, use_bm25 = true, use_rrf = true, use_rerank = true,
}) {
  append({
    id: Date.now(),
    type: 'search',
    project_id,
    project_name,
    query,
    mode,
    legacy_method: legacy_method ?? null,
    k,
    results_returned,
    total_ms,
    display_columns: display_columns ?? [],
    results: results ?? [],
    use_vector,
    use_bm25,
    use_rrf,
    use_rerank,
    at: new Date().toISOString(),
  })
}

export function saveEval({ project_id, project_name, test_case_count, k, results, use_vector = true, use_bm25 = true, use_rrf = true, use_rerank = true }) {
  append({
    id: Date.now(),
    type: 'evaluate',
    project_id,
    project_name,
    test_case_count,
    k,
    results: results ?? [],
    use_vector,
    use_bm25,
    use_rrf,
    use_rerank,
    at: new Date().toISOString(),
  })
}

export function saveCluster({
  project_id, project_name, algorithm, k, filters, filter_column, filter_value, n_clusters, records_loaded, total_ms, groups, display_columns,
}) {
  append({
    id: Date.now(),
    type: 'cluster',
    project_id,
    project_name,
    algorithm,
    k: k ?? null,
    filters: filters ?? undefined,
    filter_column: filter_column ?? null,
    filter_value: filter_value ?? null,
    n_clusters,
    records_loaded,
    total_ms,
    groups: groups ?? [],
    display_columns: display_columns ?? [],
    at: new Date().toISOString(),
  })
}

export function loadHistory() {
  return load()
}

export function clearHistory() {
  localStorage.removeItem(KEY)
  try {
    window.dispatchEvent(new CustomEvent(HISTORY_UPDATED_EVENT))
  } catch {
    // no-op
  }
}

export function subscribeHistoryUpdates(cb) {
  if (typeof window === 'undefined') return () => {}
  const handler = () => cb?.()
  const storageHandler = (e) => {
    if (e.key === KEY) handler()
  }
  window.addEventListener(HISTORY_UPDATED_EVENT, handler)
  // Also listen for cross-tab updates.
  window.addEventListener('storage', storageHandler)
  return () => {
    window.removeEventListener(HISTORY_UPDATED_EVENT, handler)
    window.removeEventListener('storage', storageHandler)
  }
}

export function exportHistoryCSV() {
  const entries = load()
  if (!entries.length) return

  const headers = ['type', 'project', 'query / test cases', 'mode', 'k', 'results', 'latency_ms', 'at']
  const rows = entries.map(e => [
    e.type,
    e.project_name,
    e.type === 'search'
      ? e.query
      : e.type === 'cluster'
        ? (() => {
            const tail = e.filters?.length
              ? e.filters.map(f => {
                  if (f.values?.length) return `${f.column}=(${f.values.join(' | ')})`
                  if (f.value != null && f.value !== '') return `${f.column}=${f.value}`
                  return ''
                }).filter(Boolean).join(' & ')
              : (e.filter_column ? `${e.filter_column}=${e.filter_value}` : '')
            return `${e.algorithm}${e.k ? ` k=${e.k}` : ''}${tail ? ` [${tail}]` : ''}`
          })()
        : `${e.test_case_count} questions`,
    e.mode ?? '',
    e.k ?? '',
    e.type === 'search' ? e.results_returned : e.type === 'cluster' ? e.n_clusters : '',
    e.type === 'search' || e.type === 'cluster' ? (e.total_ms ?? '') : '',
    e.at,
  ])

  const csv = [headers, ...rows]
    .map(row => row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n')

  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `lens_history_${fileDateTime()}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

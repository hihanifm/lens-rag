const KEY = 'lens_history'
const MAX_ENTRIES = 100

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
}

function append(entry) {
  const entries = [entry, ...load()].slice(0, MAX_ENTRIES)
  save(entries)
}

export function saveSearch({ project_id, project_name, query, mode, k, results_returned, total_ms, display_columns, results, use_vector = true, use_bm25 = true, use_rrf = true, use_rerank = true }) {
  append({
    id: Date.now(),
    type: 'search',
    project_id,
    project_name,
    query,
    mode,
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

export function loadHistory() {
  return load()
}

export function clearHistory() {
  localStorage.removeItem(KEY)
}

export function exportHistoryCSV() {
  const entries = load()
  if (!entries.length) return

  const headers = ['type', 'project', 'query / test cases', 'mode', 'k', 'results', 'latency_ms', 'at']
  const rows = entries.map(e => [
    e.type,
    e.project_name,
    e.type === 'search' ? e.query : `${e.test_case_count} questions`,
    e.mode ?? '',
    e.k,
    e.type === 'search' ? e.results_returned : '',
    e.type === 'search' ? (e.total_ms ?? '') : '',
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

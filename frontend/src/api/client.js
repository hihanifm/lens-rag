// api/client.js — ALL API calls live here. Never call axios directly in components.
import axios from 'axios'
import { fileDateTime } from '../utils/history'

// Dev:
// - Leave VITE_API_URL empty so the browser uses same-origin calls (Vite proxy handles API).
// Prod:
// - VITE_API_URL is typically unset; BASE_URL is /lens-rag/ and API calls are same-origin.
const _explicitApiBase = (import.meta.env.VITE_API_URL ?? '').trim()
export const API_BASE_URL = _explicitApiBase
  ? _explicitApiBase.replace(/\/$/, '')
  : (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '')

const api = axios.create({
  // Important: axios treats `baseURL: ''` as "no base" and then resolves relative
  // request URLs against the current SPA route (e.g. /projects/new), producing
  // paths like /projects/projects. When the app base is '/', keep axios anchored
  // at the origin root by using '/' as the base.
  baseURL: API_BASE_URL || '/',
  headers: { 'Content-Type': 'application/json' }
})

// Safety: if someone accidentally uses a leading '/' (e.g. '/models'), axios will
// ignore baseURL path prefixes like '/lens-rag'. Normalize to a relative URL so
// baseURL is always respected.
api.interceptors.request.use((config) => {
  if (typeof config.url === 'string' && config.url.startsWith('/')) {
    config.url = config.url.replace(/^\/+/, '')
  }
  return config
})

// ── Per-project PIN (localStorage) ─────────────────────────────────────────

export const getProjectPin = (projectId) =>
  localStorage.getItem(`lens_pin_${projectId}`) ?? ''

export const setProjectPin = (projectId, pin) =>
  localStorage.setItem(`lens_pin_${projectId}`, pin)

export const clearProjectPin = (projectId) =>
  localStorage.removeItem(`lens_pin_${projectId}`)

export const projectHeaders = (projectId) => {
  const pin = getProjectPin(projectId)
  return pin ? { 'X-Project-Pin': pin } : {}
}

export const verifyProjectPin = (projectId, pin) =>
  api.post(`projects/${projectId}/verify-pin`, { pin }).then(r => r.data)

// ── Health ────────────────────────────────────────────────────────────────

export const getHealth = () => api.get('health').then(r => r.data)

// ── Projects ──────────────────────────────────────────────────────────────

export const getProjects = () =>
  api.get('projects').then(r => r.data)

export const getProject = (id) =>
  api.get(`projects/${id}`).then(r => r.data)

export const createProject = (data) =>
  api.post('projects', data).then(r => r.data)

export const updateProject = (id, data) =>
  api.patch(`projects/${id}`, data, { headers: projectHeaders(id) }).then(r => r.data)

export const deleteProject = (id) =>
  api.delete(`projects/${id}`, { headers: projectHeaders(id) }).then(r => r.data)

export const getProjectColumns = (id) =>
  api.get(`projects/${id}/columns`, { headers: projectHeaders(id) }).then(r => r.data)

export const getSystemConfig = () =>
  api.get('system-config').then(r => r.data)

export const fetchModels = (url, apiKey) => {
  const params = new URLSearchParams({ url })
  if (apiKey) params.set('api_key', apiKey)
  return api.get(`models?${params}`).then(r => r.data.models)
}

/** One embed probe; same shape as create-project Connection fields. */
export const verifyEmbedding = (body) =>
  api.post('embedding/verify', body).then(r => r.data)

/** One rerank probe (server-side Ollama only). */
export const verifyRerank = (body) =>
  api.post('rerank/verify', body).then(r => r.data)

export const browseProject = (id) =>
  api.get(`projects/${id}/browse`, { headers: projectHeaders(id) }).then(r => r.data)

// ── Excel Upload ──────────────────────────────────────────────────────────

export const previewExcel = (file) => {
  const form = new FormData()
  form.append('file', file)
  // Use native fetch — the axios instance default Content-Type: application/json
  // overrides multipart detection. fetch lets the browser set the correct
  // multipart/form-data boundary automatically.
  return fetch(`${API_BASE_URL}/projects/preview`, { method: 'POST', body: form })
    .then(r => r.json())
}

// ── Search ────────────────────────────────────────────────────────────────

export const searchProject = (projectId, query, mode, k, legacy_method) =>
  api.post(
    `projects/${projectId}/search`,
    { query, mode, k, legacy_method },
    { headers: projectHeaders(projectId) }
  ).then(r => r.data)

// ── Evaluate ──────────────────────────────────────────────────────────────

export const streamEvaluation = (projectId, testCases, k, onProgress, onComplete, onError) => {
  fetch(`${API_BASE_URL}/projects/${projectId}/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...projectHeaders(projectId) },
    body: JSON.stringify({ test_cases: testCases, k }),
  }).then(async (res) => {
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n\n')
      buffer = lines.pop()
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const event = JSON.parse(line.slice(6))
        if (event.type === 'question_start') onProgress({ ...event, currentStep: null })
        if (event.type === 'step') onProgress({ ...event })
        if (event.type === 'progress') onProgress({ ...event, currentStep: null })
        if (event.type === 'complete') onComplete(event.results)
      }
    }
  }).catch(onError)
}

// ── Export ────────────────────────────────────────────────────────────────

export const exportResults = async (projectId, query, mode, k, projectName = '', pipeline = {}) => {
  const {
    use_vector = true, use_bm25 = true, use_rrf = true, use_rerank = true,
    legacy_method,
  } = pipeline
  const response = await api.post(
    `projects/${projectId}/export`,
    { query, mode, legacy_method, k, use_vector, use_bm25, use_rrf, use_rerank },
    { responseType: 'blob', headers: projectHeaders(projectId) }
  )
  const slug = projectName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
  const filename = `${slug}_lens_results_${fileDateTime()}.xlsx`
  const url = window.URL.createObjectURL(new Blob([response.data]))
  const link = document.createElement('a')
  link.href = url
  link.setAttribute('download', filename)
  document.body.appendChild(link)
  link.click()
  link.remove()
}

// ── Cluster ───────────────────────────────────────────────────────────────

export const getColumnValues = (projectId, column) =>
  api.get(`projects/${projectId}/column-values`, {
    params: { column },
    headers: projectHeaders(projectId),
  }).then(r => r.data)

export const clusterRecords = (projectId, algorithm, k, filters) =>
  api.post(
    `projects/${projectId}/cluster`,
    {
      algorithm,
      k: k ?? null,
      filters: filters ?? [],
    },
    { headers: projectHeaders(projectId) }
  ).then(r => r.data)

export const exportCluster = async (projectId, algorithm, k, filters, projectName = '') => {
  const response = await api.post(
    `projects/${projectId}/cluster/export`,
    {
      algorithm,
      k: k ?? null,
      filters: filters ?? [],
    },
    { responseType: 'blob', headers: projectHeaders(projectId) }
  )
  const slug = projectName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
  const filename = `${slug}_lens_clusters_${fileDateTime()}.xlsx`
  const url = window.URL.createObjectURL(new Blob([response.data]))
  const link = document.createElement('a')
  link.href = url
  link.setAttribute('download', filename)
  document.body.appendChild(link)
  link.click()
  link.remove()
}

// ── Compare ───────────────────────────────────────────────────────────────

export const previewCompareFile = (file, side) => {
  const form = new FormData()
  form.append('file', file)
  return fetch(`${API_BASE_URL}/compare/preview-${side}`, { method: 'POST', body: form })
    .then(r => r.json())
}

export const createCompareJob = (data) =>
  api.post('compare/', data).then(r => r.data)

export const previewCompareContext = (tmpPath, matchColumns, n = 3, options = {}) =>
  api.post('compare/preview-context', {
    tmp_path: tmpPath,
    match_columns: matchColumns,
    n,
    sheet_name: options.sheetName ?? null,
    row_filters: options.rowFilters ?? [],
  }).then(r => r.data)

export const previewCompareRowStats = (tmpPath, { sheetName = null, rowFilters = [] } = {}) =>
  api.post('compare/preview-row-stats', {
    tmp_path: tmpPath,
    sheet_name: sheetName || null,
    row_filters: rowFilters,
  }).then(r => r.data)

/** Distinct values for a column (max 100); rowFilters = sibling filters only. */
export const previewCompareColumnValues = (tmpPath, { sheetName = null, column, rowFilters = [] } = {}) =>
  api.post('compare/preview-column-values', {
    tmp_path: tmpPath,
    sheet_name: sheetName || null,
    column: column || '',
    row_filters: rowFilters,
  }).then(r => r.data)

/** First n row values per column (after filters); for column-picker hints. */
export const previewCompareColumnSamples = (tmpPath, { sheetName = null, rowFilters = [], columns = [], n = 1 } = {}) =>
  api.post('compare/preview-column-samples', {
    tmp_path: tmpPath,
    sheet_name: sheetName || null,
    row_filters: rowFilters,
    columns,
    n,
  }).then(r => r.data)

export const listCompareJobs = () =>
  api.get('compare/').then(r => r.data)

export const getCompareJob = (jobId) =>
  api.get(`compare/${jobId}`).then(r => r.data)

export const updateCompareJob = (jobId, patch) =>
  api.patch(`compare/${jobId}`, patch).then(r => r.data)

export const deleteCompareJob = (jobId) =>
  api.delete(`compare/${jobId}`).then(r => r.data)

export const browseCompareJob = (jobId, { side = null, limit = 25 } = {}) =>
  api.get(`compare/${jobId}/browse`, {
    params: { side: side || undefined, limit },
  }).then(r => r.data)

export const getCompareConfigStats = (jobId) =>
  api.get(`compare/${jobId}/config-stats`).then(r => r.data)

/** Built-in LLM judge system prompt and generation limits (read-only). */
export const getCompareLlmJudgeDefaults = () =>
  api.get('compare/llm-judge-defaults').then(r => r.data)

// ── Compare Runs ──────────────────────────────────────────────────────────

export const createRun = (jobId, data) =>
  api.post(`compare/${jobId}/runs`, data).then(r => r.data)

export const listRuns = (jobId) =>
  api.get(`compare/${jobId}/runs`).then(r => r.data)

export const getRun = (jobId, runId) =>
  api.get(`compare/${jobId}/runs/${runId}`).then(r => r.data)

export const updateRun = (jobId, runId, body) =>
  api.patch(`compare/${jobId}/runs/${runId}`, body).then(r => r.data)

export const deleteRun = (jobId, runId) =>
  api.delete(`compare/${jobId}/runs/${runId}`).then(r => r.data)

export const getRunReviewStats = (jobId, runId) =>
  api.get(`compare/${jobId}/runs/${runId}/review`).then(r => r.data)

export const getNextRunReviewItem = (
  jobId,
  runId,
  { minScore = 0, offset = 0, includeDecided = false, textContains = '' } = {},
) =>
  api.get(`compare/${jobId}/runs/${runId}/review/next`, {
    params: {
      min_score: minScore,
      offset,
      include_decided: includeDecided,
      ...(String(textContains).trim() ? { text_contains: String(textContains).trim() } : {}),
    },
  }).then(r => r.data)

export const submitRunDecision = (jobId, runId, leftId, matchedRightId, reviewComment = '') =>
  api.post(`compare/${jobId}/runs/${runId}/review/${leftId}`, {
    matched_right_id: matchedRightId ?? null,
    review_comment: typeof reviewComment === 'string' ? reviewComment : '',
  }).then(r => r.data)

export const clearRunReviewDecision = (jobId, runId, leftId) =>
  api.delete(`compare/${jobId}/runs/${runId}/review/${leftId}`).then(r => r.data)

export const downloadRunExport = async (jobId, runId, type = 'confirmed', jobName = '') => {
  const response = await api.get(`compare/${jobId}/runs/${runId}/export`, {
    params: { type },
    responseType: 'blob',
  })
  const slug = jobName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || 'compare'
  const descriptor = type === 'raw' ? 'raw' : 'confirmed'
  const filename = `${slug}_lens_compare_${descriptor}_${fileDateTime()}.xlsx`
  const url = window.URL.createObjectURL(new Blob([response.data]))
  const link = document.createElement('a')
  link.href = url
  link.setAttribute('download', filename)
  document.body.appendChild(link)
  link.click()
  link.remove()
}

export const browseRunRaw = (jobId, runId, { limit = 50, leftRow = null } = {}) =>
  api.get(`compare/${jobId}/runs/${runId}/browse-raw`, {
    params: { limit, left_row: leftRow ?? undefined },
  }).then(r => r.data)

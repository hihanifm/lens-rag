// api/client.js — ALL API calls live here. Never call axios directly in components.
import axios from 'axios'

export const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: { 'Content-Type': 'application/json' }
})

// ── Health ────────────────────────────────────────────────────────────────

export const getHealth = () => api.get('/health').then(r => r.data)

// ── Projects ──────────────────────────────────────────────────────────────

export const getProjects = () =>
  api.get('/projects').then(r => r.data)

export const getProject = (id) =>
  api.get(`/projects/${id}`).then(r => r.data)

export const createProject = (data) =>
  api.post('/projects', data).then(r => r.data)

export const updateProject = (id, data) =>
  api.patch(`/projects/${id}`, data).then(r => r.data)

export const getProjectColumns = (id) =>
  api.get(`/projects/${id}/columns`).then(r => r.data)

export const browseProject = (id) =>
  api.get(`/projects/${id}/browse`).then(r => r.data)

// ── Excel Upload ──────────────────────────────────────────────────────────

export const previewExcel = (file) => {
  const form = new FormData()
  form.append('file', file)
  return api.post('/upload/preview', form, {
    headers: { 'Content-Type': 'multipart/form-data' }
  }).then(r => r.data)
}

// ── Search ────────────────────────────────────────────────────────────────

export const searchProject = (projectId, query, mode, k) =>
  api.post(`/projects/${projectId}/search`, { query, mode, k }).then(r => r.data)

// ── Evaluate ──────────────────────────────────────────────────────────────

export const streamEvaluation = (projectId, testCases, k, onProgress, onComplete, onError) => {
  fetch(`${API_BASE_URL}/projects/${projectId}/evaluate/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
        if (event.type === 'progress') onProgress(event)
        if (event.type === 'complete') onComplete(event.results)
      }
    }
  }).catch(onError)
}

// ── Export ────────────────────────────────────────────────────────────────

export const exportResults = async (projectId, query, mode, k) => {
  const response = await api.post(
    `/projects/${projectId}/export`,
    { query, mode, k },
    { responseType: 'blob' }
  )
  const url = window.URL.createObjectURL(new Blob([response.data]))
  const link = document.createElement('a')
  link.href = url
  link.setAttribute('download', 'lens_results.xlsx')
  document.body.appendChild(link)
  link.click()
  link.remove()
}

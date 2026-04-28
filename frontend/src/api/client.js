// api/client.js — ALL API calls live here. Never call axios directly in components.
import axios from 'axios'

// In dev: VITE_API_URL=http://localhost:37000 (set in .env.development)
// In prod (built with VITE_BASE_PATH=/lens-rag/): falls back to BASE_URL (/lens-rag)
// → same-origin calls, Caddy strips the prefix before forwarding to FastAPI
export const API_BASE_URL = import.meta.env.VITE_API_URL
  ?? import.meta.env.BASE_URL.replace(/\/$/, '')

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: { 'Content-Type': 'application/json' }
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
  api.post(`/projects/${projectId}/verify-pin`, { pin }).then(r => r.data)

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
  api.patch(`/projects/${id}`, data, { headers: projectHeaders(id) }).then(r => r.data)

export const deleteProject = (id) =>
  api.delete(`/projects/${id}`, { headers: projectHeaders(id) }).then(r => r.data)

export const getProjectColumns = (id) =>
  api.get(`/projects/${id}/columns`, { headers: projectHeaders(id) }).then(r => r.data)

export const browseProject = (id) =>
  api.get(`/projects/${id}/browse`, { headers: projectHeaders(id) }).then(r => r.data)

// ── Excel Upload ──────────────────────────────────────────────────────────

export const previewExcel = (file) => {
  const form = new FormData()
  form.append('file', file)
  return api.post('/projects/preview', form, {
    headers: { 'Content-Type': 'multipart/form-data' }
  }).then(r => r.data)
}

// ── Search ────────────────────────────────────────────────────────────────

export const searchProject = (projectId, query, mode, k) =>
  api.post(
    `/projects/${projectId}/search`,
    { query, mode, k },
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
        if (event.type === 'progress') onProgress(event)
        if (event.type === 'complete') onComplete(event.results)
      }
    }
  }).catch(onError)
}

// ── Export ────────────────────────────────────────────────────────────────

export const exportResults = async (projectId, query, mode, k, projectName = '') => {
  const response = await api.post(
    `/projects/${projectId}/export`,
    { query, mode, k },
    { responseType: 'blob', headers: projectHeaders(projectId) }
  )
  const slug = projectName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
  const date = new Date().toISOString().slice(0, 10)
  const filename = `${slug}_lens_results_${date}.xlsx`
  const url = window.URL.createObjectURL(new Blob([response.data]))
  const link = document.createElement('a')
  link.href = url
  link.setAttribute('download', filename)
  document.body.appendChild(link)
  link.click()
  link.remove()
}

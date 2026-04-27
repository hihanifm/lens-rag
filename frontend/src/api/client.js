// api/client.js — ALL API calls live here. Never call axios directly in components.
import axios from 'axios'

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:8000',
  headers: { 'Content-Type': 'application/json' }
})

// ── Projects ──────────────────────────────────────────────────────────────

export const getProjects = () =>
  api.get('/projects').then(r => r.data)

export const getProject = (id) =>
  api.get(`/projects/${id}`).then(r => r.data)

export const createProject = (data) =>
  api.post('/projects', data).then(r => r.data)

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

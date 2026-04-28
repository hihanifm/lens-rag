import { API_BASE_URL, getProjectPin } from '../api/client'
import { saveCluster } from './history'

/**
 * Keeps cluster SSE runs alive across route changes.
 * - One active run per projectId; a new run aborts the previous.
 * - Subscribers receive snapshots of run state whenever it changes.
 */

const runsByProject = new Map()

function _notify(run) {
  for (const cb of run.subscribers) cb(run.state)
}

function _setState(run, patch) {
  run.state = { ...run.state, ...patch }
  _notify(run)
}

function _initRun(projectId) {
  const run = {
    projectId: String(projectId),
    controller: null,
    subscribers: new Set(),
    state: {
      loading: false,
      currentStep: null,
      stepCounts: {},
      error: '',
      result: null,
      collapsed: {},
    },
  }
  runsByProject.set(run.projectId, run)
  return run
}

function _getRun(projectId) {
  const key = String(projectId)
  return runsByProject.get(key) ?? _initRun(key)
}

async function _streamCluster({
  projectId,
  algorithm,
  k,
  filters,
  projectName,
  displayColumns,
  controller,
  onState,
}) {
  const pin = getProjectPin(projectId)
  const headers = { 'Content-Type': 'application/json' }
  if (pin) headers['X-Project-Pin'] = pin

  const res = await fetch(`${API_BASE_URL}/projects/${projectId}/cluster`, {
    method: 'POST',
    headers,
    signal: controller.signal,
    body: JSON.stringify({
      algorithm,
      k: k ?? null,
      filters: filters ?? [],
    }),
  })

  if (!res.ok) {
    const msg = res.status === 401 ? 'PIN required or incorrect.' : 'Clustering failed. Please try again.'
    onState({ loading: false, currentStep: null, error: msg })
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop()
    for (const part of parts) {
      if (!part.startsWith('data: ')) continue
      const event = JSON.parse(part.slice(6))
      if (event.step === 'complete') {
        const data = event.result
        const initCollapsed = {}
        data.groups.forEach((g, i) => { initCollapsed[g.label] = i >= 3 })
        onState({
          result: data,
          collapsed: initCollapsed,
          currentStep: null,
          loading: false,
        })
        saveCluster({
          project_id: Number(projectId),
          project_name: projectName ?? '',
          algorithm,
          k: k ?? null,
          filters: filters?.length ? filters : undefined,
          filter_column: null,
          filter_value: null,
          n_clusters: data.stats.n_clusters,
          records_loaded: data.stats.records_loaded,
          total_ms: data.stats.total_ms,
          groups: data.groups,
          display_columns: displayColumns ?? [],
        })
      } else if (event.step === 'error') {
        onState({ loading: false, currentStep: null, error: event.message || 'Clustering failed.' })
      } else if (event.step === 'count') {
        onState(prev => ({ stepCounts: { ...prev.stepCounts, [event.for_step]: event.count } }))
      } else {
        onState({ currentStep: event.step })
      }
    }
  }
}

export function subscribeClusterRun(projectId, cb) {
  const run = _getRun(projectId)
  run.subscribers.add(cb)
  cb(run.state)
  return () => {
    run.subscribers.delete(cb)
  }
}

export function getClusterRunState(projectId) {
  return _getRun(projectId).state
}

export function abortClusterRun(projectId) {
  const run = _getRun(projectId)
  run.controller?.abort()
}

export async function startClusterRun({
  projectId,
  algorithm,
  k,
  filters,
  projectName,
  displayColumns,
}) {
  const run = _getRun(projectId)
  run.controller?.abort()
  const controller = new AbortController()
  run.controller = controller

  _setState(run, {
    loading: true,
    error: '',
    result: null,
    currentStep: null,
    stepCounts: {},
    collapsed: {},
  })

  const onState = updater => {
    if (typeof updater === 'function') {
      _setState(run, updater(run.state))
    } else {
      _setState(run, updater)
    }
  }

  try {
    await _streamCluster({
      projectId,
      algorithm,
      k,
      filters,
      projectName,
      displayColumns,
      controller,
      onState,
    })
  } catch (err) {
    if (err?.name === 'AbortError') return
    onState({ loading: false, currentStep: null, error: 'Clustering failed. Please try again.' })
  } finally {
    if (run.controller === controller) run.controller = null
  }
}


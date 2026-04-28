/**
 * ProjectStateContext
 *
 * Persists search and evaluation state per project across tab navigation.
 * Both Search and EvaluateProject components read/write here instead of
 * local useState, so switching tabs never loses in-progress work.
 *
 * Eval streaming runs inside the context so it keeps going even when the
 * EvaluateProject component is unmounted.
 */
import { createContext, useContext, useState, useRef, useCallback } from 'react'
import { API_BASE_URL, getProjectPin } from '../api/client'
import { saveSearch, saveEval } from '../utils/history'

const ProjectStateContext = createContext(null)

const defaultSearch = {
  query: '', mode: 'topic', k: null,
  use_vector: true, use_bm25: true, use_rrf: true, use_rerank: true,
  loading: false, currentStep: null, doneSteps: [],
  results: null, stats: null, error: '',
}

const defaultEval = {
  testCases: null, k: 10,
  use_vector: true, use_bm25: true, use_rrf: true, use_rerank: true,
  loading: false, progress: null,
  results: null, error: '',
}

export function ProjectStateProvider({ children }) {
  const [searchStates, setSearchStates] = useState({})
  const [evalStates, setEvalStates]   = useState({})

  // Active EventSource refs for search (keyed by projectId)
  const searchEvtRefs = useRef({})
  // Active fetch reader refs for eval (keyed by projectId)
  const evalReaderRefs = useRef({})

  // ── Search helpers ──────────────────────────────────────────────────────

  const getSearch = useCallback((pid) =>
    searchStates[pid] ?? defaultSearch, [searchStates])

  const setSearch = useCallback((pid, patch) =>
    setSearchStates(prev => ({
      ...prev,
      [pid]: { ...(prev[pid] ?? defaultSearch), ...(typeof patch === 'function' ? patch(prev[pid] ?? defaultSearch) : patch) },
    })), [])

  const startSearch = useCallback((pid, query, mode, k, projectName, displayColumns, pipeline) => {
    // Abort any existing stream for this project
    searchEvtRefs.current[pid]?.abort()

    const { use_vector, use_bm25, use_rrf, use_rerank } = pipeline

    setSearch(pid, {
      loading: true, error: '', results: null, stats: null,
      currentStep: null, doneSteps: [],
      query, mode, k, use_vector, use_bm25, use_rrf, use_rerank,
    })

    const params = new URLSearchParams({ query, mode, k, use_vector, use_bm25, use_rrf, use_rerank })
    const url = `${API_BASE_URL}/projects/${pid}/search/stream?${params}`

    // Use fetch instead of EventSource so we can include the PIN header.
    // EventSource does not support custom headers.
    const controller = new AbortController()
    searchEvtRefs.current[pid] = controller

    const pin = getProjectPin(pid)
    const headers = {}
    if (pin) headers['X-Project-Pin'] = pin

    fetch(url, { headers, signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {
          const msg = res.status === 401 ? 'PIN required or incorrect.' : 'Search failed. Please try again.'
          setSearch(pid, { loading: false, error: msg, currentStep: null, doneSteps: [] })
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
              delete searchEvtRefs.current[pid]
              const data = event.results
              setSearch(pid, { loading: false, results: data.results, stats: data.stats, currentStep: null, doneSteps: [] })
              saveSearch({
                project_id: Number(pid), project_name: projectName, query, mode, k,
                results_returned: data.results.length, total_ms: data.stats?.total_ms,
                display_columns: displayColumns, results: data.results,
                use_vector, use_bm25, use_rrf, use_rerank,
              })
            } else if (event.step === 'error') {
              delete searchEvtRefs.current[pid]
              setSearch(pid, { loading: false, error: event.message || 'Search failed.', currentStep: null, doneSteps: [] })
            } else {
              setSearch(pid, s => ({
                ...s,
                doneSteps: s.currentStep ? [...s.doneSteps, s.currentStep] : s.doneSteps,
                currentStep: event.step,
              }))
            }
          }
        }
      })
      .catch((err) => {
        if (err.name === 'AbortError') return
        delete searchEvtRefs.current[pid]
        setSearch(pid, { loading: false, error: 'Search failed. Please try again.', currentStep: null, doneSteps: [] })
      })
  }, [setSearch])

  // ── Eval helpers ────────────────────────────────────────────────────────

  const getEval = useCallback((pid) =>
    evalStates[pid] ?? defaultEval, [evalStates])

  const setEval = useCallback((pid, patch) =>
    setEvalStates(prev => ({
      ...prev,
      [pid]: { ...(prev[pid] ?? defaultEval), ...(typeof patch === 'function' ? patch(prev[pid] ?? defaultEval) : patch) },
    })), [])

  const startEval = useCallback((pid, testCases, k, projectName, pin, pipeline) => {
    // Cancel any existing eval for this project
    evalReaderRefs.current[pid]?.cancel()

    const { use_vector, use_bm25, use_rrf, use_rerank } = pipeline

    setEval(pid, { loading: true, progress: null, results: null, error: '' })

    const headers = { 'Content-Type': 'application/json' }
    if (pin) headers['X-Project-Pin'] = pin

    fetch(`${API_BASE_URL}/projects/${pid}/evaluate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ test_cases: testCases, k, use_vector, use_bm25, use_rrf, use_rerank }),
    }).then(async (res) => {
      const reader = res.body.getReader()
      evalReaderRefs.current[pid] = reader
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
          if (event.type === 'complete') {
            delete evalReaderRefs.current[pid]
            setEval(pid, { loading: false, results: event.results, progress: null })
            saveEval({
              project_id: Number(pid), project_name: projectName,
              test_case_count: event.results.length, k, results: event.results,
              use_vector, use_bm25, use_rrf, use_rerank,
            })
          } else {
            setEval(pid, { progress: event })
          }
        }
      }
    }).catch(() => {
      delete evalReaderRefs.current[pid]
      setEval(pid, { loading: false, error: 'Evaluation failed. Please try again.', progress: null })
    })
  }, [setEval])

  return (
    <ProjectStateContext.Provider value={{ getSearch, setSearch, startSearch, getEval, setEval, startEval }}>
      {children}
    </ProjectStateContext.Provider>
  )
}

export const useProjectState = () => useContext(ProjectStateContext)

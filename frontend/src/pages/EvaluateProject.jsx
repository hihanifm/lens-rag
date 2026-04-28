import { useParams, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getProject } from '../api/client'
import { API_BASE_URL } from '../api/client'
import { useProjectPin } from '../hooks/useProjectPin'
import PinGate from '../components/PinGate'
import { useProjectState } from '../contexts/ProjectStateContext'

export default function EvaluateProject() {
  const { projectId } = useParams()
  const { getEval, setEval, startEval } = useProjectState()
  const ev = getEval(projectId)

  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId)
  })

  const { isLocked, unlockWithPin } = useProjectPin(projectId, project?.has_pin)

  const parseCSVLine = (line) => {
    const result = []
    let current = ''
    let inQuotes = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { current += '"'; i++ }
        else inQuotes = !inQuotes
      } else if (ch === ',' && !inQuotes) {
        result.push(current); current = ''
      } else {
        current += ch
      }
    }
    result.push(current)
    return result
  }

  const handleFileUpload = (e) => {
    const file = e.target.files[0]
    if (!file) return
    setEval(projectId, { error: '', results: null })
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const lines = ev.target.result.trim().split(/\r?\n/)
        const headers = parseCSVLine(lines[0]).map(h => h.trim())
        if (!headers.includes('question') || !headers.includes('ground_truth')) {
          setEval(projectId, { error: 'CSV must have "question" and "ground_truth" columns.' })
          return
        }
        const qi = headers.indexOf('question')
        const gi = headers.indexOf('ground_truth')
        const parsed = lines.slice(1).filter(l => l.trim()).map(line => {
          const vals = parseCSVLine(line)
          return { question: vals[qi]?.trim(), ground_truth: vals[gi]?.trim() }
        }).filter(r => r.question && r.ground_truth)
        if (!parsed.length) { setEval(projectId, { error: 'No valid rows found in CSV.' }); return }
        setEval(projectId, { testCases: parsed })
      } catch {
        setEval(projectId, { error: 'Could not parse CSV file.' })
      }
    }
    reader.readAsText(file)
  }

  const handleRun = () => {
    if (!ev.testCases?.length) return
    const pin = localStorage.getItem(`pin_${projectId}`) ?? undefined
    const pipeline = {
      use_vector: ev.use_vector ?? true,
      use_bm25:   ev.use_bm25   ?? true,
      use_rrf:    ev.use_rrf    ?? true,
      use_rerank: ev.use_rerank ?? true,
    }
    startEval(projectId, ev.testCases, ev.k, project?.name ?? '', pin, pipeline)
  }

  const retrieversOk = (ev.use_vector ?? true) || (ev.use_bm25 ?? true)

  const handleExport = () => {
    if (!ev.results) return
    const slug = (project?.name ?? '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
    const date = new Date().toISOString().slice(0, 10)
    const blob = new Blob([JSON.stringify(ev.results, null, 2)], { type: 'application/json' })
    const url = window.URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.setAttribute('download', `${slug}_lens_ragas_${date}.json`)
    document.body.appendChild(link)
    link.click()
    link.remove()
  }

  if (!project) return <div className="p-8 text-gray-400">Loading...</div>
  if (isLocked) return <PinGate onUnlock={unlockWithPin} />

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="w-[90%] mx-auto py-10">

        {/* Header */}
        <div className="mb-8">
          <Link to="/" className="text-sm text-gray-400 hover:text-gray-600">← Projects</Link>
          <div className="flex items-center gap-2 mt-1">
            <h1 className="text-2xl font-bold text-gray-900">{project.name}</h1>
            {project.has_pin && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 text-xs font-medium">
                <span aria-hidden>🔒</span>
                PIN protected
              </span>
            )}
          </div>
          <p className="text-sm text-gray-400 mb-4">
            {project.row_count?.toLocaleString()} records
            {project.source_filename && <span className="ml-2 text-gray-300">·</span>}
            {project.source_filename && <span className="ml-2 font-mono">{project.source_filename}</span>}
          </p>
          <div className="flex gap-1">
            <Link
              to={`/projects/${projectId}/search`}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors"
            >
              Search
            </Link>
            <Link
              to={`/projects/${projectId}/evaluate`}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white transition-colors"
            >
              Evaluate
            </Link>
            <Link
              to={`/projects/${projectId}/browse`}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors"
            >
              Browse
            </Link>
            <Link
              to={`/projects/${projectId}/settings`}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors"
            >
              <span className="inline-flex items-center gap-1">
                Settings
                {project.has_pin && <span aria-hidden>🔒</span>}
              </span>
            </Link>
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm max-w-2xl">

          {/* Test set upload */}
          <h2 className="text-base font-semibold text-gray-900 mb-1">Test Set</h2>
          <p className="text-sm text-gray-500 mb-4">
            Upload a CSV with <code className="bg-gray-100 px-1 rounded text-xs">question</code> and <code className="bg-gray-100 px-1 rounded text-xs">ground_truth</code> columns.
          </p>

          <div
            className="border-2 border-dashed border-gray-300 rounded-xl p-8 text-center cursor-pointer hover:border-blue-400 transition-colors mb-2"
            onClick={() => document.getElementById('eval-file-input').click()}
          >
            {ev.testCases ? (
              <p className="text-gray-700 font-medium">{ev.testCases.length} question{ev.testCases.length !== 1 ? 's' : ''} loaded</p>
            ) : (
              <p className="text-gray-400 text-sm">Click to upload test set CSV</p>
            )}
            <input id="eval-file-input" type="file" accept=".csv" className="hidden" onChange={handleFileUpload} />
          </div>

          <a
            href={`${API_BASE_URL}/samples/product_catalog_testset.csv`}
            download
            className="text-xs text-blue-500 hover:text-blue-700"
          >
            Download product catalog sample test set ↗
          </a>

          {/* K selector */}
          <div className="flex items-center gap-3 mt-6 mb-6">
            <span className="text-sm text-gray-500">Results per question (k):</span>
            {[5, 10, 20, 50].map(val => (
              <button
                key={val}
                onClick={() => setEval(projectId, { k: val })}
                className={`text-sm px-3 py-1 rounded-lg transition-colors ${
                  ev.k === val ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-500 hover:bg-gray-100'
                }`}
              >
                {val}
              </button>
            ))}
          </div>

          {/* Pipeline toggles */}
          <div className="mb-6 pt-4 border-t border-gray-100">
            <div className="flex flex-wrap items-center gap-4">
              <span className="text-xs text-gray-400 font-medium uppercase tracking-wide">Pipeline</span>
              {[
                { key: 'use_vector', label: 'Vector (embedding)', disabledWhen: !(ev.use_bm25 ?? true) },
                { key: 'use_bm25',   label: 'BM25 (keyword)',     disabledWhen: !(ev.use_vector ?? true) },
                { key: 'use_rrf',    label: 'RRF merge',          disabledWhen: false },
                { key: 'use_rerank', label: 'Rerank',             disabledWhen: false },
              ].map(({ key, label, disabledWhen }) => (
                <label
                  key={key}
                  className={`inline-flex items-center gap-1.5 cursor-pointer select-none ${disabledWhen ? 'opacity-40 pointer-events-none' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={ev[key] ?? true}
                    onChange={e => setEval(projectId, { [key]: e.target.checked })}
                    className="w-3.5 h-3.5 rounded accent-blue-600"
                  />
                  <span className="text-xs text-gray-600">{label}</span>
                </label>
              ))}
            </div>
            {!retrieversOk && (
              <p className="mt-2 text-xs text-red-500">Enable at least one retriever (Vector or BM25).</p>
            )}
          </div>

          {/* Action buttons */}
          <div className="flex gap-3">
            <button
              onClick={handleRun}
              disabled={!ev.testCases || ev.loading || !retrieversOk}
              className="flex-1 bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors"
            >
              {ev.loading ? 'Running...' : 'Run Evaluation'}
            </button>
            <button
              onClick={handleExport}
              disabled={!ev.results}
              className="flex-1 border border-gray-300 text-gray-700 py-3 rounded-lg font-medium hover:bg-gray-50 disabled:opacity-40 transition-colors"
            >
              Export RAGAS JSON
            </button>
          </div>

          {ev.error && <p className="mt-3 text-sm text-red-600">{ev.error}</p>}

          {/* Live progress */}
          {ev.progress && (
            <div className="mt-5 space-y-2">
              <div className="flex justify-between text-xs text-gray-500">
                <span className="truncate max-w-xs font-medium text-gray-700">{ev.progress.question}</span>
                <span className="ml-2 shrink-0">{ev.progress.index} / {ev.progress.total}</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-1.5">
                <div
                  className="bg-blue-600 h-1.5 rounded-full transition-all duration-300"
                  style={{ width: `${(ev.progress.index / ev.progress.total) * 100}%` }}
                />
              </div>
              {ev.progress.type === 'step' && (
                <div className="flex items-center gap-1.5 text-xs text-blue-600">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                  {ev.progress.message}
                </div>
              )}
              {ev.progress.type === 'progress' && (
                <div className="flex items-center gap-1.5 text-xs text-emerald-600">
                  ✓ {ev.progress.contexts_count} context{ev.progress.contexts_count !== 1 ? 's' : ''} retrieved
                </div>
              )}
            </div>
          )}
        </div>

        {/* Results */}
        {ev.results && (
          <div className="mt-6 bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden max-w-2xl">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-900">Results</h2>
              <span className="text-sm text-gray-400">{ev.results.length} questions · k={ev.k}</span>
            </div>
            <div className="divide-y divide-gray-100">
              {ev.results.slice(0, 10).map((r, i) => (
                <div key={i} className="px-6 py-4">
                  <p className="text-sm font-medium text-gray-800 mb-1">{r.question}</p>
                  <p className="text-xs text-gray-400">{r.contexts.length} context{r.contexts.length !== 1 ? 's' : ''} retrieved</p>
                  <p className="text-xs text-gray-400 mt-1 truncate">{r.contexts[0]}</p>
                </div>
              ))}
            </div>
            <div className="px-6 py-4 bg-gray-50 border-t border-gray-100">
              {ev.results.length > 10 && (
                <p className="text-xs text-gray-400 mb-2">Showing 10 of {ev.results.length} — export the JSON for the full dataset.</p>
              )}
              <p className="text-xs text-gray-500">
                Export the JSON and upload it to the Lens RAGAS portal to get precision and recall scores.
              </p>
            </div>
          </div>
        )}

        {/* RAGAS portal / evaluation instructions */}
        {(() => {
          const portalUrl = import.meta.env.VITE_RAGAS_PORTAL_URL
          if (portalUrl) {
            return (
              <div className="mt-6 max-w-2xl bg-white rounded-2xl border border-blue-100 shadow-sm p-6">
                <h3 className="text-base font-semibold text-gray-900 mb-1">Run RAGAS Evaluation</h3>
                <p className="text-sm text-gray-500 mb-4">
                  Export the RAGAS JSON above, then upload it to the Lens RAGAS portal to compute
                  precision, recall and other scores.
                </p>
                <a
                  href={portalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 bg-blue-600 text-white px-5 py-2.5 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
                >
                  Open Lens RAGAS Portal ↗
                </a>
                <p className="mt-3 text-xs text-gray-400 font-mono break-all">{portalUrl}</p>
              </div>
            )
          }
          return (
            <div className="mt-6 max-w-2xl bg-gray-50 rounded-2xl border border-gray-200 p-5">
              <p className="text-xs text-gray-400">
                No RAGAS portal configured. Set{' '}
                <code className="bg-gray-200 px-1 rounded">VITE_RAGAS_PORTAL_URL</code>{' '}
                in your <code className="bg-gray-200 px-1 rounded">.env</code> to add a direct link.
              </p>
            </div>
          )
        })()}

      </div>
    </div>
  )
}

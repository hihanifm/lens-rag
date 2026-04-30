import { useState, useRef, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  previewCompareFile,
  previewCompareContext,
  createCompareJob,
  fetchModels,
  getSystemConfig,
  verifyEmbedding,
  verifyRerank,
  API_BASE_URL,
} from '../api/client'

const STEPS = ['Names', 'Upload Left', 'Columns Left', 'Upload Right', 'Columns Right', 'Connection', 'Rerank', 'Review']

// ── Helpers ────────────────────────────────────────────────────────────────

function StepHeader({ step, total, title }) {
  return (
    <div className="mb-6">
      <p className="text-xs text-gray-400 uppercase tracking-widest font-semibold mb-1">
        Step {step + 1} of {total} — {STEPS[step]}
      </p>
      <h2 className="text-xl font-bold text-gray-900">{title}</h2>
    </div>
  )
}

function ColumnMultiSelect({ columns, selected, onChange, label }) {
  const toggle = (col) => {
    onChange(
      selected.includes(col) ? selected.filter(c => c !== col) : [...selected, col]
    )
  }
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-2">{label}</label>
      <div className="border border-gray-200 rounded-lg overflow-hidden max-h-48 overflow-y-auto">
        {columns.map(col => (
          <label key={col} className="flex items-center gap-3 px-3 py-2 hover:bg-gray-50 cursor-pointer">
            <input
              type="checkbox"
              checked={selected.includes(col)}
              onChange={() => toggle(col)}
              className="rounded border-gray-300 text-blue-600"
            />
            <span className="text-sm text-gray-700 truncate">{col}</span>
          </label>
        ))}
      </div>
      <p className="text-xs text-gray-400 mt-1">{selected.length} selected</p>
    </div>
  )
}

function ColumnSingleSelect({ columns, value, onChange, label, required = false }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-2">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      <select
        value={value || ''}
        onChange={e => onChange(e.target.value || null)}
        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-300"
      >
        {!required && <option value="">— None —</option>}
        {required && <option value="">— Select a column —</option>}
        {columns.map(col => (
          <option key={col} value={col}>{col}</option>
        ))}
      </select>
    </div>
  )
}

function FileDropZone({ side, onFile, filename }) {
  const inputRef = useRef(null)
  const [dragging, setDragging] = useState(false)

  const handleDrop = (e) => {
    e.preventDefault()
    setDragging(false)
    const f = e.dataTransfer.files[0]
    if (f) onFile(f)
  }

  return (
    <div
      onClick={() => inputRef.current?.click()}
      onDragOver={e => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-colors
        ${dragging ? 'border-blue-400 bg-blue-50' : 'border-gray-200 hover:border-blue-300 hover:bg-gray-50'}`}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.xls"
        className="hidden"
        onChange={e => e.target.files[0] && onFile(e.target.files[0])}
      />
      {filename ? (
        <p className="text-green-600 font-medium">✓ {filename}</p>
      ) : (
        <>
          <p className="text-gray-500 font-medium">Drop your Excel file here</p>
          <p className="text-xs text-gray-400 mt-1">or click to browse — .xlsx / .xls</p>
          <div className="mt-5">
            <p className="text-[11px] text-gray-400 uppercase tracking-wide mb-2">Or try a sample</p>
            <div className="flex flex-wrap justify-center gap-2">
              {[
                { label: 'Products', file: 'product_catalog.xlsx', icon: '📦' },
                { label: 'IT Assets', file: 'it_assets.xlsx', icon: '🖥' },
                { label: 'Books', file: 'book_library.xlsx', icon: '📚' },
                { label: 'HR', file: 'hr_directory.xlsx', icon: '👥' },
              ].map(s => (
                <button
                  key={`${side}-${s.file}`}
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onFile({ __sample: true, filename: s.file }) }}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border border-gray-200 bg-white text-xs text-gray-600 hover:border-blue-300 hover:text-blue-700 transition-colors"
                  title={`Load sample: ${s.file}`}
                >
                  <span aria-hidden>{s.icon}</span>
                  <span>{s.label}</span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ── Steps ──────────────────────────────────────────────────────────────────

function StepNames({ state, setState, onNext }) {
  return (
    <div className="space-y-4">
      <StepHeader step={0} total={STEPS.length} title="Name your comparison" />
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Job name</label>
        <input
          autoFocus
          type="text"
          placeholder="e.g. Q2 coverage gap analysis"
          value={state.name}
          onChange={e => setState(s => ({ ...s, name: e.target.value }))}
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Left file label</label>
          <input
            type="text"
            placeholder="e.g. Reference"
            value={state.labelLeft}
            onChange={e => setState(s => ({ ...s, labelLeft: e.target.value }))}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Right file label</label>
          <input
            type="text"
            placeholder="e.g. Candidate"
            value={state.labelRight}
            onChange={e => setState(s => ({ ...s, labelRight: e.target.value }))}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
          />
        </div>
      </div>
      <button
        onClick={onNext}
        disabled={!state.name.trim() || !state.labelLeft.trim() || !state.labelRight.trim()}
        className="mt-2 bg-blue-600 text-white px-6 py-2 rounded-lg font-medium hover:bg-blue-700 transition-colors disabled:opacity-40"
      >
        Continue →
      </button>
    </div>
  )
}

function StepUpload({ side, label, state, setState, onNext }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const handleFile = async (file) => {
    setLoading(true)
    setError(null)
    try {
      // Support one-click sample loads from the dropzone.
      if (file && file.__sample) {
        const filename = file.filename
        const res = await fetch(`${API_BASE_URL}/samples/${filename}`)
        if (!res.ok) throw new Error('Failed to fetch sample')
        const blob = await res.blob()
        file = new File([blob], filename, { type: blob.type })
      }
      const result = await previewCompareFile(file, side)
      if (result.detail) throw new Error(result.detail)
      const colsKey = side === 'left' ? 'Left' : 'Right'
      const cols = result.columns || []
      const lower = (s) => String(s || '').toLowerCase()
      const preferred = [
        'description',
        'details',
        'notes',
        'summary',
        'specs',
        'name',
        'title',
        'model',
        'category',
      ]
      const defaults = []
      for (const p of preferred) {
        const hit = cols.find(c => lower(c) === p || lower(c).includes(p))
        if (hit && !defaults.includes(hit)) defaults.push(hit)
      }
      if (defaults.length === 0 && cols.length > 0) defaults.push(cols[0])

      setState(s => ({
        ...s,
        [`columns${side === 'left' ? 'Left' : 'Right'}`]: result.columns,
        [`tmpPath${side === 'left' ? 'Left' : 'Right'}`]: result.tmp_path,
        [`filename${side === 'left' ? 'Left' : 'Right'}`]: file.name,
        [`rowCount${side === 'left' ? 'Left' : 'Right'}`]: result.row_count,
        // Preselect "match columns" so the user can usually just continue.
        [`contextColumns${colsKey}`]: (s[`contextColumns${colsKey}`] && s[`contextColumns${colsKey}`].length > 0)
          ? s[`contextColumns${colsKey}`]
          : defaults.slice(0, 4),
      }))
    } catch (e) {
      setError(e.message || 'Failed to read file')
    } finally {
      setLoading(false)
    }
  }

  const stepIdx = side === 'left' ? 1 : 3
  const filename = state[`filename${side === 'left' ? 'Left' : 'Right'}`]
  const tmpPath = state[`tmpPath${side === 'left' ? 'Left' : 'Right'}`]

  return (
    <div className="space-y-4">
      <StepHeader step={stepIdx} total={STEPS.length} title={`Upload the "${label}" file`} />
      {loading ? (
        <div className="text-center py-10 text-gray-400">Reading file…</div>
      ) : (
        <FileDropZone side={side} onFile={handleFile} filename={filename} />
      )}
      {error && <p className="text-red-500 text-sm">{error}</p>}
      {tmpPath && (
        <p className="text-xs text-gray-400">{state[`rowCount${side === 'left' ? 'Left' : 'Right'}`]?.toLocaleString()} rows detected</p>
      )}
      <button
        onClick={onNext}
        disabled={!tmpPath}
        className="bg-blue-600 text-white px-6 py-2 rounded-lg font-medium hover:bg-blue-700 transition-colors disabled:opacity-40"
      >
        Continue →
      </button>
    </div>
  )
}

function StepColumns({ side, label, state, setState, onNext }) {
  const key = side === 'left' ? 'Left' : 'Right'
  const columns = state[`columns${key}`] || []
  const ctx = state[`contextColumns${key}`]
  const display = state[`displayColumn${key}`]
  const stepIdx = side === 'left' ? 2 : 4

  const setCtx = (v) => setState(s => ({ ...s, [`contextColumns${key}`]: v }))
  const setDisplay = (v) => setState(s => ({ ...s, [`displayColumn${key}`]: v }))

  return (
    <div className="space-y-5">
      <StepHeader step={stepIdx} total={STEPS.length} title={`Column setup for "${label}"`} />

      <ColumnMultiSelect
        columns={columns}
        selected={ctx}
        onChange={setCtx}
        label="Columns to use for matching (all selected columns are merged into one text field)"
      />

      <ColumnSingleSelect
        columns={columns}
        value={display}
        onChange={setDisplay}
        label="Identifier column (shown in review card & export — one column only)"
      />

      <button
        onClick={onNext}
        disabled={!ctx || ctx.length === 0}
        className="bg-blue-600 text-white px-6 py-2 rounded-lg font-medium hover:bg-blue-700 transition-colors disabled:opacity-40"
      >
        Continue →
      </button>
    </div>
  )
}

function StepConnection({
  embedUrl, setEmbedUrl,
  embedApiKey, setEmbedApiKey,
  embedModel, setEmbedModel,
  availableModels, modelLoading, modelError,
  connectionCheckLoading,
  onFetchModels, onNext, onBack,
  connectionTouched, embedUrlRef,
}) {
  return (
    <div className="space-y-5">
      <StepHeader step={5} total={STEPS.length} title="Embedding Model" />
      <p className="text-sm text-gray-500">
        Override the default embedding model for this job. Leave blank to use the system default.
        The chosen model will be used for ingestion and comparison.
      </p>

      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <div className="font-semibold mb-0.5">Tip</div>
        <div>
          Unless you're testing a new embedding model or endpoint, leave these fields blank
          so the server default is used.
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Endpoint URL <span className="text-gray-400 font-normal">(OpenAI-compatible)</span>
        </label>
        <input
          type="text"
          value={embedUrl}
          onChange={e => {
            connectionTouched.current = true
            embedUrlRef.current = e.target.value
            setEmbedUrl(e.target.value)
          }}
          placeholder="e.g. http://192.168.1.10:11434/v1"
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
        />
        <div className="mt-2 text-xs space-y-1">
          <p className="text-gray-500">Ollama endpoints (click to fill):</p>
          <div className="flex flex-wrap gap-2">
            {['http://host.docker.internal:11434/v1', 'http://localhost:11434/v1'].map(v => (
              <button
                key={v}
                type="button"
                onClick={() => {
                  connectionTouched.current = true
                  embedUrlRef.current = v
                  setEmbedUrl(v)
                }}
                className="px-2 py-0.5 rounded border border-gray-200 bg-white hover:bg-gray-50 text-gray-700 font-mono text-xs"
              >
                {v}
              </button>
            ))}
          </div>
          <p className="text-gray-400">
            Use <span className="font-mono">host.docker.internal</span> when LENS runs in Docker and Ollama on the host.
          </p>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          API Key <span className="text-gray-400 font-normal">(optional)</span>
        </label>
        <input
          type="password"
          value={embedApiKey}
          onChange={e => setEmbedApiKey(e.target.value)}
          placeholder="Leave blank for Ollama (no key needed)"
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
        />
      </div>

      <button
        type="button"
        onClick={onFetchModels}
        disabled={!embedUrl.trim() || modelLoading}
        className="w-full border border-gray-200 text-gray-700 py-2.5 rounded-lg font-medium text-sm hover:bg-gray-50 disabled:opacity-40 transition-colors"
      >
        {modelLoading ? 'Fetching models…' : 'Fetch available models'}
      </button>

      {modelError && <p className="text-sm text-red-600">{modelError}</p>}

      {availableModels.length > 0 && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Model</label>
          <select
            value={embedModel}
            onChange={e => setEmbedModel(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
          >
            {availableModels.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
      )}

      {embedUrl.trim() && availableModels.length === 0 && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Model <span className="text-gray-400 font-normal">(manual)</span>
          </label>
          <input
            type="text"
            value={embedModel}
            onChange={e => setEmbedModel(e.target.value)}
            placeholder="e.g. bge-m3"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
          />
          <p className="text-xs text-gray-400 mt-1">
            If model listing fails, you can still enter the embedding model ID directly.
          </p>
        </div>
      )}

      {!embedUrl.trim() && (
        <p className="text-sm text-gray-400">System default will be used.</p>
      )}

      <div className="flex gap-3 pt-1">
        <button onClick={onBack} className="flex-1 border border-gray-200 text-gray-600 py-2.5 rounded-lg font-medium text-sm hover:bg-gray-50">
          ← Back
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={connectionCheckLoading}
          className="flex-1 bg-blue-600 text-white py-2.5 rounded-lg font-medium text-sm hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {connectionCheckLoading ? 'Checking…' : 'Continue →'}
        </button>
      </div>
    </div>
  )
}

function StepRerank({
  rerankEnabled, setRerankEnabled,
  rerankModel, setRerankModel,
  rerankAvailableModels, rerankModelLoading, rerankModelError, rerankCheckLoading,
  onFetchRerankModels, onNext, onBack,
}) {
  return (
    <div className="space-y-5">
      <StepHeader step={6} total={STEPS.length} title="Reranking Model" />
      <p className="text-sm text-gray-500">
        Reranking improves match quality. For most users, leave it enabled with the server default.
      </p>

      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <div className="font-semibold mb-0.5">Tip</div>
        <div>
          Unless you're testing a new reranker, leave reranking enabled and keep the model blank
          so the server default is used.
        </div>
      </div>

      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={rerankEnabled}
          onChange={e => {
            setRerankEnabled(e.target.checked)
          }}
          className="rounded border-gray-300 text-blue-600"
        />
        <span className="text-sm font-medium text-gray-700">Enable reranking for this job</span>
      </label>

      <button
        type="button"
        onClick={onFetchRerankModels}
        disabled={!rerankEnabled || rerankModelLoading}
        className="w-full border border-gray-200 text-gray-700 py-2.5 rounded-lg font-medium text-sm hover:bg-gray-50 disabled:opacity-40 transition-colors"
      >
        {rerankModelLoading ? 'Fetching models…' : 'Fetch available models'}
      </button>
      <p className="text-xs text-gray-400">
        Lists models from the same OpenAI-compatible URL as the Embedding step (or the system default URL).
      </p>

      {rerankModelError && <p className="text-sm text-red-600">{rerankModelError}</p>}

      {rerankAvailableModels.length > 0 && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Rerank model id <span className="text-gray-400 font-normal">(optional)</span>
          </label>
          <select
            value={rerankModel}
            onChange={e => setRerankModel(e.target.value)}
            disabled={!rerankEnabled}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300 disabled:bg-gray-100"
          >
            {rerankAvailableModels.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
      )}

      {rerankAvailableModels.length === 0 && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Rerank model id <span className="text-gray-400 font-normal">(optional)</span>
          </label>
          <input
            type="text"
            value={rerankModel}
            onChange={e => setRerankModel(e.target.value)}
            placeholder="e.g. bbjson/bge-reranker-base:latest"
            disabled={!rerankEnabled}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300 disabled:bg-gray-100 disabled:text-gray-400"
          />
          <p className="text-xs text-gray-400 mt-1">
            Fetch models above, or enter a rerank-capable model id manually. Blank uses the server default.
          </p>
        </div>
      )}

      <div className="flex gap-3 pt-1">
        <button onClick={onBack} className="flex-1 border border-gray-200 text-gray-600 py-2.5 rounded-lg font-medium text-sm hover:bg-gray-50">
          ← Back
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={rerankModelLoading || rerankCheckLoading}
          className="flex-1 bg-blue-600 text-white py-2.5 rounded-lg font-medium text-sm hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {rerankCheckLoading ? 'Checking…' : 'Continue →'}
        </button>
      </div>
    </div>
  )
}

function StepReview({ state, onSubmit, onBack, submitting, error }) {
  const leftTitle = state.labelLeft || 'Left'
  const rightTitle = state.labelRight || 'Right'
  const [ctxPreview, setCtxPreview] = useState({ left: null, right: null })
  const [ctxLoading, setCtxLoading] = useState(false)
  const [ctxError, setCtxError] = useState('')

  useEffect(() => {
    let alive = true
    const run = async () => {
      if (!state.tmpPathLeft || !state.tmpPathRight) return
      if (!state.contextColumnsLeft?.length || !state.contextColumnsRight?.length) return
      setCtxLoading(true)
      setCtxError('')
      try {
        const [left, right] = await Promise.all([
          previewCompareContext(state.tmpPathLeft, state.contextColumnsLeft, 2),
          previewCompareContext(state.tmpPathRight, state.contextColumnsRight, 2),
        ])
        if (!alive) return
        setCtxPreview({ left, right })
      } catch {
        if (!alive) return
        setCtxPreview({ left: null, right: null })
        setCtxError('Preview unavailable (server not updated). Rebuild/restart the backend to enable it.')
      } finally {
        if (alive) setCtxLoading(false)
      }
    }
    run()
    return () => { alive = false }
  }, [state.tmpPathLeft, state.tmpPathRight, state.contextColumnsLeft, state.contextColumnsRight])

  const fields = [
    ['File', state.filenameLeft, state.filenameRight],
    ['Rows', state.rowCountLeft?.toLocaleString(), state.rowCountRight?.toLocaleString()],
    ['Match columns', state.contextColumnsLeft.join(', ') || '—', state.contextColumnsRight.join(', ') || '—'],
    ['Identifier column', state.displayColumnLeft || '—', state.displayColumnRight || '—'],
    [
      'Example merged text',
      ctxLoading
        ? 'Loading…'
        : (ctxPreview.left?.samples?.[0] || (ctxError ? ctxError : '—')),
      ctxLoading
        ? 'Loading…'
        : (ctxPreview.right?.samples?.[0] || (ctxError ? ctxError : '—')),
    ],
  ]

  return (
    <div className="space-y-4">
      <StepHeader step={7} total={STEPS.length} title="Review & create" />
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100">
          <div className="text-sm">
            <span className="text-gray-400">Job name</span>{' '}
            <span className="text-gray-900 font-semibold">{state.name || '—'}</span>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3">
          <div className="hidden sm:block bg-gray-50 border-r border-gray-100" />
          <div className="px-4 py-3 border-b sm:border-b-0 sm:border-r border-gray-100">
            <div className="text-xs uppercase tracking-widest text-gray-400 font-semibold">Left</div>
            <div className="text-sm font-semibold text-gray-900 truncate">{leftTitle}</div>
          </div>
          <div className="px-4 py-3 border-b sm:border-b-0 border-gray-100">
            <div className="text-xs uppercase tracking-widest text-gray-400 font-semibold">Right</div>
            <div className="text-sm font-semibold text-gray-900 truncate">{rightTitle}</div>
          </div>

          {fields.map(([label, leftVal, rightVal]) => (
            <div key={label} className="contents">
              <div className="px-4 py-3 bg-gray-50 border-t border-gray-100 text-xs font-semibold text-gray-500 uppercase tracking-widest">
                {label}
              </div>
              <div className="px-4 py-3 border-t border-gray-100 text-sm text-gray-900 font-medium min-w-0">
                <span className="block truncate">{leftVal || '—'}</span>
                {label === 'Example merged text' && !ctxLoading && ctxPreview.left?.samples?.[1] && (
                  <span className="block truncate text-xs text-gray-500 font-normal mt-1">
                    {ctxPreview.left.samples[1]}
                  </span>
                )}
              </div>
              <div className="px-4 py-3 border-t border-gray-100 text-sm text-gray-900 font-medium min-w-0">
                <span className="block truncate">{rightVal || '—'}</span>
                {label === 'Example merged text' && !ctxLoading && ctxPreview.right?.samples?.[1] && (
                  <span className="block truncate text-xs text-gray-500 font-normal mt-1">
                    {ctxPreview.right.samples[1]}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
      {error && <p className="text-red-500 text-sm">{error}</p>}
      <div className="flex gap-3">
        {onBack && (
          <button
            onClick={onBack}
            disabled={submitting}
            className="border border-gray-200 text-gray-600 px-5 py-2.5 rounded-lg font-medium text-sm hover:bg-gray-50 disabled:opacity-40"
          >
            ← Back
          </button>
        )}
        <button
          onClick={onSubmit}
          disabled={submitting}
          className="bg-blue-600 text-white px-8 py-2.5 rounded-lg font-medium hover:bg-blue-700 transition-colors disabled:opacity-40"
        >
          {submitting ? 'Creating…' : 'Create & Start Comparison'}
        </button>
      </div>
    </div>
  )
}

// ── Progress overlay ──────────────────────────────────────────────────────

function ProgressView({ jobId, onDone }) {
  const [events, setEvents] = useState([])
  const [done, setDone] = useState(false)

  useEffect(() => {
    if (!jobId) return
    const es = new EventSource(`${API_BASE_URL}/compare/${jobId}/ingest`)
    es.onmessage = (e) => {
      const data = JSON.parse(e.data)
      setEvents(prev => {
        // Update last event of same type or append
        const last = prev[prev.length - 1]
        if (last && last.type === data.type) {
          return [...prev.slice(0, -1), data]
        }
        return [...prev, data]
      })
      if (data.type === 'complete') {
        setDone(true)
        es.close()
        setTimeout(() => onDone(jobId), 1500)
      }
      if (data.type === 'error') {
        es.close()
      }
    }
    return () => es.close()
  }, [jobId])

  const stages = [
    { type: 'ingest_left',  label: 'Ingesting Left' },
    { type: 'ingest_right', label: 'Ingesting Right' },
    { type: 'searching',    label: 'Bidirectional search' },
    { type: 'reranking',    label: 'Reranking pairs' },
    { type: 'complete',     label: 'Done' },
  ]

  const current = events[events.length - 1]
  const currentType = current?.type

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold text-gray-900">Running comparison…</h2>
      <div className="space-y-3">
        {stages.map(stage => {
          const isActive = currentType === stage.type
          const isDone = done || (
            stages.findIndex(s => s.type === stage.type) <
            stages.findIndex(s => s.type === currentType)
          )
          const event = events.find(ev => ev.type === stage.type)

          return (
            <div key={stage.type} className={`flex items-center gap-3 px-4 py-3 rounded-lg border
              ${isDone ? 'bg-emerald-50 border-emerald-200' : isActive ? 'bg-blue-50 border-blue-200' : 'bg-gray-50 border-gray-200'}`}
            >
              <span className="text-lg">
                {isDone ? '✓' : isActive ? (
                  <svg className="animate-spin h-4 w-4 text-blue-600" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                ) : '○'}
              </span>
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-medium ${isDone ? 'text-emerald-700' : isActive ? 'text-blue-700' : 'text-gray-400'}`}>
                  {stage.label}
                </p>
                {isActive && event && (event.processed != null) && (
                  <p className="text-xs text-gray-500 mt-0.5">
                    {event.processed.toLocaleString()} / {event.total.toLocaleString()} rows ({event.percent ?? 0}%)
                  </p>
                )}
                {isActive && event?.message && !event.processed && (
                  <p className="text-xs text-gray-500 mt-0.5">{event.message}</p>
                )}
              </div>
            </div>
          )
        })}
      </div>
      {currentType === 'error' && (
        <p className="text-red-500 text-sm">{current?.message}</p>
      )}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────

const INITIAL = {
  name: '',
  labelLeft: 'Baseline',
  labelRight: 'Candidate',
  filenameLeft: '',
  filenameRight: '',
  tmpPathLeft: '',
  tmpPathRight: '',
  rowCountLeft: null,
  rowCountRight: null,
  columnsLeft: [],
  columnsRight: [],
  contextColumnsLeft: [],
  contextColumnsRight: [],
  displayColumnLeft: null,
  displayColumnRight: null,
}

export default function CreateCompareJob() {
  const navigate = useNavigate()
  const [step, setStep] = useState(0)
  const [state, setState] = useState(INITIAL)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(null)
  const [createdJobId, setCreatedJobId] = useState(null)

  // ── Embedding / Connection state ────────────────────────────────────────
  const [embedUrl, setEmbedUrl] = useState('')
  const [embedApiKey, setEmbedApiKey] = useState('')
  const [embedModel, setEmbedModel] = useState('')
  const [availableModels, setAvailableModels] = useState([])
  const [modelLoading, setModelLoading] = useState(false)
  const [modelError, setModelError] = useState('')
  const [connectionCheckLoading, setConnectionCheckLoading] = useState(false)

  // ── Reranking state ─────────────────────────────────────────────────────
  const [rerankEnabled, setRerankEnabled] = useState(true)
  const [rerankModel, setRerankModel] = useState('')
  const [rerankAvailableModels, setRerankAvailableModels] = useState([])
  const [rerankModelError, setRerankModelError] = useState('')
  const [rerankModelLoading, setRerankModelLoading] = useState(false)
  const [rerankCheckLoading, setRerankCheckLoading] = useState(false)

  // Refs for pre-fill logic (mirrors CreateProject pattern)
  const connectionPrefilled = useRef(false)
  const connectionTouched = useRef(false)
  const embedUrlRef = useRef('')
  const systemEmbedUrlRef = useRef('')
  const rerankPrefilled = useRef(false)

  // Pre-fill Connection step from system config on first visit
  useEffect(() => {
    if (step !== 5 || connectionPrefilled.current) return
    connectionPrefilled.current = true
    getSystemConfig().then(cfg => {
      if (connectionTouched.current) return
      const url = cfg.embedding_url || ''
      if (cfg?.embedding_url) systemEmbedUrlRef.current = cfg.embedding_url
      if (!embedUrlRef.current.trim()) {
        setEmbedUrl(url)
        embedUrlRef.current = url
      }
      if (url) {
        if (cfg.embedding_provider === 'openai') {
          setAvailableModels([])
          setEmbedModel(cfg.embedding_model || '')
          setModelError('OpenAI endpoints require an API key to list models.')
          return
        }
        setModelLoading(true)
        setModelError('')
        fetchModels(url, null)
          .then(models => {
            const list = Array.isArray(models) ? models : []
            setAvailableModels(list)
            const def = cfg.embedding_model
            setEmbedModel(list.includes(def) ? def : (list[0] || ''))
          })
          .catch(() => setModelError('Could not reach the system endpoint to list models.'))
          .finally(() => setModelLoading(false))
      }
    }).catch(() => {})
  }, [step])

  // Pre-fill Rerank step from system config on first visit
  useEffect(() => {
    if (step !== 6 || rerankPrefilled.current) return
    rerankPrefilled.current = true
    getSystemConfig().then(cfg => {
      if (cfg?.embedding_url) systemEmbedUrlRef.current = cfg.embedding_url
      if (cfg?.reranker_model) {
        setRerankModel(prev => (prev.trim() ? prev : cfg.reranker_model))
      }
    }).catch(() => {})
  }, [step])

  const handleFetchModels = useCallback(async () => {
    if (!embedUrl.trim()) return
    setModelLoading(true)
    setModelError('')
    setAvailableModels([])
    setEmbedModel('')
    try {
      const raw = await fetchModels(embedUrl.trim(), embedApiKey.trim() || null)
      const models = Array.isArray(raw) ? raw : []
      setAvailableModels(models)
      if (models.length > 0) setEmbedModel(models[0])
    } catch {
      setModelError('Could not reach the endpoint. Check the URL and try again.')
    } finally {
      setModelLoading(false)
    }
  }, [embedUrl, embedApiKey])

  const handleFetchRerankModels = useCallback(async () => {
    const url = embedUrl.trim() || systemEmbedUrlRef.current
    if (!url) {
      setRerankModelError('No endpoint to list models from. Enter one on the Embedding step, or type a model id manually.')
      return
    }
    setRerankModelLoading(true)
    setRerankModelError('')
    setRerankAvailableModels([])
    setRerankModel('')
    try {
      const cfg = await getSystemConfig().catch(() => ({}))
      const raw = await fetchModels(url, embedApiKey.trim() || null)
      const models = Array.isArray(raw) ? raw : []
      setRerankAvailableModels(models)
      if (models.length > 0) {
        const preferred = cfg?.reranker_model
        setRerankModel(preferred && models.includes(preferred) ? preferred : models[0])
      }
    } catch {
      setRerankModelError('Could not reach the endpoint. Check the embedding URL and try again.')
    } finally {
      setRerankModelLoading(false)
    }
  }, [embedUrl, embedApiKey])

  const handleConnectionContinue = useCallback(async () => {
    setModelError('')
    setConnectionCheckLoading(true)
    try {
      const url = embedUrl.trim()
      await verifyEmbedding({
        url: url || null,
        api_key: url ? (embedApiKey.trim() || null) : null,
        model: url ? (embedModel.trim() || null) : null,
      })
      setStep(6)
    } catch (e) {
      const d = e?.response?.data?.detail
      setModelError(
        typeof d === 'string'
          ? d
          : 'Could not verify embedding. Use an embedding-capable model or fix the endpoint.',
      )
    } finally {
      setConnectionCheckLoading(false)
    }
  }, [embedUrl, embedApiKey, embedModel])

  const handleRerankContinue = useCallback(async () => {
    setRerankModelError('')
    if (!rerankEnabled || !rerankModel.trim()) {
      setStep(7)
      return
    }
    setRerankCheckLoading(true)
    try {
      await verifyRerank({ model: rerankModel.trim() })
      setStep(7)
    } catch (e) {
      const d = e?.response?.data?.detail
      setRerankModelError(
        typeof d === 'string'
          ? d
          : 'Could not verify reranker model. Use a rerank-capable model id installed on the server.',
      )
    } finally {
      setRerankCheckLoading(false)
    }
  }, [rerankEnabled, rerankModel])

  const handleSubmit = async () => {
    setSubmitting(true)
    setSubmitError(null)
    try {
      const pickContentColumn = (cols, selected) => {
        const chosen = Array.isArray(selected) ? selected : []
        const lower = (s) => String(s || '').toLowerCase()
        const preferred = chosen.find(c => /description|details|notes|summary|text|content/.test(lower(c)))
        return preferred || chosen[0] || cols?.[0] || ''
      }

      const contentLeft = pickContentColumn(state.columnsLeft, state.contextColumnsLeft)
      const contentRight = pickContentColumn(state.columnsRight, state.contextColumnsRight)

      const ctxLeft = state.contextColumnsLeft.filter(c => c !== contentLeft)
      const ctxRight = state.contextColumnsRight.filter(c => c !== contentRight)

      const url = embedUrl.trim()
      const job = await createCompareJob({
        name: state.name,
        label_left: state.labelLeft,
        label_right: state.labelRight,
        tmp_path_left: state.tmpPathLeft,
        tmp_path_right: state.tmpPathRight,
        source_filename_left: state.filenameLeft,
        source_filename_right: state.filenameRight,
        context_columns_left: ctxLeft,
        content_column_left: contentLeft,
        display_column_left: state.displayColumnLeft,
        context_columns_right: ctxRight,
        content_column_right: contentRight,
        display_column_right: state.displayColumnRight,
        embed_url: url || null,
        embed_api_key: url ? (embedApiKey.trim() || null) : null,
        embed_model: url ? (embedModel.trim() || null) : null,
        rerank_enabled: rerankEnabled,
        rerank_model: rerankModel.trim() || null,
      })
      setCreatedJobId(job.id)
    } catch (e) {
      setSubmitError(e?.response?.data?.detail || e.message || 'Failed to create job')
      setSubmitting(false)
    }
  }

  if (createdJobId) {
    return (
      <div className="min-h-screen bg-gray-50">
        <div className="w-[90%] mx-auto py-12">
          <ProgressView jobId={createdJobId} onDone={(id) => navigate(`/compare/${id}`)} />
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="w-[90%] mx-auto py-12">
        <div className="max-w-lg">

          {/* Step progress dots */}
          <div className="flex items-center gap-2 mb-8">
            {STEPS.map((s, i) => (
              <div key={s} className={`h-1.5 flex-1 rounded-full transition-colors
                ${i < step ? 'bg-blue-600' : i === step ? 'bg-blue-400' : 'bg-gray-200'}`} />
            ))}
          </div>

          {step === 0 && (
            <StepNames state={state} setState={setState} onNext={() => setStep(1)} />
          )}
          {step === 1 && (
            <StepUpload side="left" label={state.labelLeft} state={state} setState={setState} onNext={() => setStep(2)} />
          )}
          {step === 2 && (
            <StepColumns side="left" label={state.labelLeft} state={state} setState={setState} onNext={() => setStep(3)} />
          )}
          {step === 3 && (
            <StepUpload side="right" label={state.labelRight} state={state} setState={setState} onNext={() => setStep(4)} />
          )}
          {step === 4 && (
            <StepColumns side="right" label={state.labelRight} state={state} setState={setState} onNext={() => setStep(5)} />
          )}
          {step === 5 && (
            <StepConnection
              embedUrl={embedUrl} setEmbedUrl={setEmbedUrl}
              embedApiKey={embedApiKey} setEmbedApiKey={setEmbedApiKey}
              embedModel={embedModel} setEmbedModel={setEmbedModel}
              availableModels={availableModels}
              modelLoading={modelLoading}
              modelError={modelError}
              connectionCheckLoading={connectionCheckLoading}
              onFetchModels={handleFetchModels}
              onNext={handleConnectionContinue}
              onBack={() => setStep(4)}
              connectionTouched={connectionTouched}
              embedUrlRef={embedUrlRef}
            />
          )}
          {step === 6 && (
            <StepRerank
              rerankEnabled={rerankEnabled} setRerankEnabled={setRerankEnabled}
              rerankModel={rerankModel} setRerankModel={setRerankModel}
              rerankAvailableModels={rerankAvailableModels}
              rerankModelLoading={rerankModelLoading}
              rerankModelError={rerankModelError}
              rerankCheckLoading={rerankCheckLoading}
              onFetchRerankModels={handleFetchRerankModels}
              onNext={handleRerankContinue}
              onBack={() => setStep(5)}
            />
          )}
          {step === 7 && (
            <StepReview state={state} onSubmit={handleSubmit} onBack={() => setStep(6)} submitting={submitting} error={submitError} />
          )}

          {step > 0 && step < 5 && !createdJobId && (
            <button
              onClick={() => setStep(s => s - 1)}
              className="mt-4 text-sm text-gray-400 hover:text-gray-600"
            >
              ← Back
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

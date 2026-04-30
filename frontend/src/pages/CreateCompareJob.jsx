import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { previewCompareFile, createCompareJob, API_BASE_URL } from '../api/client'

const STEPS = ['Names', 'Upload Left', 'Columns Left', 'Upload Right', 'Columns Right', 'Review']

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
      const result = await previewCompareFile(file, side)
      if (result.detail) throw new Error(result.detail)
      setState(s => ({
        ...s,
        [`columns${side === 'left' ? 'Left' : 'Right'}`]: result.columns,
        [`tmpPath${side === 'left' ? 'Left' : 'Right'}`]: result.tmp_path,
        [`filename${side === 'left' ? 'Left' : 'Right'}`]: file.name,
        [`rowCount${side === 'left' ? 'Left' : 'Right'}`]: result.row_count,
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
  const content = state[`contentColumn${key}`]
  const display = state[`displayColumn${key}`]
  const stepIdx = side === 'left' ? 2 : 4

  const setCtx = (v) => setState(s => ({ ...s, [`contextColumns${key}`]: v }))
  const setContent = (v) => setState(s => ({ ...s, [`contentColumn${key}`]: v }))
  const setDisplay = (v) => setState(s => ({ ...s, [`displayColumn${key}`]: v }))

  return (
    <div className="space-y-5">
      <StepHeader step={stepIdx} total={STEPS.length} title={`Column setup for "${label}"`} />

      <ColumnSingleSelect
        columns={columns}
        value={content}
        onChange={setContent}
        label="Content column (main text to embed)"
        required
      />

      <ColumnMultiSelect
        columns={columns}
        selected={ctx}
        onChange={setCtx}
        label="Context columns (prepended to content for richer embedding)"
      />

      <ColumnSingleSelect
        columns={columns}
        value={display}
        onChange={setDisplay}
        label="Identifier column (shown in review card & export — one column only)"
      />

      <button
        onClick={onNext}
        disabled={!content}
        className="bg-blue-600 text-white px-6 py-2 rounded-lg font-medium hover:bg-blue-700 transition-colors disabled:opacity-40"
      >
        Continue →
      </button>
    </div>
  )
}

function StepReview({ state, onSubmit, submitting, error }) {
  const rows = [
    ['Job name', state.name],
    ['Left label', state.labelLeft],
    ['Left file', state.filenameLeft],
    ['Left rows', state.rowCountLeft?.toLocaleString()],
    ['Left content column', state.contentColumnLeft],
    ['Left context columns', state.contextColumnsLeft.join(', ') || '—'],
    ['Left identifier column', state.displayColumnLeft || '—'],
    ['Right label', state.labelRight],
    ['Right file', state.filenameRight],
    ['Right rows', state.rowCountRight?.toLocaleString()],
    ['Right content column', state.contentColumnRight],
    ['Right context columns', state.contextColumnsRight.join(', ') || '—'],
    ['Right identifier column', state.displayColumnRight || '—'],
  ]

  return (
    <div className="space-y-4">
      <StepHeader step={5} total={STEPS.length} title="Review & create" />
      <div className="bg-gray-50 rounded-xl border border-gray-200 divide-y divide-gray-100">
        {rows.map(([label, value]) => (
          <div key={label} className="flex gap-4 px-4 py-2.5 text-sm">
            <span className="text-gray-400 w-44 shrink-0">{label}</span>
            <span className="text-gray-800 font-medium">{value || '—'}</span>
          </div>
        ))}
      </div>
      {error && <p className="text-red-500 text-sm">{error}</p>}
      <button
        onClick={onSubmit}
        disabled={submitting}
        className="bg-blue-600 text-white px-8 py-2.5 rounded-lg font-medium hover:bg-blue-700 transition-colors disabled:opacity-40"
      >
        {submitting ? 'Creating…' : 'Create & Start Comparison'}
      </button>
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
  labelLeft: '',
  labelRight: '',
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
  contentColumnLeft: '',
  contentColumnRight: '',
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

  const handleSubmit = async () => {
    setSubmitting(true)
    setSubmitError(null)
    try {
      const job = await createCompareJob({
        name: state.name,
        label_left: state.labelLeft,
        label_right: state.labelRight,
        tmp_path_left: state.tmpPathLeft,
        tmp_path_right: state.tmpPathRight,
        source_filename_left: state.filenameLeft,
        source_filename_right: state.filenameRight,
        context_columns_left: state.contextColumnsLeft,
        content_column_left: state.contentColumnLeft,
        display_column_left: state.displayColumnLeft,
        context_columns_right: state.contextColumnsRight,
        content_column_right: state.contentColumnRight,
        display_column_right: state.displayColumnRight,
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
            <StepReview state={state} onSubmit={handleSubmit} submitting={submitting} error={submitError} />
          )}

          {step > 0 && !createdJobId && (
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

import { useState, useRef, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  previewCompareFile,
  previewCompareContext,
  previewCompareRowStats,
  previewCompareColumnValues,
  previewCompareColumnSamples,
  createCompareJob,
  fetchModels,
  getSystemConfig,
  verifyEmbedding,
  API_BASE_URL,
} from '../api/client'

const STEPS = ['Names', 'Upload Left', 'Setup Left', 'Upload Right', 'Setup Right', 'Connection', 'Review']

const FILTER_OPS = [
  { id: 'contains', label: 'contains' },
  { id: 'not_contains', label: 'does not contain' },
  { id: 'equals', label: 'equals' },
  { id: 'not_equals', label: 'does not equal' },
  { id: 'empty', label: 'is empty' },
  { id: 'not_empty', label: 'is not empty' },
  { id: 'regex', label: 'matches regex' },
]

const FILTER_VALUE_PICK_OPS = ['contains', 'not_contains', 'equals', 'not_equals']
const FILTER_VALUE_OTHER = '__other__'

function RowFilterValueField({ column, op, value, tmpPath, sheetForApi, siblingFilters, onChange }) {
  const [distinctMode, setDistinctMode] = useState(false)
  const [options, setOptions] = useState([])
  const [loadingDistinct, setLoadingDistinct] = useState(false)
  const [truncated, setTruncated] = useState(false)

  const siblingsKey = JSON.stringify(siblingFilters || [])

  useEffect(() => {
    setDistinctMode(false)
    setOptions([])
    setTruncated(false)
    setLoadingDistinct(false)
  }, [op, tmpPath, sheetForApi, column, siblingsKey])

  const loadDistinctValues = useCallback(() => {
    if (!FILTER_VALUE_PICK_OPS.includes(op) || !tmpPath || !String(column || '').trim()) return
    setLoadingDistinct(true)
    setOptions([])
    previewCompareColumnValues(tmpPath, {
      sheetName: sheetForApi,
      column: String(column).trim(),
      rowFilters: siblingFilters || [],
    })
      .then((res) => {
        setOptions(Array.isArray(res?.values) ? res.values : [])
        setTruncated(!!res?.truncated)
      })
      .catch(() => {
        setOptions([])
        setTruncated(false)
      })
      .finally(() => setLoadingDistinct(false))
  }, [op, tmpPath, sheetForApi, column, siblingFilters])

  const startDistinctPicker = () => {
    setDistinctMode(true)
    loadDistinctValues()
  }

  if (op === 'regex') {
    return (
      <input
        type="text"
        value={value || ''}
        onChange={e => onChange(e.target.value)}
        placeholder="pattern"
        className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-sm"
      />
    )
  }

  if (!FILTER_VALUE_PICK_OPS.includes(op)) {
    return null
  }

  if (!String(column || '').trim()) {
    return (
      <input
        type="text"
        disabled
        placeholder="Pick a column first"
        className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-sm bg-gray-50 text-gray-400"
      />
    )
  }

  if (!distinctMode) {
    return (
      <div className="w-full min-w-[160px] flex-1 space-y-1">
        <input
          type="text"
          value={value || ''}
          onChange={e => onChange(e.target.value)}
          placeholder="Value"
          className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-sm"
        />
        <button
          type="button"
          onClick={startDistinctPicker}
          className="text-xs font-semibold text-blue-600 hover:text-blue-700"
        >
          Browse distinct values…
        </button>
      </div>
    )
  }

  if (loadingDistinct) {
    return (
      <div className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-sm text-gray-400 bg-white">
        Loading distinct values…
      </div>
    )
  }

  const valueInList = options.includes(value)
  const selectVal = value === '' ? '' : (valueInList ? value : FILTER_VALUE_OTHER)
  const showCustomInput = selectVal === FILTER_VALUE_OTHER

  if (options.length === 0) {
    return (
      <div className="w-full min-w-[160px] flex-1 space-y-1">
        <input
          type="text"
          value={value || ''}
          onChange={e => onChange(e.target.value)}
          placeholder="Value"
          className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-sm"
        />
        <p className="text-xs text-gray-500">No distinct values for this column with current filters.</p>
        <button
          type="button"
          onClick={() => setDistinctMode(false)}
          className="text-xs font-semibold text-blue-600 hover:text-blue-700"
        >
          Plain text only
        </button>
      </div>
    )
  }

  return (
    <div className="w-full min-w-[160px] flex-1 space-y-1">
      <select
        value={selectVal}
        onChange={(e) => {
          const v = e.target.value
          if (v === '') onChange('')
          else if (v === FILTER_VALUE_OTHER) {
            if (valueInList) onChange('')
          }
          else onChange(v)
        }}
        className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-sm"
      >
        <option value="">— Select value —</option>
        {options.map((o) => (
          <option key={o} value={o}>{o.length > 90 ? `${o.slice(0, 87)}…` : o}</option>
        ))}
        <option value={FILTER_VALUE_OTHER}>Other…</option>
      </select>
      {truncated && (
        <p className="text-[10px] text-amber-700 leading-tight">
          First 100 distinct values shown. Choose Other… to type any value.
        </p>
      )}
      {showCustomInput && (
        <input
          type="text"
          value={value || ''}
          onChange={e => onChange(e.target.value)}
          placeholder="Type value"
          className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-sm"
        />
      )}
      <button
        type="button"
        onClick={() => setDistinctMode(false)}
        className="text-xs font-semibold text-gray-600 hover:text-gray-800"
      >
        Plain text only
      </button>
    </div>
  )
}

function pickDefaultContextColumns(cols) {
  const lower = (s) => String(s || '').toLowerCase()
  const preferred = ['description', 'details', 'notes', 'summary', 'specs', 'name', 'title', 'model', 'category']
  const defaults = []
  for (const p of preferred) {
    const hit = cols.find(c => lower(c) === p || lower(c).includes(p))
    if (hit && !defaults.includes(hit)) defaults.push(hit)
  }
  if (defaults.length === 0 && cols.length > 0) defaults.push(cols[0])
  return defaults.slice(0, 4)
}

/** Strip UI `id` keys for API bodies; drops incomplete filter rows. */
function compareFiltersForApi(list) {
  return (list || [])
    .filter(f => f.column && String(f.column).trim())
    .filter(f => {
      const op = f.op || 'contains'
      if (['contains', 'not_contains', 'regex'].includes(op))
        return String(f.value || '').trim().length > 0
      return true
    })
    .map(({ column, op, value }) => ({
      column: String(column).trim(),
      op: op || 'contains',
      value: ['empty', 'not_empty'].includes(op) ? null : (String(value || '').trim() || null),
    }))
}

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

function formatColumnSamplesTooltip(samples) {
  if (!samples?.length) return ''
  const v = samples[0]
  return v === '' ? '(empty)' : v
}

function formatColumnSamplesInline(samples) {
  if (!samples?.length) return ''
  const v = samples[0]
  const s = v === '' ? '(empty)' : v
  return s.length > 120 ? `${s.slice(0, 117)}…` : s
}

function ColumnMultiSelect({ columns, selected, onChange, label, samplesByColumn = {}, samplesLoading = false }) {
  const toggle = (col) => {
    onChange(
      selected.includes(col) ? selected.filter(c => c !== col) : [...selected, col]
    )
  }
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-2">{label}</label>
      <p className="text-xs text-gray-400 mb-2">
        One sample per column from the first data row (after row filters), so you can see what each field looks like for pattern matching. Hover for full text when truncated.
      </p>
      <div className="border border-gray-200 rounded-lg overflow-hidden max-h-64 overflow-y-auto">
        {columns.map(col => {
          const raw = samplesByColumn[col]
          const line = formatColumnSamplesInline(raw)
          const tip = formatColumnSamplesTooltip(raw)
          return (
            <label
              key={col}
              className="flex items-start gap-2 px-3 py-2 hover:bg-gray-50 cursor-pointer border-b border-gray-100 last:border-b-0"
            >
              <input
                type="checkbox"
                checked={selected.includes(col)}
                onChange={() => toggle(col)}
                className="rounded border-gray-300 text-blue-600 mt-1 shrink-0"
              />
              <span className="text-sm text-gray-800 font-medium shrink-0 w-[28%] min-w-[6.5rem] break-words">{col}</span>
              <span
                className={`text-xs flex-1 min-w-0 leading-snug ${samplesLoading && !line ? 'text-gray-400 italic' : 'text-gray-500'}`}
                title={tip || undefined}
              >
                {samplesLoading && !line ? 'Loading…' : (line || '—')}
              </span>
            </label>
          )
        })}
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

function newRowFilterId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `rf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 11)}`
}

function RowFiltersEditor({ columns, filters, onChange, tmpPath, sheetForApi }) {
  const add = () => onChange([...filters, { id: newRowFilterId(), column: '', op: 'contains', value: '' }])
  const remove = (id) => onChange(filters.filter(f => f.id !== id))
  const patch = (id, part) => onChange(filters.map(f => (f.id === id ? { ...f, ...part } : f)))

  return (
    <div className="space-y-2" data-ignore-enter-wizard>
      <div className="flex items-center justify-between gap-2">
        <label className="block text-sm font-medium text-gray-700">Row filters (optional)</label>
        <button
          type="button"
          onClick={add}
          className="text-xs font-semibold text-blue-600 hover:text-blue-700"
        >
          + Add filter
        </button>
      </div>
      <p className="text-xs text-gray-400">Only rows matching every filter are embedded. Text compares case-insensitive except regex.</p>
      {filters.length === 0 ? (
        <p className="text-xs text-gray-400 italic">No filters — all rows from the sheet are used.</p>
      ) : (
        <div className="space-y-2">
          {filters.map(f => (
            <div key={f.id} className="flex flex-wrap items-end gap-2 p-2 rounded-lg border border-gray-100 bg-gray-50/80">
              <div className="min-w-[140px] flex-1">
                <label className="block text-[11px] text-gray-400 mb-0.5">Column</label>
                <select
                  value={f.column || ''}
                  onChange={e => patch(f.id, { column: e.target.value, value: '' })}
                  className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-sm"
                >
                  <option value="">—</option>
                  {columns.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="min-w-[130px]">
                <label className="block text-[11px] text-gray-400 mb-0.5">Condition</label>
                <select
                  value={f.op || 'contains'}
                  onChange={e => patch(f.id, { op: e.target.value, value: ['regex', 'contains', 'not_contains', 'equals', 'not_equals'].includes(e.target.value) ? f.value : '' })}
                  className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-sm"
                >
                  {FILTER_OPS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                </select>
              </div>
              {!['empty', 'not_empty'].includes(f.op) && (
                <div className="min-w-[160px] flex-1">
                  <label className="block text-[11px] text-gray-400 mb-0.5">Value</label>
                  <RowFilterValueField
                    column={f.column}
                    op={f.op || 'contains'}
                    value={f.value || ''}
                    tmpPath={tmpPath}
                    sheetForApi={sheetForApi}
                    siblingFilters={compareFiltersForApi(filters.filter(x => x.id !== f.id))}
                    onChange={(v) => patch(f.id, { value: v })}
                  />
                </div>
              )}
              <button
                type="button"
                onClick={() => remove(f.id)}
                className="text-xs text-gray-400 hover:text-red-600 px-1 py-1"
                title="Remove"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
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
      const perSheet = result.per_sheet || []
      const sheetNames = result.sheet_names || []
      const firstName = sheetNames[0] || ''
      const firstRow = perSheet.find(p => p.sheet_name === firstName) || perSheet[0]
      const cols = firstRow?.columns || result.columns || []
      const defaults = pickDefaultContextColumns(cols)

      setState(s => ({
        ...s,
        [`perSheet${colsKey}`]: perSheet,
        [`sheetNames${colsKey}`]: sheetNames,
        [`sheet${colsKey}`]: firstName,
        [`columns${colsKey}`]: cols,
        [`tmpPath${colsKey}`]: result.tmp_path,
        [`filename${colsKey}`]: file.name,
        [`rowsTotal${colsKey}`]: result.row_count,
        [`rowCount${colsKey}`]: firstRow?.row_count ?? result.row_count,
        [`rowCountFiltered${colsKey}`]: null,
        [`rowFilters${colsKey}`]: [],
        [`contextColumns${colsKey}`]: (s[`contextColumns${colsKey}`] && s[`contextColumns${colsKey}`].length > 0)
          ? s[`contextColumns${colsKey}`]
          : defaults,
        [`displayColumn${colsKey}`]: null,
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
        <p className="text-xs text-gray-400">
          {(state[`sheetNames${side === 'left' ? 'Left' : 'Right'}`]?.length ?? 0) > 1
            ? (<>{state[`rowsTotal${side === 'left' ? 'Left' : 'Right'}`]?.toLocaleString()} rows in file ({state[`sheetNames${side === 'left' ? 'Left' : 'Right'}`]?.length} sheets). Pick a sheet on the next step.</>)
            : (<>{state[`rowCount${side === 'left' ? 'Left' : 'Right'}`]?.toLocaleString()} rows detected</>)}
        </p>
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
  const sheetNames = state[`sheetNames${key}`] || []
  const sheet = state[`sheet${key}`] || ''
  const perSheet = state[`perSheet${key}`] || []
  const filters = state[`rowFilters${key}`] || []
  const tmpPath = state[`tmpPath${key}`]
  const sheetForApi = sheetNames.length > 1 ? sheet : null
  const rowCountSheet = state[`rowCount${key}`]
  const stepIdx = side === 'left' ? 2 : 4

  const [columnSamples, setColumnSamples] = useState({})
  const [columnSamplesLoading, setColumnSamplesLoading] = useState(false)

  const setCtx = (v) => setState(s => ({ ...s, [`contextColumns${key}`]: v }))
  const setDisplay = (v) => setState(s => ({ ...s, [`displayColumn${key}`]: v }))
  const setFilters = (next) => setState(s => ({
    ...s,
    [`rowFilters${key}`]: typeof next === 'function' ? next(s[`rowFilters${key}`] || []) : next,
  }))

  const applySheetChange = (sn) => {
    const row = perSheet.find(p => p.sheet_name === sn)
    if (!row) return
    const cols = row.columns
    const defaults = pickDefaultContextColumns(cols)
    setState(s => ({
      ...s,
      [`sheet${key}`]: sn,
      [`columns${key}`]: cols,
      [`rowCount${key}`]: row.row_count,
      [`rowCountFiltered${key}`]: null,
      [`contextColumns${key}`]: defaults,
      [`displayColumn${key}`]: null,
      [`rowFilters${key}`]: [],
    }))
  }

  useEffect(() => {
    if (!tmpPath || !sheet) return
    const apiFilters = compareFiltersForApi(filters)
    let cancelled = false
    const t = setTimeout(() => {
      previewCompareRowStats(tmpPath, {
        sheetName: sheetForApi,
        rowFilters: apiFilters,
      })
        .then((res) => {
          if (!cancelled) {
            const n = res?.row_count_filtered ?? null
            setState(s => ({ ...s, [`rowCountFiltered${key}`]: n }))
          }
        })
        .catch(() => {
          if (!cancelled) setState(s => ({ ...s, [`rowCountFiltered${key}`]: null }))
        })
    }, 400)
    return () => { cancelled = true; clearTimeout(t) }
  }, [tmpPath, sheet, sheetForApi, filters])

  useEffect(() => {
    if (!tmpPath || !sheet || !columns.length) {
      setColumnSamples({})
      setColumnSamplesLoading(false)
      return
    }
    let cancelled = false
    const apiFilters = compareFiltersForApi(filters)
    const t = setTimeout(() => {
      setColumnSamples({})
      setColumnSamplesLoading(true)
      previewCompareColumnSamples(tmpPath, {
        sheetName: sheetForApi,
        rowFilters: apiFilters,
        columns,
        n: 1,
      })
        .then((res) => {
          if (!cancelled) setColumnSamples(res?.samples_by_column || {})
        })
        .catch(() => {
          if (!cancelled) setColumnSamples({})
        })
        .finally(() => {
          if (!cancelled) setColumnSamplesLoading(false)
        })
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [tmpPath, sheet, sheetForApi, filters, columns])

  return (
    <div className="space-y-5">
      <StepHeader step={stepIdx} total={STEPS.length} title={`Sheet, filters, and columns for "${label}"`} />

      {sheetNames.length > 0 && sheet && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Excel sheet</label>
          {sheetNames.length > 1 ? (
            <select
              value={sheet}
              onChange={e => applySheetChange(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-300"
            >
              {sheetNames.map(sn => (
                <option key={sn} value={sn}>{sn}</option>
              ))}
            </select>
          ) : (
            <div
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-800 bg-gray-50"
              title="This workbook has only one sheet"
            >
              {sheet}
            </div>
          )}
          <p className="text-xs text-gray-400 mt-1">
            {sheetNames.length > 1
              ? `Only this sheet is embedded for this side (${rowCountSheet?.toLocaleString?.() ?? rowCountSheet} rows before filters).`
              : `Single-sheet workbook — rows below use sheet "${sheet}" (${rowCountSheet?.toLocaleString?.() ?? rowCountSheet} rows before filters).`}
          </p>
        </div>
      )}

      <RowFiltersEditor
        columns={columns}
        filters={filters}
        onChange={setFilters}
        tmpPath={tmpPath}
        sheetForApi={sheetForApi}
      />

      <p className="text-xs text-gray-500">
        Rows after filters
        {state[`rowCountFiltered${key}`] != null ? (
          <>: <strong>{state[`rowCountFiltered${key}`].toLocaleString()}</strong> (of {rowCountSheet?.toLocaleString?.() ?? rowCountSheet} on this sheet)</>
        ) : (
          <>…</>
        )}
      </p>

      <div className="border-t border-gray-100 pt-5 space-y-5">
        <p className="text-xs text-gray-500 uppercase tracking-wide font-semibold">
          Column selection
        </p>
        <div>
          <ColumnMultiSelect
            columns={columns}
            selected={ctx}
            onChange={setCtx}
            label="Columns for similarity matching"
            samplesByColumn={columnSamples}
            samplesLoading={columnSamplesLoading}
          />
          <p className="text-xs text-gray-400 mt-1">
            Selected columns are merged into one text field per row. That text is embedded and used to find similar rows on the other side (vector similarity, not exact key matching).
          </p>
        </div>

        <ColumnSingleSelect
          columns={columns}
          value={display}
          onChange={setDisplay}
          label="Identifier column (shown in review card & export — one column only)"
        />
      </div>

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
        The chosen model will be used for all runs on this job.
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

function StepReview({ state, onSubmit, onBack, submitting, error }) {
  const leftTitle = state.labelLeft || 'Left'
  const rightTitle = state.labelRight || 'Right'

  const fmtRowsAfterFilters = (filtered, onSheet) => {
    if (filtered == null) return '—'
    if (onSheet != null) return `${filtered.toLocaleString()} (of ${onSheet.toLocaleString()})`
    return filtered.toLocaleString()
  }

  const [ctxPreview, setCtxPreview] = useState({ left: null, right: null })
  const [ctxLoading, setCtxLoading] = useState(false)
  const [ctxError, setCtxError] = useState('')
  const [expandedExample, setExpandedExample] = useState({ left: false, right: false })

  useEffect(() => {
    let alive = true
    const run = async () => {
      if (!state.tmpPathLeft || !state.tmpPathRight) return
      if (!state.contextColumnsLeft?.length || !state.contextColumnsRight?.length) return
      setCtxLoading(true)
      setCtxError('')
      try {
        const leftOpts = {
          sheetName: state.sheetNamesLeft?.length > 1 ? state.sheetLeft : null,
          rowFilters: compareFiltersForApi(state.rowFiltersLeft),
        }
        const rightOpts = {
          sheetName: state.sheetNamesRight?.length > 1 ? state.sheetRight : null,
          rowFilters: compareFiltersForApi(state.rowFiltersRight),
        }
        const [left, right] = await Promise.all([
          previewCompareContext(state.tmpPathLeft, state.contextColumnsLeft, 1, leftOpts),
          previewCompareContext(state.tmpPathRight, state.contextColumnsRight, 1, rightOpts),
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
  }, [
    state.tmpPathLeft,
    state.tmpPathRight,
    state.contextColumnsLeft,
    state.contextColumnsRight,
    state.sheetLeft,
    state.sheetRight,
    state.sheetNamesLeft,
    state.sheetNamesRight,
    state.rowFiltersLeft,
    state.rowFiltersRight,
  ])

  const fields = [
    ['File', state.filenameLeft, state.filenameRight],
    ['Excel sheet', state.sheetLeft || '—', state.sheetRight || '—'],
    ['Rows on sheet', state.rowCountLeft?.toLocaleString(), state.rowCountRight?.toLocaleString()],
    [
      'Rows after filters',
      fmtRowsAfterFilters(state.rowCountFilteredLeft, state.rowCountLeft),
      fmtRowsAfterFilters(state.rowCountFilteredRight, state.rowCountRight),
    ],
    [
      'Row filters',
      state.rowFiltersLeft?.length ? `${state.rowFiltersLeft.length} rule(s)` : 'None',
      state.rowFiltersRight?.length ? `${state.rowFiltersRight.length} rule(s)` : 'None',
    ],
    ['Match columns', state.contextColumnsLeft.join(', ') || '—', state.contextColumnsRight.join(', ') || '—'],
    ['Identifier column', state.displayColumnLeft || '—', state.displayColumnRight || '—'],
    [
      'Example merged text',
      ctxLoading ? 'Loading…' : (ctxPreview.left?.samples?.[0] || (ctxError ? ctxError : '—')),
      ctxLoading ? 'Loading…' : (ctxPreview.right?.samples?.[0] || (ctxError ? ctxError : '—')),
    ],
  ]

  const toggleExample = (side) => {
    setExpandedExample(prev => ({ ...prev, [side]: !prev[side] }))
  }

  return (
    <div className="space-y-4">
      <StepHeader step={6} total={STEPS.length} title="Review & create" />
      <p className="text-sm text-gray-500">
        After creation, embeddings will run once. You can then create multiple runs with different pipelines (reranker, LLM judge, top-k) — each run has its own review and export.
      </p>
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100">
          <div className="text-sm">
            <span className="text-gray-400">Job name</span>{' '}
            <span className="text-gray-900 font-semibold">{state.name || '—'}</span>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-12">
          <div className="hidden sm:block sm:col-span-2 bg-gray-50 border-r border-gray-100" />
          <div className="px-4 py-3 border-b sm:border-b-0 sm:border-r border-gray-100 sm:col-span-5">
            <div className="text-xs uppercase tracking-widest text-gray-400 font-semibold">Left</div>
            <div className="text-sm font-semibold text-gray-900 break-words">{leftTitle}</div>
          </div>
          <div className="px-4 py-3 border-b sm:border-b-0 border-gray-100 sm:col-span-5">
            <div className="text-xs uppercase tracking-widest text-gray-400 font-semibold">Right</div>
            <div className="text-sm font-semibold text-gray-900 break-words">{rightTitle}</div>
          </div>

          {fields.map(([label, leftVal, rightVal]) => (
            <div key={label} className="contents">
              <div className="px-4 py-3 bg-gray-50 border-t border-gray-100 text-xs font-semibold text-gray-500 uppercase tracking-widest sm:col-span-2">
                {label}
              </div>
              <div className="px-4 py-3 border-t border-gray-100 text-sm text-gray-900 font-medium min-w-0 sm:col-span-5">
                <span
                  onClick={label === 'Example merged text' ? () => toggleExample('left') : undefined}
                  role={label === 'Example merged text' ? 'button' : undefined}
                  tabIndex={label === 'Example merged text' ? 0 : undefined}
                  onKeyDown={label === 'Example merged text' ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') toggleExample('left')
                  } : undefined}
                  className={`block break-words ${
                    label === 'Example merged text'
                      ? `cursor-pointer ${expandedExample.left ? 'whitespace-pre-wrap' : 'whitespace-normal line-clamp-5 lens-clamp-5'}`
                      : 'whitespace-normal line-clamp-5 lens-clamp-5'
                  }`}
                  title={label === 'Example merged text' ? (expandedExample.left ? 'Click to collapse' : 'Click to expand') : undefined}
                >
                  {leftVal || '—'}
                </span>
              </div>
              <div className="px-4 py-3 border-t border-gray-100 text-sm text-gray-900 font-medium min-w-0 sm:col-span-5">
                <span
                  onClick={label === 'Example merged text' ? () => toggleExample('right') : undefined}
                  role={label === 'Example merged text' ? 'button' : undefined}
                  tabIndex={label === 'Example merged text' ? 0 : undefined}
                  onKeyDown={label === 'Example merged text' ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') toggleExample('right')
                  } : undefined}
                  className={`block break-words ${
                    label === 'Example merged text'
                      ? `cursor-pointer ${expandedExample.right ? 'whitespace-pre-wrap' : 'whitespace-normal line-clamp-5 lens-clamp-5'}`
                      : 'whitespace-normal line-clamp-5 lens-clamp-5'
                  }`}
                  title={label === 'Example merged text' ? (expandedExample.right ? 'Click to collapse' : 'Click to expand') : undefined}
                >
                  {rightVal || '—'}
                </span>
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
          {submitting ? 'Creating…' : 'Create & Start Embedding'}
        </button>
      </div>
    </div>
  )
}

// ── Progress overlay ──────────────────────────────────────────────────────

function ProgressView({ jobId, onDone, onBackground, onHome }) {
  const [events, setEvents] = useState([])
  const [done, setDone] = useState(false)
  const [startedAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (done) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [done])

  useEffect(() => {
    if (!jobId) return
    const es = new EventSource(`${API_BASE_URL}/compare/${jobId}/ingest`)
    es.onmessage = (e) => {
      const data = JSON.parse(e.data)
      setEvents(prev => {
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
    { type: 'ingest_left',  label: 'Embedding Left' },
    { type: 'ingest_right', label: 'Embedding Right' },
    { type: 'complete',     label: 'Done' },
  ]

  const current = events[events.length - 1]
  const currentType = current?.type
  const elapsedSec = Math.max(0, Math.floor((now - startedAt) / 1000))
  const elapsed =
    elapsedSec >= 60
      ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`
      : `${elapsedSec}s`

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-xl font-bold text-gray-900">Embedding documents…</h2>
        <span className="text-xs text-gray-400 whitespace-nowrap">Elapsed: {elapsed}</span>
      </div>
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

      {!done && currentType !== 'error' && (
        <div className="pt-2 border-t border-gray-100">
          <p className="text-sm text-gray-500">
            This runs on the server — you can safely leave this page.
          </p>
          <div className="flex flex-wrap gap-3 mt-3">
            {onBackground && (
              <button
                type="button"
                onClick={() => onBackground(jobId)}
                className="bg-white border border-gray-200 text-gray-700 px-4 py-2 rounded-lg font-medium text-sm hover:bg-gray-50 transition-colors"
              >
                Continue in background →
              </button>
            )}
            {onHome && (
              <button
                type="button"
                onClick={onHome}
                className="text-sm text-gray-500 hover:text-gray-700"
              >
                ← Home
              </button>
            )}
          </div>
        </div>
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
  rowsTotalLeft: null,
  rowsTotalRight: null,
  rowCountLeft: null,
  rowCountRight: null,
  rowCountFilteredLeft: null,
  rowCountFilteredRight: null,
  perSheetLeft: [],
  perSheetRight: [],
  sheetNamesLeft: [],
  sheetNamesRight: [],
  sheetLeft: '',
  sheetRight: '',
  columnsLeft: [],
  columnsRight: [],
  contextColumnsLeft: [],
  contextColumnsRight: [],
  displayColumnLeft: null,
  displayColumnRight: null,
  rowFiltersLeft: [],
  rowFiltersRight: [],
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

  const connectionPrefilled = useRef(false)
  const connectionTouched = useRef(false)
  const embedUrlRef = useRef('')

  // Pre-fill Connection step from system config on first visit
  useEffect(() => {
    if (step !== 5 || connectionPrefilled.current) return
    connectionPrefilled.current = true
    getSystemConfig().then(cfg => {
      if (connectionTouched.current) return
      const url = cfg.embedding_url || ''
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
        sheet_name_left: state.sheetNamesLeft?.length > 1 ? (state.sheetLeft || null) : null,
        sheet_name_right: state.sheetNamesRight?.length > 1 ? (state.sheetRight || null) : null,
        row_filters_left: compareFiltersForApi(state.rowFiltersLeft),
        row_filters_right: compareFiltersForApi(state.rowFiltersRight),
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
      })
      setCreatedJobId(job.id)
    } catch (e) {
      setSubmitError(e?.response?.data?.detail || e.message || 'Failed to create job')
      setSubmitting(false)
    }
  }

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key !== 'Enter') return
      if (e.isComposing) return
      if (e.metaKey || e.ctrlKey || e.altKey) return

      const el = document.activeElement
      if (el?.tagName === 'TEXTAREA') return
      if (el?.isContentEditable) return
      if (el?.closest?.('[data-ignore-enter-wizard]')) return

      const canProceed =
        (step === 0 && state.name.trim() && state.labelLeft.trim() && state.labelRight.trim()) ||
        (step === 1 && state.tmpPathLeft) ||
        (step === 2 && (state.contextColumnsLeft?.length ?? 0) > 0) ||
        (step === 3 && state.tmpPathRight) ||
        (step === 4 && (state.contextColumnsRight?.length ?? 0) > 0) ||
        (step === 5 && !connectionCheckLoading) ||
        (step === 6 && !submitting)

      if (!canProceed) return
      e.preventDefault()

      if (step === 0) return setStep(1)
      if (step === 1) return setStep(2)
      if (step === 2) return setStep(3)
      if (step === 3) return setStep(4)
      if (step === 4) return setStep(5)
      if (step === 5) return void handleConnectionContinue()
      if (step === 6) return void handleSubmit()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    step,
    state.name,
    state.labelLeft,
    state.labelRight,
    state.tmpPathLeft,
    state.contextColumnsLeft,
    state.tmpPathRight,
    state.contextColumnsRight,
    connectionCheckLoading,
    submitting,
    handleConnectionContinue,
  ])

  if (createdJobId) {
    return (
      <div className="min-h-screen bg-gray-50">
        <div className="w-[90%] mx-auto py-12">
          <ProgressView
            jobId={createdJobId}
            onDone={(id) => navigate(`/compare/${id}`)}
            onBackground={(id) => navigate(`/compare/${id}`)}
            onHome={() => navigate('/')}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="w-[90%] mx-auto py-12">
        <div className={`w-full ${step === 6 ? 'max-w-none' : 'max-w-lg'}`}>

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
            <StepReview state={state} onSubmit={handleSubmit} onBack={() => setStep(5)} submitting={submitting} error={submitError} />
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

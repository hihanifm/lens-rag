import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { previewExcel, createProject, API_BASE_URL } from '../api/client'

const STEPS = ['Name', 'Upload', 'Store', 'Context', 'ID Column', 'Display', 'Settings']

export default function CreateProject() {
  const navigate = useNavigate()
  const [step, setStep] = useState(0)
  const [name, setName] = useState('')
  const [file, setFile] = useState(null)
  const [preview, setPreview] = useState(null)  // { columns, sheet_names, row_count, tmp_path }
  const [storedColumns, setStoredColumns] = useState([])  // Step A: which columns to store in DB
  const [contextColumns, setContextColumns] = useState([])
  const [idColumn, setIdColumn] = useState(null)
  const [displayColumns, setDisplayColumns] = useState([])
  const [defaultK, setDefaultK] = useState(10)
  const [pin, setPin] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [ingestProgress, setIngestProgress] = useState(null)
  const evtSourceRef = useRef(null)
  const nameInputRef = useRef(null)

  useEffect(() => {
    nameInputRef.current?.focus()
  }, [])

  const next = () => setStep(s => s + 1)
  const back = () => setStep(s => s - 1)

  // Close the EventSource when the component unmounts so the browser doesn't
  // auto-reconnect and trigger a duplicate ingestion request.
  useEffect(() => {
    return () => { evtSourceRef.current?.close() }
  }, [])

  useEffect(() => {
    // Enter should behave like clicking the primary action (Continue/Create) in the create wizard.
    const onKeyDown = (e) => {
      if (e.key !== 'Enter') return
      if (e.isComposing) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (step >= STEPS.length) return // ingestion screen

      const el = document.activeElement
      if (el?.tagName === 'TEXTAREA') return
      if (el?.isContentEditable) return

      const canProceed =
        (step === 0 && name.trim()) ||
        (step === 1 && file && !loading) ||
        (step === 2 && storedColumns.length > 0) ||
        (step === 3) ||
        (step === 4) ||
        (step === 5 && displayColumns.length > 0) ||
        (step === 6 && !loading)

      if (!canProceed) return
      e.preventDefault()

      if (step === 0) return next()
      if (step === 1) return handleUpload()
      if (step === 2) return next()
      if (step === 3) return next()
      if (step === 4) {
        const defaults = [...new Set([...contextColumns, idColumn].filter(Boolean))]
        setDisplayColumns(prev => {
          const stillValid = prev.filter(c => storedColumns.includes(c))
          return stillValid.length > 0 ? stillValid : defaults
        })
        return next()
      }
      if (step === 5) return next()
      if (step === 6) return handleCreate()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    step,
    name,
    file,
    loading,
    storedColumns.length,
    contextColumns,
    idColumn,
    displayColumns.length,
  ])

  const handleUpload = async (fileArg) => {
    const target = fileArg ?? file
    if (!target) return
    setLoading(true)
    setError('')
    try {
      const data = await previewExcel(target)
      setFile(target)
      setPreview(data)
      setStoredColumns(data.columns)  // default: store all columns
      next()
    } catch (e) {
      setError('Failed to read Excel file. Please check the format.')
    } finally {
      setLoading(false)
    }
  }

  const handleLoadSample = async (filename) => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${API_BASE_URL}/samples/${filename}`)
      if (!res.ok) throw new Error('fetch failed')
      const blob = await res.blob()
      const sampleFile = new File([blob], filename, { type: blob.type })
      await handleUpload(sampleFile)
    } catch (e) {
      setError('Failed to load sample file.')
      setLoading(false)
    }
  }

  const handleCreate = async () => {
    setLoading(true)
    setError('')
    try {
      const project = await createProject({
        name,
        stored_columns: storedColumns,
        content_column: '',
        context_columns: contextColumns,
        id_column: idColumn || null,
        display_columns: displayColumns,
        default_k: defaultK,
        pin: pin || null,
        source_filename: file?.name || null,
      })

      // Start ingestion via SSE
      setStep(STEPS.length) // move to ingestion screen
      const evtSource = new EventSource(
        `${API_BASE_URL}/projects/${project.id}/ingest?tmp_path=${encodeURIComponent(preview.tmp_path)}`
      )
      evtSourceRef.current = evtSource
      evtSource.onmessage = (e) => {
        const data = JSON.parse(e.data)
        setIngestProgress(data)
        if (data.step === 'complete' || data.step === 'error') {
          evtSource.close()
          evtSourceRef.current = null
          if (data.step === 'complete') {
            setTimeout(() => navigate(`/projects/${project.id}/search`), 1500)
          }
        }
      }
    } catch (e) {
      setError('Failed to create project.')
      setLoading(false)
    }
  }

  const toggleMulti = (val, list, setList) => {
    setList(prev => prev.includes(val) ? prev.filter(x => x !== val) : [...prev, val])
  }

  // Downstream pickers are scoped to storedColumns (user's DB selection)
  const availableForContext = storedColumns
  const availableForId = storedColumns
  const availableForDisplay = storedColumns

  const toggleStored = (col) => {
    setStoredColumns(prev => {
      const next = prev.includes(col) ? prev.filter(x => x !== col) : [...prev, col]
      // Cascade: clear downstream selections that are no longer in stored
      setContextColumns(cc => cc.filter(c => next.includes(c)))
      if (idColumn && !next.includes(idColumn)) setIdColumn(null)
      setDisplayColumns(dc => dc.filter(c => next.includes(c)))
      return next
    })
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="w-[90%] mx-auto py-12 max-w-3xl">

        {/* Back */}
        <button onClick={() => navigate('/')} className="text-sm text-gray-400 hover:text-gray-600 mb-8 block">
          ← Back to projects
        </button>

        {/* Progress indicator */}
        {step < STEPS.length && (
          <div className="flex gap-1.5 mb-10">
            {STEPS.map((s, i) => (
              <div key={s} className={`h-1 flex-1 rounded-full transition-colors ${i <= step ? 'bg-blue-600' : 'bg-gray-200'}`} />
            ))}
          </div>
        )}

        {error && (
          <div className="mb-6 bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm">
            {error}
          </div>
        )}

        {/* ── Step 0: Name ── */}
        {step === 0 && (
          <div>
            <h2 className="text-2xl font-bold text-gray-900 mb-2">New Project</h2>
            <p className="text-gray-500 mb-8">Give your project a name.</p>
            <input
              ref={nameInputRef}
              data-testid="project-name"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Product Catalog Q1 2025"
              className="w-full border border-gray-300 rounded-lg px-4 py-3 text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={next}
              data-testid="continue"
              disabled={!name.trim()}
              className="mt-6 w-full bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors"
            >
              Continue
            </button>
          </div>
        )}

        {/* ── Step 1: Upload ── */}
        {step === 1 && (
          <div>
            <h2 className="text-2xl font-bold text-gray-900 mb-2">Upload Excel</h2>
            <p className="text-gray-500 mb-8">Upload your .xlsx file. All sheets will be read.</p>
            <div
              className={`border-2 rounded-xl p-8 text-center cursor-pointer transition-colors ${
                file
                  ? 'border-blue-400 bg-blue-50'
                  : 'border-dashed border-gray-300 hover:border-blue-400 hover:bg-blue-50'
              }`}
              onClick={() => document.getElementById('file-input').click()}
            >
              {file ? (
                <div className="flex flex-col items-center gap-2">
                  <span className="text-2xl">📄</span>
                  <p className="text-blue-700 font-semibold">{file.name}</p>
                  <p className="text-xs text-blue-400">Click to change</p>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3">
                  <span className="text-3xl">📂</span>
                  <button
                    type="button"
                    className="px-5 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 transition-colors pointer-events-none"
                  >
                    Choose file
                  </button>
                  <p className="text-xs text-gray-400">.xlsx or .xls</p>
                </div>
              )}
              <input
                id="file-input"
                data-testid="file-input"
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                onChange={e => setFile(e.target.files[0])}
              />
            </div>

            <div className="mt-8">
              <p className="text-xs text-gray-400 uppercase tracking-wide mb-3">Or try a sample</p>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { label: 'Product Catalog', file: 'product_catalog.xlsx', icon: '📦' },
                  { label: 'IT Assets', file: 'it_assets.xlsx', icon: '🖥' },
                  { label: 'Book Library', file: 'book_library.xlsx', icon: '📚' },
                  { label: 'HR Directory', file: 'hr_directory.xlsx', icon: '👥' },
                ].map(s => (
                  <button
                    key={s.file}
                    type="button"
                    disabled={loading}
                    onClick={() => handleLoadSample(s.file)}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-600 hover:border-blue-300 hover:text-blue-600 disabled:opacity-40 transition-colors"
                  >
                    <span>{s.icon}</span>
                    <span>{s.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="flex gap-3 mt-6">
              <button onClick={back} className="flex-1 border border-gray-300 text-gray-700 py-3 rounded-lg font-medium hover:bg-gray-50">
                Back
              </button>
              <button
                onClick={handleUpload}
                data-testid="upload-continue"
                disabled={!file || loading}
                className="flex-1 bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-40"
              >
                {loading ? 'Reading...' : 'Continue'}
              </button>
            </div>
          </div>
        )}

        {/* ── Step 2: Store columns in DB ── */}
        {step === 2 && preview && (
          <div>
            <h2 className="text-2xl font-bold text-gray-900 mb-2">Store Columns in DB</h2>
            <p className="text-gray-500 mb-2">
              Found <strong>{preview.row_count.toLocaleString()}</strong> rows across <strong>{preview.sheet_names.length}</strong> sheet(s).
            </p>
            <p className="text-gray-500 mb-8">
              Choose which columns to store. Only stored columns can be searched or shown in results.
              Defaults to all — deselect columns you don't need to save space.
            </p>
            <div className="flex gap-2 mb-3">
              <button
                onClick={() => setStoredColumns(preview.columns)}
                className="text-xs text-blue-600 hover:underline"
              >
                Select all
              </button>
              <span className="text-gray-300">·</span>
              <button
                onClick={() => setStoredColumns([])}
                className="text-xs text-gray-400 hover:underline"
              >
                Clear all
              </button>
            </div>
            <div className="space-y-2">
              {preview.columns.map(col => (
                <button
                  key={col}
                  onClick={() => toggleStored(col)}
                  className={`w-full text-left px-4 py-3 rounded-lg border transition-colors ${
                    storedColumns.includes(col)
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-gray-200 hover:border-gray-300 text-gray-700'
                  }`}
                >
                  <span className="mr-2">{storedColumns.includes(col) ? '☑' : '☐'}</span>
                  {col}
                </button>
              ))}
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={back} className="flex-1 border border-gray-300 text-gray-700 py-3 rounded-lg font-medium hover:bg-gray-50">Back</button>
              <button
                data-testid="store-continue"
                onClick={next}
                disabled={storedColumns.length === 0}
                className="flex-1 bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-40"
              >
                Continue ({storedColumns.length} of {preview.columns.length} columns)
              </button>
            </div>
          </div>
        )}

        {/* ── Step 3: Context columns ── */}
        {step === 3 && (
          <div>
            <h2 className="text-2xl font-bold text-gray-900 mb-2">Context Columns</h2>
            <p className="text-gray-500 mb-8">
              Which columns add meaningful context to search? Keep it to a few — fewer, richer columns give better accuracy.
              These are concatenated with the content to build the search index and <strong>cannot be changed later</strong>.
            </p>
            <div className="space-y-2">
              {availableForContext.map(col => (
                <button
                  key={col}
                  onClick={() => toggleMulti(col, contextColumns, setContextColumns)}
                  className={`w-full text-left px-4 py-3 rounded-lg border transition-colors ${
                    contextColumns.includes(col)
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-gray-200 hover:border-gray-300 text-gray-700'
                  }`}
                >
                  <span className="mr-2">{contextColumns.includes(col) ? '☑' : '☐'}</span>
                  {col}
                </button>
              ))}
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={back} className="flex-1 border border-gray-300 text-gray-700 py-3 rounded-lg font-medium hover:bg-gray-50">Back</button>
              <button data-testid="context-continue" onClick={next} className="flex-1 bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700">Continue</button>
            </div>
          </div>
        )}

        {/* ── Step 4: ID column (optional) ── */}
        {step === 4 && (
          <div>
            <h2 className="text-2xl font-bold text-gray-900 mb-2">ID Column <span className="text-gray-400 font-normal text-lg">(optional)</span></h2>
            <p className="text-gray-500 mb-8">
              Is there a unique identifier like a request ID or task ID? If selected, users can search by exact or partial ID.
              <strong className="block mt-1 text-gray-600">Cannot be changed after creation.</strong>
            </p>
            <div className="space-y-2">
              <button
                onClick={() => setIdColumn(null)}
                className={`w-full text-left px-4 py-3 rounded-lg border transition-colors ${
                  idColumn === null ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-200 hover:border-gray-300 text-gray-700'
                }`}
              >
                None
              </button>
              {availableForId.map(col => (
                <button
                  key={col}
                  onClick={() => setIdColumn(col)}
                  className={`w-full text-left px-4 py-3 rounded-lg border transition-colors ${
                    idColumn === col ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-200 hover:border-gray-300 text-gray-700'
                  }`}
                >
                  {col}
                </button>
              ))}
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={back} className="flex-1 border border-gray-300 text-gray-700 py-3 rounded-lg font-medium hover:bg-gray-50">Back</button>
              <button data-testid="id-continue" onClick={() => {
                const defaults = [...new Set([...contextColumns, idColumn].filter(Boolean))]
                setDisplayColumns(prev => {
                  const stillValid = prev.filter(c => storedColumns.includes(c))
                  return stillValid.length > 0 ? stillValid : defaults
                })
                next()
              }} className="flex-1 bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700">Continue</button>
            </div>
          </div>
        )}

        {/* ── Step 5: Results columns ── */}
        {step === 5 && (
          <div>
            <h2 className="text-2xl font-bold text-gray-900 mb-2">Results Columns</h2>
            <p className="text-gray-500 mb-8">Which columns should appear in search results? You can change this later in Settings.</p>
            <div className="space-y-2">
              {availableForDisplay.map(col => (
                <button
                  key={col}
                  onClick={() => toggleMulti(col, displayColumns, setDisplayColumns)}
                  className={`w-full text-left px-4 py-3 rounded-lg border transition-colors ${
                    displayColumns.includes(col)
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-gray-200 hover:border-gray-300 text-gray-700'
                  }`}
                >
                  <span className="mr-2">{displayColumns.includes(col) ? '☑' : '☐'}</span>
                  {col}
                </button>
              ))}
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={back} className="flex-1 border border-gray-300 text-gray-700 py-3 rounded-lg font-medium hover:bg-gray-50">Back</button>
              <button data-testid="display-continue" onClick={next} disabled={displayColumns.length === 0} className="flex-1 bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-40">Continue</button>
            </div>
          </div>
        )}

        {/* ── Step 6: Settings ── */}
        {step === 6 && (
          <div>
            <h2 className="text-2xl font-bold text-gray-900 mb-2">Settings</h2>
            <p className="text-gray-500 mb-8">Default number of results to show per search.</p>
            <div className="flex gap-3">
              {[5, 10, 20, 50].map(k => (
                <button
                  key={k}
                  onClick={() => setDefaultK(k)}
                  className={`flex-1 py-3 rounded-lg border font-medium transition-colors ${
                    defaultK === k ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-700 hover:border-gray-300'
                  }`}
                >
                  {k}
                </button>
              ))}
            </div>

            <div className="mt-6">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Access PIN <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              <input
                type="password"
                value={pin}
                onChange={e => setPin(e.target.value)}
                placeholder="Leave blank for open access"
                className="w-full border border-gray-300 rounded-lg px-4 py-3 text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div className="mt-10 bg-gray-50 rounded-xl border border-gray-200 p-5 text-sm text-gray-600 space-y-1.5">
              <p><span className="font-medium">Project:</span> {name}</p>
              <p><span className="font-medium">Stored columns:</span> {storedColumns.length} of {preview?.columns.length}</p>
              <p><span className="font-medium">Context:</span> {contextColumns.join(', ') || 'None'}</p>
              <p><span className="font-medium">ID column:</span> {idColumn || 'None'}</p>
              <p><span className="font-medium">Results columns:</span> {displayColumns.join(', ')}</p>
              <p><span className="font-medium">Records:</span> {preview?.row_count?.toLocaleString()}</p>
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={back} className="flex-1 border border-gray-300 text-gray-700 py-3 rounded-lg font-medium hover:bg-gray-50">Back</button>
              <button
                onClick={handleCreate}
                data-testid="create-project"
                disabled={loading}
                className="flex-1 bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-40"
              >
                {loading ? 'Creating...' : 'Create Project'}
              </button>
            </div>
          </div>
        )}

        {/* ── Ingestion progress ── */}
        {step === STEPS.length && (
          <div>
            <h2 className="text-2xl font-bold text-gray-900 mb-8">Ingesting records...</h2>
            {ingestProgress && (
              <div className="space-y-4">
                <p className="text-gray-600">{ingestProgress.message}</p>
                {ingestProgress.step === 'progress' && (
                  <>
                    <div className="w-full bg-gray-200 rounded-full h-2">
                      <div
                        className="bg-blue-600 h-2 rounded-full transition-all"
                        style={{ width: `${ingestProgress.percent}%` }}
                      />
                    </div>
                    <p className="text-sm text-gray-400">
                      {ingestProgress.processed.toLocaleString()} / {ingestProgress.total.toLocaleString()} records ({ingestProgress.percent}%)
                    </p>
                  </>
                )}
                {ingestProgress.step === 'complete' && (
                  <p data-testid="ingest-complete" className="text-emerald-600 font-medium">✓ Complete! Redirecting to search...</p>
                )}
                {ingestProgress.step === 'error' && (
                  <p className="text-red-600">Error: {ingestProgress.message}</p>
                )}
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  )
}

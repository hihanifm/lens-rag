import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { previewExcel, createProject, fetchModels, getSystemConfig, verifyEmbedding, verifyRerank, API_BASE_URL } from '../api/client'

const STEPS = [
  'Name',
  'Upload',
  'Store',
  'Context',
  'ID Column',
  'Display',
  'Connection',
  'Rerank',
  'Settings',
]

export default function CreateProject() {
  const navigate = useNavigate()
  const [step, setStep] = useState(0)
  const [name, setName] = useState('')
  const [file, setFile] = useState(null)
  const [preview, setPreview] = useState(null)  // { columns, sheet_names, row_count, tmp_path }
  const [previewFileName, setPreviewFileName] = useState('')
  const [storedColumns, setStoredColumns] = useState([])  // Step A: which columns to store in DB
  const [contextColumns, setContextColumns] = useState([])
  const [idColumn, setIdColumn] = useState(null)
  const [displayColumns, setDisplayColumns] = useState([])
  const [defaultK, setDefaultK] = useState(10)
  const [pin, setPin] = useState('')
  const [rerankEnabled, setRerankEnabled] = useState(true)
  const [rerankModel, setRerankModel] = useState('')
  const [embedUrl, setEmbedUrl] = useState('')
  const [embedApiKey, setEmbedApiKey] = useState('')
  const [embedModel, setEmbedModel] = useState('')
  const [availableModels, setAvailableModels] = useState([])
  const [modelLoading, setModelLoading] = useState(false)
  const [modelError, setModelError] = useState('')
  const [rerankAvailableModels, setRerankAvailableModels] = useState([])
  const [rerankModelError, setRerankModelError] = useState('')
  const [rerankModelLoading, setRerankModelLoading] = useState(false)
  const [rerankCheckLoading, setRerankCheckLoading] = useState(false)
  const [connectionCheckLoading, setConnectionCheckLoading] = useState(false)
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
      next()
    } catch (e) {
      const d = e?.response?.data?.detail
      setModelError(
        typeof d === 'string'
          ? d
          : 'Could not verify embedding with this URL/model. Use an embedding-capable model or fix the endpoint.',
      )
    } finally {
      setConnectionCheckLoading(false)
    }
  }, [embedUrl, embedApiKey, embedModel, next])

  const handleRerankContinue = useCallback(async () => {
    setRerankModelError('')
    // Only validate when enabled + explicit override.
    if (!rerankEnabled || !rerankModel.trim()) return next()
    setRerankCheckLoading(true)
    try {
      await verifyRerank({ model: rerankModel.trim() })
      next()
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
  }, [rerankEnabled, rerankModel, next])

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
        (step === 6 && !connectionCheckLoading) ||
        (step === 7 && !rerankModelLoading && !rerankCheckLoading) ||
        (step === 8 && !loading)

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
      if (step === 6) return void handleConnectionContinue()
      if (step === 7) return void handleRerankContinue()
      if (step === 8) return handleCreate()
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
    connectionCheckLoading,
    rerankModelLoading,
    rerankCheckLoading,
    handleConnectionContinue,
    handleRerankContinue,
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
      setPreviewFileName(target.name)
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
      // Populate the widget and pre-fetch preview, but do not advance steps.
      setFile(sampleFile)
      const data = await previewExcel(sampleFile)
      setPreview(data)
      setPreviewFileName(sampleFile.name)
      setStoredColumns(data.columns) // default: store all columns
    } catch (e) {
      setError('Failed to load sample file.')
    } finally {
      setLoading(false)
    }
  }

  // Pre-fill Connection step with system defaults on first visit
  const connectionPrefilled = useRef(false)
  const connectionTouched = useRef(false)
  const embedUrlRef = useRef('')
  /** System embedding URL — used on Rerank step to list models when Connection was left blank. */
  const systemEmbedUrlRef = useRef('')
  useEffect(() => {
    if (step !== 6 || connectionPrefilled.current) return
    connectionPrefilled.current = true
    getSystemConfig().then(cfg => {
      if (connectionTouched.current) return
      const url = cfg.embedding_url || ''
      if (cfg?.embedding_url) systemEmbedUrlRef.current = cfg.embedding_url
      // Only prefill if the user hasn't typed anything yet.
      if (!embedUrlRef.current.trim()) {
        setEmbedUrl(url)
        embedUrlRef.current = url
      }
      if (url) {
        // OpenAI model listing requires an API key; don't auto-fetch on arrival.
        if (cfg.embedding_provider === 'openai') {
          setAvailableModels([])
          setEmbedModel(cfg.embedding_model || '')
          setModelError('OpenAI endpoints require an API key to list models. Enter key, then click “Fetch available models”.')
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

  const rerankPrefilled = useRef(false)
  useEffect(() => {
    if (step !== 7 || rerankPrefilled.current) return
    rerankPrefilled.current = true
    getSystemConfig()
      .then(cfg => {
        if (cfg?.embedding_url) systemEmbedUrlRef.current = cfg.embedding_url
        if (cfg?.reranker_model) {
          setRerankModel(prev => (prev.trim() ? prev : cfg.reranker_model))
        }
      })
      .catch(() => {})
  }, [step])

  const handleFetchRerankModels = async () => {
    const url = embedUrl.trim() || systemEmbedUrlRef.current
    if (!url) {
      setRerankModelError('No OpenAI-compatible endpoint to list models from. Enter one on the Embedding step, or type a rerank model id manually.')
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
        setRerankModel(
          preferred && models.includes(preferred) ? preferred : models[0],
        )
      }
    } catch (e) {
      setRerankModelError('Could not reach the endpoint. Check the embedding URL and try again.')
    } finally {
      setRerankModelLoading(false)
    }
  }

  const handleFetchModels = async () => {
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
      else setEmbedModel('')
    } catch (e) {
      setModelError('Could not reach the endpoint. Check the URL and try again.')
    } finally {
      setModelLoading(false)
    }
  }

  const handleCreate = async () => {
    setLoading(true)
    setError('')
    try {
      const url = embedUrl.trim()
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
        embed_url: url || null,
        embed_api_key: url ? (embedApiKey.trim() || null) : null,
        // Custom model only applies with a custom endpoint; avoids stale chat-model IDs with system URL.
        embed_model: url ? (embedModel.trim() || null) : null,
        embed_dims: null,
        rerank_enabled: rerankEnabled,
        rerank_model: rerankModel.trim() || null,
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
                  <div className="pt-2">
                    <p className="text-[11px] text-gray-400 uppercase tracking-wide mb-2">Or try a sample</p>
                    <div className="flex flex-wrap justify-center gap-2">
                      {[
                        { label: 'Products', file: 'product_catalog.xlsx', icon: '📦' },
                        { label: 'IT Assets', file: 'it_assets.xlsx', icon: '🖥' },
                        { label: 'Books', file: 'book_library.xlsx', icon: '📚' },
                        { label: 'HR', file: 'hr_directory.xlsx', icon: '👥' },
                      ].map(s => (
                        <button
                          key={s.file}
                          type="button"
                          disabled={loading}
                          onClick={(e) => { e.stopPropagation(); handleLoadSample(s.file) }}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border border-gray-200 bg-white text-xs text-gray-600 hover:border-blue-300 hover:text-blue-700 disabled:opacity-40 transition-colors"
                        >
                          <span aria-hidden>{s.icon}</span>
                          <span>{s.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
              <input
                id="file-input"
                data-testid="file-input"
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                onChange={e => {
                  const f = e.target.files[0]
                  setFile(f || null)
                  setPreview(null)
                  setPreviewFileName('')
                }}
              />
            </div>

            <div className="flex gap-3 mt-6">
              <button onClick={back} className="flex-1 border border-gray-300 text-gray-700 py-3 rounded-lg font-medium hover:bg-gray-50">
                Back
              </button>
              <button
                onClick={() => {
                  if (file && preview && previewFileName === file.name) return next()
                  return handleUpload()
                }}
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

        {/* ── Step 6: Connection (embedding model) ── */}
        {step === 6 && (
          <div>
            <h2 className="text-2xl font-bold text-gray-900 mb-2">Embedding Model</h2>
            <p className="text-gray-500 mb-8">
              Override the default embedding model for this project. Leave blank to use the system default.
              The chosen model will be used for ingestion and all searches.
            </p>

            <div className="space-y-4">
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                <div className="font-semibold mb-0.5">Tip</div>
                <div>
                  Unless you&apos;re debugging performance or testing a new embedding model/endpoint you installed, leave these fields blank
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
                  onChange={e => { connectionTouched.current = true; embedUrlRef.current = e.target.value; setEmbedUrl(e.target.value); setAvailableModels([]); setEmbedModel(''); setModelError('') }}
                  placeholder="e.g. http://192.168.1.10:11434/v1"
                  data-testid="embed-url"
                  className="w-full border border-gray-300 rounded-lg px-4 py-3 text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <div className="mt-2 text-xs text-gray-600 space-y-2">
                  <p className="text-gray-500">
                    Ollama endpoints (click to fill):
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        const v = 'http://host.docker.internal:11434/v1'
                        connectionTouched.current = true
                        embedUrlRef.current = v
                        setEmbedUrl(v)
                        setAvailableModels([])
                        setEmbedModel('')
                        setModelError('')
                      }}
                      className="px-2.5 py-1 rounded-md border border-gray-200 bg-white hover:bg-gray-50 text-gray-700 font-mono"
                    >
                      http://host.docker.internal:11434/v1
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const v = 'http://localhost:11434/v1'
                        connectionTouched.current = true
                        embedUrlRef.current = v
                        setEmbedUrl(v)
                        setAvailableModels([])
                        setEmbedModel('')
                        setModelError('')
                      }}
                      className="px-2.5 py-1 rounded-md border border-gray-200 bg-white hover:bg-gray-50 text-gray-700 font-mono"
                    >
                      http://localhost:11434/v1
                    </button>
                  </div>
                  <p className="text-gray-400">
                    Use <span className="font-mono">host.docker.internal</span> when LENS runs in Docker and Ollama runs on the host; use <span className="font-mono">localhost</span> only when the browser is on the same machine as Ollama.
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
                  data-testid="embed-api-key"
                  className="w-full border border-gray-300 rounded-lg px-4 py-3 text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <button
                type="button"
                onClick={handleFetchModels}
                disabled={!embedUrl.trim() || modelLoading}
                data-testid="fetch-models"
                className="w-full border border-gray-300 text-gray-700 py-3 rounded-lg font-medium hover:bg-gray-50 disabled:opacity-40 transition-colors"
              >
                {modelLoading ? 'Fetching models...' : 'Fetch available models'}
              </button>

              {modelError && (
                <p className="text-sm text-red-600">{modelError}</p>
              )}

              {availableModels.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Model</label>
                  <select
                    value={embedModel}
                    onChange={e => setEmbedModel(e.target.value)}
                    data-testid="embed-model"
                    className="w-full border border-gray-300 rounded-lg px-4 py-3 text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {availableModels.map(m => (
                      <option key={m} value={m}>{m}</option>
                    ))}
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
                    data-testid="embed-model-input"
                    className="w-full border border-gray-300 rounded-lg px-4 py-3 text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <p className="text-xs text-gray-400 mt-1">
                    If model listing fails, you can still enter the embedding model ID directly.
                  </p>
                </div>
              )}

              {!embedUrl.trim() && (
                <p className="text-sm text-gray-400">System default will be used (configured by the server admin).</p>
              )}
            </div>

            <div className="flex gap-3 mt-8">
              <button onClick={back} className="flex-1 border border-gray-300 text-gray-700 py-3 rounded-lg font-medium hover:bg-gray-50">Back</button>
              <button
                data-testid="connection-continue"
                type="button"
                onClick={handleConnectionContinue}
                disabled={connectionCheckLoading}
                className="flex-1 bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50"
              >
                {connectionCheckLoading ? 'Checking…' : 'Continue'}
              </button>
            </div>
          </div>
        )}

        {/* ── Step 7: Rerank (same flow pattern as Connection / embedding) ── */}
        {step === 7 && (
          <div>
            <h2 className="text-2xl font-bold text-gray-900 mb-2">Reranking model</h2>
            <p className="text-gray-500 mb-8">
              Topic search can rerank merged candidates using your server&apos;s Ollama rerank API (same host as embeddings).
              For most users, you should ignore this and stick with the system default.
            </p>

            <div className="space-y-4">
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                <div className="font-semibold mb-0.5">Tip</div>
                <div>
                  Unless you&apos;re debugging performance or testing a new reranker you installed, leave reranking enabled
                  and keep the model blank so the server default is used.
                </div>
              </div>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={rerankEnabled}
                  onChange={e => {
                    setRerankEnabled(e.target.checked)
                    if (!e.target.checked) setRerankModelError('')
                  }}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm font-medium text-gray-700">Enable reranking for this project</span>
              </label>

              <button
                type="button"
                onClick={handleFetchRerankModels}
                disabled={!rerankEnabled || rerankModelLoading}
                data-testid="fetch-rerank-models"
                className="w-full border border-gray-300 text-gray-700 py-3 rounded-lg font-medium hover:bg-gray-50 disabled:opacity-40 transition-colors"
              >
                {rerankModelLoading ? 'Fetching models...' : 'Fetch available models'}
              </button>
              <p className="text-xs text-gray-400">
                Lists models from the same OpenAI-compatible URL as the Embedding step (or the system default URL).
                Uses the embedding API key when set.
              </p>

              {rerankModelError && (
                <p className="text-sm text-red-600">{rerankModelError}</p>
              )}

              {rerankAvailableModels.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Rerank model id <span className="text-gray-400 font-normal">(optional)</span>
                  </label>
                  <select
                    value={rerankModel}
                    onChange={e => setRerankModel(e.target.value)}
                    disabled={!rerankEnabled}
                    data-testid="rerank-model"
                    className="w-full border border-gray-300 rounded-lg px-4 py-3 text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
                  >
                    {rerankAvailableModels.map(m => (
                      <option key={m} value={m}>{m}</option>
                    ))}
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
                    data-testid="rerank-model-input"
                    className="w-full border border-gray-300 rounded-lg px-4 py-3 text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:text-gray-400"
                  />
                  <p className="text-xs text-gray-400 mt-1">
                    Fetch models above, or enter a rerank-capable model id manually. Blank uses the server default.
                  </p>
                </div>
              )}
            </div>

            <div className="flex gap-3 mt-8">
              <button onClick={back} className="flex-1 border border-gray-300 text-gray-700 py-3 rounded-lg font-medium hover:bg-gray-50">Back</button>
              <button
                type="button"
                onClick={handleRerankContinue}
                data-testid="rerank-continue"
                disabled={rerankModelLoading || rerankCheckLoading}
                className="flex-1 bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50"
              >
                {rerankCheckLoading ? 'Checking…' : 'Continue'}
              </button>
            </div>
          </div>
        )}

        {/* ── Step 8: Settings ── */}
        {step === 8 && (
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
              <p><span className="font-medium">Embedding model:</span> {embedModel || <span className="text-gray-400">system default</span>}</p>
              {embedUrl && <p><span className="font-medium">Endpoint:</span> {embedUrl}</p>}
              <p>
                <span className="font-medium">Reranker:</span>{' '}
                {rerankEnabled ? (
                  rerankModel.trim()
                    ? <span className="font-mono">{rerankModel.trim()}</span>
                    : <span className="text-gray-400">system default</span>
                ) : (
                  <span className="text-gray-400">off for this project</span>
                )}
              </p>
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

            {/* Show background CTA only while ingestion is running */}
            {ingestProgress?.step !== 'complete' && ingestProgress?.step !== 'error' && (
              <div className="mt-8 pt-6 border-t border-gray-100 text-center">
                <p className="text-sm text-gray-400 mb-3">
                  Ingestion runs on the server — safe to leave this page.
                </p>
                <button
                  onClick={() => navigate('/')}
                  className="text-sm text-blue-600 hover:text-blue-700 font-medium"
                >
                  Continue in background →
                </button>
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  )
}

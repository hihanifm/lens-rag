import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { previewExcel, createProject } from '../api/client'

const STEPS = ['Name', 'Upload', 'Content', 'Context', 'ID Column', 'Display', 'Settings']

export default function CreateProject() {
  const navigate = useNavigate()
  const [step, setStep] = useState(0)
  const [name, setName] = useState('')
  const [file, setFile] = useState(null)
  const [preview, setPreview] = useState(null)  // { columns, sheet_names, row_count, tmp_path }
  const [contentColumn, setContentColumn] = useState('')
  const [contextColumns, setContextColumns] = useState([])
  const [idColumn, setIdColumn] = useState(null)
  const [displayColumns, setDisplayColumns] = useState([])
  const [defaultK, setDefaultK] = useState(10)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [ingestProgress, setIngestProgress] = useState(null)

  const next = () => setStep(s => s + 1)
  const back = () => setStep(s => s - 1)

  const handleUpload = async () => {
    if (!file) return
    setLoading(true)
    setError('')
    try {
      const data = await previewExcel(file)
      setPreview(data)
      next()
    } catch (e) {
      setError('Failed to read Excel file. Please check the format.')
    } finally {
      setLoading(false)
    }
  }

  const handleCreate = async () => {
    setLoading(true)
    setError('')
    try {
      const project = await createProject({
        name,
        content_column: contentColumn,
        context_columns: contextColumns,
        id_column: idColumn || null,
        display_columns: displayColumns,
        default_k: defaultK
      })

      // Start ingestion via SSE
      setStep(STEPS.length) // move to ingestion screen
      const evtSource = new EventSource(
        `http://localhost:8000/projects/${project.id}/ingest?tmp_path=${encodeURIComponent(preview.tmp_path)}`
      )
      evtSource.onmessage = (e) => {
        const data = JSON.parse(e.data)
        setIngestProgress(data)
        if (data.step === 'complete' || data.step === 'error') {
          evtSource.close()
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

  const availableForContext = preview?.columns.filter(c => c !== contentColumn) || []

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-2xl mx-auto px-6 py-12">

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
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. VZW SMS Requirements"
              className="w-full border border-gray-300 rounded-lg px-4 py-3 text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={next}
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
              className="border-2 border-dashed border-gray-300 rounded-xl p-12 text-center cursor-pointer hover:border-blue-400 transition-colors"
              onClick={() => document.getElementById('file-input').click()}
            >
              {file ? (
                <p className="text-gray-700 font-medium">{file.name}</p>
              ) : (
                <p className="text-gray-400">Click to choose file</p>
              )}
              <input
                id="file-input"
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                onChange={e => setFile(e.target.files[0])}
              />
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={back} className="flex-1 border border-gray-300 text-gray-700 py-3 rounded-lg font-medium hover:bg-gray-50">
                Back
              </button>
              <button
                onClick={handleUpload}
                disabled={!file || loading}
                className="flex-1 bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-40"
              >
                {loading ? 'Reading...' : 'Continue'}
              </button>
            </div>
          </div>
        )}

        {/* ── Step 2: Content column ── */}
        {step === 2 && preview && (
          <div>
            <h2 className="text-2xl font-bold text-gray-900 mb-2">Content Column</h2>
            <p className="text-gray-500 mb-2">
              Found <strong>{preview.row_count.toLocaleString()}</strong> rows across <strong>{preview.sheet_names.length}</strong> sheet(s).
            </p>
            <p className="text-gray-500 mb-8">Which column contains the main text to search?</p>
            <div className="space-y-2">
              {preview.columns.map(col => (
                <button
                  key={col}
                  onClick={() => setContentColumn(col)}
                  className={`w-full text-left px-4 py-3 rounded-lg border transition-colors ${
                    contentColumn === col
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-gray-200 hover:border-gray-300 text-gray-700'
                  }`}
                >
                  {col}
                </button>
              ))}
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={back} className="flex-1 border border-gray-300 text-gray-700 py-3 rounded-lg font-medium hover:bg-gray-50">Back</button>
              <button onClick={next} disabled={!contentColumn} className="flex-1 bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-40">Continue</button>
            </div>
          </div>
        )}

        {/* ── Step 3: Context columns ── */}
        {step === 3 && (
          <div>
            <h2 className="text-2xl font-bold text-gray-900 mb-2">Context Columns</h2>
            <p className="text-gray-500 mb-8">Which columns provide context? These will be prefixed to the content for better search accuracy.</p>
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
              <button onClick={next} className="flex-1 bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700">Continue</button>
            </div>
          </div>
        )}

        {/* ── Step 4: ID column (optional) ── */}
        {step === 4 && (
          <div>
            <h2 className="text-2xl font-bold text-gray-900 mb-2">ID Column <span className="text-gray-400 font-normal text-lg">(optional)</span></h2>
            <p className="text-gray-500 mb-8">Is there a unique identifier column? If selected, users can search by exact or partial ID.</p>
            <div className="space-y-2">
              <button
                onClick={() => setIdColumn(null)}
                className={`w-full text-left px-4 py-3 rounded-lg border transition-colors ${
                  idColumn === null ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-200 hover:border-gray-300 text-gray-700'
                }`}
              >
                None
              </button>
              {availableForContext.map(col => (
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
              <button onClick={() => {
                // Pre-fill display columns with context + id + content
                const defaults = [...new Set([...contextColumns, idColumn, contentColumn].filter(Boolean))]
                setDisplayColumns(defaults)
                next()
              }} className="flex-1 bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700">Continue</button>
            </div>
          </div>
        )}

        {/* ── Step 5: Display columns ── */}
        {step === 5 && (
          <div>
            <h2 className="text-2xl font-bold text-gray-900 mb-2">Display Columns</h2>
            <p className="text-gray-500 mb-8">Which columns should appear in search results?</p>
            <div className="space-y-2">
              {preview.columns.map(col => (
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
              <button onClick={next} disabled={displayColumns.length === 0} className="flex-1 bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-40">Continue</button>
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
            <div className="mt-10 bg-gray-50 rounded-xl border border-gray-200 p-5 text-sm text-gray-600 space-y-1.5">
              <p><span className="font-medium">Project:</span> {name}</p>
              <p><span className="font-medium">Content:</span> {contentColumn}</p>
              <p><span className="font-medium">Context:</span> {contextColumns.join(', ') || 'None'}</p>
              <p><span className="font-medium">ID column:</span> {idColumn || 'None'}</p>
              <p><span className="font-medium">Display:</span> {displayColumns.join(', ')}</p>
              <p><span className="font-medium">Records:</span> {preview?.row_count?.toLocaleString()}</p>
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={back} className="flex-1 border border-gray-300 text-gray-700 py-3 rounded-lg font-medium hover:bg-gray-50">Back</button>
              <button
                onClick={handleCreate}
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
                  <p className="text-emerald-600 font-medium">✓ Complete! Redirecting to search...</p>
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

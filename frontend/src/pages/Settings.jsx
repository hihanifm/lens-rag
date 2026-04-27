import { useState, useEffect } from 'react'
import { useParams, Link, useLocation } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getProject, getProjectColumns, updateProject } from '../api/client'

function Badge({ children }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded bg-gray-100 text-gray-700 text-xs font-medium">
      {children}
    </span>
  )
}

function ReadOnlyField({ label, children }) {
  return (
    <div>
      <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-1">{label}</p>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  )
}

export default function Settings() {
  const { projectId } = useParams()
  const location = useLocation()
  const queryClient = useQueryClient()

  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId),
  })

  const { data: columnsData } = useQuery({
    queryKey: ['project-columns', projectId],
    queryFn: () => getProjectColumns(projectId),
    enabled: !!project,
  })

  const [name, setName] = useState('')
  const [defaultK, setDefaultK] = useState(10)
  const [displayColumns, setDisplayColumns] = useState([])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (project) {
      setName(project.name)
      setDefaultK(project.default_k)
      setDisplayColumns(project.display_columns)
    }
  }, [project])

  const allColumns = columnsData?.columns ?? []

  const toggleColumn = (col) => {
    setDisplayColumns(prev =>
      prev.includes(col) ? prev.filter(c => c !== col) : [...prev, col]
    )
    setSaved(false)
  }

  const handleSave = async () => {
    setSaving(true)
    setSaved(false)
    try {
      await updateProject(projectId, { name, display_columns: displayColumns, default_k: defaultK })
      await queryClient.invalidateQueries({ queryKey: ['project', projectId] })
      await queryClient.invalidateQueries({ queryKey: ['projects'] })
      setSaved(true)
    } finally {
      setSaving(false)
    }
  }

  const isDirty = project && (
    name !== project.name ||
    defaultK !== project.default_k ||
    JSON.stringify([...displayColumns].sort()) !== JSON.stringify([...project.display_columns].sort())
  )

  if (!project) return <div className="p-8 text-gray-400">Loading...</div>

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto px-6 py-10">

        {/* Header */}
        <div className="mb-8">
          <Link to="/" className="text-sm text-gray-400 hover:text-gray-600">← Projects</Link>
          <h1 className="text-2xl font-bold text-gray-900 mt-1">{project.name}</h1>
          <p className="text-sm text-gray-400 mb-4">{project.row_count?.toLocaleString()} records</p>
          <div className="flex gap-1">
            <Link
              to={`/projects/${projectId}/search`}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors"
            >
              Search
            </Link>
            <Link
              to={`/projects/${projectId}/evaluate`}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors"
            >
              Evaluate
            </Link>
            <Link
              to={`/projects/${projectId}/settings`}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                location.pathname.endsWith('/settings')
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              Settings
            </Link>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

          {/* Read-only config */}
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
            <h2 className="text-base font-semibold text-gray-900 mb-5">Ingestion Config</h2>
            <div className="space-y-4">
              <ReadOnlyField label="Content column">
                <Badge>{project.content_column}</Badge>
              </ReadOnlyField>
              <ReadOnlyField label="Context columns">
                {project.context_columns.length > 0
                  ? project.context_columns.map(c => <Badge key={c}>{c}</Badge>)
                  : <span className="text-sm text-gray-400">None</span>}
              </ReadOnlyField>
              <ReadOnlyField label="ID column">
                {project.id_column
                  ? <Badge>{project.id_column}</Badge>
                  : <span className="text-sm text-gray-400">None</span>}
              </ReadOnlyField>
              <ReadOnlyField label="Records">
                <Badge>{project.row_count?.toLocaleString() ?? '—'}</Badge>
              </ReadOnlyField>
              <ReadOnlyField label="Created">
                <span className="text-sm text-gray-600">
                  {new Date(project.created_at).toLocaleString()}
                </span>
              </ReadOnlyField>
              <ReadOnlyField label="Schema">
                <span className="text-sm text-gray-400 font-mono">{project.schema_name}</span>
              </ReadOnlyField>
            </div>
            <p className="mt-5 text-xs text-gray-400">
              Changing content or context columns requires re-ingestion — create a new project to change these.
            </p>
          </div>

          {/* Editable settings */}
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
            <h2 className="text-base font-semibold text-gray-900 mb-5">Project Settings</h2>
            <div className="space-y-6">

              {/* Name */}
              <div>
                <label className="text-xs font-medium text-gray-400 uppercase tracking-wide block mb-1">
                  Project name
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={e => { setName(e.target.value); setSaved(false) }}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              {/* Default k */}
              <div>
                <label className="text-xs font-medium text-gray-400 uppercase tracking-wide block mb-2">
                  Default results (k)
                </label>
                <div className="flex gap-2">
                  {[5, 10, 20, 50].map(val => (
                    <button
                      key={val}
                      onClick={() => { setDefaultK(val); setSaved(false) }}
                      className={`text-sm px-4 py-1.5 rounded-lg transition-colors ${
                        defaultK === val
                          ? 'bg-blue-100 text-blue-700 font-medium'
                          : 'text-gray-500 hover:bg-gray-100'
                      }`}
                    >
                      {val}
                    </button>
                  ))}
                </div>
              </div>

              {/* Display columns */}
              <div>
                <label className="text-xs font-medium text-gray-400 uppercase tracking-wide block mb-2">
                  Display columns
                </label>
                {allColumns.length === 0 ? (
                  <p className="text-sm text-gray-400">Loading columns...</p>
                ) : (
                  <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto pr-1">
                    {allColumns.map(col => (
                      <label key={col} className="flex items-center gap-2 cursor-pointer group">
                        <input
                          type="checkbox"
                          checked={displayColumns.includes(col)}
                          onChange={() => toggleColumn(col)}
                          className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                        <span className="text-sm text-gray-700 group-hover:text-gray-900 truncate">{col}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

            </div>

            {/* Save */}
            <div className="mt-6 flex items-center gap-3">
              <button
                onClick={handleSave}
                disabled={saving || !isDirty || displayColumns.length === 0}
                className="bg-blue-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors"
              >
                {saving ? 'Saving...' : 'Save changes'}
              </button>
              {saved && (
                <span className="text-sm text-emerald-600 font-medium">Saved</span>
              )}
              {displayColumns.length === 0 && (
                <span className="text-sm text-red-500">Select at least one display column.</span>
              )}
            </div>
          </div>

        </div>
      </div>
    </div>
  )
}

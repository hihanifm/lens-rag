import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  listPromptTemplates,
  getPromptTemplate,
  createPromptTemplate,
  updatePromptTemplate,
  deletePromptTemplate,
} from '../api/client'

/** FastAPI often returns `detail` as string or list of { msg, ... }; never pass raw objects to React children. */
function formatApiDetail(detail) {
  if (detail == null || detail === '') return null
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    return detail
      .map((x) => (typeof x === 'object' && x != null && 'msg' in x ? x.msg : JSON.stringify(x)))
      .join(' — ')
  }
  if (typeof detail === 'object') return JSON.stringify(detail)
  return String(detail)
}

function formatAxiosError(err, fallback) {
  const d = formatApiDetail(err?.response?.data?.detail)
  if (d) return d
  return err?.message || fallback
}

export default function PromptPresets() {
  const queryClient = useQueryClient()
  const { data: rows = [], isLoading, isError, error } = useQuery({
    queryKey: ['compare-prompt-templates'],
    queryFn: listPromptTemplates,
  })

  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newBody, setNewBody] = useState('')
  const [editingId, setEditingId] = useState(null)
  const [editName, setEditName] = useState('')
  const [editBody, setEditBody] = useState('')
  const [editMeta, setEditMeta] = useState(null)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState('')

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['compare-prompt-templates'] })

  const startEdit = async (id) => {
    setFormError('')
    setBusy(true)
    try {
      const t = await getPromptTemplate(id)
      setEditingId(id)
      setEditName(t.name)
      setEditBody(t.body)
      setEditMeta({ version: t.version, updated_at: t.updated_at })
    } catch (e) {
      setFormError(formatAxiosError(e, 'Could not load preset'))
    } finally {
      setBusy(false)
    }
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditMeta(null)
    setFormError('')
  }

  const saveEdit = async () => {
    setFormError('')
    const name = editName.trim()
    const body = editBody.trim()
    if (!name || !body) {
      setFormError('Name and body are required.')
      return
    }
    setBusy(true)
    try {
      await updatePromptTemplate(editingId, { name, body })
      await invalidate()
      cancelEdit()
    } catch (e) {
      setFormError(formatAxiosError(e, 'Could not save'))
    } finally {
      setBusy(false)
    }
  }

  const saveNew = async () => {
    setFormError('')
    const name = newName.trim()
    const body = newBody.trim()
    if (!name || !body) {
      setFormError('Name and body are required.')
      return
    }
    setBusy(true)
    try {
      await createPromptTemplate({ name, body })
      setNewName('')
      setNewBody('')
      setCreating(false)
      await invalidate()
    } catch (e) {
      setFormError(formatAxiosError(e, 'Could not create'))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id, name) => {
    if (!window.confirm(`Delete preset "${name}"? This cannot be undone.`)) return
    setBusy(true)
    setFormError('')
    try {
      await deletePromptTemplate(id)
      if (editingId === id) cancelEdit()
      await invalidate()
    } catch (e) {
      setFormError(formatAxiosError(e, 'Could not delete'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="w-[90%] mx-auto py-10 max-w-3xl">
        <Link to="/" className="text-sm text-gray-400 hover:text-gray-600">
          ← Home
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 mt-2">Judge prompt presets</h1>
        <p className="text-sm text-gray-500 mt-1 max-w-2xl">
          Named domain overlays for the Compare LLM judge (same presets as in New Run). Editing the body bumps the
          version on that row.
        </p>

        {formError && (
          <div className="mt-6 bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm">
            {formError}
          </div>
        )}

        <div className="mt-8 flex flex-wrap gap-2">
          {!creating ? (
            <button
              type="button"
              onClick={() => {
                setCreating(true)
                setFormError('')
              }}
              disabled={busy}
              className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40"
            >
              Create prompt
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                setCreating(false)
                setNewName('')
                setNewBody('')
                setFormError('')
              }}
              disabled={busy}
              className="border border-gray-200 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-50 disabled:opacity-40"
            >
              Cancel
            </button>
          )}
        </div>

        {creating && (
          <div className="mt-4 bg-white rounded-xl border border-gray-200 p-5 space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Name</label>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                placeholder="Short label"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Domain guidance (body)</label>
              <textarea
                value={newBody}
                onChange={(e) => setNewBody(e.target.value)}
                rows={6}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono"
                placeholder="What to emphasize when judging candidates…"
              />
            </div>
            <button
              type="button"
              onClick={saveNew}
              disabled={busy}
              className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40"
            >
              {busy ? 'Saving…' : 'Create preset'}
            </button>
          </div>
        )}

        <div className="mt-8">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">Saved presets</h2>
          {isLoading && <p className="text-gray-400 text-sm">Loading…</p>}
          {isError && (
            <div className="text-red-600 text-sm space-y-1">
              <p>{formatAxiosError(error, 'Failed to load presets')}</p>
              {error?.response?.status === 422 && (
                <p className="text-xs text-gray-600">
                  If this is a fresh preset setup, rebuild and restart the API container so{' '}
                  <code className="font-mono bg-red-50 px-1 rounded">/compare/prompt-templates</code> is registered.
                </p>
              )}
            </div>
          )}
          {!isLoading && !isError && rows.length === 0 && !creating && (
            <p className="text-gray-500 text-sm">No presets yet. Create one above or from a Compare job run.</p>
          )}
          <ul className="space-y-3">
            {rows.map((r) => (
              <li key={r.id} className="bg-white rounded-xl border border-gray-200 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <span className="font-semibold text-gray-900">{r.name}</span>
                    <span className="text-xs text-gray-500 ml-2">v{r.version ?? 1}</span>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => startEdit(r.id)}
                      disabled={busy}
                      className="text-sm text-blue-600 hover:text-blue-800 font-medium disabled:opacity-40"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(r.id, r.name)}
                      disabled={busy}
                      className="text-sm text-red-600 hover:text-red-800 font-medium disabled:opacity-40"
                    >
                      Delete
                    </button>
                  </div>
                </div>
                {editingId === r.id && (
                  <div className="mt-4 pt-4 border-t border-gray-100 space-y-3">
                    {editMeta && (
                      <p className="text-xs text-gray-400">
                        Version {editMeta.version}
                        {editMeta.updated_at != null &&
                          ` · updated ${new Date(editMeta.updated_at).toLocaleString()}`}
                      </p>
                    )}
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Name</label>
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Body</label>
                      <textarea
                        value={editBody}
                        onChange={(e) => setEditBody(e.target.value)}
                        rows={8}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono"
                      />
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={saveEdit}
                        disabled={busy}
                        className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40"
                      >
                        {busy ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        type="button"
                        onClick={cancelEdit}
                        disabled={busy}
                        className="border border-gray-200 text-gray-700 px-4 py-2 rounded-lg text-sm hover:bg-gray-50 disabled:opacity-40"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}

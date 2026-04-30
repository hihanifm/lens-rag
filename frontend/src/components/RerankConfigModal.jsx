import { useEffect, useMemo, useState } from 'react'
import { fetchModels, getSystemConfig, updateProject, verifyRerank } from '../api/client'

export default function RerankConfigModal({
  open,
  onClose,
  projectId,
  currentEnabled,
  currentModel,
  embedUrl,
  onSaved,
}) {
  const [enabled, setEnabled] = useState(Boolean(currentEnabled))
  const [model, setModel] = useState(currentModel || '')
  const [availableModels, setAvailableModels] = useState([])
  const [modelLoading, setModelLoading] = useState(false)
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [systemDefaultModel, setSystemDefaultModel] = useState('')

  const hasModelList = availableModels.length > 0

  useEffect(() => {
    if (!open) return
    setEnabled(Boolean(currentEnabled))
    setModel(currentModel || '')
    setAvailableModels([])
    setError('')
    setModelLoading(false)
    setChecking(false)
    setSaving(false)
    setSystemDefaultModel('')
  }, [open, currentEnabled, currentModel])

  useEffect(() => {
    if (!open) return
    getSystemConfig()
      .then(cfg => setSystemDefaultModel((cfg?.reranker_model || '').trim()))
      .catch(() => {})
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const canSave = useMemo(() => {
    if (saving || checking) return false
    if (!enabled) return true
    // enabled: allow blank model (system default) or any non-empty override
    return true
  }, [enabled, saving, checking])

  const handleFetchModels = async () => {
    setModelLoading(true)
    setError('')
    setAvailableModels([])
    try {
      const cfg = await getSystemConfig().catch(() => ({}))
      const url = (embedUrl || '').trim() || (cfg?.embedding_url || '').trim()
      if (!url) {
        setError('No OpenAI-compatible endpoint URL available to list models.')
        return
      }
      const raw = await fetchModels(url, null)
      const models = Array.isArray(raw) ? raw : []
      setAvailableModels(models)
      if (models.length > 0) {
        const preferred = cfg?.reranker_model
        setModel(preferred && models.includes(preferred) ? preferred : models[0])
      }
    } catch (e) {
      setError('Could not reach the endpoint. Check the embedding URL and try again.')
    } finally {
      setModelLoading(false)
    }
  }

  const handleSave = async () => {
    setError('')
    setChecking(false)
    setSaving(false)
    const patch = {
      rerank_enabled: Boolean(enabled),
      rerank_model: enabled && model.trim() ? model.trim() : null,
    }

    // Validate only when enabled + explicit override.
    if (patch.rerank_enabled && patch.rerank_model) {
      setChecking(true)
      try {
        await verifyRerank({ model: patch.rerank_model })
      } catch (e) {
        const d = e?.response?.data?.detail
        setError(typeof d === 'string' ? d : 'Could not verify rerank model. Check the model id and try again.')
        setChecking(false)
        return
      } finally {
        setChecking(false)
      }
    }

    setSaving(true)
    try {
      await updateProject(projectId, patch)
      await onSaved?.()
      onClose?.()
    } catch (e) {
      const d = e?.response?.data?.detail
      setError(typeof d === 'string' ? d : 'Failed to save rerank settings.')
    } finally {
      setSaving(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50">
      <div
        className="absolute inset-0 bg-black/30"
        onClick={() => (saving || checking) ? null : onClose?.()}
      />

      <div className="absolute inset-0 flex items-center justify-center p-4">
        <div className="w-full max-w-xl bg-white rounded-2xl border border-gray-200 shadow-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100 flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-lg font-bold text-gray-900">Reranking model</h2>
              <p className="text-sm text-gray-500 mt-1">
                Optional. Use the system default unless you know what you’re changing.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={saving || checking}
              className="shrink-0 p-2 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-50 disabled:opacity-40"
              title="Close"
            >
              ✕
            </button>
          </div>

          <div className="px-6 py-5 space-y-5">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => { setEnabled(e.target.checked); if (!e.target.checked) setError('') }}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm font-medium text-gray-800">Enable reranking for this project</span>
            </label>

            <div className="flex items-center justify-between gap-3">
              <div className="text-sm text-gray-600">
                Model id <span className="text-gray-400">(optional override)</span>
              </div>
              <button
                type="button"
                onClick={handleFetchModels}
                disabled={!enabled || modelLoading}
                className="text-sm px-3 py-1.5 rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-40"
              >
                {modelLoading ? 'Fetching…' : 'Fetch models'}
              </button>
            </div>

            {hasModelList ? (
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={!enabled}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
              >
                <option value="">{systemDefaultModel ? `system default (${systemDefaultModel})` : 'system default'}</option>
                {availableModels.map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={!enabled}
                placeholder={systemDefaultModel ? `Blank = ${systemDefaultModel}` : 'Blank = system default'}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
              />
            )}

            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm">
                {error}
              </div>
            )}
          </div>

          <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-between gap-3">
            <div className="text-xs text-gray-400">
              Saved values apply to future Topic searches immediately.
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={saving || checking}
                className="px-4 py-2 rounded-lg text-sm border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={!canSave}
                className="px-4 py-2 rounded-lg text-sm bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-40"
              >
                {checking ? 'Checking…' : saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}


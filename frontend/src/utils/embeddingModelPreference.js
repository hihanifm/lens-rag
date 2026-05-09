/** Fallback when `/system-config` omits preference list (aligned with backend `EMBED_MODEL_PREFERENCES`). */
export const DEFAULT_EMBEDDING_MODEL_PREFERENCE_ORDER = ['qwen3-embedding:0.6b', 'bge-m3:latest']

/** Placeholder / shortcut target — same default as backend `OLLAMA_BASE_URL` for Docker → host Ollama. */
export const DEFAULT_OLLAMA_EMBEDDING_URL_HINT = 'http://host.docker.internal:11434/v1'

/**
 * Pick dropdown value from Ollama model list — same precedence as API startup (`EMBED_MODEL_PREFERENCES`),
 * then the server-resolved embedding model when present and listed.
 */
export function pickPreferredEmbeddingModel(
  available,
  preferencesFromApi,
  serverResolvedModel,
) {
  const list = Array.isArray(available) ? [...new Set(available)].filter(Boolean) : []
  const prefs =
    Array.isArray(preferencesFromApi) && preferencesFromApi.length > 0
      ? preferencesFromApi
      : DEFAULT_EMBEDDING_MODEL_PREFERENCE_ORDER
  for (const p of prefs) {
    if (list.includes(p)) return p
  }
  if (serverResolvedModel && list.includes(serverResolvedModel)) return serverResolvedModel
  if (list.length > 0) return list[0]
  return prefs[0] || ''
}

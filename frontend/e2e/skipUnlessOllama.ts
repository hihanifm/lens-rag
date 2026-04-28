import type { APIRequestContext } from '@playwright/test'

export type PlaywrightTestApi = { skip: (condition: boolean, description?: string) => void }

/**
 * Ingestion e2e assumes the default on-prem stack (Ollama embeddings).
 * If the server is configured with EMBEDDING_PROVIDER=openai, embedding calls use
 * a different client and these flows are not suitable for automated e2e without secrets.
 */
export async function skipUnlessOllamaEmbedding(
  request: APIRequestContext,
  test: PlaywrightTestApi
) {
  const res = await request.get('/system-config')
  if (!res.ok()) {
    test.skip(true, `Cannot read /system-config (${res.status()}); skip ingest e2e`)
    return
  }
  const cfg = (await res.json()) as { embedding_provider?: string }
  test.skip(
    cfg.embedding_provider !== 'ollama',
    `E2E ingestion tests require EMBEDDING_PROVIDER=ollama; got ${cfg.embedding_provider ?? 'unknown'}`
  )
}

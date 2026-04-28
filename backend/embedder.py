import logging
import time

from openai import OpenAI
from config import (
    EMBEDDING_PROVIDER, EMBEDDING_MODEL,
    OLLAMA_BASE_URL, OPENAI_API_KEY,
    RERANKER_ENABLED, RERANKER_MODEL
)

logger = logging.getLogger("lens.embedder")

# Embedding client — Ollama or OpenAI depending on provider
if EMBEDDING_PROVIDER == "openai":
    _embed_client = OpenAI(api_key=OPENAI_API_KEY)
    logger.info("Embedder: provider=openai model=%s", EMBEDDING_MODEL)
else:
    _embed_client = OpenAI(base_url=OLLAMA_BASE_URL, api_key="ollama")
    logger.info("Embedder: provider=ollama base_url=%s model=%s", OLLAMA_BASE_URL, EMBEDDING_MODEL)

# Reranker always runs via Ollama
_rerank_client = OpenAI(base_url=OLLAMA_BASE_URL, api_key="ollama")
logger.info("Reranker: enabled=%s model=%s base_url=%s", RERANKER_ENABLED, RERANKER_MODEL, OLLAMA_BASE_URL)


def _probe_ollama():
    """Fire a tiny embed request at startup to verify Ollama is reachable and the model is loaded."""
    logger.info("Probing embed model — url=%s model=%s", OLLAMA_BASE_URL, EMBEDDING_MODEL)
    t0 = time.monotonic()
    try:
        resp = _embed_client.embeddings.create(model=EMBEDDING_MODEL, input="ping")
        elapsed = int((time.monotonic() - t0) * 1000)
        logger.info("Embed probe OK — dims=%d elapsed_ms=%d", len(resp.data[0].embedding), elapsed)
    except Exception as e:
        logger.error(
            "Embed probe FAILED — url=%s model=%s — %s: %s\n"
            "  Is Ollama running on the host? Try: curl %s/models",
            OLLAMA_BASE_URL, EMBEDDING_MODEL, type(e).__name__, e, OLLAMA_BASE_URL,
            exc_info=True,
        )

    if RERANKER_ENABLED:
        logger.info("Probing reranker model — url=%s model=%s", OLLAMA_BASE_URL, RERANKER_MODEL)
        t0 = time.monotonic()
        try:
            resp = _rerank_client.embeddings.create(model=RERANKER_MODEL, input="ping [SEP] pong")
            elapsed = int((time.monotonic() - t0) * 1000)
            logger.info("Reranker probe OK — score_dims=%d elapsed_ms=%d",
                        len(resp.data[0].embedding), elapsed)
        except Exception as e:
            logger.error(
                "Reranker probe FAILED — url=%s model=%s — %s: %s\n"
                "  Try: ollama pull %s",
                OLLAMA_BASE_URL, RERANKER_MODEL, type(e).__name__, e, RERANKER_MODEL,
                exc_info=True,
            )
    else:
        logger.info("Reranker disabled — skipping probe")


_probe_ollama()


def _get_embed_client(base_url: str | None, api_key: str | None):
    """Return per-call client when overrides given, else the module singleton."""
    if base_url:
        return OpenAI(base_url=base_url, api_key=api_key or "ollama")
    return _embed_client


def embed(
    text: str,
    *,
    base_url: str | None = None,
    api_key: str | None = None,
    model: str | None = None,
) -> list[float]:
    client = _get_embed_client(base_url, api_key)
    eff_model = model or EMBEDDING_MODEL
    eff_url = base_url or OLLAMA_BASE_URL
    logger.debug("embed() → %s model=%s text_len=%d preview=%r", eff_url, eff_model, len(text), text[:80])
    t0 = time.monotonic()
    try:
        response = client.embeddings.create(model=eff_model, input=text)
        elapsed = int((time.monotonic() - t0) * 1000)
        dims = len(response.data[0].embedding)
        logger.debug("embed() ← OK dims=%d elapsed_ms=%d", dims, elapsed)
        return response.data[0].embedding
    except Exception as e:
        elapsed = int((time.monotonic() - t0) * 1000)
        logger.exception("embed() ← FAILED url=%s model=%s elapsed_ms=%d — %s: %s",
                         eff_url, eff_model, elapsed, type(e).__name__, e)
        raise


def embed_batch(
    texts: list[str],
    *,
    base_url: str | None = None,
    api_key: str | None = None,
    model: str | None = None,
) -> list[list[float]]:
    client = _get_embed_client(base_url, api_key)
    eff_model = model or EMBEDDING_MODEL
    eff_url = base_url or OLLAMA_BASE_URL
    logger.debug("embed_batch() → %s model=%s count=%d", eff_url, eff_model, len(texts))
    t0 = time.monotonic()
    try:
        response = client.embeddings.create(model=eff_model, input=texts)
        elapsed = int((time.monotonic() - t0) * 1000)
        logger.debug("embed_batch() ← OK count=%d elapsed_ms=%d", len(texts), elapsed)
        return [item.embedding for item in response.data]
    except Exception as e:
        elapsed = int((time.monotonic() - t0) * 1000)
        logger.exception("embed_batch() ← FAILED url=%s model=%s count=%d elapsed_ms=%d — %s: %s",
                         eff_url, eff_model, len(texts), elapsed, type(e).__name__, e)
        raise


def list_models(base_url: str, api_key: str | None = None) -> list[str]:
    """Fetch available models from an OpenAI-compatible /v1/models endpoint."""
    client = OpenAI(base_url=base_url, api_key=api_key or "ollama")
    try:
        models = client.models.list()
        return [m.id for m in models.data]
    except Exception as e:
        logger.error("list_models() FAILED url=%s — %s: %s", base_url, type(e).__name__, e)
        raise


def rerank(query: str, candidates: list[str]) -> list[float]:
    """Score each candidate against the query. Returns scores in same order."""
    logger.debug("rerank() → %s model=%s candidates=%d", OLLAMA_BASE_URL, RERANKER_MODEL, len(candidates))
    t0 = time.monotonic()
    scores = []
    for i, candidate in enumerate(candidates):
        combined = f"{query} [SEP] {candidate}"
        try:
            response = _rerank_client.embeddings.create(model=RERANKER_MODEL, input=combined)
            scores.append(response.data[0].embedding[0])
        except Exception as e:
            elapsed = int((time.monotonic() - t0) * 1000)
            logger.exception(
                "rerank() ← FAILED on candidate %d/%d url=%s model=%s elapsed_ms=%d — %s: %s",
                i + 1, len(candidates), OLLAMA_BASE_URL, RERANKER_MODEL, elapsed, type(e).__name__, e,
            )
            raise
    elapsed = int((time.monotonic() - t0) * 1000)
    logger.debug("rerank() ← OK candidates=%d elapsed_ms=%d", len(candidates), elapsed)
    return scores

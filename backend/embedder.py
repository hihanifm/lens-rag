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
    logger.info("Probing Ollama at %s with model=%s ...", OLLAMA_BASE_URL, EMBEDDING_MODEL)
    t0 = time.monotonic()
    try:
        resp = _embed_client.embeddings.create(model=EMBEDDING_MODEL, input="ping")
        elapsed = int((time.monotonic() - t0) * 1000)
        logger.info("Ollama probe OK — dims=%d elapsed_ms=%d", len(resp.data[0].embedding), elapsed)
    except Exception as e:
        logger.error(
            "Ollama probe FAILED — url=%s model=%s — %s: %s\n"
            "  Is Ollama running on the host? Try: curl %s/models",
            OLLAMA_BASE_URL, EMBEDDING_MODEL, type(e).__name__, e, OLLAMA_BASE_URL,
            exc_info=True,
        )


_probe_ollama()


def embed(text: str) -> list[float]:
    logger.debug("embed() → %s model=%s text_len=%d preview=%r",
                 OLLAMA_BASE_URL, EMBEDDING_MODEL, len(text), text[:80])
    t0 = time.monotonic()
    try:
        response = _embed_client.embeddings.create(model=EMBEDDING_MODEL, input=text)
        elapsed = int((time.monotonic() - t0) * 1000)
        dims = len(response.data[0].embedding)
        logger.debug("embed() ← OK dims=%d elapsed_ms=%d", dims, elapsed)
        return response.data[0].embedding
    except Exception as e:
        elapsed = int((time.monotonic() - t0) * 1000)
        logger.exception("embed() ← FAILED url=%s model=%s elapsed_ms=%d — %s: %s",
                         OLLAMA_BASE_URL, EMBEDDING_MODEL, elapsed, type(e).__name__, e)
        raise


def embed_batch(texts: list[str]) -> list[list[float]]:
    logger.debug("embed_batch() → %s model=%s count=%d", OLLAMA_BASE_URL, EMBEDDING_MODEL, len(texts))
    t0 = time.monotonic()
    try:
        response = _embed_client.embeddings.create(model=EMBEDDING_MODEL, input=texts)
        elapsed = int((time.monotonic() - t0) * 1000)
        logger.debug("embed_batch() ← OK count=%d elapsed_ms=%d", len(texts), elapsed)
        return [item.embedding for item in response.data]
    except Exception as e:
        elapsed = int((time.monotonic() - t0) * 1000)
        logger.exception("embed_batch() ← FAILED url=%s model=%s count=%d elapsed_ms=%d — %s: %s",
                         OLLAMA_BASE_URL, EMBEDDING_MODEL, len(texts), elapsed, type(e).__name__, e)
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

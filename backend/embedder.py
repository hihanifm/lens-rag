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


def embed(text: str) -> list[float]:
    logger.debug("embed() text_len=%d", len(text))
    t0 = time.monotonic()
    try:
        response = _embed_client.embeddings.create(model=EMBEDDING_MODEL, input=text)
        elapsed = int((time.monotonic() - t0) * 1000)
        logger.debug("embed() done dims=%d elapsed_ms=%d", len(response.data[0].embedding), elapsed)
        return response.data[0].embedding
    except Exception as e:
        logger.error("embed() FAILED after %dms — %s: %s",
                     int((time.monotonic() - t0) * 1000), type(e).__name__, e)
        raise


def embed_batch(texts: list[str]) -> list[list[float]]:
    logger.debug("embed_batch() count=%d", len(texts))
    t0 = time.monotonic()
    try:
        response = _embed_client.embeddings.create(model=EMBEDDING_MODEL, input=texts)
        elapsed = int((time.monotonic() - t0) * 1000)
        logger.debug("embed_batch() done count=%d elapsed_ms=%d", len(texts), elapsed)
        return [item.embedding for item in response.data]
    except Exception as e:
        logger.error("embed_batch() FAILED after %dms — %s: %s",
                     int((time.monotonic() - t0) * 1000), type(e).__name__, e)
        raise


def rerank(query: str, candidates: list[str]) -> list[float]:
    """Score each candidate against the query. Returns scores in same order."""
    logger.debug("rerank() candidates=%d", len(candidates))
    t0 = time.monotonic()
    scores = []
    for i, candidate in enumerate(candidates):
        combined = f"{query} [SEP] {candidate}"
        try:
            response = _rerank_client.embeddings.create(model=RERANKER_MODEL, input=combined)
            scores.append(response.data[0].embedding[0])
        except Exception as e:
            logger.error("rerank() FAILED on candidate %d/%d — %s: %s",
                         i + 1, len(candidates), type(e).__name__, e)
            raise
    elapsed = int((time.monotonic() - t0) * 1000)
    logger.debug("rerank() done candidates=%d elapsed_ms=%d", len(candidates), elapsed)
    return scores

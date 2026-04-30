import logging
import threading
import time

import httpx
from openai import OpenAI

from config import (
    EMBEDDING_PROVIDER,
    EMBEDDING_MODEL,
    OLLAMA_BASE_URL,
    OLLAMA_NATIVE_ORIGIN,
    OPENAI_API_KEY,
    RERANKER_ENABLED,
    RERANKER_MODEL,
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

# Runtime auto-detect: "native" (POST /api/rerank) vs "embedding" (/v1/embeddings hack).
# Cached per resolved model id (system default + per-project overrides).
_rerank_strategy_lock = threading.Lock()
_rerank_strategy_by_model: dict[str, str] = {}  # model_id -> "native" | "embedding"

logger.info(
    "Reranker: enabled=%s default_model=%s — strategy auto-detected per model on first rerank (cached in memory)",
    RERANKER_ENABLED,
    RERANKER_MODEL,
)


def peek_rerank_strategy(model: str | None = None) -> str | None:
    """Return cached rerank strategy if already detected; does not probe Ollama."""
    if not RERANKER_ENABLED:
        return None
    eff = ((model or "").strip() or RERANKER_MODEL)
    return _rerank_strategy_by_model.get(eff)


def _ensure_rerank_strategy(model: str) -> str:
    """Pick native vs embedding API for the given model once per process (thread-safe)."""
    if not RERANKER_ENABLED:
        raise RuntimeError("reranker disabled")
    with _rerank_strategy_lock:
        if model in _rerank_strategy_by_model:
            return _rerank_strategy_by_model[model]

        # 1) Prefer Ollama native /api/rerank (Qwen3-Reranker, etc.)
        try:
            r = httpx.post(
                f"{OLLAMA_NATIVE_ORIGIN}/api/rerank",
                json={"model": model, "query": "__lens_probe__", "documents": ["__doc__"]},
                timeout=45.0,
            )
            if r.status_code == 200:
                data = r.json()
                if isinstance(data, dict) and data.get("error"):
                    raise RuntimeError(str(data.get("error")))
                if isinstance(data, dict) and "results" in data:
                    _rerank_strategy_by_model[model] = "native"
                    logger.info(
                        "Rerank strategy (auto): native POST %s/api/rerank for model=%s",
                        OLLAMA_NATIVE_ORIGIN,
                        model,
                    )
                    return _rerank_strategy_by_model[model]
        except Exception as e:
            logger.debug(
                "Rerank native probe failed — %s: %s (will try /v1/embeddings)",
                type(e).__name__,
                e,
            )

        # 2) Fallback: OpenAI-compatible embeddings (bge-reranker-base pattern)
        try:
            _rerank_client.embeddings.create(
                model=model,
                input="__lens_probe__ [SEP] __doc__",
            )
            _rerank_strategy_by_model[model] = "embedding"
            logger.info(
                "Rerank strategy (auto): /v1/embeddings for model=%s",
                model,
            )
            return _rerank_strategy_by_model[model]
        except Exception as e:
            logger.error(
                "Rerank auto-detect FAILED for model=%r — neither /api/rerank nor embeddings: %s",
                model,
                e,
            )
            raise RuntimeError(
                f"Rerank model={model!r} is not usable with Ollama "
                "(tried POST /api/rerank and /v1/embeddings). "
                "Use a compatible reranker or set RERANKER_ENABLED=false."
            ) from e


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
        logger.info(
            "Reranker: strategy will be chosen at runtime for model=%s (native /api/rerank first, else embeddings)",
            RERANKER_MODEL,
        )
    else:
        logger.info("Reranker disabled — skipping")


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


def _rerank_ollama_native(query: str, candidates: list[str], model: str) -> list[float]:
    """POST /api/rerank — one request for all candidates."""
    url = f"{OLLAMA_NATIVE_ORIGIN}/api/rerank"
    payload = {"model": model, "query": query, "documents": candidates}
    t0 = time.monotonic()
    r = httpx.post(url, json=payload, timeout=120.0)
    r.raise_for_status()
    data = r.json()
    results = data.get("results") or []
    by_idx: dict[int, float] = {}
    for item in results:
        idx = item.get("index")
        if idx is None:
            continue
        by_idx[int(idx)] = float(item.get("relevance_score", 0.0))
    scores = [by_idx.get(i, 0.0) for i in range(len(candidates))]
    elapsed = int((time.monotonic() - t0) * 1000)
    logger.debug(
        "rerank(native) ← OK url=%s model=%s candidates=%d elapsed_ms=%d",
        url,
        model,
        len(candidates),
        elapsed,
    )
    return scores


def rerank(query: str, candidates: list[str], *, model: str | None = None) -> list[float]:
    """Score each candidate against the query. Returns scores in same order."""
    if not candidates:
        return []

    eff_model = (model or "").strip() or RERANKER_MODEL
    strategy = _ensure_rerank_strategy(eff_model)

    if strategy == "native":
        logger.debug(
            "rerank() native → %s/api/rerank model=%s candidates=%d",
            OLLAMA_NATIVE_ORIGIN,
            eff_model,
            len(candidates),
        )
        t0 = time.monotonic()
        try:
            scores = _rerank_ollama_native(query, candidates, eff_model)
            elapsed = int((time.monotonic() - t0) * 1000)
            logger.debug("rerank(native) total elapsed_ms=%d", elapsed)
            return scores
        except Exception as e:
            elapsed = int((time.monotonic() - t0) * 1000)
            logger.exception(
                "rerank(native) ← FAILED model=%s candidates=%d elapsed_ms=%d — %s: %s",
                eff_model,
                len(candidates),
                elapsed,
                type(e).__name__,
                e,
            )
            raise

    logger.debug("rerank() embedding-path → %s model=%s candidates=%d", OLLAMA_BASE_URL, eff_model, len(candidates))
    t0 = time.monotonic()
    scores = []
    for i, candidate in enumerate(candidates):
        combined = f"{query} [SEP] {candidate}"
        try:
            response = _rerank_client.embeddings.create(model=eff_model, input=combined)
            scores.append(response.data[0].embedding[0])
        except Exception as e:
            elapsed = int((time.monotonic() - t0) * 1000)
            logger.exception(
                "rerank() ← FAILED on candidate %d/%d url=%s model=%s elapsed_ms=%d — %s: %s",
                i + 1, len(candidates), OLLAMA_BASE_URL, eff_model, elapsed, type(e).__name__, e,
            )
            raise
    elapsed = int((time.monotonic() - t0) * 1000)
    logger.debug("rerank() ← OK candidates=%d elapsed_ms=%d", len(candidates), elapsed)
    return scores


def verify_rerank_model(model: str | None = None) -> str:
    """Validate that a rerank model works with the server's Ollama. Returns strategy."""
    if not RERANKER_ENABLED:
        raise RuntimeError("reranker disabled")
    eff_model = (model or "").strip() or RERANKER_MODEL
    strategy = _ensure_rerank_strategy(eff_model)
    # Fire a tiny real request on the chosen path to surface runtime errors.
    if strategy == "native":
        _rerank_ollama_native("__lens_probe__", ["__doc__"], eff_model)
    else:
        _rerank_client.embeddings.create(model=eff_model, input="__lens_probe__ [SEP] __doc__")
    return strategy

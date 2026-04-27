from openai import OpenAI
from config import (
    EMBEDDING_PROVIDER, EMBEDDING_MODEL,
    OLLAMA_BASE_URL, OPENAI_API_KEY,
    RERANKER_ENABLED, RERANKER_MODEL
)

# Embedding client — Ollama or OpenAI depending on provider
if EMBEDDING_PROVIDER == "openai":
    _embed_client = OpenAI(api_key=OPENAI_API_KEY)
else:
    _embed_client = OpenAI(base_url=OLLAMA_BASE_URL, api_key="ollama")

# Reranker always runs via Ollama
_rerank_client = OpenAI(base_url=OLLAMA_BASE_URL, api_key="ollama")


def embed(text: str) -> list[float]:
    response = _embed_client.embeddings.create(model=EMBEDDING_MODEL, input=text)
    return response.data[0].embedding


def embed_batch(texts: list[str]) -> list[list[float]]:
    response = _embed_client.embeddings.create(model=EMBEDDING_MODEL, input=texts)
    return [item.embedding for item in response.data]


def rerank(query: str, candidates: list[str]) -> list[float]:
    """Score each candidate against the query. Returns scores in same order."""
    scores = []
    for candidate in candidates:
        combined = f"{query} [SEP] {candidate}"
        response = _rerank_client.embeddings.create(model=RERANKER_MODEL, input=combined)
        scores.append(response.data[0].embedding[0])
    return scores

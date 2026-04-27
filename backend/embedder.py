from openai import OpenAI
from config import EMBEDDING_BASE_URL, EMBEDDING_MODEL, RERANKER_MODEL

# Single client pointed at Ollama — NOT OpenAI servers
_client = OpenAI(
    base_url=EMBEDDING_BASE_URL,
    api_key="ollama"  # required by client, ignored by Ollama
)


def embed(text: str) -> list[float]:
    """Embed a single text using bge-m3 via Ollama."""
    response = _client.embeddings.create(
        model=EMBEDDING_MODEL,
        input=text
    )
    return response.data[0].embedding


def embed_batch(texts: list[str]) -> list[list[float]]:
    """Embed multiple texts in one call."""
    response = _client.embeddings.create(
        model=EMBEDDING_MODEL,
        input=texts
    )
    return [item.embedding for item in response.data]


def rerank(query: str, candidates: list[str]) -> list[float]:
    """
    Score each candidate against the query using bge-reranker-base.
    Returns list of relevance scores, same order as candidates.
    """
    scores = []
    for candidate in candidates:
        combined = f"{query} [SEP] {candidate}"
        response = _client.embeddings.create(
            model=RERANKER_MODEL,
            input=combined
        )
        # Reranker returns a relevance score as first embedding value
        scores.append(response.data[0].embedding[0])
    return scores

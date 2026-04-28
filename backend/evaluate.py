import json
import time
from db import get_cursor
from embedder import embed, rerank
from config import TOP_K_RETRIEVAL, TOP_K_MAX, RERANKER_ENABLED
from search import rrf_merge


def _search_with_steps(question: str, schema_name: str, k: int):
    """
    Run the full topic search pipeline for evaluation, yielding step events
    and finally returning the retrieved contextual_content strings.
    Yields: dict step events (same shape as topic_search_stream)
    Returns: (via StopIteration value) list[str] contexts
    """
    # Step 1: Embed
    yield {"step": "embedding", "message": "Embedding query..."}
    query_vector = embed(question)

    # Step 2: Vector search
    yield {"step": "vector", "message": "Vector search..."}
    with get_cursor() as (cur, conn):
        cur.execute(f"""
            SELECT id, contextual_content,
                   1 - (embedding <=> %s::vector) AS score
            FROM {schema_name}.records
            ORDER BY embedding <=> %s::vector
            LIMIT %s
        """, [query_vector, query_vector, TOP_K_RETRIEVAL])
        vector_rows = cur.fetchall()

    vector_ids = [row['id'] for row in vector_rows]
    rows_by_id = {row['id']: row for row in vector_rows}

    # Step 3: BM25
    yield {"step": "bm25", "message": "Keyword search..."}
    with get_cursor() as (cur, conn):
        cur.execute(f"""
            SELECT id, contextual_content,
                   ts_rank(search_vector, plainto_tsquery('english', %s)) AS score
            FROM {schema_name}.records
            WHERE search_vector @@ plainto_tsquery('english', %s)
            ORDER BY score DESC
            LIMIT %s
        """, [question, question, TOP_K_RETRIEVAL])
        bm25_rows = cur.fetchall()

    for row in bm25_rows:
        if row['id'] not in rows_by_id:
            rows_by_id[row['id']] = row

    # Step 4: RRF
    yield {"step": "rrf", "message": "Merging results..."}
    merged_ids = rrf_merge(vector_ids, [row['id'] for row in bm25_rows])
    candidates = merged_ids[:min(len(merged_ids), TOP_K_RETRIEVAL)]

    # Step 5: Rerank
    if RERANKER_ENABLED:
        yield {"step": "reranking", "message": f"Reranking {len(candidates)} candidates..."}
        candidate_texts = [rows_by_id[cid]['contextual_content'] for cid in candidates if cid in rows_by_id]
        rerank_scores = rerank(question, candidate_texts)
        ranked = sorted(zip(candidates, rerank_scores), key=lambda x: x[1], reverse=True)
    else:
        ranked = [(cid, None) for cid in candidates]

    # Collect contexts
    contexts = []
    for doc_id, _ in ranked[:k]:
        row = rows_by_id.get(doc_id)
        if row:
            contexts.append(row['contextual_content'])

    return contexts


def stream_ragas_export(test_cases: list[dict], schema_name: str, k: int):
    """
    Generator — yields SSE-formatted strings.
    For each question: emits a 'question_start' event, then one 'step' event
    per pipeline stage (embedding/vector/bm25/rrf/reranking), then a 'progress'
    event when done. Final event is 'complete' with the full results list.
    """
    total = len(test_cases)
    effective_k = min(k, TOP_K_MAX)
    results = []

    for i, case in enumerate(test_cases):
        question = case['question']

        yield f"data: {json.dumps({'type': 'question_start', 'index': i + 1, 'total': total, 'question': question})}\n\n"

        # Drive the pipeline generator, emitting step events as they come
        gen = _search_with_steps(question, schema_name, effective_k)
        contexts = []
        try:
            while True:
                event = next(gen)
                yield f"data: {json.dumps({'type': 'step', 'index': i + 1, 'total': total, 'step': event['step'], 'message': event['message']})}\n\n"
        except StopIteration as e:
            contexts = e.value or []

        result = {
            "question": question,
            "contexts": contexts,
            "ground_truth": case['ground_truth'],
        }
        results.append(result)
        yield f"data: {json.dumps({'type': 'progress', 'index': i + 1, 'total': total, 'question': question, 'contexts_count': len(contexts)})}\n\n"

    yield f"data: {json.dumps({'type': 'complete', 'results': results})}\n\n"

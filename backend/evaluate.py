import json
from db import get_cursor
from embedder import embed, rerank as do_rerank
from config import TOP_K_RETRIEVAL, TOP_K_MAX, RERANKER_ENABLED
from search import merge_candidates


def _pipeline_for_eval(
    question: str,
    schema_name: str,
    k: int,
    use_vector: bool,
    use_bm25: bool,
    use_rrf: bool,
    use_rerank: bool,
):
    """
    Single-pass pipeline generator for evaluation.
    Yields step dicts (same shape as topic_search_stream steps).
    Returns (via StopIteration.value) list[str] of contextual_content strings.

    Shares merge_candidates from search.py — one canonical implementation.
    """
    eff_rerank = use_rerank and RERANKER_ENABLED

    vector_ids: list = []
    rows_by_id: dict = {}

    if use_vector:
        yield {"step": "embedding", "message": "Embedding query..."}
        query_vector = embed(question)

        yield {"step": "vector", "message": "Vector search..."}
        with get_cursor() as (cur, conn):
            cur.execute(f"""
                SELECT id, contextual_content,
                       1 - (embedding <=> %s::vector) AS score
                FROM {schema_name}.records
                ORDER BY embedding <=> %s::vector
                LIMIT %s
            """, [query_vector, query_vector, TOP_K_RETRIEVAL])
            for row in cur.fetchall():
                vector_ids.append(row['id'])
                rows_by_id[row['id']] = row

    bm25_ids: list = []
    if use_bm25:
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
            for row in cur.fetchall():
                bm25_ids.append(row['id'])
                if row['id'] not in rows_by_id:
                    rows_by_id[row['id']] = row

    yield {"step": "rrf", "message": "Merging results..."}
    merged = merge_candidates(vector_ids, bm25_ids, use_rrf)
    candidates = merged[:min(len(merged), TOP_K_RETRIEVAL)]

    if eff_rerank and candidates:
        yield {"step": "reranking", "message": f"Reranking {len(candidates)} candidates..."}
        texts = [rows_by_id[cid]['contextual_content'] for cid in candidates if cid in rows_by_id]
        scores = do_rerank(question, texts)
        ranked = sorted(zip(candidates, scores), key=lambda x: x[1], reverse=True)
    else:
        ranked = [(cid, None) for cid in candidates]

    contexts = []
    for doc_id, _ in ranked[:k]:
        row = rows_by_id.get(doc_id)
        if row:
            contexts.append(row['contextual_content'])
    return contexts


def stream_ragas_export(
    test_cases: list[dict],
    schema_name: str,
    k: int,
    use_vector: bool = True,
    use_bm25: bool = True,
    use_rrf: bool = True,
    use_rerank: bool = True,
):
    """
    Generator — yields SSE-formatted strings.
    For each question: emits a 'question_start' event, then one 'step' event
    per pipeline stage (embedding/vector/bm25/rrf/reranking), then a 'progress'
    event when done. Final event is 'complete' with the full results list.

    Pipeline flags mirror topic search — same four toggles.
    """
    total = len(test_cases)
    effective_k = min(k, TOP_K_MAX)
    results = []

    for i, case in enumerate(test_cases):
        question = case['question']

        yield f"data: {json.dumps({'type': 'question_start', 'index': i + 1, 'total': total, 'question': question})}\n\n"

        gen = _pipeline_for_eval(
            question, schema_name, effective_k,
            use_vector, use_bm25, use_rrf, use_rerank,
        )
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

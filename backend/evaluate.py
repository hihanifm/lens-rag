import json
from db import get_cursor
from embedder import embed, rerank
from config import TOP_K_RETRIEVAL, TOP_K_MAX, RERANKER_ENABLED
from ingestion import safe_col_name
from search import rrf_merge


def search_for_eval(query: str, schema_name: str, k: int) -> list[str]:
    """
    Run topic search and return contextual_content strings for the top k results.
    Used for RAGAS export — returns the full embedded text, not just display columns.
    """
    k = min(k, TOP_K_MAX)
    query_vector = embed(query)

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

    with get_cursor() as (cur, conn):
        cur.execute(f"""
            SELECT id, contextual_content,
                   ts_rank(search_vector, plainto_tsquery('english', %s)) AS score
            FROM {schema_name}.records
            WHERE search_vector @@ plainto_tsquery('english', %s)
            ORDER BY score DESC
            LIMIT %s
        """, [query, query, TOP_K_RETRIEVAL])
        bm25_rows = cur.fetchall()

    bm25_ids = [row['id'] for row in bm25_rows]
    for row in bm25_rows:
        if row['id'] not in rows_by_id:
            rows_by_id[row['id']] = row

    merged_ids = rrf_merge(vector_ids, bm25_ids)
    candidates = merged_ids[:min(len(merged_ids), TOP_K_RETRIEVAL)]

    if RERANKER_ENABLED:
        candidate_texts = [rows_by_id[cid]['contextual_content'] for cid in candidates if cid in rows_by_id]
        rerank_scores = rerank(query, candidate_texts)
        ranked = sorted(zip(candidates, rerank_scores), key=lambda x: x[1], reverse=True)
    else:
        ranked = [(cid, None) for cid in candidates]

    contexts = []
    for doc_id, _ in ranked[:k]:
        row = rows_by_id.get(doc_id)
        if row:
            contexts.append(row['contextual_content'])

    return contexts


def build_ragas_export(test_cases: list[dict], schema_name: str, k: int) -> list[dict]:
    """
    For each test case, run search and collect retrieved contexts.
    Returns a list of RAGAS-format dicts: {question, contexts, ground_truth}.
    """
    output = []
    for case in test_cases:
        contexts = search_for_eval(case['question'], schema_name, k)
        output.append({
            "question": case['question'],
            "contexts": contexts,
            "ground_truth": case['ground_truth'],
        })
    return output

import logging
import time
from db import get_cursor
from embedder import embed, rerank
from config import TOP_K_RETRIEVAL, TOP_K_DEFAULT, TOP_K_MAX, RERANKER_ENABLED
from models import SearchResponse, SearchResult, SearchStats
from ingestion import safe_col_name

logger = logging.getLogger("lens.search")


def rrf_merge(vector_ids: list, bm25_ids: list, k: int = 60) -> list:
    """
    Reciprocal Rank Fusion — merge two ranked lists.
    Higher score = more relevant.
    """
    scores = {}
    for rank, doc_id in enumerate(vector_ids):
        scores[doc_id] = scores.get(doc_id, 0) + 1 / (k + rank + 1)
    for rank, doc_id in enumerate(bm25_ids):
        scores[doc_id] = scores.get(doc_id, 0) + 1 / (k + rank + 1)
    return sorted(scores.keys(), key=lambda x: scores[x], reverse=True)


def id_search(
    query: str,
    schema_name: str,
    id_column: str,
    display_columns: list[str],
    k: int
) -> SearchResponse:
    """
    Exact/partial ID search using ILIKE.
    Fast SQL lookup — no embedding, no BM25.
    """
    logger.info("id_search schema=%s id_column=%r query=%r k=%d", schema_name, id_column, query, k)
    stats = {}
    total_start = time.perf_counter()

    safe_id = f'col_{safe_col_name(id_column)}'
    safe_display = [f'col_{safe_col_name(c)}' for c in display_columns]
    select_cols = ', '.join([f'"{c}"' for c in safe_display])

    t = time.perf_counter()
    with get_cursor() as (cur, conn):
        cur.execute(f"""
            SELECT {select_cols}
            FROM {schema_name}.records
            WHERE "{safe_id}" ILIKE %s
            LIMIT %s
        """, [f'%{query}%', k])
        rows = cur.fetchall()
    stats['sql_lookup_ms'] = round((time.perf_counter() - t) * 1000, 1)
    stats['total_ms'] = round((time.perf_counter() - total_start) * 1000, 1)
    logger.info("id_search done results=%d sql_ms=%.1f total_ms=%.1f",
                len(rows), stats['sql_lookup_ms'], stats['total_ms'])

    results = []
    for row in rows:
        display_data = {}
        for i, col in enumerate(display_columns):
            safe = f'col_{safe_col_name(col)}'
            display_data[col] = row.get(safe)
        results.append(SearchResult(display_data=display_data))

    return SearchResponse(
        results=results,
        stats=SearchStats(
            mode="id",
            sql_lookup_ms=stats['sql_lookup_ms'],
            total_ms=stats['total_ms'],
            results_returned=len(results)
        )
    )


def topic_search_stream(
    query: str,
    schema_name: str,
    display_columns: list[str],
    k: int
):
    """
    Generator that yields step dicts for SSE streaming, ending with a
    'complete' event that contains results + stats.
    Also used by topic_search() to avoid code duplication.
    """
    logger.info("topic_search schema=%s query=%r k=%d reranker=%s", schema_name, query, k, RERANKER_ENABLED)
    stats = {}
    total_start = time.perf_counter()
    safe_display = [f'col_{safe_col_name(c)}' for c in display_columns]
    select_cols = ', '.join([f'"{c}"' for c in safe_display])

    # Step 1: Embed query
    yield {"step": "embedding", "message": "Embedding query..."}
    t = time.perf_counter()
    query_vector = embed(query)
    stats['embedding_ms'] = round((time.perf_counter() - t) * 1000, 1)
    logger.debug("  embed done embedding_ms=%.1f", stats['embedding_ms'])

    # Step 2: Vector search
    yield {"step": "vector", "message": "Vector search..."}
    t = time.perf_counter()
    with get_cursor() as (cur, conn):
        cur.execute(f"""
            SELECT id, contextual_content, {select_cols},
                   1 - (embedding <=> %s::vector) AS score
            FROM {schema_name}.records
            ORDER BY embedding <=> %s::vector
            LIMIT %s
        """, [query_vector, query_vector, TOP_K_RETRIEVAL])
        vector_rows = cur.fetchall()
    stats['vector_search_ms'] = round((time.perf_counter() - t) * 1000, 1)
    logger.debug("  vector search hits=%d vector_ms=%.1f", len(vector_rows), stats['vector_search_ms'])

    vector_ids = [row['id'] for row in vector_rows]
    rows_by_id = {row['id']: row for row in vector_rows}

    # Step 3: BM25 search
    yield {"step": "bm25", "message": "Keyword search..."}
    t = time.perf_counter()
    with get_cursor() as (cur, conn):
        cur.execute(f"""
            SELECT id, contextual_content, {select_cols},
                   ts_rank(search_vector, plainto_tsquery('english', %s)) AS score
            FROM {schema_name}.records
            WHERE search_vector @@ plainto_tsquery('english', %s)
            ORDER BY score DESC
            LIMIT %s
        """, [query, query, TOP_K_RETRIEVAL])
        bm25_rows = cur.fetchall()
    stats['bm25_search_ms'] = round((time.perf_counter() - t) * 1000, 1)
    logger.debug("  bm25 search hits=%d bm25_ms=%.1f", len(bm25_rows), stats['bm25_search_ms'])

    bm25_ids = [row['id'] for row in bm25_rows]
    for row in bm25_rows:
        if row['id'] not in rows_by_id:
            rows_by_id[row['id']] = row

    # Step 4: RRF merge
    yield {"step": "rrf", "message": "Merging results..."}
    t = time.perf_counter()
    merged_ids = rrf_merge(vector_ids, bm25_ids)
    stats['rrf_merge_ms'] = round((time.perf_counter() - t) * 1000, 1)
    stats['candidates_retrieved'] = len(merged_ids)
    logger.debug("  rrf merge candidates=%d rrf_ms=%.1f", len(merged_ids), stats['rrf_merge_ms'])

    # Step 5: Rerank
    candidates_to_rerank = merged_ids[:min(len(merged_ids), TOP_K_RETRIEVAL)]
    t = time.perf_counter()
    if RERANKER_ENABLED:
        yield {"step": "reranking", "message": f"Reranking {len(candidates_to_rerank)} candidates..."}
        candidate_texts = [
            rows_by_id[cid]['contextual_content']
            for cid in candidates_to_rerank
            if cid in rows_by_id
        ]
        rerank_scores = rerank(query, candidate_texts)
        ranked = sorted(
            zip(candidates_to_rerank, rerank_scores),
            key=lambda x: x[1],
            reverse=True
        )
        stats['reranker_ms'] = round((time.perf_counter() - t) * 1000, 1)
        logger.debug("  rerank done reranker_ms=%.1f", stats['reranker_ms'])
    else:
        ranked = [(doc_id, None) for doc_id in candidates_to_rerank]
        stats['reranker_ms'] = None
        logger.debug("  reranker skipped")

    # Step 6: Build results
    results = []
    for doc_id, score in ranked[:k]:
        row = rows_by_id.get(doc_id)
        if not row:
            continue
        display_data = {}
        for col in display_columns:
            safe = f'col_{safe_col_name(col)}'
            display_data[col] = row.get(safe)
        results.append(SearchResult(
            display_data=display_data,
            score=round(float(score), 4) if score is not None else None
        ))

    stats['total_ms'] = round((time.perf_counter() - total_start) * 1000, 1)
    logger.info("topic_search done results=%d embed_ms=%.1f vector_ms=%.1f bm25_ms=%.1f reranker_ms=%s total_ms=%.1f",
                len(results), stats['embedding_ms'], stats['vector_search_ms'],
                stats['bm25_search_ms'],
                f"{stats['reranker_ms']:.1f}" if stats['reranker_ms'] is not None else "off",
                stats['total_ms'])

    yield {
        "step": "complete",
        "response": SearchResponse(
            results=results,
            stats=SearchStats(
                mode="topic",
                embedding_ms=stats['embedding_ms'],
                vector_search_ms=stats['vector_search_ms'],
                bm25_search_ms=stats['bm25_search_ms'],
                rrf_merge_ms=stats['rrf_merge_ms'],
                reranker_ms=stats['reranker_ms'],
                total_ms=stats['total_ms'],
                candidates_retrieved=stats['candidates_retrieved'],
                results_returned=len(results)
            )
        )
    }


def topic_search(
    query: str,
    schema_name: str,
    display_columns: list[str],
    k: int
) -> SearchResponse:
    """Synchronous wrapper — collects the final event from the stream generator."""
    for event in topic_search_stream(query, schema_name, display_columns, k):
        if event['step'] == 'complete':
            return event['response']


def search(
    query: str,
    mode: str,
    schema_name: str,
    id_column: str | None,
    display_columns: list[str],
    k: int = TOP_K_DEFAULT
) -> SearchResponse:
    """Main search dispatcher."""
    # Enforce max K
    k = min(k, TOP_K_MAX)

    if mode == "id" and id_column:
        return id_search(query, schema_name, id_column, display_columns, k)
    else:
        return topic_search(query, schema_name, display_columns, k)

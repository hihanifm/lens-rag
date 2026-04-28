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


def merge_candidates(vector_ids: list, bm25_ids: list, use_rrf: bool) -> list:
    """
    Merge two ranked candidate lists according to the configured strategy.

    use_rrf=True  → RRF (handles empty lists gracefully — degenerates to
                    whichever side is non-empty).
    use_rrf=False → vector-primary when both lists non-empty: V order first,
                    then B-only ids appended in B order.
                    Falls back to whichever single list is non-empty.
    """
    if use_rrf:
        return rrf_merge(vector_ids, bm25_ids)

    # Non-RRF: primary list first, then append ids that only appear in the other
    if vector_ids and bm25_ids:
        v_set = set(vector_ids)
        extra = [doc_id for doc_id in bm25_ids if doc_id not in v_set]
        return list(vector_ids) + extra
    # Only one side populated
    return list(vector_ids) if vector_ids else list(bm25_ids)


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
    k: int,
    use_vector: bool = True,
    use_bm25: bool = True,
    use_rrf: bool = True,
    use_rerank: bool = True,
):
    """
    Generator that yields step dicts for SSE streaming, ending with a
    'complete' event that contains results + stats.
    Also used by topic_search() to avoid code duplication.

    Pipeline flags (all default True → same behaviour as before):
      use_vector  — embed query + pgvector retrieval
      use_bm25    — tsvector keyword retrieval
      use_rrf     — RRF merge (vs vector-primary concat when False)
      use_rerank  — cross-encoder reranking (also gated by RERANKER_ENABLED env)

    At least one of use_vector or use_bm25 must be True.
    """
    # Resolve effective flags (use_rerank is further gated by env)
    eff_rerank = use_rerank and RERANKER_ENABLED

    logger.info(
        "topic_search schema=%s query=%r k=%d vector=%s bm25=%s rrf=%s rerank=%s(env=%s)",
        schema_name, query, k, use_vector, use_bm25, use_rrf, use_rerank, RERANKER_ENABLED,
    )

    stats = {}
    total_start = time.perf_counter()
    safe_display = [f'col_{safe_col_name(c)}' for c in display_columns]
    select_cols = ', '.join([f'"{c}"' for c in safe_display])

    vector_ids = []
    rows_by_id = {}

    # ── Step 1: Embed + vector retrieval ─────────────────────────────────────
    if use_vector:
        yield {"step": "embedding", "message": "Embedding query..."}
        t = time.perf_counter()
        query_vector = embed(query)
        stats['embedding_ms'] = round((time.perf_counter() - t) * 1000, 1)
        logger.debug("  embed done embedding_ms=%.1f", stats['embedding_ms'])

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
    else:
        stats['embedding_ms'] = None
        stats['vector_search_ms'] = None
        logger.debug("  vector search skipped (use_vector=False)")

    # ── Step 2: BM25 retrieval ────────────────────────────────────────────────
    if use_bm25:
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
    else:
        bm25_ids = []
        stats['bm25_search_ms'] = None
        logger.debug("  bm25 search skipped (use_bm25=False)")

    # ── Step 3: Merge ─────────────────────────────────────────────────────────
    yield {"step": "rrf", "message": "Merging results..."}
    t = time.perf_counter()
    merged_ids = merge_candidates(vector_ids, bm25_ids, use_rrf)
    merge_ms = round((time.perf_counter() - t) * 1000, 1)
    # Only record RRF timing when RRF actually ran; trivial concat gets None
    stats['rrf_merge_ms'] = merge_ms if (use_rrf and vector_ids and bm25_ids) else None
    stats['candidates_retrieved'] = len(merged_ids)
    logger.debug("  merge done candidates=%d rrf=%s ms=%.1f", len(merged_ids), use_rrf, merge_ms)

    # ── Step 4: Rerank ────────────────────────────────────────────────────────
    candidates_to_rerank = merged_ids[:min(len(merged_ids), TOP_K_RETRIEVAL)]
    t = time.perf_counter()
    if eff_rerank:
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
        logger.debug("  reranker skipped (use_rerank=%s env=%s)", use_rerank, RERANKER_ENABLED)

    # ── Step 5: Build results ─────────────────────────────────────────────────
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
    logger.info(
        "topic_search done results=%d embed_ms=%s vector_ms=%s bm25_ms=%s reranker_ms=%s total_ms=%.1f",
        len(results),
        f"{stats['embedding_ms']:.1f}" if stats['embedding_ms'] is not None else "off",
        f"{stats['vector_search_ms']:.1f}" if stats['vector_search_ms'] is not None else "off",
        f"{stats['bm25_search_ms']:.1f}" if stats['bm25_search_ms'] is not None else "off",
        f"{stats['reranker_ms']:.1f}" if stats['reranker_ms'] is not None else "off",
        stats['total_ms'],
    )

    yield {
        "step": "complete",
        "response": SearchResponse(
            results=results,
            stats=SearchStats(
                mode="topic",
                use_vector=use_vector,
                use_bm25=use_bm25,
                use_rrf=use_rrf,
                use_rerank=eff_rerank,
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
    k: int,
    use_vector: bool = True,
    use_bm25: bool = True,
    use_rrf: bool = True,
    use_rerank: bool = True,
) -> SearchResponse:
    """Synchronous wrapper — collects the final event from the stream generator."""
    for event in topic_search_stream(
        query, schema_name, display_columns, k,
        use_vector=use_vector, use_bm25=use_bm25,
        use_rrf=use_rrf, use_rerank=use_rerank,
    ):
        if event['step'] == 'complete':
            return event['response']


def search(
    query: str,
    mode: str,
    schema_name: str,
    id_column: str | None,
    display_columns: list[str],
    k: int = TOP_K_DEFAULT,
    use_vector: bool = True,
    use_bm25: bool = True,
    use_rrf: bool = True,
    use_rerank: bool = True,
) -> SearchResponse:
    """Main search dispatcher."""
    k = min(k, TOP_K_MAX)

    if mode == "id" and id_column:
        return id_search(query, schema_name, id_column, display_columns, k)
    else:
        return topic_search(
            query, schema_name, display_columns, k,
            use_vector=use_vector, use_bm25=use_bm25,
            use_rrf=use_rrf, use_rerank=use_rerank,
        )

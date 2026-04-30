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


def legacy_bm25_search(
    query: str,
    schema_name: str,
    display_columns: list[str],
    k: int,
) -> SearchResponse:
    """
    Legacy baseline: BM25-only search using the precomputed tsvector index.
    No embeddings, no merge, no reranker.
    """
    logger.info("legacy_bm25_search schema=%s query=%r k=%d", schema_name, query, k)
    total_start = time.perf_counter()

    safe_display = [f'col_{safe_col_name(c)}' for c in display_columns]
    select_cols = ', '.join([f'"{c}"' for c in safe_display])

    t = time.perf_counter()
    with get_cursor() as (cur, conn):
        cur.execute(f"""
            SELECT id, {select_cols},
                   ts_rank(search_vector, plainto_tsquery('english', %s)) AS score
            FROM {schema_name}.records
            WHERE search_vector @@ plainto_tsquery('english', %s)
            ORDER BY score DESC
            LIMIT %s
        """, [query, query, TOP_K_RETRIEVAL])
        rows = cur.fetchall()
    bm25_ms = round((time.perf_counter() - t) * 1000, 1)

    results: list[SearchResult] = []
    for row in rows[:k]:
        display_data = {}
        for col in display_columns:
            safe = f'col_{safe_col_name(col)}'
            display_data[col] = row.get(safe)
        score = row.get("score")
        results.append(SearchResult(
            display_data=display_data,
            score=round(float(score), 4) if score is not None else None
        ))

    total_ms = round((time.perf_counter() - total_start) * 1000, 1)
    return SearchResponse(
        results=results,
        stats=SearchStats(
            mode="legacy",
            legacy_method="bm25",
            use_vector=False,
            use_bm25=True,
            use_rrf=False,
            use_rerank=False,
            bm25_search_ms=bm25_ms,
            bm25_candidates=len(rows),
            candidates_retrieved=len(rows),
            total_ms=total_ms,
            results_returned=len(results),
        ),
    )


def legacy_ilike_search(
    query: str,
    schema_name: str,
    id_column: str | None,
    display_columns: list[str],
    k: int,
) -> SearchResponse:
    """
    Legacy baseline: plain substring ILIKE search.
    Searches contextual_content, plus the configured ID column when present.
    """
    logger.info("legacy_ilike_search schema=%s id_column=%r query=%r k=%d", schema_name, id_column, query, k)
    total_start = time.perf_counter()

    safe_display = [f'col_{safe_col_name(c)}' for c in display_columns]
    select_cols = ', '.join([f'"{c}"' for c in safe_display])

    where_parts = ['contextual_content ILIKE %s']
    params: list = [f'%{query}%']
    if id_column:
        safe_id = f'col_{safe_col_name(id_column)}'
        where_parts.append(f'"{safe_id}" ILIKE %s')
        params.append(f'%{query}%')

    where_clause = " OR ".join(where_parts)

    t = time.perf_counter()
    with get_cursor() as (cur, conn):
        cur.execute(f"""
            SELECT {select_cols}
            FROM {schema_name}.records
            WHERE {where_clause}
            ORDER BY id
            LIMIT %s
        """, params + [k])
        rows = cur.fetchall()
    sql_ms = round((time.perf_counter() - t) * 1000, 1)

    results: list[SearchResult] = []
    for row in rows:
        display_data = {}
        for col in display_columns:
            safe = f'col_{safe_col_name(col)}'
            display_data[col] = row.get(safe)
        results.append(SearchResult(display_data=display_data, score=None))

    total_ms = round((time.perf_counter() - total_start) * 1000, 1)
    return SearchResponse(
        results=results,
        stats=SearchStats(
            mode="legacy",
            legacy_method="ilike",
            use_vector=False,
            use_bm25=False,
            use_rrf=False,
            use_rerank=False,
            sql_lookup_ms=sql_ms,
            candidates_retrieved=len(results),
            total_ms=total_ms,
            results_returned=len(results),
        ),
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
    embed_url: str | None = None,
    embed_api_key: str | None = None,
    embed_model: str | None = None,
    *,
    project_rerank_allowed: bool = True,
    rerank_model: str | None = None,
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
    # Resolve effective flags (use_rerank is further gated by env + project setting)
    eff_rerank = use_rerank and RERANKER_ENABLED and project_rerank_allowed
    reranker_available = bool(RERANKER_ENABLED and project_rerank_allowed)

    logger.info(
        "topic_search schema=%s query=%r k=%d vector=%s bm25=%s rrf=%s rerank=%s(env=%s proj=%s)",
        schema_name, query, k, use_vector, use_bm25, use_rrf, use_rerank, RERANKER_ENABLED, project_rerank_allowed,
    )

    stats = {}
    total_start = time.perf_counter()
    safe_display = [f'col_{safe_col_name(c)}' for c in display_columns]
    select_cols = ', '.join([f'"{c}"' for c in safe_display])

    vector_ids = []
    rows_by_id = {}
    vector_score_by_id: dict[int, float] = {}
    bm25_rank_by_id: dict[int, int] = {}

    # ── Step 1: Embed + vector retrieval ─────────────────────────────────────
    if use_vector:
        yield {"step": "embedding", "message": "Embedding query..."}
        t = time.perf_counter()
        query_vector = embed(query, base_url=embed_url, api_key=embed_api_key, model=embed_model)
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
        # 1 - (embedding <=> query_vector) stored as `score` in vector rows
        for row in vector_rows:
            try:
                if row.get("score") is not None:
                    vector_score_by_id[int(row["id"])] = float(row["score"])
            except Exception:
                pass
        stats['vector_candidates'] = len(vector_ids)
        yield {"step": "count", "for_step": "vector", "count": len(vector_ids)}
    else:
        stats['embedding_ms'] = None
        stats['vector_search_ms'] = None
        stats['vector_candidates'] = None
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
        stats['bm25_candidates'] = len(bm25_ids)
        yield {"step": "count", "for_step": "bm25", "count": len(bm25_ids)}
        bm25_rank_by_id = {int(row_id): (rank + 1) for rank, row_id in enumerate(bm25_ids)}
        for row in bm25_rows:
            if row['id'] not in rows_by_id:
                rows_by_id[row['id']] = row
    else:
        bm25_ids = []
        stats['bm25_search_ms'] = None
        stats['bm25_candidates'] = None
        logger.debug("  bm25 search skipped (use_bm25=False)")

    # ── Step 3: Merge ─────────────────────────────────────────────────────────
    yield {"step": "rrf", "message": "Merging results..."}
    t = time.perf_counter()
    merged_ids = merge_candidates(vector_ids, bm25_ids, use_rrf)
    merge_ms = round((time.perf_counter() - t) * 1000, 1)
    # Only record RRF timing when RRF actually ran; trivial concat gets None
    stats['rrf_merge_ms'] = merge_ms
    stats['candidates_retrieved'] = len(merged_ids)
    yield {"step": "count", "for_step": "rrf", "count": len(merged_ids)}
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
        rerank_scores = rerank(query, candidate_texts, model=rerank_model)
        ranked = sorted(
            zip(candidates_to_rerank, rerank_scores),
            key=lambda x: x[1],
            reverse=True
        )
        stats['reranker_ms'] = round((time.perf_counter() - t) * 1000, 1)
        logger.debug("  rerank done reranker_ms=%.1f", stats['reranker_ms'])
        yield {"step": "count", "for_step": "reranking", "count": min(k, len(ranked))}
    else:
        ranked = [(doc_id, None) for doc_id in candidates_to_rerank]
        stats['reranker_ms'] = None
        logger.debug(
            "  reranker skipped (use_rerank=%s env=%s proj=%s)",
            use_rerank,
            RERANKER_ENABLED,
            project_rerank_allowed,
        )

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
            score=round(float(score), 4) if score is not None else None,
            cosine_score=round(float(vector_score_by_id.get(int(doc_id))), 4) if int(doc_id) in vector_score_by_id else None,
            bm25_rank=bm25_rank_by_id.get(int(doc_id)),
            rerank_score=round(float(score), 4) if score is not None else None,
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
                reranker_available=reranker_available,
                embedding_ms=stats['embedding_ms'],
                vector_search_ms=stats['vector_search_ms'],
                vector_candidates=stats['vector_candidates'],
                bm25_search_ms=stats['bm25_search_ms'],
                bm25_candidates=stats['bm25_candidates'],
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
    embed_url: str | None = None,
    embed_api_key: str | None = None,
    embed_model: str | None = None,
    *,
    project_rerank_allowed: bool = True,
    rerank_model: str | None = None,
) -> SearchResponse:
    """Synchronous wrapper — collects the final event from the stream generator."""
    for event in topic_search_stream(
        query, schema_name, display_columns, k,
        use_vector=use_vector, use_bm25=use_bm25,
        use_rrf=use_rrf, use_rerank=use_rerank,
        embed_url=embed_url, embed_api_key=embed_api_key, embed_model=embed_model,
        project_rerank_allowed=project_rerank_allowed,
        rerank_model=rerank_model,
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
    legacy_method: str | None = None,
    embed_url: str | None = None,
    embed_api_key: str | None = None,
    embed_model: str | None = None,
    *,
    project_rerank_allowed: bool = True,
    rerank_model: str | None = None,
) -> SearchResponse:
    """Main search dispatcher."""
    k = min(k, TOP_K_MAX)

    if mode == "id" and id_column:
        return id_search(query, schema_name, id_column, display_columns, k)
    if mode == "legacy":
        method = (legacy_method or "bm25").lower().strip()
        if method == "bm25":
            return legacy_bm25_search(query, schema_name, display_columns, k)
        if method == "ilike":
            return legacy_ilike_search(query, schema_name, id_column, display_columns, k)
        raise ValueError(f"Unknown legacy_method: {legacy_method!r}")
    else:
        return topic_search(
            query, schema_name, display_columns, k,
            use_vector=use_vector, use_bm25=use_bm25,
            use_rrf=use_rrf, use_rerank=use_rerank,
            embed_url=embed_url, embed_api_key=embed_api_key, embed_model=embed_model,
            project_rerank_allowed=project_rerank_allowed,
            rerank_model=rerank_model,
        )

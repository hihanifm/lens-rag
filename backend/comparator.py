"""
comparator.py — Core Compare pipeline.

Reuses:
  - read_excel(), build_contextual_content() from ingestion.py
  - embed() from embedder.py
  - rerank() from embedder.py
  - get_cursor() from db.py

All heavy lifting (embed + rerank) stays on the existing Ollama/OpenAI setup.
No new models, no external calls.
"""
import logging
import time
import json
from typing import Generator

from db import get_cursor, create_compare_schema
from embedder import embed, rerank
from ingestion import read_excel, build_contextual_content
from config import EMBEDDING_DIMS, RERANKER_ENABLED

logger = logging.getLogger("lens.comparator")


# ── Ingestion ──────────────────────────────────────────────────────────────

def ingest_side(
    job_id: int,
    side: str,             # "left" or "right"
    df,
    content_column: str,
    context_columns: list[str],
    display_column: str | None,
    schema_name: str,
    embed_kwargs: dict | None = None,
    metrics: dict | None = None,
) -> Generator[dict, None, None]:
    """
    Embed and insert one side (left or right) into compare_{id}.records.
    Yields SSE-style progress dicts.
    Skips rows whose contextual_content is empty.
    """
    records = df.to_dict(orient="records")
    total = len(records)
    inserted = 0
    embed_ms = 0.0

    logger.info(
        "ingest_side() job_id=%d side=%s total_rows=%d content_col=%r context_cols=%s",
        job_id, side, total, content_column, context_columns,
    )

    for i, row in enumerate(records):
        sheet_name = str(row.get("sheet_name", ""))
        contextual_content = build_contextual_content(row, context_columns, content_column, sheet_name)

        if not contextual_content.strip():
            logger.debug("ingest_side() skip empty row %d/%d side=%s", i + 1, total, side)
            continue

        display_value = None
        if display_column:
            raw = row.get(display_column)
            if raw is not None and str(raw).lower() != "nan":
                display_value = str(raw)

        try:
            t_embed0 = time.monotonic()
            vector = embed(contextual_content, **(embed_kwargs or {}))
            embed_ms += (time.monotonic() - t_embed0) * 1000.0
        except Exception as e:
            logger.error("embed failed on row %d/%d side=%s — %s: %s", i + 1, total, side, type(e).__name__, e)
            raise

        try:
            with get_cursor() as (cur, _conn):
                cur.execute(
                    f"""
                    INSERT INTO {schema_name}.records
                        (side, original_row, sheet_name, contextual_content, display_value, embedding)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    """,
                    [side, i, sheet_name, contextual_content, display_value, vector],
                )
        except Exception as e:
            logger.error("DB insert failed row %d/%d side=%s — %s: %s", i + 1, total, side, type(e).__name__, e)
            raise

        inserted += 1

        if (i + 1) % 10 == 0 or (i + 1) == total:
            logger.info("ingest_side() %s %d/%d inserted=%d", side, i + 1, total, inserted)
            yield {
                "type": f"ingest_{side}",
                "processed": i + 1,
                "total": total,
                "percent": round(((i + 1) / total) * 100),
            }

    # Update row_count in compare_jobs
    col = "row_count_left" if side == "left" else "row_count_right"
    with get_cursor() as (cur, _conn):
        cur.execute(
            f"UPDATE public.compare_jobs SET {col} = %s WHERE id = %s",
            [inserted, job_id],
        )

    logger.info("ingest_side() done side=%s inserted=%d", side, inserted)
    if metrics is not None:
        metrics[f"rows_{side}"] = inserted
        metrics[f"embed_{side}_ms"] = int(embed_ms)


# ── Bidirectional vector search ────────────────────────────────────────────

def run_bidirectional_search(
    schema_name: str,
    top_k: int,
) -> list[tuple[int, int, float]]:
    """
    For each left record, find the top_k closest right records by cosine similarity.
    Returns list of (left_id, right_id, cosine_score).
    cosine_score = 1 - cosine_distance (higher = more similar).
    """
    logger.info("run_bidirectional_search() schema=%s top_k=%d", schema_name, top_k)
    t0 = time.monotonic()

    # Fetch all left embeddings
    with get_cursor() as (cur, _conn):
        cur.execute(
            f"SELECT id, embedding FROM {schema_name}.records WHERE side = 'left' ORDER BY id"
        )
        left_rows = cur.fetchall()

    candidates = []
    for left_row in left_rows:
        left_id = left_row["id"]
        embedding = left_row["embedding"]

        with get_cursor() as (cur, _conn):
            cur.execute(
                f"""
                SELECT id,
                       (1 - (embedding <=> %s::vector)) AS cosine_score
                FROM {schema_name}.records
                WHERE side = 'right'
                ORDER BY embedding <=> %s::vector ASC
                LIMIT %s
                """,
                [embedding, embedding, top_k],
            )
            rows = cur.fetchall()

        for row in rows:
            candidates.append((left_id, row["id"], float(row["cosine_score"])))

    elapsed = int((time.monotonic() - t0) * 1000)
    logger.info(
        "run_bidirectional_search() done left_rows=%d candidates=%d elapsed_ms=%d",
        len(left_rows), len(candidates), elapsed,
    )
    return candidates


# ── Reranking ──────────────────────────────────────────────────────────────

def run_reranking(
    schema_name: str,
    candidates: list[tuple[int, int, float]],
    *,
    rerank_enabled: bool | None = None,
    rerank_model: str | None = None,
) -> list[tuple[int, int, float, float]]:
    """
    Rerank each (left, right) pair.
    Groups candidates by left_id, calls rerank() once per left record.
    Returns list of (left_id, right_id, cosine_score, rerank_score).

    rerank_enabled: per-job override; falls back to global RERANKER_ENABLED when None.
    rerank_model:   per-job model override; None = use server default.
    """
    # Per-job setting takes precedence; fall back to global config.
    effective_enabled = rerank_enabled if rerank_enabled is not None else RERANKER_ENABLED
    if not effective_enabled:
        logger.info("run_reranking() reranker disabled — using cosine score as rerank_score")
        return [(l, r, c, c) for l, r, c in candidates]

    logger.info("run_reranking() candidates=%d", len(candidates))
    t0 = time.monotonic()

    # Fetch contextual_content for all unique IDs
    all_ids = set()
    for left_id, right_id, _ in candidates:
        all_ids.add(left_id)
        all_ids.add(right_id)

    content_map: dict[int, str] = {}
    with get_cursor() as (cur, _conn):
        cur.execute(
            f"SELECT id, contextual_content FROM {schema_name}.records WHERE id = ANY(%s)",
            [list(all_ids)],
        )
        for row in cur.fetchall():
            content_map[row["id"]] = row["contextual_content"] or ""

    # Group by left_id
    from collections import defaultdict
    groups: dict[int, list[tuple[int, float]]] = defaultdict(list)
    for left_id, right_id, cosine in candidates:
        groups[left_id].append((right_id, cosine))

    results = []
    for left_id, pairs in groups.items():
        query_text = content_map.get(left_id, "")
        right_texts = [content_map.get(right_id, "") for right_id, _ in pairs]

        try:
            scores = rerank(query_text, right_texts, model=rerank_model or None)
        except Exception as e:
            logger.warning(
                "rerank() failed for left_id=%d — falling back to cosine. Error: %s", left_id, e
            )
            scores = [cosine for _, cosine in pairs]

        for (right_id, cosine), rerank_score in zip(pairs, scores):
            results.append((left_id, right_id, cosine, float(rerank_score)))

    elapsed = int((time.monotonic() - t0) * 1000)
    logger.info("run_reranking() done pairs=%d elapsed_ms=%d", len(results), elapsed)
    return results


# ── Write matches ──────────────────────────────────────────────────────────

def write_matches(
    schema_name: str,
    scored_pairs: list[tuple[int, int, float, float]],
    top_k: int,
) -> None:
    """
    Per left_id: sort by rerank_score desc, take top_k, insert into matches with rank 1..top_k.
    """
    from collections import defaultdict

    groups: dict[int, list[tuple[int, float, float]]] = defaultdict(list)
    for left_id, right_id, cosine, rerank_score in scored_pairs:
        groups[left_id].append((right_id, cosine, rerank_score))

    rows_to_insert = []
    for left_id, pairs in groups.items():
        sorted_pairs = sorted(pairs, key=lambda x: x[2], reverse=True)[:top_k]
        for rank, (right_id, cosine, rerank_score) in enumerate(sorted_pairs, start=1):
            rows_to_insert.append((left_id, right_id, cosine, rerank_score, rank))

    logger.info("write_matches() schema=%s inserting %d match rows", schema_name, len(rows_to_insert))
    with get_cursor() as (cur, _conn):
        cur.executemany(
            f"""
            INSERT INTO {schema_name}.matches (left_id, right_id, cosine_score, rerank_score, rank)
            VALUES (%s, %s, %s, %s, %s)
            """,
            rows_to_insert,
        )


# ── Orchestrator ───────────────────────────────────────────────────────────

def run_compare_job(job_id: int) -> Generator[dict, None, None]:
    """
    Full pipeline for a compare job. Yields SSE-style progress dicts.
    Reads job config from public.compare_jobs.
    Updates status at each phase.
    """
    logger.info("run_compare_job() start job_id=%d", job_id)

    # Load job config
    with get_cursor() as (cur, _conn):
        cur.execute("SELECT * FROM public.compare_jobs WHERE id = %s", [job_id])
        job = cur.fetchone()
    if not job:
        yield {"type": "error", "message": f"Job {job_id} not found"}
        return

    job = dict(job)
    schema_name = job["schema_name"]

    # Resolve dims + per-job embed/rerank config
    dims = job.get("embed_dims") or EMBEDDING_DIMS
    top_k = job.get("top_k") or 3

    embed_url   = job.get("embed_url") or None
    embed_key   = job.get("embed_api_key") or None
    embed_model = job.get("embed_model") or None
    embed_kwargs: dict = {}
    if embed_url:
        embed_kwargs["base_url"] = embed_url
        if embed_key:
            embed_kwargs["api_key"] = embed_key
        if embed_model:
            embed_kwargs["model"] = embed_model

    job_rerank_enabled = job.get("rerank_enabled")   # may be None for legacy rows
    job_rerank_model   = job.get("rerank_model") or None

    def _set_status(status: str, message: str | None = None):
        with get_cursor() as (cur, _conn):
            cur.execute(
                "UPDATE public.compare_jobs SET status = %s, status_message = %s WHERE id = %s",
                [status, message, job_id],
            )

    try:
        t_total0 = time.monotonic()
        metrics: dict = {}
        # ── Ingest left ──────────────────────────────────────────────────
        _set_status("ingesting")
        yield {"type": "ingest_left", "processed": 0, "total": 0, "percent": 0,
               "message": f"Reading {job['source_filename_left'] or 'left file'}..."}

        df_left, _, _ = read_excel(job["tmp_path_left"])
        t0 = time.monotonic()
        for event in ingest_side(
            job_id=job_id,
            side="left",
            df=df_left,
            content_column=job["content_column_left"],
            context_columns=job["context_columns_left"] or [],
            display_column=job.get("display_column_left"),
            schema_name=schema_name,
            embed_kwargs=embed_kwargs,
            metrics=metrics,
        ):
            yield event
        metrics["ingest_left_ms"] = int((time.monotonic() - t0) * 1000)

        # ── Ingest right ─────────────────────────────────────────────────
        yield {"type": "ingest_right", "processed": 0, "total": 0, "percent": 0,
               "message": f"Reading {job['source_filename_right'] or 'right file'}..."}

        df_right, _, _ = read_excel(job["tmp_path_right"])
        t0 = time.monotonic()
        for event in ingest_side(
            job_id=job_id,
            side="right",
            df=df_right,
            content_column=job["content_column_right"],
            context_columns=job["context_columns_right"] or [],
            display_column=job.get("display_column_right"),
            schema_name=schema_name,
            embed_kwargs=embed_kwargs,
            metrics=metrics,
        ):
            yield event
        metrics["ingest_right_ms"] = int((time.monotonic() - t0) * 1000)

        # ── Bidirectional search ──────────────────────────────────────────
        _set_status("comparing")
        yield {"type": "searching", "message": "Running bidirectional vector search..."}

        t0 = time.monotonic()
        candidates = run_bidirectional_search(schema_name, top_k)
        metrics["vector_search_ms"] = int((time.monotonic() - t0) * 1000)
        metrics["candidate_pairs"] = len(candidates)

        yield {"type": "reranking", "message": f"Reranking {len(candidates)} candidate pairs..."}

        # ── Reranking ─────────────────────────────────────────────────────
        t0 = time.monotonic()
        scored_pairs = run_reranking(
            schema_name,
            candidates,
            rerank_enabled=job_rerank_enabled,
            rerank_model=job_rerank_model,
        )
        metrics["rerank_ms"] = int((time.monotonic() - t0) * 1000)

        # ── Write matches ─────────────────────────────────────────────────
        t0 = time.monotonic()
        write_matches(schema_name, scored_pairs, top_k)
        metrics["write_matches_ms"] = int((time.monotonic() - t0) * 1000)
        metrics["total_ms"] = int((time.monotonic() - t_total0) * 1000)

        # ── Done ──────────────────────────────────────────────────────────
        _set_status("ready", json.dumps({
            "message": "Comparison complete. Ready for review.",
            "metrics": metrics,
        }))
        yield {"type": "complete", "message": "Comparison complete. Ready for review."}
        logger.info("run_compare_job() done job_id=%d", job_id)

    except Exception as e:
        logger.exception("run_compare_job() FAILED job_id=%d", job_id)
        _set_status("error", str(e))
        yield {"type": "error", "message": str(e)}

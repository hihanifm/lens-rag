"""
comparator.py — Core Compare pipeline.

Reuses:
  - read_compare_dataframe(), apply_compare_row_filters(), build_contextual_content() from ingestion.py
  - embed() / rerank() from embedder.py
  - get_cursor() from db.py

Pipeline is split into two phases:
  1. run_ingest_job()  — embed left + right and store in compare_{id}.records
  2. run_pipeline()    — vector search + optional rerank + optional LLM judge → write per-run matches
"""
import json
import logging
import time
from collections import defaultdict
from typing import Generator

from openai import OpenAI

from config import EMBEDDING_DIMS, LLM_JUDGE_MAX_REQUESTS_PER_MINUTE, RERANKER_ENABLED
from db import get_cursor, create_compare_schema
from embedder import embed, rerank
from ingestion import apply_compare_row_filters, build_contextual_content, read_compare_dataframe

logger = logging.getLogger("lens.comparator")


def _job_row_filters(job: dict, key: str) -> list[dict]:
    raw = job.get(key)
    if raw is None:
        return []
    if isinstance(raw, list):
        return [dict(x) for x in raw]
    if isinstance(raw, str) and raw.strip():
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return []
    return []


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

def iter_vector_search(
    schema_name: str,
    top_k: int,
    candidates_out: list[tuple[int, int, float]],
) -> Generator[dict, None, None]:
    """
    For each left record, find the top_k closest right records by cosine similarity.
    Appends (left_id, right_id, cosine_score) tuples to candidates_out.
    Yields SSE dicts with type vector_search and processed/total/percent.
    """
    logger.info("iter_vector_search() schema=%s top_k=%d", schema_name, top_k)
    t0 = time.monotonic()

    with get_cursor() as (cur, _conn):
        cur.execute(
            f"SELECT id, embedding FROM {schema_name}.records WHERE side = 'left' ORDER BY id"
        )
        left_rows = cur.fetchall()

    n = len(left_rows)
    if n == 0:
        yield {
            "type": "vector_search",
            "processed": 0,
            "total": 0,
            "percent": 100,
            "message": "No left rows to search",
        }
        elapsed = int((time.monotonic() - t0) * 1000)
        logger.info("iter_vector_search() done left_rows=0 elapsed_ms=%d", elapsed)
        return

    yield {
        "type": "vector_search",
        "processed": 0,
        "total": n,
        "percent": 0,
        "message": f"Vector search — {n} left row(s)",
    }

    for i, left_row in enumerate(left_rows):
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
            candidates_out.append((left_id, row["id"], float(row["cosine_score"])))

        pct = round(100 * (i + 1) / n)
        yield {
            "type": "vector_search",
            "processed": i + 1,
            "total": n,
            "percent": pct,
            "message": f"Left row {i + 1} / {n} (db id {left_id})",
            "left_id": left_id,
        }

    elapsed = int((time.monotonic() - t0) * 1000)
    logger.info(
        "iter_vector_search() done left_rows=%d candidates=%d elapsed_ms=%d",
        n, len(candidates_out), elapsed,
    )


def run_bidirectional_search(schema_name: str, top_k: int) -> list[tuple[int, int, float]]:
    """Non-streaming wrapper (tests / callers that do not need SSE)."""
    out: list[tuple[int, int, float]] = []
    for _ in iter_vector_search(schema_name, top_k, out):
        pass
    return out


# ── Reranking ──────────────────────────────────────────────────────────────

def iter_run_reranking(
    schema_name: str,
    candidates: list[tuple[int, int, float]],
    *,
    rerank_enabled: bool | None = None,
    rerank_model: str | None = None,
    results_out: list[tuple[int, int, float, float]],
) -> Generator[dict, None, None]:
    """
    Rerank each (left, right) pair (grouped by left_id). Appends to results_out.
    Yields SSE dicts type reranking with processed/total per left group.
    """
    effective_enabled = rerank_enabled if rerank_enabled is not None else RERANKER_ENABLED
    if not effective_enabled:
        logger.info("iter_run_reranking() reranker disabled — using cosine score as rerank_score")
        results_out.extend([(l, r, c, c) for l, r, c in candidates])
        return

    logger.info("iter_run_reranking() candidates=%d", len(candidates))
    t0 = time.monotonic()

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

    groups: dict[int, list[tuple[int, float]]] = defaultdict(list)
    for left_id, right_id, cosine in candidates:
        groups[left_id].append((right_id, cosine))

    group_items = list(groups.items())
    total_g = len(group_items)
    if total_g == 0:
        yield {
            "type": "reranking",
            "processed": 0,
            "total": 0,
            "percent": 100,
            "message": "Nothing to rerank",
        }
        elapsed = int((time.monotonic() - t0) * 1000)
        logger.info("iter_run_reranking() done pairs=0 elapsed_ms=%d", elapsed)
        return

    yield {
        "type": "reranking",
        "processed": 0,
        "total": total_g,
        "percent": 0,
        "message": f"Reranking — {total_g} left row(s)",
    }

    for gi, (left_id, pairs) in enumerate(group_items):
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
            results_out.append((left_id, right_id, cosine, float(rerank_score)))

        pct = round(100 * (gi + 1) / total_g) if total_g else 100
        yield {
            "type": "reranking",
            "processed": gi + 1,
            "total": total_g,
            "percent": pct,
            "message": f"Reranked left group {gi + 1} / {total_g} (db id {left_id})",
            "left_id": left_id,
        }

    elapsed = int((time.monotonic() - t0) * 1000)
    logger.info("iter_run_reranking() done pairs=%d elapsed_ms=%d", len(results_out), elapsed)


def run_reranking(
    schema_name: str,
    candidates: list[tuple[int, int, float]],
    *,
    rerank_enabled: bool | None = None,
    rerank_model: str | None = None,
) -> list[tuple[int, int, float, float]]:
    """Non-streaming wrapper."""
    out: list[tuple[int, int, float, float]] = []
    for _ in iter_run_reranking(
        schema_name,
        candidates,
        rerank_enabled=rerank_enabled,
        rerank_model=rerank_model,
        results_out=out,
    ):
        pass
    return out


# ── Write matches ──────────────────────────────────────────────────────────

def write_matches(
    schema_name: str,
    table_name: str,
    scored_tuples: list,
    top_k: int,
) -> int:
    """
    Per left_id: sort by final_score desc, take top_k, insert into {schema_name}.{table_name}.
    scored_tuples: (left_id, right_id, cosine_score, rerank_score, llm_score, final_score)
    """
    groups: dict[int, list] = defaultdict(list)
    for row in scored_tuples:
        left_id = row[0]
        groups[left_id].append(row)

    rows_to_insert = []
    for left_id, pairs in groups.items():
        sorted_pairs = sorted(pairs, key=lambda x: x[5], reverse=True)[:top_k]
        for rank, (lid, right_id, cosine, rerank_score, llm_score, final_score) in enumerate(sorted_pairs, start=1):
            rows_to_insert.append((lid, right_id, cosine, rerank_score, llm_score, final_score, rank))

    n_insert = len(rows_to_insert)
    logger.info("write_matches() table=%s.%s inserting %d rows", schema_name, table_name, n_insert)
    with get_cursor() as (cur, _conn):
        cur.executemany(
            f"""
            INSERT INTO {schema_name}.{table_name}
                (left_id, right_id, cosine_score, rerank_score, llm_score, final_score, rank)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            """,
            rows_to_insert,
        )
    return n_insert


# ── LLM Judge ─────────────────────────────────────────────────────────────

DEFAULT_LLM_JUDGE_PROMPT = """You compare test specifications from two sources (e.g. different clients or baselines).

Domain context (critical):
- These tests concern telecom protocol behavior as implemented on Android devices.
- Content typically reflects 3GPP-family specifications and related industry specs — including legacy cellular (e.g. GSM/UMTS context where relevant), LTE (4G), and 5G NR (New Radio), plus associated procedures, timers, RRC/NAS/AS behaviors, bearers, registrations, handovers, measurements, and conformance-style scenarios as described in the text.

Input format (fixed by the tool):
- "Query" is ONE reference test case (steps, scope, and fields merged into one text).
- "Document" is ONE candidate test case from the other source.

Your job for THIS pair only:
- Decide how well this single candidate corresponds to the reference test for human review — not a final truth.
- Use telecom domain knowledge only to judge intent and coverage (procedures, layers, signals, parameters named in the text). Do not hallucinate spec clauses or requirements not supported by the given text.
- Matching is often imperfect: one reference may align with one candidate, or several candidates together may cover one reference (split/combined cases). You only score THIS pair; reviewers may merge or split rows later.

Scoring (output a single number 0.0–1.0):
- 0.90–1.00 = Strong match: same intent, scope, and main checks; wording/format differences are OK.
- 0.75–0.89 = Good / reasonable match: clearly the same area with minor gaps, extra/missing steps, or different structure.
- 0.55–0.74 = Partial / weak: overlapping topic but important differences; might be one of several candidates needed for a full match.
- 0.25–0.54 = Mostly different with small overlap.
- 0.00–0.24 = Unrelated or wrong candidate.

Use the full merged text; do not invent IDs or missing steps. Prefer lower scores when unsure.

Reply with ONLY valid JSON in this format: {"score": <float>}"""

# OpenAI-compatible chat params for LLM judge (surfaced in run metrics JSON).
LLM_JUDGE_MAX_TOKENS = 50
LLM_JUDGE_TEMPERATURE = 0.0


def effective_llm_judge_max_rpm(run: dict) -> int:
    """
    Max LLM chat requests per minute (0 = unlimited).
    Run column NULL → server env LLM_JUDGE_MAX_REQUESTS_PER_MINUTE.
    """
    raw = run.get("llm_judge_max_requests_per_minute")
    if raw is None:
        try:
            return max(0, int(LLM_JUDGE_MAX_REQUESTS_PER_MINUTE))
        except (TypeError, ValueError):
            return 0
    try:
        return max(0, min(int(raw), 360))
    except (TypeError, ValueError):
        try:
            return max(0, int(LLM_JUDGE_MAX_REQUESTS_PER_MINUTE))
        except (TypeError, ValueError):
            return 0


def iter_run_llm_judge(
    schema_name: str,
    candidates: list,
    *,
    url: str,
    model: str,
    results_out: list,
    prompt: str | None = None,
    max_requests_per_minute: int = 0,
) -> Generator[dict, None, None]:
    """
    Score each (left_id, right_id, cosine, rerank_score) tuple using an LLM judge.
    Appends (left_id, right_id, cosine, rerank_score, llm_score) to results_out.
    Yields SSE dicts type llm_judge with processed/total per pair.

    max_requests_per_minute: > 0 enforces minimum spacing (60/rpm seconds) between call starts.
    """
    system_prompt = prompt or DEFAULT_LLM_JUDGE_PROMPT
    client = OpenAI(base_url=url, api_key="ollama")

    all_ids = list({row[0] for row in candidates} | {row[1] for row in candidates})
    content_map: dict[int, str] = {}
    with get_cursor() as (cur, _conn):
        cur.execute(
            f"SELECT id, contextual_content FROM {schema_name}.records WHERE id = ANY(%s)",
            [all_ids],
        )
        for row in cur.fetchall():
            content_map[row["id"]] = row["contextual_content"] or ""

    total_p = len(candidates)
    if total_p == 0:
        yield {
            "type": "llm_judge",
            "processed": 0,
            "total": 0,
            "percent": 100,
            "message": "No pairs to judge",
        }
        return

    rpm = max(0, int(max_requests_per_minute or 0))
    throttle_note = f", max {rpm}/min" if rpm > 0 else ""
    yield {
        "type": "llm_judge",
        "processed": 0,
        "total": total_p,
        "percent": 0,
        "message": f"LLM judge — {total_p} pair(s){throttle_note}",
    }

    last_call_start: float | None = None
    min_gap_s = (60.0 / float(rpm)) if rpm > 0 else 0.0

    for pi, (left_id, right_id, cosine, rerank_score) in enumerate(candidates):
        if min_gap_s > 0 and last_call_start is not None:
            elapsed = time.monotonic() - last_call_start
            if elapsed < min_gap_s:
                time.sleep(min_gap_s - elapsed)
        last_call_start = time.monotonic()

        query_text = content_map.get(left_id, "")
        doc_text = content_map.get(right_id, "")
        fallback = float(rerank_score) if rerank_score is not None else float(cosine)

        try:
            resp = client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": f"Query: {query_text}\n\nDocument: {doc_text}"},
                ],
                max_tokens=LLM_JUDGE_MAX_TOKENS,
                temperature=LLM_JUDGE_TEMPERATURE,
            )
            text = resp.choices[0].message.content.strip()
            data = json.loads(text)
            llm_score = float(data.get("score", fallback))
            llm_score = max(0.0, min(1.0, llm_score))
        except Exception as e:
            logger.warning(
                "run_llm_judge() fallback for left_id=%d right_id=%d — %s", left_id, right_id, e
            )
            llm_score = fallback

        results_out.append((left_id, right_id, cosine, rerank_score, llm_score))

        pct = round(100 * (pi + 1) / total_p)
        yield {
            "type": "llm_judge",
            "processed": pi + 1,
            "total": total_p,
            "percent": pct,
            "message": f"Pair {pi + 1} / {total_p} (left {left_id} → right {right_id})",
            "left_id": left_id,
            "right_id": right_id,
        }

    logger.info("iter_run_llm_judge() done pairs=%d", len(results_out))


def run_llm_judge(
    schema_name: str,
    candidates: list,
    *,
    url: str,
    model: str,
    prompt: str | None = None,
    max_requests_per_minute: int = 0,
) -> list:
    """Non-streaming wrapper."""
    out = []
    for _ in iter_run_llm_judge(
        schema_name,
        candidates,
        url=url,
        model=model,
        results_out=out,
        prompt=prompt,
        max_requests_per_minute=max_requests_per_minute,
    ):
        pass
    return out


# ── Job ingest orchestrator (Phase 1 — embed only) ─────────────────────────

def run_ingest_job(job_id: int) -> Generator[dict, None, None]:
    """
    Phase 1: embed left + right files and store in compare_{job_id}.records.
    Does NOT run vector search or reranking.
    Yields SSE-style progress dicts.
    """
    logger.info("run_ingest_job() start job_id=%d", job_id)

    with get_cursor() as (cur, _conn):
        cur.execute("SELECT * FROM public.compare_jobs WHERE id = %s", [job_id])
        job = cur.fetchone()
    if not job:
        yield {"type": "error", "message": f"Job {job_id} not found"}
        return

    job = dict(job)
    schema_name = job["schema_name"]
    dims = job.get("embed_dims") or EMBEDDING_DIMS

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

        df_left = read_compare_dataframe(job["tmp_path_left"], job.get("sheet_name_left") or None)
        df_left = apply_compare_row_filters(df_left, _job_row_filters(job, "row_filters_left"))
        t0 = time.monotonic()
        for event in ingest_side(
            job_id=job_id, side="left", df=df_left,
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

        df_right = read_compare_dataframe(job["tmp_path_right"], job.get("sheet_name_right") or None)
        df_right = apply_compare_row_filters(df_right, _job_row_filters(job, "row_filters_right"))
        t0 = time.monotonic()
        for event in ingest_side(
            job_id=job_id, side="right", df=df_right,
            content_column=job["content_column_right"],
            context_columns=job["context_columns_right"] or [],
            display_column=job.get("display_column_right"),
            schema_name=schema_name,
            embed_kwargs=embed_kwargs,
            metrics=metrics,
        ):
            yield event
        metrics["ingest_right_ms"] = int((time.monotonic() - t0) * 1000)
        metrics["total_ms"] = int((time.monotonic() - t_total0) * 1000)

        _set_status("ready", json.dumps({"message": "Embeddings ready.", "metrics": metrics}))
        yield {"type": "complete", "message": "Embeddings ready. Create a run to search and rank."}
        logger.info("run_ingest_job() done job_id=%d", job_id)

    except Exception as e:
        logger.exception("run_ingest_job() FAILED job_id=%d", job_id)
        _set_status("error", str(e))
        yield {"type": "error", "message": str(e)}


# ── Run pipeline orchestrator (Phase 2 — search + rank) ────────────────────

def run_pipeline(job_id: int, run_id: int) -> Generator[dict, None, None]:
    """
    Phase 2: vector search + optional rerank + optional LLM judge → write per-run matches.
    Reads run config from public.compare_runs.
    Yields SSE-style progress dicts.
    """
    logger.info("run_pipeline() start job_id=%d run_id=%d", job_id, run_id)

    with get_cursor() as (cur, _conn):
        cur.execute("SELECT * FROM public.compare_jobs WHERE id = %s", [job_id])
        job = cur.fetchone()
        cur.execute("SELECT * FROM public.compare_runs WHERE id = %s", [run_id])
        run = cur.fetchone()

    if not job or not run:
        yield {"type": "error", "message": f"Job {job_id} or run {run_id} not found"}
        return

    job = dict(job)
    run = dict(run)
    schema_name = job["schema_name"]
    table_name  = f"run_{run_id}_matches"
    top_k       = run["top_k"]

    def _set_run_status(status: str, message: str | None = None):
        with get_cursor() as (cur, _conn):
            cur.execute(
                "UPDATE public.compare_runs SET status = %s, status_message = %s WHERE id = %s",
                [status, message, run_id],
            )

    try:
        t_total0 = time.monotonic()
        metrics: dict = {}

        # ── Vector search ─────────────────────────────────────────────────
        _set_run_status("running")

        t_vec0 = time.monotonic()
        candidates: list[tuple[int, int, float]] = []
        for prog in iter_vector_search(schema_name, top_k, candidates):
            yield prog
        metrics["vector_search_ms"] = int((time.monotonic() - t_vec0) * 1000)
        metrics["candidate_pairs"] = len(candidates)
        metrics["vector_left_rows"] = len({left_id for left_id, _, _ in candidates})

        # ── Reranker ──────────────────────────────────────────────────────
        pairs_with_rerank: list[tuple[int, int, float, float]] = []
        if run["reranker_enabled"]:
            t_rr0 = time.monotonic()
            for prog in iter_run_reranking(
                schema_name,
                candidates,
                rerank_enabled=True,
                rerank_model=run.get("reranker_model") or None,
                results_out=pairs_with_rerank,
            ):
                yield prog
            metrics["rerank_ms"] = int((time.monotonic() - t_rr0) * 1000)
            metrics["rerank_pairs"] = len(candidates)
        else:
            # No reranker pass: keep rerank slot None so DB/UI do not show a fake "R" score (was cosine duplicate).
            pairs_with_rerank = [(l, r, c, None) for l, r, c in candidates]

        # ── LLM Judge ─────────────────────────────────────────────────────
        if run["llm_judge_enabled"]:
            url = run.get("llm_judge_url") or ""
            model = run.get("llm_judge_model") or ""
            if not url or not model:
                yield {"type": "error", "message": "LLM judge enabled but url/model not configured"}
                _set_run_status("error", "LLM judge url or model missing")
                return

            rpm_eff = effective_llm_judge_max_rpm(run)
            t_llm0 = time.monotonic()
            judged: list[tuple] = []
            for prog in iter_run_llm_judge(
                schema_name,
                pairs_with_rerank,
                url=url,
                model=model,
                results_out=judged,
                prompt=run.get("llm_judge_prompt") or None,
                max_requests_per_minute=rpm_eff,
            ):
                yield prog
            metrics["llm_judge_ms"] = int((time.monotonic() - t_llm0) * 1000)
            metrics["llm_judge_pairs"] = len(pairs_with_rerank)
            metrics["llm_judge_max_tokens"] = LLM_JUDGE_MAX_TOKENS
            metrics["llm_judge_temperature"] = LLM_JUDGE_TEMPERATURE
            metrics["llm_judge_max_requests_per_minute"] = rpm_eff
            scored_tuples = [(l, r, c, rs, ls, ls) for l, r, c, rs, ls in judged]
        else:
            # final_score = rerank when present, else cosine (reranker off)
            scored_tuples = [
                (l, r, c, rs, None, float(rs) if rs is not None else float(c))
                for l, r, c, rs in pairs_with_rerank
            ]

        # ── Write matches ─────────────────────────────────────────────────
        t0 = time.monotonic()
        metrics["matches_inserted"] = write_matches(schema_name, table_name, scored_tuples, top_k)
        metrics["write_matches_ms"] = int((time.monotonic() - t0) * 1000)
        metrics["total_ms"]         = int((time.monotonic() - t_total0) * 1000)

        lp = metrics.get("llm_judge_pairs")
        lm = metrics.get("llm_judge_ms")
        if lp and lm and lp > 0:
            metrics["llm_judge_avg_ms_per_pair"] = round(lm / lp, 2)

        metrics["embedding_job"] = {
            "embed_dims": job.get("embed_dims"),
            "embed_model": job.get("embed_model"),
            "embed_url": job.get("embed_url"),
        }

        # Update row_count_left on the run
        with get_cursor() as (cur, _conn):
            cur.execute(
                f"SELECT COUNT(*) AS cnt FROM {schema_name}.records WHERE side = 'left'"
            )
            cnt = (cur.fetchone() or {}).get("cnt", 0)
            cur.execute(
                "UPDATE public.compare_runs SET row_count_left = %s, completed_at = NOW() WHERE id = %s",
                [cnt, run_id],
            )

        _set_run_status("ready", json.dumps({"message": "Run complete.", "metrics": metrics}))
        yield {"type": "complete", "message": "Run complete. Ready for review."}
        logger.info("run_pipeline() done job_id=%d run_id=%d", job_id, run_id)

    except Exception as e:
        logger.exception("run_pipeline() FAILED job_id=%d run_id=%d", job_id, run_id)
        _set_run_status("error", str(e))
        yield {"type": "error", "message": str(e)}

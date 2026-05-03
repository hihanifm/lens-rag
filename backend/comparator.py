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
import re
import time
from collections import defaultdict
from typing import Generator

from openai import OpenAI
from psycopg2.extras import Json

from config import (
    COMPARE_PIPELINE_MAX_LEFT_ROWS_CAP,
    EMBEDDING_DIMS,
    LLM_COMPARE_MAX_RIGHTS_CAP,
    LLM_COMPARE_MAX_RIGHTS_DEFAULT,
    LLM_JUDGE_COMPLETION_MAX,
    LLM_JUDGE_MAX_REQUESTS_PER_MINUTE,
    LLM_JUDGE_MAX_TOKENS,
    RERANKER_ENABLED,
)
from db import get_cursor, create_compare_schema
from embedder import embed, rerank
from ingestion import apply_compare_row_filters, build_contextual_content, read_compare_dataframe

logger = logging.getLogger("lens.comparator")


def _openai_completion_http_status(resp) -> int | None:
    """Best-effort HTTP status from OpenAI SDK chat completion (shape varies by SDK version)."""
    for attr in ("response", "_response", "raw_response"):
        r = getattr(resp, attr, None)
        if r is not None:
            sc = getattr(r, "status_code", None)
            if isinstance(sc, int):
                return sc
    return None


def _openai_error_http_status(exc: BaseException) -> int | None:
    sc = getattr(exc, "status_code", None)
    return sc if isinstance(sc, int) else None


def _one_line_preview(text: str, max_len: int = 320) -> str:
    s = (text or "").replace("\n", " ").replace("\r", " ").strip()
    if len(s) <= max_len:
        return s
    return s[: max_len - 1] + "…"


def _format_int_list_summary(xs: list[int], *, max_show: int = 32) -> str:
    """Compact list of ints for logs when pairing many candidates."""
    if not xs:
        return "[]"
    if len(xs) <= max_show:
        return str(xs)
    return (
        f"n={len(xs)} min={min(xs)} max={max(xs)} sum={sum(xs)} "
        f"first5={xs[:5]} … last5={xs[-5]}"
    )


# Excerpt length for DEBUG logs (full payload may be huge; httpx DEBUG also truncates).
LLM_JUDGE_LOG_EXCERPT_CHARS = 720


def _log_llm_judge_outbound_payload(
    *,
    left_id: int,
    batch_num: int,
    total_batches: int,
    model: str,
    max_completion_tokens: int,
    system_prompt: str,
    user_content: str,
    reference_text: str,
    candidate_body_chars: list[int],
) -> None:
    """
    Logs exact string sizes we pass to chat.completions.create (nothing stripped by LENS).
    OpenAI/httpx DEBUGRequest logs often truncate the JSON body — use this to verify.
    """
    sm = len(system_prompt)
    um = len(user_content)
    ref = len(reference_text)
    sm_b = len(system_prompt.encode("utf-8"))
    um_b = len(user_content.encode("utf-8"))
    logger.info(
        "LLM judge → POST /v1/chat/completions INPUT (built by LENS, not truncated before send):\n"
        "  left_id=%s  batch %s/%s  model=%s  max_completion_tokens=%s\n"
        "  system message: %s chars, %s UTF-8 bytes\n"
        "  user message:   %s chars, %s UTF-8 bytes\n"
        "  reference-only text length: %s chars (left contextual_content)\n"
        "  candidates: %s  right-side body lengths (chars each): %s\n"
        "  Note: SDK/httpx DEBUG may clip the printed JSON; sizes above are the real strings.",
        left_id,
        batch_num,
        total_batches,
        model,
        max_completion_tokens,
        sm,
        sm_b,
        um,
        um_b,
        ref,
        len(candidate_body_chars),
        _format_int_list_summary(candidate_body_chars),
    )
    if not logger.isEnabledFor(logging.DEBUG):
        return
    ex = LLM_JUDGE_LOG_EXCERPT_CHARS
    logger.debug(
        "LLM judge SYSTEM (first %d of %d chars):\n%s",
        ex,
        sm,
        system_prompt[:ex],
    )
    if sm > ex:
        logger.debug("LLM judge SYSTEM (last %d chars):\n%s", ex, system_prompt[-ex:])
    logger.debug(
        "LLM judge USER (first %d of %d chars):\n%s",
        ex,
        um,
        user_content[:ex],
    )
    if um > ex:
        logger.debug("LLM judge USER (last %d chars):\n%s", ex, user_content[-ex:])


def _log_llm_judge_inbound_response(
    *,
    left_id: int,
    batch_num: int,
    total_batches: int,
    text: str,
    finish_reason: str | None,
) -> None:
    """
    Log assistant message content after SDK parse. HTTP responses may use chunked encoding;
    httpx/OpenAI client reads the full body before returning — chunk framing is not exposed here.
    """
    n = len(text or "")
    nb = len((text or "").encode("utf-8"))
    logger.info(
        "LLM judge ← assistant response body (reassembled by HTTP client; chunked transport if "
        "present does not affect this string): left_id=%s batch %s/%s finish_reason=%s "
        "%s chars %s UTF-8 bytes",
        left_id,
        batch_num,
        total_batches,
        finish_reason,
        n,
        nb,
    )
    if not logger.isEnabledFor(logging.DEBUG):
        return
    ex = LLM_JUDGE_LOG_EXCERPT_CHARS
    if n == 0:
        logger.debug("LLM judge assistant content: (empty)")
        return
    if n <= ex:
        logger.debug("LLM judge assistant content (full %d chars):\n%s", n, text)
        return
    logger.debug(
        "LLM judge assistant content (first %d of %d chars):\n%s\n…[truncated for DEBUG log]",
        ex,
        n,
        text[:ex],
    )


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
    max_left_rows: int | None = None,
) -> Generator[dict, None, None]:
    """
    For each left record, find the top_k closest right records by cosine similarity.
    Appends (left_id, right_id, cosine_score) tuples to candidates_out.
    Yields SSE dicts with type vector_search and processed/total/percent.

    max_left_rows: if set, only the first N left rows (by id order) are processed — for quick pipeline tests.
    """
    logger.info(
        "iter_vector_search() schema=%s top_k=%d max_left_rows=%s",
        schema_name,
        top_k,
        max_left_rows,
    )
    t0 = time.monotonic()

    with get_cursor() as (cur, _conn):
        cur.execute(
            f"SELECT id, embedding FROM {schema_name}.records WHERE side = 'left' ORDER BY id"
        )
        left_rows = cur.fetchall()

    total_left_in_db = len(left_rows)
    limited_from_total = False
    if max_left_rows is not None:
        cap = max(
            1,
            min(int(max_left_rows), COMPARE_PIPELINE_MAX_LEFT_ROWS_CAP, total_left_in_db),
        )
        if cap < total_left_in_db:
            limited_from_total = True
        left_rows = left_rows[:cap]

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

    msg = f"Vector search — {n} left row(s)"
    if limited_from_total:
        msg += f" (limited from {total_left_in_db} total)"
    yield {
        "type": "vector_search",
        "processed": 0,
        "total": n,
        "percent": 0,
        "message": msg,
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


def run_bidirectional_search(
    schema_name: str,
    top_k: int,
    max_left_rows: int | None = None,
) -> list[tuple[int, int, float]]:
    """Non-streaming wrapper (tests / callers that do not need SSE)."""
    out: list[tuple[int, int, float]] = []
    for _ in iter_vector_search(schema_name, top_k, out, max_left_rows=max_left_rows):
        pass
    return out


def iter_cartesian_candidates(
    schema_name: str,
    max_rights: int,
    candidates_out: list[tuple[int, int, float]],
    stats_out: dict | None = None,
    max_left_rows: int | None = None,
) -> Generator[dict, None, None]:
    """
    For each left row, pair with up to max_rights right rows (by id order). Cosine placeholder 0.0.
    Used when vector retrieval is off and LLM scores all pairs in one call per left.

    max_left_rows: if set, only the first N left rows (by id order) are paired — for quick pipeline tests.
    """
    max_rights = max(1, min(int(max_rights), LLM_COMPARE_MAX_RIGHTS_CAP))

    with get_cursor() as (cur, _conn):
        cur.execute(f"SELECT id FROM {schema_name}.records WHERE side = 'left' ORDER BY id")
        left_rows = cur.fetchall()
        cur.execute(f"SELECT COUNT(*) AS c FROM {schema_name}.records WHERE side = 'right'")
        total_right = int((cur.fetchone() or {}).get("c") or 0)
        cur.execute(
            f"""
            SELECT id FROM {schema_name}.records
            WHERE side = 'right'
            ORDER BY id
            LIMIT %s
            """,
            [max_rights],
        )
        right_rows = cur.fetchall()

    total_left_in_db = len(left_rows)
    limited_from_total = False
    if max_left_rows is not None:
        cap = max(
            1,
            min(int(max_left_rows), COMPARE_PIPELINE_MAX_LEFT_ROWS_CAP, total_left_in_db),
        )
        if cap < total_left_in_db:
            limited_from_total = True
        left_rows = left_rows[:cap]

    right_ids = [r["id"] for r in right_rows]
    truncated = total_right > len(right_ids)
    if stats_out is not None:
        stats_out["llm_compare_rights_loaded"] = len(right_ids)
        stats_out["llm_compare_rights_total"] = total_right
        stats_out["llm_compare_truncated_rights"] = truncated

    n_left = len(left_rows)
    if n_left == 0 or len(right_ids) == 0:
        yield {
            "type": "vector_search",
            "processed": 0,
            "total": 0,
            "percent": 100,
            "message": "No left or right rows for LLM compare"
            + (" (truncated right pool)" if truncated else ""),
        }
        logger.info(
            "iter_cartesian_candidates() empty left=%d right_loaded=%d",
            n_left,
            len(right_ids),
        )
        return

    msg = (
        f"LLM compare — {n_left} left × {len(right_ids)} right"
        + (f" (showing first {len(right_ids)} of {total_right} right rows)" if truncated else "")
    )
    if limited_from_total:
        msg += f" — left rows limited from {total_left_in_db} total"
    yield {
        "type": "vector_search",
        "processed": 0,
        "total": n_left,
        "percent": 0,
        "message": msg,
    }

    for i, left_row in enumerate(left_rows):
        left_id = left_row["id"]
        for rid in right_ids:
            candidates_out.append((left_id, rid, 0.0))

        pct = round(100 * (i + 1) / n_left)
        yield {
            "type": "vector_search",
            "processed": i + 1,
            "total": n_left,
            "percent": pct,
            "message": f"Left row {i + 1} / {n_left} (db id {left_id}) — {len(right_ids)} pair(s)",
            "left_id": left_id,
        }

    logger.info(
        "iter_cartesian_candidates() left_rows=%d right_loaded=%d candidates=%d truncated=%s",
        n_left,
        len(right_ids),
        len(candidates_out),
        truncated,
    )


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


def _final_score_for_ranking(cosine, rerank_score, llm_score) -> float:
    """Ranking key for matches row; when LLM did not produce a score (NULL), use rerank then cosine."""
    if llm_score is not None:
        return float(llm_score)
    if rerank_score is not None:
        return float(rerank_score)
    return float(cosine or 0.0)


# ── Write matches ──────────────────────────────────────────────────────────

def write_matches(
    schema_name: str,
    table_name: str,
    scored_tuples: list,
    top_k: int,
) -> int:
    """
    Per left_id: sort by final_score desc, take top_k, insert into {schema_name}.{table_name}.
    scored_tuples: (left_id, right_id, cosine_score, rerank_score, llm_score, llm_judge_meta, final_score)

    For LLM Cartesian runs (many candidates per left), raise top_k on the run to persist more rows;
    it caps how many ranked pairs are stored after scoring.
    """
    groups: dict[int, list] = defaultdict(list)
    for row in scored_tuples:
        left_id = row[0]
        groups[left_id].append(row)

    rows_to_insert = []
    for left_id, pairs in groups.items():
        sorted_pairs = sorted(pairs, key=lambda x: x[6], reverse=True)[:top_k]
        for rank, (lid, right_id, cosine, rerank_score, llm_score, llm_meta, final_score) in enumerate(
            sorted_pairs, start=1
        ):
            meta_sql = Json(llm_meta) if llm_meta else None
            rows_to_insert.append(
                (lid, right_id, cosine, rerank_score, llm_score, meta_sql, final_score, rank)
            )

    n_insert = len(rows_to_insert)
    logger.info("write_matches() table=%s.%s inserting %d rows", schema_name, table_name, n_insert)
    with get_cursor() as (cur, _conn):
        cur.executemany(
            f"""
            INSERT INTO {schema_name}.{table_name}
                (left_id, right_id, cosine_score, rerank_score, llm_score, llm_judge_meta, final_score, rank)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """,
            rows_to_insert,
        )
    return n_insert


# ── LLM Judge ─────────────────────────────────────────────────────────────
# Empty `llm_judge_prompt` → DEFAULT_LLM_JUDGE_PROMPT (intro + default domain + JSON tail).
# Non-empty → that text is the full system message (no server prefix/suffix; _parse_llm_judge_batch).

LLM_JUDGE_PROMPT_PREFIX = """You compare test specifications from two sources (e.g. different clients or baselines).

Domain context (critical):
"""

LLM_JUDGE_PROMPT_DEFAULT_DOMAIN = """- These tests concern telecom protocol behavior as implemented on Android devices.
- Content typically reflects 3GPP-family specifications and related industry specs — including legacy cellular (e.g. GSM/UMTS context where relevant), LTE (4G), and 5G NR (New Radio), plus associated procedures, timers, RRC/NAS/AS behaviors, bearers, registrations, handovers, measurements, and conformance-style scenarios as described in the text."""

LLM_JUDGE_PROMPT_SUFFIX = """Input format (fixed by the tool):
- "Reference" is ONE left-side test case (merged text).
- "Candidate 1", "Candidate 2", … are top-ranked right-side rows for the SAME reference (same order as retrieval).

Your job:
- Score EACH candidate against the reference independently for human review — not final truth.
- Use telecom domain knowledge only to judge intent and coverage (procedures, layers, signals, parameters named in the text). Do not hallucinate spec clauses not supported by the given text.
- Matching is often imperfect; reviewers may merge or split rows later.
- Do not force an exact match: wording, structure, or formatting differences must not dominate the score when the candidate still helps a reviewer relate equivalent or partially overlapping telecom test cases.
- Treat scores as a usefulness ranking for that reviewer — how helpful each candidate is for mapping decisions across sides (including partial overlap); relative ordering among candidates matters more than a binary same-vs-different verdict.

Per-candidate scores (each 0.0–1.0), aligned with candidate index order:
- 0.90–1.00 = Strong match: same intent, scope, and main checks; wording/format differences are OK.
- 0.75–0.89 = Good / reasonable match: clearly the same area with minor gaps, extra/missing steps, or different structure.
- 0.55–0.74 = Partial / weak: overlapping topic but important differences.
- 0.25–0.54 = Mostly different with small overlap.
- 0.00–0.24 = Unrelated or wrong candidate.

Use the full merged text; do not invent IDs or missing steps. Prefer lower scores when unsure.

Reply with ONLY valid JSON: {"scores": [<float>, ...]} — same length as the number of candidates, in order (scores[0] = Candidate 1). If there is exactly one candidate, {"score": <float>} is also accepted."""

DEFAULT_LLM_JUDGE_PROMPT = (
    LLM_JUDGE_PROMPT_PREFIX + LLM_JUDGE_PROMPT_DEFAULT_DOMAIN + "\n\n" + LLM_JUDGE_PROMPT_SUFFIX
)


def effective_llm_judge_system_prompt(domain_overlay: str | None) -> str:
    """
    Build the LLM judge system message from `compare_runs.llm_judge_prompt`.
    Empty or whitespace → built-in default (includes LLM_JUDGE_PROMPT_SUFFIX / scores contract).
    Non-empty → return that string only (full user-controlled system prompt).
    """
    t = (domain_overlay or "").strip()
    if not t:
        return DEFAULT_LLM_JUDGE_PROMPT
    return t

# OpenAI-compatible chat params for LLM judge (surfaced in run metrics JSON).
# LLM_JUDGE_MAX_TOKENS — see config.py (env floor for completion budget).
LLM_JUDGE_TEMPERATURE = 0.0
# Cap string values in llm_judge_meta (reason etc.) when persisting JSONB.
LLM_JUDGE_META_VALUE_STR_CAP = 2000


def llm_judge_completion_max_tokens(num_candidates: int) -> int:
    """Ensure JSON scores array fits when scoring many candidates per request."""
    n = max(1, int(num_candidates))
    est = 258 + n * 128
    return min(LLM_JUDGE_COMPLETION_MAX, max(LLM_JUDGE_MAX_TOKENS, est))


def _llm_judge_message_parse_text(message) -> str:
    """Prefer content; reasoning models may put JSON in reasoning with empty content."""
    c = (getattr(message, "content", None) or "").strip()
    if c:
        return c
    r = getattr(message, "reasoning", None)
    if isinstance(r, str) and r.strip():
        return r.strip()
    try:
        d = message.model_dump() if hasattr(message, "model_dump") else None
    except Exception:
        d = None
    if isinstance(d, dict):
        for key in ("content", "reasoning", "text"):
            v = d.get(key)
            if isinstance(v, str) and v.strip():
                return v.strip()
    return ""


def _strip_json_fence(text: str) -> str:
    raw = (text or "").strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.IGNORECASE)
        raw = re.sub(r"\s*```\s*$", "", raw)
    return raw.strip()


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, float(x)))


def _meta_from_extra_keys(obj: dict) -> dict | None:
    """Extra keys from an object-shaped slot (excluding score). Primitives only."""
    out: dict = {}
    for k, v in obj.items():
        if k == "score":
            continue
        if isinstance(v, str):
            s = v
            if len(s) > LLM_JUDGE_META_VALUE_STR_CAP:
                s = s[: LLM_JUDGE_META_VALUE_STR_CAP] + "…"
            out[str(k)] = s
        elif isinstance(v, (int, float, bool)) or v is None:
            out[str(k)] = v
    return out if out else None


def _parse_llm_judge_slot(el) -> tuple[float | None, dict | None]:
    """One candidate slot: float, or dict with numeric score plus optional metadata."""
    if el is None:
        return None, None
    if isinstance(el, bool):
        return None, None
    if isinstance(el, (int, float)):
        try:
            return _clamp01(float(el)), None
        except (TypeError, ValueError):
            return None, None
    if isinstance(el, dict):
        raw_sc = el.get("score")
        if not isinstance(raw_sc, (int, float)):
            return None, None
        try:
            sc = _clamp01(float(raw_sc))
        except (TypeError, ValueError):
            return None, None
        meta = _meta_from_extra_keys(el)
        return sc, meta
    return None, None


def _parse_llm_judge_batch(text: str, n: int) -> tuple[list[float | None], list[dict | None]]:
    """
    Parse judge JSON into per-candidate scores and optional metadata dicts.

    Accepts:
    - {"scores": [float | object, ...]} (legacy floats or objects with score + extras)
    - [ {...}, ... ] root array of length n (e.g. score + reason per candidate)
    - {"score": float, ...} when n==1

    Returns parallel lists; unparsed slots are (None, None).
    """
    if n <= 0:
        return [], []

    try:
        raw = _strip_json_fence(text)
        data = json.loads(raw)

        if isinstance(data, list):
            if len(data) != n:
                raw_full = text or ""
                logger.warning(
                    "LLM judge JSON root array length %d != n=%d | stripped_prefix=%r | raw_len=%d",
                    len(data),
                    n,
                    raw[:400],
                    len(raw_full),
                )
                return [None] * n, [None] * n
            scores: list[float | None] = []
            metas: list[dict | None] = []
            for el in data:
                s, m = _parse_llm_judge_slot(el)
                scores.append(s)
                metas.append(m)
            return scores, metas

        if isinstance(data, dict):
            if n == 1 and "scores" not in data and isinstance(data.get("score"), (int, float)):
                try:
                    v = _clamp01(float(data["score"]))
                except (TypeError, ValueError):
                    return [None], [None]
                meta = _meta_from_extra_keys(data)
                return [v], [meta]

            arr = data.get("scores")
            if not isinstance(arr, list):
                raw_full = text or ""
                logger.warning(
                    'LLM judge JSON missing "scores" array (n=%d) | stripped_prefix=%r | raw_len=%d | raw_repr=%s',
                    n,
                    raw[:400],
                    len(raw_full),
                    repr(raw_full[:4000]) + ("…(truncated)" if len(raw_full) > 4000 else ""),
                )
                return [None] * n, [None] * n

            out_s: list[float | None] = []
            out_m: list[dict | None] = []
            for i in range(n):
                if i < len(arr):
                    s, m = _parse_llm_judge_slot(arr[i])
                    out_s.append(s)
                    out_m.append(m)
                else:
                    out_s.append(None)
                    out_m.append(None)
            return out_s, out_m

        return [None] * n, [None] * n
    except Exception as ex:
        try:
            rp = _strip_json_fence(text)[:400]
        except Exception:
            rp = (text or "")[:400]
        raw_full = text or ""
        logger.warning(
            "LLM judge JSON parse failed (expect scores length %d): %s | stripped_prefix=%r | raw_len=%d | raw_repr=%s",
            n,
            ex,
            rp,
            len(raw_full),
            repr(raw_full[:4000]) + ("…(truncated)" if len(raw_full) > 4000 else ""),
        )
        return [None] * n, [None] * n


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
    Score (left_id, right_id, cosine, rerank_score) tuples using an LLM judge.
    One chat completion per left row: reference text + all candidate rights for that row.
    Appends (left_id, right_id, cosine, rerank_score, llm_score, llm_judge_meta) per pair to results_out.
    llm_score may be None when the judge response is missing or not parseable (stored as NULL).
    llm_judge_meta is optional dict (e.g. reason) from extended JSON; None when absent.

    max_requests_per_minute: > 0 enforces minimum spacing between chat call starts.

    prompt: compare_runs.llm_judge_prompt; empty → built-in default, non-empty → full system prompt.
    """
    system_prompt = effective_llm_judge_system_prompt(prompt)
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

    total_pairs = len(candidates)
    if total_pairs == 0:
        yield {
            "type": "llm_judge",
            "processed": 0,
            "total": 0,
            "percent": 100,
            "message": "No pairs to judge",
        }
        return

    groups: dict[int, list[tuple]] = defaultdict(list)
    left_order: list[int] = []
    seen_left: set[int] = set()
    for tup in candidates:
        lid = tup[0]
        groups[lid].append(tup)
        if lid not in seen_left:
            seen_left.add(lid)
            left_order.append(lid)

    total_batches = len(left_order)
    rpm = max(0, int(max_requests_per_minute or 0))
    throttle_note = f", max {rpm}/min" if rpm > 0 else ""
    yield {
        "type": "llm_judge",
        "processed": 0,
        "total": total_batches,
        "percent": 0,
        "message": f"LLM judge — {total_batches} left row(s), {total_pairs} candidate pair(s){throttle_note}",
    }

    last_call_start: float | None = None
    min_gap_s = (60.0 / float(rpm)) if rpm > 0 else 0.0
    pairs_done = 0

    for bi, left_id in enumerate(left_order):
        pairs = groups[left_id]
        if min_gap_s > 0 and last_call_start is not None:
            elapsed = time.monotonic() - last_call_start
            if elapsed < min_gap_s:
                time.sleep(min_gap_s - elapsed)
        last_call_start = time.monotonic()

        query_text = content_map.get(left_id, "")
        doc_blocks = []
        for i, (_l, right_id, cosine, rerank_score) in enumerate(pairs, start=1):
            doc_blocks.append(f"--- Candidate {i} ---\n{content_map.get(right_id, '')}")

        user_content = f"Reference:\n{query_text}\n\n" + "\n\n".join(doc_blocks)

        candidate_body_chars = [len(content_map.get(right_id, "")) for _, right_id, _, _ in pairs]
        max_completion_tokens = llm_judge_completion_max_tokens(len(pairs))
        _log_llm_judge_outbound_payload(
            left_id=left_id,
            batch_num=bi + 1,
            total_batches=total_batches,
            model=model,
            max_completion_tokens=max_completion_tokens,
            system_prompt=system_prompt,
            user_content=user_content,
            reference_text=query_text,
            candidate_body_chars=candidate_body_chars,
        )

        text = ""
        detail: dict = {
            "phase": "llm_judge",
            "api_base": _one_line_preview(url, 200),
            "model": model,
            "left_id": left_id,
            "candidates_in_batch": len(pairs),
        }
        try:
            resp = client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_content},
                ],
                max_tokens=max_completion_tokens,
                temperature=LLM_JUDGE_TEMPERATURE,
            )
            detail["http_status"] = _openai_completion_http_status(resp)
            choice0 = resp.choices[0]
            fr = getattr(choice0, "finish_reason", None)
            text = _llm_judge_message_parse_text(choice0.message)
            if fr == "length":
                logger.warning(
                    "LLM judge completion truncated (finish_reason=length) left_id=%d "
                    "max_completion_tokens=%d model=%r — raise LLM_JUDGE_MAX_TOKENS if JSON scores were cut off",
                    left_id,
                    max_completion_tokens,
                    model,
                )
            _log_llm_judge_inbound_response(
                left_id=left_id,
                batch_num=bi + 1,
                total_batches=total_batches,
                text=text,
                finish_reason=fr,
            )
            if not text:
                msg_dump = None
                try:
                    msg_dump = choice0.message.model_dump() if hasattr(choice0.message, "model_dump") else None
                except Exception:
                    msg_dump = {"repr": repr(choice0.message)}
                logger.warning(
                    "LLM judge empty assistant content left_id=%d finish_reason=%s message_dump=%s",
                    left_id,
                    fr,
                    json.dumps(msg_dump, default=str)[:2500] if msg_dump is not None else "—",
                )
            llm_scores, llm_metas = _parse_llm_judge_batch(text, len(pairs))
            detail["response_chars"] = len(text)
            detail["response_preview"] = _one_line_preview(text, 360)
            n_ok = sum(1 for x in llm_scores if x is not None)
            detail["scores_parsed"] = n_ok
            detail["scores_total"] = len(llm_scores)
            if n_ok < len(llm_scores):
                detail["note"] = "Some scores missing — JSON incomplete or invalid for those slots (stored as null)."
        except Exception as e:
            detail["http_status"] = detail.get("http_status") or _openai_error_http_status(e)
            detail["error"] = f"{type(e).__name__}: {e}"[:500]
            if text:
                detail["response_preview"] = _one_line_preview(text, 360)
                detail["response_chars"] = len(text)
            logger.warning(
                "iter_run_llm_judge() batch failed left_id=%d candidates=%d — %s | response_prefix=%r",
                left_id,
                len(pairs),
                e,
                (text or "")[:400],
            )
            llm_scores = [None] * len(pairs)
            llm_metas = [None] * len(pairs)
            detail["scores_parsed"] = 0
            detail["scores_total"] = len(pairs)

        for tup, llm_score, llm_meta in zip(pairs, llm_scores, llm_metas):
            left_i, right_id, cosine, rerank_score = tup
            results_out.append((left_i, right_id, cosine, rerank_score, llm_score, llm_meta))

        pairs_done += len(pairs)
        pct = round(100 * (bi + 1) / total_batches) if total_batches else 100
        yield {
            "type": "llm_judge",
            "processed": bi + 1,
            "total": total_batches,
            "percent": pct,
            "message": (
                f"Left {bi + 1} / {total_batches} (id {left_id}, {len(pairs)} candidate(s)) "
                f"— pairs scored {pairs_done} / {total_pairs}"
            ),
            "left_id": left_id,
            "detail": detail,
        }

    logger.info("iter_run_llm_judge() done pairs=%d batches=%d", len(results_out), total_batches)


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

def run_pipeline(
    job_id: int,
    run_id: int,
    *,
    max_left_rows: int | None = None,
) -> Generator[dict, None, None]:
    """
    Phase 2: vector search + optional rerank + optional LLM judge → write per-run matches.
    Reads run config from public.compare_runs.
    Yields SSE-style progress dicts.

    max_left_rows: optional cap on how many left rows to process (by id order); unset = all rows.
    """
    logger.info(
        "run_pipeline() start job_id=%d run_id=%d max_left_rows=%s",
        job_id,
        run_id,
        max_left_rows,
    )

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

        # ── Candidate generation: vector top-K vs Cartesian LLM compare ───
        _set_run_status("running")

        use_vector = bool(run.get("vector_enabled", True))
        candidates: list[tuple[int, int, float]] = []
        cartesian_stats: dict = {}

        max_left_cap: int | None = None
        if max_left_rows is not None:
            try:
                ml = int(max_left_rows)
                if ml >= 1:
                    max_left_cap = min(ml, COMPARE_PIPELINE_MAX_LEFT_ROWS_CAP)
            except (TypeError, ValueError):
                max_left_cap = None

        if use_vector:
            t_vec0 = time.monotonic()
            for prog in iter_vector_search(
                schema_name,
                top_k,
                candidates,
                max_left_rows=max_left_cap,
            ):
                yield prog
            metrics["vector_search_ms"] = int((time.monotonic() - t_vec0) * 1000)
            metrics["pipeline_mode"] = "vector_top_k"
        else:
            if not run["llm_judge_enabled"]:
                yield {
                    "type": "error",
                    "message": "Vector retrieval is off — enable LLM judge and set URL + model.",
                }
                _set_run_status("error", "LLM judge required when vector retrieval is off")
                return
            url_chk = (run.get("llm_judge_url") or "").strip()
            model_chk = (run.get("llm_judge_model") or "").strip()
            if not url_chk or not model_chk:
                yield {
                    "type": "error",
                    "message": "LLM judge URL and model are required when vector retrieval is off.",
                }
                _set_run_status("error", "LLM judge url or model missing")
                return

            raw_cap = run.get("llm_compare_max_rights")
            max_rights = int(raw_cap) if raw_cap is not None else LLM_COMPARE_MAX_RIGHTS_DEFAULT
            max_rights = max(1, min(max_rights, LLM_COMPARE_MAX_RIGHTS_CAP))

            t_vec0 = time.monotonic()
            for prog in iter_cartesian_candidates(
                schema_name,
                max_rights,
                candidates,
                cartesian_stats,
                max_left_rows=max_left_cap,
            ):
                yield prog
            metrics["vector_search_ms"] = int((time.monotonic() - t_vec0) * 1000)
            metrics["pipeline_mode"] = "llm_compare_cartesian"
            metrics.update(cartesian_stats)

        metrics["candidate_pairs"] = len(candidates)
        metrics["vector_left_rows"] = len({left_id for left_id, _, _ in candidates})
        if max_left_cap is not None:
            metrics["pipeline_max_left_rows"] = max_left_cap
        with get_cursor() as (cur, _conn):
            cur.execute(f"SELECT COUNT(*) AS c FROM {schema_name}.records WHERE side = 'left'")
            metrics["pipeline_left_rows_in_job"] = int((cur.fetchone() or {}).get("c") or 0)

        # ── Reranker (only when embedding retrieval produced cosine scores) ─
        pairs_with_rerank: list[tuple[int, int, float, float]] = []
        if use_vector and run["reranker_enabled"]:
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
            metrics["llm_judge_requests"] = len({p[0] for p in pairs_with_rerank})
            grp_sz = defaultdict(int)
            for p in pairs_with_rerank:
                grp_sz[p[0]] += 1
            max_grp = max(grp_sz.values()) if grp_sz else 1
            metrics["llm_judge_max_tokens"] = llm_judge_completion_max_tokens(max_grp)
            metrics["llm_judge_temperature"] = LLM_JUDGE_TEMPERATURE
            metrics["llm_judge_max_requests_per_minute"] = rpm_eff
            metrics["llm_judge_unparsed_pairs"] = sum(1 for t in judged if t[4] is None)
            scored_tuples = [
                (l, r, c, rs, ls, lm, _final_score_for_ranking(c, rs, ls))
                for l, r, c, rs, ls, lm in judged
            ]
        else:
            if not use_vector:
                yield {"type": "error", "message": "LLM judge must be enabled when vector retrieval is off."}
                _set_run_status("error", "LLM judge required for LLM-only compare")
                return
            scored_tuples = [
                (l, r, c, rs, None, None, float(rs) if rs is not None else float(c))
                for l, r, c, rs in pairs_with_rerank
            ]

        # ── Write matches ─────────────────────────────────────────────────
        t0 = time.monotonic()
        metrics["matches_inserted"] = write_matches(schema_name, table_name, scored_tuples, top_k)
        metrics["write_matches_ms"] = int((time.monotonic() - t0) * 1000)
        metrics["total_ms"]         = int((time.monotonic() - t_total0) * 1000)

        lr = metrics.get("llm_judge_requests")
        lp = metrics.get("llm_judge_pairs")
        lm = metrics.get("llm_judge_ms")
        if lm is not None:
            if lr and lr > 0:
                metrics["llm_judge_avg_ms_per_request"] = round(lm / lr, 2)
            if lp and lp > 0:
                metrics["llm_judge_avg_ms_per_pair"] = round(lm / lp, 2)

        metrics["embedding_job"] = {
            "embed_dims": job.get("embed_dims"),
            "embed_model": job.get("embed_model"),
            "embed_url": job.get("embed_url"),
        }

        # Distinct left rows that received matches this run (equals processed left rows).
        processed_left = metrics.get("vector_left_rows") or 0
        with get_cursor() as (cur, _conn):
            cur.execute(
                "UPDATE public.compare_runs SET row_count_left = %s, completed_at = NOW() WHERE id = %s",
                [processed_left, run_id],
            )

        _set_run_status("ready", json.dumps({"message": "Run complete.", "metrics": metrics}))
        yield {"type": "complete", "message": "Run complete. Ready for review."}
        logger.info("run_pipeline() done job_id=%d run_id=%d", job_id, run_id)

    except Exception as e:
        logger.exception("run_pipeline() FAILED job_id=%d run_id=%d", job_id, run_id)
        _set_run_status("error", str(e))
        yield {"type": "error", "message": str(e)}

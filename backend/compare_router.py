"""
compare_router.py — FastAPI routes for the Compare project flavor.

Routes:
  POST /compare/preview-left          upload left file → columns + tmp_path
  POST /compare/preview-right         upload right file → columns + tmp_path
  POST /compare/                      create job
  GET  /compare/                      list jobs
  GET  /compare/{job_id}              job detail
  GET  /compare/{job_id}/ingest       SSE: run full compare pipeline
  GET  /compare/{job_id}/review       stats {total_left, reviewed, pending}
  GET  /compare/{job_id}/review/next  next ReviewItem
  POST /compare/{job_id}/review/{left_id}  submit decision
  GET  /compare/{job_id}/export       Excel download
  DELETE /compare/{job_id}            drop job + schema
"""
import io
import json
import logging
import os
import tempfile
import threading
import time

import pandas as pd
from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import Response, StreamingResponse

from comparator import run_compare_job
from config import EMBEDDING_DIMS
from db import create_compare_schema, drop_compare_schema, get_cursor
from embedder import embed as _embed_probe
from ingestion import read_excel, build_contextual_content
from models import (
    CandidateItem,
    CompareDecision,
    CompareJobCreate,
    CompareJobResponse,
    CompareJobUpdate,
    CompareContextPreviewRequest,
    CompareContextPreviewResponse,
    ReviewItem,
)

logger = logging.getLogger("lens.compare_router")
router = APIRouter()

# Progress dict: keyed by job_id, same pattern as _ingest_progress in main.py
_compare_progress: dict[int, dict] = {}


# ── Helpers ────────────────────────────────────────────────────────────────

def _get_job_raw(job_id: int) -> dict | None:
    with get_cursor() as (cur, _conn):
        cur.execute("SELECT * FROM public.compare_jobs WHERE id = %s", [job_id])
        row = cur.fetchone()
    return dict(row) if row else None


def _job_or_404(job_id: int) -> dict:
    job = _get_job_raw(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Compare job not found")
    return job


# ── File preview ──────────────────────────────────────────────────────────

async def _preview_file(file: UploadFile) -> dict:
    if not file.filename.endswith((".xlsx", ".xls")):
        raise HTTPException(status_code=400, detail="Only Excel files accepted")
    with tempfile.NamedTemporaryFile(delete=False, suffix=".xlsx") as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name
    try:
        df, columns, sheet_names = read_excel(tmp_path)
        return {
            "columns": columns,
            "sheet_names": sheet_names,
            "row_count": len(df),
            "tmp_path": tmp_path,
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/preview-left")
async def preview_left(file: UploadFile = File(...)):
    return await _preview_file(file)


@router.post("/preview-right")
async def preview_right(file: UploadFile = File(...)):
    return await _preview_file(file)


@router.post("/preview-context", response_model=CompareContextPreviewResponse)
def preview_context(body: CompareContextPreviewRequest):
    """
    Return a few example merged context strings for the selected match columns.
    Mirrors how Compare builds `contextual_content` (sheet_name + context cols + content col).
    """
    tmp_path = (body.tmp_path or "").strip()
    if not tmp_path or not os.path.exists(tmp_path):
        raise HTTPException(status_code=400, detail="Uploaded file not found. Please re-upload.")

    match_columns = [str(c).strip() for c in (body.match_columns or []) if str(c).strip()]
    if not match_columns:
        raise HTTPException(status_code=422, detail="match_columns must include at least one column")

    def _pick_content(cols: list[str]) -> str:
        lower = lambda s: str(s or "").lower()
        for pat in ["description", "details", "notes", "summary", "text", "content", "specs", "name", "title"]:
            for c in cols:
                lc = lower(c)
                if lc == pat or pat in lc:
                    return c
        return cols[0]

    content_col = _pick_content(match_columns)
    context_cols = [c for c in match_columns if c != content_col]

    df, _columns, _sheets = read_excel(tmp_path)
    records = df.to_dict(orient="records")

    samples: list[str] = []
    n = max(1, min(int(body.n or 3), 5))
    for row in records:
        sheet_name = str(row.get("sheet_name", ""))
        text = build_contextual_content(row, context_cols, content_col, sheet_name)
        if text and str(text).strip():
            samples.append(str(text))
        if len(samples) >= n:
            break

    return CompareContextPreviewResponse(
        content_column=content_col,
        context_columns=context_cols,
        samples=samples,
    )


# ── Job CRUD ──────────────────────────────────────────────────────────────

@router.post("/", response_model=CompareJobResponse)
async def create_compare_job(data: CompareJobCreate):
    # Validate tmp files still exist
    for path, label in [(data.tmp_path_left, "left"), (data.tmp_path_right, "right")]:
        if not os.path.exists(path):
            raise HTTPException(
                status_code=400,
                detail=f"Upload file for {label} not found. Please re-upload.",
            )

    # Probe embedding dims if a custom endpoint is provided.
    # Must happen before create_compare_schema() which bakes the vector size.
    resolved_dims = EMBEDDING_DIMS
    if data.embed_url:
        try:
            probe_vec = _embed_probe(
                "probe",
                base_url=data.embed_url,
                api_key=data.embed_api_key or None,
                model=data.embed_model or None,
            )
            resolved_dims = len(probe_vec)
            logger.info("compare create: probed embed dims=%d from %s", resolved_dims, data.embed_url)
        except Exception as e:
            raise HTTPException(
                status_code=422,
                detail=f"Could not verify embedding endpoint: {e}",
            )

    with get_cursor() as (cur, _conn):
        cur.execute(
            """
            INSERT INTO public.compare_jobs (
                name, label_left, label_right, schema_name,
                context_columns_left, content_column_left, display_column_left,
                context_columns_right, content_column_right, display_column_right,
                source_filename_left, source_filename_right,
                tmp_path_left, tmp_path_right,
                embed_dims, embed_url, embed_api_key, embed_model,
                rerank_enabled, rerank_model
            ) VALUES (
                %s, %s, %s, 'compare_placeholder',
                %s, %s, %s,
                %s, %s, %s,
                %s, %s,
                %s, %s,
                %s, %s, %s, %s,
                %s, %s
            ) RETURNING id, created_at
            """,
            [
                data.name, data.label_left, data.label_right,
                data.context_columns_left, data.content_column_left, data.display_column_left,
                data.context_columns_right, data.content_column_right, data.display_column_right,
                data.source_filename_left, data.source_filename_right,
                data.tmp_path_left, data.tmp_path_right,
                resolved_dims, data.embed_url or None, data.embed_api_key or None, data.embed_model or None,
                data.rerank_enabled, data.rerank_model or None,
            ],
        )
        row = cur.fetchone()
        job_id = row["id"]
        # Update schema_name now that we have the id
        schema_name = f"compare_{job_id}"
        cur.execute(
            "UPDATE public.compare_jobs SET schema_name = %s WHERE id = %s",
            [schema_name, job_id],
        )

    # Create per-job schema with the resolved (possibly custom) dims
    create_compare_schema(job_id, resolved_dims)

    return _job_response(job_id)


@router.get("/", response_model=list[CompareJobResponse])
def list_compare_jobs():
    with get_cursor() as (cur, _conn):
        cur.execute(
            "SELECT * FROM public.compare_jobs ORDER BY created_at DESC"
        )
        rows = cur.fetchall()
    return [_serialize_job(dict(r)) for r in rows]


@router.get("/{job_id}", response_model=CompareJobResponse)
def get_compare_job(job_id: int):
    return _job_response(job_id)


@router.patch("/{job_id}", response_model=CompareJobResponse)
def update_compare_job(job_id: int, data: CompareJobUpdate):
    job = _job_or_404(job_id)
    patch = data.model_dump(exclude_unset=True)
    name = patch.get("name")
    notes = patch.get("notes")

    if name is not None:
        name = str(name).strip()
        if not name:
            raise HTTPException(status_code=422, detail="name cannot be empty")

    # Notes can be empty string (clears it)
    if notes is not None:
        notes = str(notes)

    with get_cursor() as (cur, _conn):
        if name is not None:
            cur.execute("UPDATE public.compare_jobs SET name = %s WHERE id = %s", [name, job_id])
        if notes is not None:
            cur.execute("UPDATE public.compare_jobs SET notes = %s WHERE id = %s", [notes, job_id])

    return _job_response(job_id)


@router.delete("/{job_id}")
def delete_compare_job(job_id: int):
    _job_or_404(job_id)
    drop_compare_schema(job_id)
    return {"ok": True}


# ── Ingestion SSE ─────────────────────────────────────────────────────────

@router.get("/{job_id}/ingest")
def ingest_compare(job_id: int):
    job = _job_or_404(job_id)

    tmp_path_left = job.get("tmp_path_left") or ""
    tmp_path_right = job.get("tmp_path_right") or ""

    for path, label in [(tmp_path_left, "left"), (tmp_path_right, "right")]:
        if not os.path.exists(path):
            raise HTTPException(
                status_code=400,
                detail=f"Upload file for {label} not found. Please re-create the job.",
            )

    if job_id in _compare_progress:
        def _stream_existing():
            while True:
                prog = _compare_progress.get(
                    job_id, {"type": "starting", "message": "Preparing..."}
                )
                yield f"data: {json.dumps(prog)}\n\n"
                if prog.get("type") in ("complete", "error"):
                    _compare_progress.pop(job_id, None)
                    break
                time.sleep(1)
        return StreamingResponse(_stream_existing(), media_type="text/event-stream")

    _compare_progress[job_id] = {"type": "starting", "message": "Preparing comparison..."}

    def _run():
        logger.info("Compare thread started for job_id=%d", job_id)
        try:
            for event in run_compare_job(job_id):
                _compare_progress[job_id] = event
                if event.get("type") not in ("ingest_left", "ingest_right"):
                    logger.debug("compare [job=%d] %s", job_id, event)
        except Exception as e:
            logger.exception("Compare job failed job_id=%d", job_id)
            _compare_progress[job_id] = {"type": "error", "message": str(e)}
        finally:
            for path in [tmp_path_left, tmp_path_right]:
                if path and os.path.exists(path):
                    try:
                        os.unlink(path)
                    except Exception:
                        pass

    threading.Thread(target=_run, daemon=True).start()

    def event_stream():
        while True:
            prog = _compare_progress.get(job_id, {"type": "starting", "message": "Preparing..."})
            yield f"data: {json.dumps(prog)}\n\n"
            if prog.get("type") in ("complete", "error"):
                _compare_progress.pop(job_id, None)
                break
            time.sleep(1)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


# ── Review ────────────────────────────────────────────────────────────────

@router.get("/{job_id}/review")
def review_stats(job_id: int):
    job = _job_or_404(job_id)
    schema = job["schema_name"]

    with get_cursor() as (cur, _conn):
        cur.execute(
            f"SELECT COUNT(*) AS cnt FROM {schema}.records WHERE side = 'left'"
        )
        total_left = (cur.fetchone() or {}).get("cnt", 0)

        cur.execute(f"SELECT COUNT(*) AS cnt FROM {schema}.decisions")
        reviewed = (cur.fetchone() or {}).get("cnt", 0)

    return {
        "total_left": total_left,
        "reviewed": reviewed,
        "pending": max(0, total_left - reviewed),
    }


@router.get("/{job_id}/browse")
def browse_compare(job_id: int, side: str | None = None, limit: int = 25):
    """
    Browse raw compare records exactly as stored in Postgres.
    Returns the first `limit` rows (default 25). Optional `side` filter: left|right.
    """
    job = _job_or_404(job_id)
    if job["status"] != "ready":
        raise HTTPException(status_code=400, detail=f"Job not ready (status: {job['status']})")

    schema = job["schema_name"]
    limit = max(1, min(int(limit or 25), 200))
    side = (side or "").strip().lower() or None
    if side not in (None, "left", "right"):
        raise HTTPException(status_code=422, detail="side must be 'left' or 'right'")

    where = ""
    params: list = []
    if side:
        where = "WHERE side = %s"
        params.append(side)
    params.append(limit)

    with get_cursor() as (cur, _conn):
        cur.execute(
            f"SELECT * FROM {schema}.records {where} ORDER BY id LIMIT %s",
            params,
        )
        rows = [dict(r) for r in cur.fetchall()]

        if side:
            cur.execute(f"SELECT COUNT(*) AS cnt FROM {schema}.records WHERE side = %s", [side])
        else:
            cur.execute(f"SELECT COUNT(*) AS cnt FROM {schema}.records")
        total = int((cur.fetchone() or {}).get("cnt", 0) or 0)

    for row in rows:
        if row.get("embedding") is not None:
            emb = row["embedding"]
            if isinstance(emb, str):
                vals = [float(v) for v in emb.strip("[]").split(",") if v.strip()]
            else:
                vals = [float(v) for v in emb]
            row["embedding"] = f"[{', '.join(f'{v:.3f}' for v in vals[:3])} … +{max(0, len(vals)-3)} more]"

    return {"records": rows, "total": total}


@router.get("/{job_id}/browse-raw")
def browse_compare_raw(job_id: int, limit: int = 50, left_row: int | None = None):
    """
    Browse the raw-pairs report (left × top-k right candidates) with scores.
    Mirrors the export type=raw query, but returns a limited slice for UI browsing.
    Optional filter: left_row (original_row index from the left file).
    """
    job = _job_or_404(job_id)
    if job["status"] != "ready":
        raise HTTPException(status_code=400, detail=f"Job not ready (status: {job['status']})")

    schema = job["schema_name"]
    limit = max(1, min(int(limit or 50), 500))

    where = ""
    params: list = []
    if left_row is not None:
        where = "WHERE lr.original_row = %s"
        params.append(int(left_row))
    params.append(limit)

    with get_cursor() as (cur, _conn):
        cur.execute(
            f"""
            SELECT
                lr.original_row        AS left_row,
                lr.display_value       AS left_display,
                lr.contextual_content  AS left_contextual,
                m.rank                 AS rank,
                rr.original_row        AS right_row,
                rr.display_value       AS right_display,
                rr.contextual_content  AS right_contextual,
                m.cosine_score         AS cosine_score,
                m.rerank_score         AS rerank_score
            FROM {schema}.matches m
            JOIN {schema}.records lr ON lr.id = m.left_id
            JOIN {schema}.records rr ON rr.id = m.right_id
            {where}
            ORDER BY lr.original_row ASC, m.rank ASC
            LIMIT %s
            """,
            params,
        )
        rows = [dict(r) for r in cur.fetchall()]

        if left_row is not None:
            cur.execute(
                f"""
                SELECT COUNT(*) AS cnt
                FROM {schema}.matches m
                JOIN {schema}.records lr ON lr.id = m.left_id
                WHERE lr.original_row = %s
                """,
                [int(left_row)],
            )
        else:
            cur.execute(f"SELECT COUNT(*) AS cnt FROM {schema}.matches")
        total = int((cur.fetchone() or {}).get("cnt", 0) or 0)

    return {"records": rows, "total": total}


@router.get("/{job_id}/config-stats")
def compare_config_stats(job_id: int):
    """
    Return safe compare-job configuration + lightweight process stats.
    Intended for UI transparency/debugging (similar to Projects → Settings/System pages).
    """
    job = _job_or_404(job_id)
    schema = job["schema_name"]

    cfg = {
        "id": job["id"],
        "name": job.get("name"),
        "notes": job.get("notes"),
        "label_left": job.get("label_left"),
        "label_right": job.get("label_right"),
        "status": job.get("status"),
        "status_message": _safe_status_message(job.get("status_message")),
        "created_at": job.get("created_at"),
        "schema_name": schema,
        "source_filename_left": job.get("source_filename_left"),
        "source_filename_right": job.get("source_filename_right"),
        "top_k": job.get("top_k") or 3,
        "embed_dims": job.get("embed_dims"),
        "embed_url": job.get("embed_url"),
        "embed_model": job.get("embed_model"),
        "rerank_enabled": (job.get("rerank_enabled") if job.get("rerank_enabled") is not None else True),
        "rerank_model": job.get("rerank_model"),
        "content_column_left": job.get("content_column_left"),
        "context_columns_left": job.get("context_columns_left") or [],
        "display_column_left": job.get("display_column_left"),
        "content_column_right": job.get("content_column_right"),
        "context_columns_right": job.get("context_columns_right") or [],
        "display_column_right": job.get("display_column_right"),
    }

    stats: dict = {
        "records_left": None,
        "records_right": None,
        "matches_rows": None,
        "candidates_per_left": None,
        "decisions": None,
        "pending": None,
        "best_score_min": None,
        "best_score_p50": None,
        "best_score_p90": None,
        "best_score_max": None,
        "uses_normalized_rerank": None,
        "avg_chars_left": None,
        "avg_chars_right": None,
        "est_embed_tokens": None,
        "est_rerank_pair_tokens": None,
        "timings_ms": None,
    }

    # Only compute table stats once schema exists and job is at least ingesting.
    if job.get("status") in ("ingesting", "comparing", "ready", "error"):
        try:
            with get_cursor() as (cur, _conn):
                cur.execute(f"SELECT COUNT(*) AS cnt FROM {schema}.records WHERE side = 'left'")
                stats["records_left"] = int((cur.fetchone() or {}).get("cnt", 0) or 0)
                cur.execute(f"SELECT COUNT(*) AS cnt FROM {schema}.records WHERE side = 'right'")
                stats["records_right"] = int((cur.fetchone() or {}).get("cnt", 0) or 0)

                cur.execute(f"SELECT COUNT(*) AS cnt FROM {schema}.matches")
                stats["matches_rows"] = int((cur.fetchone() or {}).get("cnt", 0) or 0)

                if stats["records_left"]:
                    stats["candidates_per_left"] = round((stats["matches_rows"] or 0) / max(1, stats["records_left"]), 3)

                cur.execute(f"SELECT COUNT(*) AS cnt FROM {schema}.decisions")
                stats["decisions"] = int((cur.fetchone() or {}).get("cnt", 0) or 0)
                if stats["records_left"] is not None and stats["decisions"] is not None:
                    stats["pending"] = max(0, stats["records_left"] - stats["decisions"])

                # Best-match score distribution over left rows (rank=1).
                cur.execute(
                    f"""
                    SELECT
                      COUNT(*) AS n,
                      MIN(CASE WHEN rerank_score BETWEEN 0 AND 1 THEN rerank_score ELSE cosine_score END) AS min_s,
                      MAX(CASE WHEN rerank_score BETWEEN 0 AND 1 THEN rerank_score ELSE cosine_score END) AS max_s,
                      percentile_cont(0.5) WITHIN GROUP (ORDER BY (CASE WHEN rerank_score BETWEEN 0 AND 1 THEN rerank_score ELSE cosine_score END)) AS p50,
                      percentile_cont(0.9) WITHIN GROUP (ORDER BY (CASE WHEN rerank_score BETWEEN 0 AND 1 THEN rerank_score ELSE cosine_score END)) AS p90
                    FROM {schema}.matches
                    WHERE rank = 1
                    """
                )
                row = cur.fetchone() or {}
                if row.get("n"):
                    stats["best_score_min"] = float(row.get("min_s") or 0.0)
                    stats["best_score_p50"] = float(row.get("p50") or 0.0)
                    stats["best_score_p90"] = float(row.get("p90") or 0.0)
                    stats["best_score_max"] = float(row.get("max_s") or 0.0)

                cur.execute(
                    f"""
                    SELECT COUNT(*) AS cnt
                    FROM {schema}.matches
                    WHERE rerank_score BETWEEN 0 AND 1
                    """
                )
                stats["uses_normalized_rerank"] = int((cur.fetchone() or {}).get("cnt", 0) or 0) > 0

                # Average contextual_content length (chars) per side.
                cur.execute(f"SELECT AVG(LENGTH(contextual_content)) AS avg_len FROM {schema}.records WHERE side = 'left'")
                stats["avg_chars_left"] = float((cur.fetchone() or {}).get("avg_len") or 0.0)
                cur.execute(f"SELECT AVG(LENGTH(contextual_content)) AS avg_len FROM {schema}.records WHERE side = 'right'")
                stats["avg_chars_right"] = float((cur.fetchone() or {}).get("avg_len") or 0.0)

                # Rough token estimates: ~4 chars per token (rule of thumb).
                n_left = stats["records_left"] or 0
                n_right = stats["records_right"] or 0
                est_embed_chars = (stats["avg_chars_left"] or 0) * n_left + (stats["avg_chars_right"] or 0) * n_right
                stats["est_embed_tokens"] = int(est_embed_chars / 4) if est_embed_chars else 0

                # Rerank token estimate per pair (query + doc). Very rough.
                avg_pair_chars = (stats["avg_chars_left"] or 0) + (stats["avg_chars_right"] or 0)
                stats["est_rerank_pair_tokens"] = int(avg_pair_chars / 4) if avg_pair_chars else 0
        except Exception:
            # If schema isn't ready yet, still return config.
            pass

    # If comparator stored persisted timings in JSON status_message, surface them here.
    try:
        parsed = json.loads(job.get("status_message") or "")
        if isinstance(parsed, dict) and isinstance(parsed.get("metrics"), dict):
            stats["timings_ms"] = parsed["metrics"]
    except Exception:
        pass

    return {"config": cfg, "stats": stats}


@router.get("/{job_id}/review/next", response_model=ReviewItem)
def next_review_item(
    job_id: int,
    min_score: float = 0.0,
    offset: int = 0,
    include_decided: bool = False,
):
    job = _job_or_404(job_id)
    if job["status"] != "ready":
        raise HTTPException(status_code=400, detail=f"Job not ready (status: {job['status']})")

    schema = job["schema_name"]
    # Some rerank strategies return arbitrary score ranges (e.g., logits or embedding scalars).
    # For review filtering, prefer rerank_score only when it appears normalized (0..1),
    # otherwise fall back to cosine_score which is always in [-1, 1] (typically 0..1 here).
    effective_score_sql = "CASE WHEN m.rerank_score BETWEEN 0 AND 1 THEN m.rerank_score ELSE m.cosine_score END"

    # Find the next left record to review
    if include_decided:
        # Any left record whose best match meets min_score
        query = f"""
            SELECT r.id, r.contextual_content, r.display_value
            FROM {schema}.records r
            JOIN {schema}.matches m ON m.left_id = r.id AND m.rank = 1
            WHERE r.side = 'left'
              AND {effective_score_sql} >= %s
            ORDER BY r.id
            LIMIT 1 OFFSET %s
        """
        params = [min_score, offset]
    else:
        # Only undecided rows
        query = f"""
            SELECT r.id, r.contextual_content, r.display_value
            FROM {schema}.records r
            JOIN {schema}.matches m ON m.left_id = r.id AND m.rank = 1
            LEFT JOIN {schema}.decisions d ON d.left_id = r.id
            WHERE r.side = 'left'
              AND d.left_id IS NULL
              AND {effective_score_sql} >= %s
            ORDER BY r.id
            LIMIT 1 OFFSET %s
        """
        params = [min_score, offset]

    with get_cursor() as (cur, _conn):
        cur.execute(query, params)
        left_row = cur.fetchone()

    if not left_row:
        raise HTTPException(status_code=404, detail="No more rows to review")

    left_id = left_row["id"]

    # Fetch top-k candidates
    with get_cursor() as (cur, _conn):
        cur.execute(
            f"""
            SELECT m.right_id, m.cosine_score, m.rerank_score, m.rank,
                   r.contextual_content, r.display_value
            FROM {schema}.matches m
            JOIN {schema}.records r ON r.id = m.right_id
            WHERE m.left_id = %s
            ORDER BY m.rank ASC
            """,
            [left_id],
        )
        match_rows = cur.fetchall()

    candidates = [
        CandidateItem(
            right_id=mr["right_id"],
            contextual_content=mr["contextual_content"] or "",
            display_value=mr["display_value"],
            cosine_score=float(mr["cosine_score"] or 0),
            rerank_score=float(mr["rerank_score"] or 0),
            rank=mr["rank"],
        )
        for mr in match_rows
    ]

    # Current decision if any
    with get_cursor() as (cur, _conn):
        cur.execute(
            f"SELECT matched_right_id FROM {schema}.decisions WHERE left_id = %s",
            [left_id],
        )
        dec = cur.fetchone()

    current_decision = dec["matched_right_id"] if dec else None
    is_decided = dec is not None

    return ReviewItem(
        left_id=left_id,
        contextual_content=left_row["contextual_content"] or "",
        display_value=left_row["display_value"],
        candidates=candidates,
        current_decision=current_decision,
        is_decided=is_decided,
    )


@router.post("/{job_id}/review/{left_id}", status_code=204)
def submit_decision(job_id: int, left_id: int, data: CompareDecision):
    job = _job_or_404(job_id)
    schema = job["schema_name"]

    with get_cursor() as (cur, _conn):
        cur.execute(
            f"""
            INSERT INTO {schema}.decisions (left_id, matched_right_id, decided_at)
            VALUES (%s, %s, NOW())
            ON CONFLICT (left_id) DO UPDATE
                SET matched_right_id = EXCLUDED.matched_right_id,
                    decided_at = NOW()
            """,
            [left_id, data.matched_right_id],
        )


# ── Export ────────────────────────────────────────────────────────────────

@router.get("/{job_id}/export")
def export_compare(job_id: int, type: str = "confirmed"):
    job = _job_or_404(job_id)
    if job["status"] != "ready":
        raise HTTPException(status_code=400, detail=f"Job not ready (status: {job['status']})")

    if type not in ("raw", "confirmed"):
        raise HTTPException(status_code=400, detail="type must be 'raw' or 'confirmed'")

    schema = job["schema_name"]
    label_l = job.get("label_left", "Left")
    label_r = job.get("label_right", "Right")
    name_slug = job["name"].lower().replace(" ", "-")

    buffer = io.BytesIO()

    if type == "raw":
        # Single sheet: all left × top-k right candidates
        with get_cursor() as (cur, _conn):
            cur.execute(
                f"""
                SELECT
                    lr.original_row    AS left_row,
                    lr.display_value   AS left_display,
                    lr.contextual_content AS left_contextual,
                    m.rank,
                    rr.original_row    AS right_row,
                    rr.display_value   AS right_display,
                    rr.contextual_content AS right_contextual,
                    m.cosine_score,
                    m.rerank_score
                FROM {schema}.matches m
                JOIN {schema}.records lr ON lr.id = m.left_id
                JOIN {schema}.records rr ON rr.id = m.right_id
                ORDER BY lr.original_row ASC, m.rank ASC
                """,
            )
            rows = [dict(r) for r in cur.fetchall()]

        df = pd.DataFrame(rows)
        df.columns = [
            f"{label_l} Row", f"{label_l} Display", f"{label_l} Content",
            "Rank",
            f"{label_r} Row", f"{label_r} Display", f"{label_r} Content",
            "Cosine Score", "Rerank Score",
        ]
        with pd.ExcelWriter(buffer, engine="openpyxl") as writer:
            df.to_excel(writer, sheet_name="All Matches", index=False)

        filename = f"{name_slug}_lens_compare_raw.xlsx"

    else:
        # 3 sheets: Confirmed Matches, Unique Left, Unique Right
        with pd.ExcelWriter(buffer, engine="openpyxl") as writer:

            # Sheet 1: Confirmed Matches
            with get_cursor() as (cur, _conn):
                cur.execute(
                    f"""
                    SELECT
                        lr.original_row    AS left_row,
                        lr.display_value   AS left_display,
                        lr.contextual_content AS left_contextual,
                        rr.original_row    AS right_row,
                        rr.display_value   AS right_display,
                        rr.contextual_content AS right_contextual,
                        m.cosine_score,
                        m.rerank_score,
                        d.decided_at
                    FROM {schema}.decisions d
                    JOIN {schema}.records lr ON lr.id = d.left_id
                    JOIN {schema}.records rr ON rr.id = d.matched_right_id
                    JOIN {schema}.matches m
                        ON m.left_id = d.left_id AND m.right_id = d.matched_right_id
                    WHERE d.matched_right_id IS NOT NULL
                    ORDER BY lr.original_row ASC
                    """,
                )
                confirmed_rows = [dict(r) for r in cur.fetchall()]

            df_confirmed = pd.DataFrame(confirmed_rows)
            if not df_confirmed.empty:
                df_confirmed.columns = [
                    f"{label_l} Row", f"{label_l} Display", f"{label_l} Content",
                    f"{label_r} Row", f"{label_r} Display", f"{label_r} Content",
                    "Cosine Score", "Rerank Score", "Decided At",
                ]
            df_confirmed.to_excel(writer, sheet_name="Confirmed Matches", index=False)

            # Sheet 2: Unique Left (no-match decisions + unreviewed)
            with get_cursor() as (cur, _conn):
                cur.execute(
                    f"""
                    SELECT
                        lr.original_row    AS left_row,
                        lr.display_value   AS left_display,
                        lr.contextual_content AS left_contextual,
                        CASE
                            WHEN d.left_id IS NOT NULL THEN 'no match'
                            ELSE ''
                        END AS human_review
                    FROM {schema}.records lr
                    LEFT JOIN {schema}.decisions d
                        ON d.left_id = lr.id AND d.matched_right_id IS NULL
                    LEFT JOIN {schema}.decisions d2
                        ON d2.left_id = lr.id AND d2.matched_right_id IS NOT NULL
                    WHERE lr.side = 'left'
                      AND d2.left_id IS NULL   -- exclude confirmed matches
                    ORDER BY lr.original_row ASC
                    """,
                )
                unique_left_rows = [dict(r) for r in cur.fetchall()]

            df_unique_left = pd.DataFrame(unique_left_rows)
            if not df_unique_left.empty:
                df_unique_left.columns = [
                    f"{label_l} Row", f"{label_l} Display", f"{label_l} Content",
                    "Human Review",
                ]
            df_unique_left.to_excel(writer, sheet_name=f"Unique {label_l}", index=False)

            # Sheet 3: Unique Right (never selected)
            with get_cursor() as (cur, _conn):
                cur.execute(
                    f"""
                    SELECT
                        rr.original_row    AS right_row,
                        rr.display_value   AS right_display,
                        rr.contextual_content AS right_contextual
                    FROM {schema}.records rr
                    WHERE rr.side = 'right'
                      AND rr.id NOT IN (
                          SELECT matched_right_id FROM {schema}.decisions
                          WHERE matched_right_id IS NOT NULL
                      )
                    ORDER BY rr.original_row ASC
                    """,
                )
                unique_right_rows = [dict(r) for r in cur.fetchall()]

            df_unique_right = pd.DataFrame(unique_right_rows)
            if not df_unique_right.empty:
                df_unique_right.columns = [
                    f"{label_r} Row", f"{label_r} Display", f"{label_r} Content",
                ]
            df_unique_right.to_excel(writer, sheet_name=f"Unique {label_r}", index=False)

        filename = f"{name_slug}_lens_compare_confirmed.xlsx"

    buffer.seek(0)
    return Response(
        content=buffer.read(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


# ── Response helpers ──────────────────────────────────────────────────────

def _serialize_job(row: dict) -> dict:
    """Strip internal/sensitive fields (tmp_path, embed_api_key) before returning to client."""
    rerank_enabled = row.get("rerank_enabled")
    return {
        "id": row["id"],
        "name": row["name"],
        "notes": row.get("notes"),
        "label_left": row["label_left"],
        "label_right": row["label_right"],
        "schema_name": row["schema_name"],
        "status": row["status"],
        "status_message": _safe_status_message(row.get("status_message")),
        "row_count_left": row.get("row_count_left"),
        "row_count_right": row.get("row_count_right"),
        "top_k": row.get("top_k") or 3,
        "embed_url": row.get("embed_url"),
        "embed_model": row.get("embed_model"),
        # rerank_enabled may be None for legacy rows written before this column existed;
        # treat None as True (system default = enabled).
        "rerank_enabled": rerank_enabled if rerank_enabled is not None else True,
        "rerank_model": row.get("rerank_model"),
        "created_at": row["created_at"],
        # embed_api_key is intentionally NOT included — same policy as project.pin
    }


def _safe_status_message(msg: str | None) -> str | None:
    """If status_message is the internal JSON tmp-path blob, return None instead."""
    if not msg:
        return None
    try:
        parsed = json.loads(msg)
        # Hide internal tmp-path blob
        if isinstance(parsed, dict) and "l" in parsed and "r" in parsed:
            return None
        # If we stored structured compare metrics, expose only the user-facing message.
        if isinstance(parsed, dict) and "metrics" in parsed:
            m = parsed.get("message")
            return str(m) if m else None
    except Exception:
        pass
    return msg


def _job_response(job_id: int) -> CompareJobResponse:
    job = _job_or_404(job_id)
    d = _serialize_job(job)
    return CompareJobResponse(**d)

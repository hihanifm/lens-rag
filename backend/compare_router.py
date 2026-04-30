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
from ingestion import read_excel
from models import (
    CandidateItem,
    CompareDecision,
    CompareJobCreate,
    CompareJobResponse,
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

    with get_cursor() as (cur, _conn):
        cur.execute(
            """
            INSERT INTO public.compare_jobs (
                name, label_left, label_right, schema_name,
                context_columns_left, content_column_left, display_column_left,
                context_columns_right, content_column_right, display_column_right,
                source_filename_left, source_filename_right,
                tmp_path_left, tmp_path_right,
                embed_dims
            ) VALUES (
                %s, %s, %s, 'compare_placeholder',
                %s, %s, %s,
                %s, %s, %s,
                %s, %s,
                %s, %s,
                %s
            ) RETURNING id, created_at
            """,
            [
                data.name, data.label_left, data.label_right,
                data.context_columns_left, data.content_column_left, data.display_column_left,
                data.context_columns_right, data.content_column_right, data.display_column_right,
                data.source_filename_left, data.source_filename_right,
                data.tmp_path_left, data.tmp_path_right,
                EMBEDDING_DIMS,
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

    # Create per-job schema
    create_compare_schema(job_id, EMBEDDING_DIMS)

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

    # Find the next left record to review
    if include_decided:
        # Any left record whose best match meets min_score
        query = f"""
            SELECT r.id, r.contextual_content, r.display_value
            FROM {schema}.records r
            JOIN {schema}.matches m ON m.left_id = r.id AND m.rank = 1
            WHERE r.side = 'left'
              AND m.rerank_score >= %s
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
              AND m.rerank_score >= %s
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
    """Strip internal tmp_path fields before returning to client."""
    return {
        "id": row["id"],
        "name": row["name"],
        "label_left": row["label_left"],
        "label_right": row["label_right"],
        "schema_name": row["schema_name"],
        "status": row["status"],
        "status_message": _safe_status_message(row.get("status_message")),
        "row_count_left": row.get("row_count_left"),
        "row_count_right": row.get("row_count_right"),
        "top_k": row.get("top_k") or 3,
        "created_at": row["created_at"],
    }


def _safe_status_message(msg: str | None) -> str | None:
    """If status_message is the internal JSON tmp-path blob, return None instead."""
    if not msg:
        return None
    try:
        parsed = json.loads(msg)
        if isinstance(parsed, dict) and "l" in parsed and "r" in parsed:
            return None
    except Exception:
        pass
    return msg


def _job_response(job_id: int) -> CompareJobResponse:
    job = _job_or_404(job_id)
    d = _serialize_job(job)
    return CompareJobResponse(**d)

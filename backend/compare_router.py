"""
compare_router.py — FastAPI routes for the Compare project flavor.

Job-level routes:
  POST /compare/preview-left          upload left file → columns + tmp_path
  POST /compare/preview-right         upload right file → columns + tmp_path
  POST /compare/preview-context       preview merged text strings
  POST /compare/preview-row-stats     row counts after sheet + filters
  POST /compare/preview-column-values distinct values for a column (filter picker)
  POST /compare/preview-column-samples   first N rows per column (column picker)
  POST /compare/                      create job (embed only, no pipeline)
  GET  /compare/                      list jobs
  GET  /compare/{job_id}              job detail
  PATCH /compare/{job_id}             update name/notes
  GET  /compare/{job_id}/ingest       SSE: embed left + right (Phase 1)
  GET  /compare/{job_id}/browse       browse raw records
  GET  /compare/{job_id}/browse-raw   browse raw match pairs (legacy/run-scoped)
  GET  /compare/{job_id}/config-stats config + stats
  DELETE /compare/{job_id}            drop job + schema + all runs

Run-level routes (under /compare/{job_id}/runs):
  POST /compare/{job_id}/runs                           create run
  GET  /compare/{job_id}/runs                           list runs
  GET  /compare/{job_id}/runs/{run_id}                  run detail
  GET  /compare/{job_id}/runs/{run_id}/execute          SSE: run pipeline (Phase 2)
  GET  /compare/{job_id}/runs/{run_id}/review           stats
  GET  /compare/{job_id}/runs/{run_id}/review/next      next ReviewItem
  POST /compare/{job_id}/runs/{run_id}/review/{left_id} submit decision
  GET  /compare/{job_id}/runs/{run_id}/export           Excel download
  DELETE /compare/{job_id}/runs/{run_id}                delete run
"""
import io
import json
import logging
import os
import re
import tempfile
import threading
import time

import pandas as pd
from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import Response, StreamingResponse

from comparator import run_ingest_job, run_pipeline
from config import EMBEDDING_DIMS
from db import create_compare_schema, create_run_tables, drop_compare_schema, drop_run_tables, get_cursor
from embedder import embed as _embed_probe
from ingestion import (
    apply_compare_row_filters,
    build_contextual_content,
    compare_column_first_row_samples,
    distinct_compare_column_strings,
    excel_sheet_previews,
    read_compare_dataframe,
)
from models import (
    CandidateItem,
    CompareContextPreviewRequest,
    CompareContextPreviewResponse,
    CompareJobCreate,
    CompareJobResponse,
    CompareJobUpdate,
    CompareDecision,
    ComparePreviewColumnValuesRequest,
    ComparePreviewColumnValuesResponse,
    ComparePreviewColumnSamplesRequest,
    ComparePreviewColumnSamplesResponse,
    ComparePreviewRowStatsRequest,
    ComparePreviewRowStatsResponse,
    CompareRunCreate,
    CompareRunResponse,
    CompareRowFilter,
    ReviewItem,
)

logger = logging.getLogger("lens.compare_router")
router = APIRouter()

# Progress for job-level embedding (Phase 1), keyed by job_id
_job_ingest_progress: dict[int, dict] = {}
# Progress for run-level pipeline (Phase 2), keyed by run_id
_run_progress: dict[int, dict] = {}


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


def _filters_to_dicts(filters: list[CompareRowFilter] | None) -> list[dict]:
    if not filters:
        return []
    out: list[dict] = []
    for f in filters:
        d = f.model_dump()
        if not str(d.get("column") or "").strip():
            continue
        out.append(d)
    return out


def _decode_job_filters(raw) -> list[CompareRowFilter]:
    if raw is None:
        return []
    if isinstance(raw, list):
        return [CompareRowFilter(**x) for x in raw if isinstance(x, dict)]
    if isinstance(raw, str) and raw.strip():
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            return []
        if not isinstance(data, list):
            return []
        return [CompareRowFilter(**x) for x in data if isinstance(x, dict)]
    return []


def _excel_sheet_names(tmp_path: str) -> list[str]:
    return [p["sheet_name"] for p in excel_sheet_previews(tmp_path)]


def _require_sheet_if_multi(tmp_path: str, sheet_name: str | None, label: str) -> str | None:
    names = _excel_sheet_names(tmp_path)
    if len(names) <= 1:
        return (sheet_name or "").strip() or None
    sn = (sheet_name or "").strip()
    if not sn:
        raise HTTPException(
            status_code=422,
            detail=f"{label}: choose an Excel sheet (workbook has multiple sheets).",
        )
    if sn not in names:
        raise HTTPException(status_code=422, detail=f"{label}: unknown sheet {sn!r}.")
    return sn


def _validate_filters_against_df(df, filters: list[dict], label: str) -> None:
    cols = set(df.columns)
    for f in filters:
        c = str(f.get("column") or "").strip()
        op = str(f.get("op") or "").strip().lower()
        if c not in cols:
            raise HTTPException(status_code=422, detail=f"{label}: filter column {c!r} not found.")
        if op in ("contains", "not_contains", "regex"):
            raw_pat = str(f.get("value") or "").strip()
            if not raw_pat:
                raise HTTPException(
                    status_code=422,
                    detail=f"{label}: filter on {c!r} needs a value for op \"{op}\".",
                )
            if op == "regex":
                try:
                    re.compile(raw_pat)
                except re.error as e:
                    raise HTTPException(status_code=422, detail=f"{label}: invalid regex: {e}") from e


# ── File preview ──────────────────────────────────────────────────────────

async def _preview_file(file: UploadFile) -> dict:
    if not file.filename.endswith((".xlsx", ".xls")):
        raise HTTPException(status_code=400, detail="Only Excel files accepted")
    with tempfile.NamedTemporaryFile(delete=False, suffix=".xlsx") as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name
    try:
        per_sheet = excel_sheet_previews(tmp_path)
        sheet_names = [p["sheet_name"] for p in per_sheet]
        total_rows = sum(int(p["row_count"]) for p in per_sheet)
        first = per_sheet[0]
        return {
            "columns": first["columns"],
            "sheet_names": sheet_names,
            "per_sheet": per_sheet,
            "row_count": total_rows,
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

    sheet_resolved = _require_sheet_if_multi(tmp_path, body.sheet_name, "Preview")
    df = read_compare_dataframe(tmp_path, sheet_resolved)
    fl = _filters_to_dicts(body.row_filters)
    _validate_filters_against_df(df, fl, "Preview")
    df = apply_compare_row_filters(df, fl)
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


@router.post("/preview-row-stats", response_model=ComparePreviewRowStatsResponse)
def preview_row_stats(body: ComparePreviewRowStatsRequest):
    """Row counts before/after filters for one uploaded Excel file."""
    tmp_path = (body.tmp_path or "").strip()
    if not tmp_path or not os.path.exists(tmp_path):
        raise HTTPException(status_code=400, detail="Uploaded file not found. Please re-upload.")

    sheet_resolved = _require_sheet_if_multi(tmp_path, body.sheet_name, "Preview")
    df0 = read_compare_dataframe(tmp_path, sheet_resolved)
    n0 = len(df0)
    fl = _filters_to_dicts(body.row_filters)
    _validate_filters_against_df(df0, fl, "Preview")
    df1 = apply_compare_row_filters(df0, fl)
    return ComparePreviewRowStatsResponse(
        row_count_unfiltered=n0,
        row_count_filtered=len(df1),
    )


@router.post("/preview-column-values", response_model=ComparePreviewColumnValuesResponse)
def preview_column_values(body: ComparePreviewColumnValuesRequest):
    """Up to 100 distinct string values for a column after optional sibling filters."""
    tmp_path = (body.tmp_path or "").strip()
    column = (body.column or "").strip()
    if not tmp_path or not os.path.exists(tmp_path):
        raise HTTPException(status_code=400, detail="Uploaded file not found. Please re-upload.")
    if not column:
        raise HTTPException(status_code=422, detail="column is required")

    sheet_resolved = _require_sheet_if_multi(tmp_path, body.sheet_name, "Preview")
    df0 = read_compare_dataframe(tmp_path, sheet_resolved)
    fl = _filters_to_dicts(body.row_filters)
    _validate_filters_against_df(df0, fl, "Preview")
    df = apply_compare_row_filters(df0, fl)
    try:
        values, truncated = distinct_compare_column_strings(df, column)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Unknown column: {column}")

    # Avoid duplicate <option value=""> in filter dropdowns; use "is empty" for blank cells.
    values = [v for v in values if v != ""]

    return ComparePreviewColumnValuesResponse(column=column, values=values, truncated=truncated)


@router.post("/preview-column-samples", response_model=ComparePreviewColumnSamplesResponse)
def preview_column_samples(body: ComparePreviewColumnSamplesRequest):
    """First n rows per column (strings), after sheet selection and row filters."""
    tmp_path = (body.tmp_path or "").strip()
    if not tmp_path or not os.path.exists(tmp_path):
        raise HTTPException(status_code=400, detail="Uploaded file not found. Please re-upload.")

    sheet_resolved = _require_sheet_if_multi(tmp_path, body.sheet_name, "Preview")
    df0 = read_compare_dataframe(tmp_path, sheet_resolved)
    fl = _filters_to_dicts(body.row_filters)
    _validate_filters_against_df(df0, fl, "Preview")
    df = apply_compare_row_filters(df0, fl)

    cols = [str(c).strip() for c in (body.columns or []) if str(c).strip()]
    if not cols:
        cols = [c for c in df.columns if c != "sheet_name"]

    n = max(1, min(int(body.n or 5), 10))
    samples = compare_column_first_row_samples(df, cols, n)
    return ComparePreviewColumnSamplesResponse(samples_by_column=samples)


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

    lf = _filters_to_dicts(data.row_filters_left)
    rf = _filters_to_dicts(data.row_filters_right)
    sheet_left = _require_sheet_if_multi(data.tmp_path_left, data.sheet_name_left, "Left file")
    sheet_right = _require_sheet_if_multi(data.tmp_path_right, data.sheet_name_right, "Right file")
    df_l = read_compare_dataframe(data.tmp_path_left, sheet_left)
    df_r = read_compare_dataframe(data.tmp_path_right, sheet_right)
    _validate_filters_against_df(df_l, lf, "Left file")
    _validate_filters_against_df(df_r, rf, "Right file")

    filters_left_json = json.dumps(lf)
    filters_right_json = json.dumps(rf)

    with get_cursor() as (cur, _conn):
        cur.execute(
            """
            INSERT INTO public.compare_jobs (
                name, label_left, label_right, schema_name,
                context_columns_left, content_column_left, display_column_left,
                context_columns_right, content_column_right, display_column_right,
                sheet_name_left, sheet_name_right,
                row_filters_left, row_filters_right,
                source_filename_left, source_filename_right,
                tmp_path_left, tmp_path_right,
                embed_dims, embed_url, embed_api_key, embed_model
            ) VALUES (
                %s, %s, %s, 'compare_placeholder',
                %s, %s, %s,
                %s, %s, %s,
                %s, %s,
                %s, %s,
                %s, %s,
                %s, %s,
                %s, %s, %s, %s
            ) RETURNING id, created_at
            """,
            [
                data.name, data.label_left, data.label_right,
                data.context_columns_left, data.content_column_left, data.display_column_left,
                data.context_columns_right, data.content_column_right, data.display_column_right,
                sheet_left,
                sheet_right,
                filters_left_json,
                filters_right_json,
                data.source_filename_left, data.source_filename_right,
                data.tmp_path_left, data.tmp_path_right,
                resolved_dims, data.embed_url or None, data.embed_api_key or None, data.embed_model or None,
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
    """SSE — Phase 1: embed left + right files. Does NOT run the match pipeline."""
    job = _job_or_404(job_id)

    tmp_path_left  = job.get("tmp_path_left") or ""
    tmp_path_right = job.get("tmp_path_right") or ""

    for path, label in [(tmp_path_left, "left"), (tmp_path_right, "right")]:
        if not os.path.exists(path):
            raise HTTPException(
                status_code=400,
                detail=f"Upload file for {label} not found. Please re-create the job.",
            )

    if job_id in _job_ingest_progress:
        def _stream_existing():
            while True:
                prog = _job_ingest_progress.get(job_id, {"type": "starting", "message": "Preparing..."})
                yield f"data: {json.dumps(prog)}\n\n"
                if prog.get("type") in ("complete", "error"):
                    _job_ingest_progress.pop(job_id, None)
                    break
                time.sleep(1)
        return StreamingResponse(_stream_existing(), media_type="text/event-stream")

    _job_ingest_progress[job_id] = {"type": "starting", "message": "Preparing embedding..."}

    def _run():
        try:
            for event in run_ingest_job(job_id):
                _job_ingest_progress[job_id] = event
        except Exception as e:
            logger.exception("Ingest job failed job_id=%d", job_id)
            _job_ingest_progress[job_id] = {"type": "error", "message": str(e)}
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
            prog = _job_ingest_progress.get(job_id, {"type": "starting", "message": "Preparing..."})
            yield f"data: {json.dumps(prog)}\n\n"
            if prog.get("type") in ("complete", "error"):
                _job_ingest_progress.pop(job_id, None)
                break
            time.sleep(1)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


# ── Run CRUD ──────────────────────────────────────────────────────────────

@router.post("/{job_id}/runs", response_model=CompareRunResponse)
def create_run(job_id: int, data: CompareRunCreate):
    job = _job_or_404(job_id)
    if job["status"] != "ready":
        raise HTTPException(status_code=400, detail=f"Job not ready (status: {job['status']})")
    if not data.vector_enabled and not data.reranker_enabled and not data.llm_judge_enabled:
        raise HTTPException(status_code=422, detail="At least one pipeline stage must be enabled")

    with get_cursor() as (cur, _conn):
        cur.execute("""
            INSERT INTO public.compare_runs
                (job_id, name, status, top_k, vector_enabled,
                 reranker_enabled, reranker_model, reranker_url,
                 llm_judge_enabled, llm_judge_url, llm_judge_model, llm_judge_prompt)
            VALUES (%s, %s, 'pending', %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id
        """, [
            job_id,
            data.name or None,
            data.top_k,
            data.vector_enabled,
            data.reranker_enabled,
            data.reranker_model or None,
            data.reranker_url or None,
            data.llm_judge_enabled,
            data.llm_judge_url or None,
            data.llm_judge_model or None,
            data.llm_judge_prompt or None,
        ])
        run_id = cur.fetchone()["id"]

    schema_name = job["schema_name"]
    create_run_tables(schema_name, run_id)
    return _run_response(run_id)


@router.get("/{job_id}/runs", response_model=list[CompareRunResponse])
def list_runs(job_id: int):
    _job_or_404(job_id)
    with get_cursor() as (cur, _conn):
        cur.execute(
            "SELECT * FROM public.compare_runs WHERE job_id = %s ORDER BY created_at DESC",
            [job_id],
        )
        rows = [dict(r) for r in cur.fetchall()]
    return [_serialize_run(r) for r in rows]


@router.get("/{job_id}/runs/{run_id}", response_model=CompareRunResponse)
def get_run(job_id: int, run_id: int):
    _job_or_404(job_id)
    return _run_response(run_id)


@router.delete("/{job_id}/runs/{run_id}")
def delete_run(job_id: int, run_id: int):
    job = _job_or_404(job_id)
    _run_or_404(run_id, job_id)
    drop_run_tables(job["schema_name"], run_id)
    return {"ok": True}


# ── Run pipeline SSE ───────────────────────────────────────────────────────

@router.get("/{job_id}/runs/{run_id}/execute")
def execute_run(job_id: int, run_id: int):
    """
    SSE — Phase 2: run the search/rank pipeline for an existing run.

    The pipeline runs in a background thread; closing this SSE connection does not cancel it.
    Opening this endpoint again while the same run is in flight reattaches to `_run_progress`
    (e.g. user navigated away and returned).
    """
    job = _job_or_404(job_id)
    run = _run_or_404(run_id, job_id)

    if job["status"] != "ready":
        raise HTTPException(status_code=400, detail=f"Job embeddings not ready (status: {job['status']})")

    # Reattach first: closing the SSE tab does not stop the worker; buffered tail may include
    # `complete` before every client has refetched DB status.
    if run_id in _run_progress:
        def _stream_existing():
            while True:
                prog = _run_progress.get(run_id, {"type": "starting", "message": "Preparing..."})
                yield f"data: {json.dumps(prog)}\n\n"
                if prog.get("type") in ("complete", "error"):
                    _run_progress.pop(run_id, None)
                    break
                time.sleep(0.3)
        return StreamingResponse(_stream_existing(), media_type="text/event-stream")

    if run["status"] == "ready":
        raise HTTPException(status_code=400, detail="This run has already completed.")

    if run["status"] == "running":
        raise HTTPException(
            status_code=409,
            detail="Run is marked running but has no active progress session (server may have restarted).",
        )

    _run_progress[run_id] = {"type": "starting", "message": "Starting pipeline..."}

    def _run_thread():
        try:
            for event in run_pipeline(job_id, run_id):
                _run_progress[run_id] = event
        except Exception as e:
            logger.exception("run_pipeline failed job_id=%d run_id=%d", job_id, run_id)
            _run_progress[run_id] = {"type": "error", "message": str(e)}

    threading.Thread(target=_run_thread, daemon=True).start()

    def event_stream():
        while True:
            prog = _run_progress.get(run_id, {"type": "starting", "message": "Starting..."})
            yield f"data: {json.dumps(prog)}\n\n"
            if prog.get("type") in ("complete", "error"):
                _run_progress.pop(run_id, None)
                break
            time.sleep(0.3)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


# ── Run review ────────────────────────────────────────────────────────────

@router.get("/{job_id}/runs/{run_id}/review")
def run_review_stats(job_id: int, run_id: int):
    job = _job_or_404(job_id)
    _run_or_404(run_id, job_id)
    schema = job["schema_name"]
    dec_table = f"run_{run_id}_decisions"

    with get_cursor() as (cur, _conn):
        cur.execute(f"SELECT COUNT(*) AS cnt FROM {schema}.records WHERE side = 'left'")
        total_left = (cur.fetchone() or {}).get("cnt", 0)

        cur.execute(f"SELECT COUNT(*) AS cnt FROM {schema}.{dec_table}")
        reviewed = (cur.fetchone() or {}).get("cnt", 0)

        cur.execute(f"SELECT COUNT(*) AS cnt FROM {schema}.{dec_table} WHERE matched_right_id IS NULL")
        no_match = (cur.fetchone() or {}).get("cnt", 0)

    return {
        "total_left": total_left,
        "reviewed": reviewed,
        "pending": max(0, total_left - reviewed),
        "no_match": no_match,
        "matched": max(0, reviewed - no_match),
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


@router.get("/{job_id}/runs/{run_id}/browse-raw")
def browse_compare_raw(job_id: int, run_id: int, limit: int = 50, left_row: int | None = None):
    """
    Browse the raw-pairs report (left × top-k right candidates) with scores for a specific run.
    Mirrors the export type=raw query, but returns a limited slice for UI browsing.
    Optional filter: left_row (original_row index from the left file).
    """
    job = _job_or_404(job_id)
    _run_or_404(run_id, job_id)
    if job["status"] != "ready":
        raise HTTPException(status_code=400, detail=f"Job not ready (status: {job['status']})")

    schema = job["schema_name"]
    match_table = f"run_{run_id}_matches"
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
                m.rerank_score         AS rerank_score,
                m.llm_score            AS llm_score,
                m.final_score          AS final_score
            FROM {schema}.{match_table} m
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
                FROM {schema}.{match_table} m
                JOIN {schema}.records lr ON lr.id = m.left_id
                WHERE lr.original_row = %s
                """,
                [int(left_row)],
            )
        else:
            cur.execute(f"SELECT COUNT(*) AS cnt FROM {schema}.{match_table}")
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
        "embed_dims": job.get("embed_dims"),
        "embed_url": job.get("embed_url"),
        "embed_model": job.get("embed_model"),
        "content_column_left": job.get("content_column_left"),
        "context_columns_left": job.get("context_columns_left") or [],
        "display_column_left": job.get("display_column_left"),
        "sheet_name_left": job.get("sheet_name_left"),
        "content_column_right": job.get("content_column_right"),
        "context_columns_right": job.get("context_columns_right") or [],
        "display_column_right": job.get("display_column_right"),
        "sheet_name_right": job.get("sheet_name_right"),
        "row_filters_left": [f.model_dump() for f in _decode_job_filters(job.get("row_filters_left"))],
        "row_filters_right": [f.model_dump() for f in _decode_job_filters(job.get("row_filters_right"))],
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

    # Record-level stats (always at job level; match/decision stats are per-run)
    if job.get("status") in ("ingesting", "comparing", "ready", "error"):
        try:
            with get_cursor() as (cur, _conn):
                cur.execute(f"SELECT COUNT(*) AS cnt FROM {schema}.records WHERE side = 'left'")
                stats["records_left"] = int((cur.fetchone() or {}).get("cnt", 0) or 0)
                cur.execute(f"SELECT COUNT(*) AS cnt FROM {schema}.records WHERE side = 'right'")
                stats["records_right"] = int((cur.fetchone() or {}).get("cnt", 0) or 0)

                cur.execute(f"SELECT AVG(LENGTH(contextual_content)) AS avg_len FROM {schema}.records WHERE side = 'left'")
                stats["avg_chars_left"] = float((cur.fetchone() or {}).get("avg_len") or 0.0)
                cur.execute(f"SELECT AVG(LENGTH(contextual_content)) AS avg_len FROM {schema}.records WHERE side = 'right'")
                stats["avg_chars_right"] = float((cur.fetchone() or {}).get("avg_len") or 0.0)

                n_left = stats["records_left"] or 0
                n_right = stats["records_right"] or 0
                est_embed_chars = (stats["avg_chars_left"] or 0) * n_left + (stats["avg_chars_right"] or 0) * n_right
                stats["est_embed_tokens"] = int(est_embed_chars / 4) if est_embed_chars else 0
        except Exception:
            pass

    # If comparator stored persisted timings in JSON status_message, surface them here.
    try:
        parsed = json.loads(job.get("status_message") or "")
        if isinstance(parsed, dict) and isinstance(parsed.get("metrics"), dict):
            stats["timings_ms"] = parsed["metrics"]
    except Exception:
        pass

    return {"config": cfg, "stats": stats}


@router.get("/{job_id}/runs/{run_id}/review/next", response_model=ReviewItem)
def next_review_item(
    job_id: int,
    run_id: int,
    min_score: float = 0.0,
    offset: int = 0,
    include_decided: bool = False,
):
    job = _job_or_404(job_id)
    _run_or_404(run_id, job_id)
    schema      = job["schema_name"]
    match_table = f"run_{run_id}_matches"
    dec_table   = f"run_{run_id}_decisions"

    if include_decided:
        query = f"""
            SELECT r.id, r.contextual_content, r.display_value
            FROM {schema}.records r
            JOIN {schema}.{match_table} m ON m.left_id = r.id AND m.rank = 1
            WHERE r.side = 'left'
              AND m.final_score >= %s
            ORDER BY r.id
            LIMIT 1 OFFSET %s
        """
    else:
        query = f"""
            SELECT r.id, r.contextual_content, r.display_value
            FROM {schema}.records r
            JOIN {schema}.{match_table} m ON m.left_id = r.id AND m.rank = 1
            LEFT JOIN {schema}.{dec_table} d ON d.left_id = r.id
            WHERE r.side = 'left'
              AND d.left_id IS NULL
              AND m.final_score >= %s
            ORDER BY r.id
            LIMIT 1 OFFSET %s
        """

    with get_cursor() as (cur, _conn):
        cur.execute(query, [min_score, offset])
        left_row = cur.fetchone()

    if not left_row:
        raise HTTPException(status_code=404, detail="No more rows to review")

    left_id = left_row["id"]

    with get_cursor() as (cur, _conn):
        cur.execute(
            f"""
            SELECT m.right_id, m.cosine_score, m.rerank_score, m.llm_score, m.final_score, m.rank,
                   r.contextual_content, r.display_value
            FROM {schema}.{match_table} m
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
            rerank_score=float(mr["rerank_score"]) if mr["rerank_score"] is not None else None,
            llm_score=float(mr["llm_score"]) if mr["llm_score"] is not None else None,
            final_score=float(mr["final_score"] or 0),
            rank=mr["rank"],
        )
        for mr in match_rows
    ]

    with get_cursor() as (cur, _conn):
        cur.execute(
            f"SELECT matched_right_id FROM {schema}.{dec_table} WHERE left_id = %s",
            [left_id],
        )
        dec = cur.fetchone()

    return ReviewItem(
        left_id=left_id,
        contextual_content=left_row["contextual_content"] or "",
        display_value=left_row["display_value"],
        candidates=candidates,
        current_decision=dec["matched_right_id"] if dec else None,
        is_decided=dec is not None,
    )


@router.post("/{job_id}/runs/{run_id}/review/{left_id}", status_code=204)
def submit_decision(job_id: int, run_id: int, left_id: int, data: CompareDecision):
    job = _job_or_404(job_id)
    _run_or_404(run_id, job_id)
    schema    = job["schema_name"]
    dec_table = f"run_{run_id}_decisions"

    with get_cursor() as (cur, _conn):
        cur.execute(
            f"""
            INSERT INTO {schema}.{dec_table} (left_id, matched_right_id, decided_at)
            VALUES (%s, %s, NOW())
            ON CONFLICT (left_id) DO UPDATE
                SET matched_right_id = EXCLUDED.matched_right_id,
                    decided_at = NOW()
            """,
            [left_id, data.matched_right_id],
        )


# ── Run export ────────────────────────────────────────────────────────────

@router.get("/{job_id}/runs/{run_id}/export")
def export_run(job_id: int, run_id: int, type: str = "confirmed"):
    job = _job_or_404(job_id)
    if job["status"] != "ready":
        raise HTTPException(status_code=400, detail=f"Job not ready (status: {job['status']})")

    if type not in ("raw", "confirmed"):
        raise HTTPException(status_code=400, detail="type must be 'raw' or 'confirmed'")

    schema = job["schema_name"]
    label_l = job.get("label_left", "Left")
    label_r = job.get("label_right", "Right")
    name_slug = job["name"].lower().replace(" ", "-")

    match_table = f"run_{run_id}_matches"
    dec_table   = f"run_{run_id}_decisions"
    buffer = io.BytesIO()

    if type == "raw":
        with get_cursor() as (cur, _conn):
            cur.execute(
                f"""
                SELECT
                    lr.original_row       AS left_row,
                    lr.display_value      AS left_display,
                    lr.contextual_content AS left_contextual,
                    m.rank,
                    rr.original_row       AS right_row,
                    rr.display_value      AS right_display,
                    rr.contextual_content AS right_contextual,
                    m.cosine_score,
                    m.rerank_score,
                    m.llm_score,
                    m.final_score
                FROM {schema}.{match_table} m
                JOIN {schema}.records lr ON lr.id = m.left_id
                JOIN {schema}.records rr ON rr.id = m.right_id
                ORDER BY lr.original_row ASC, m.rank ASC
                """,
            )
            rows = [dict(r) for r in cur.fetchall()]

        df = pd.DataFrame(rows) if rows else pd.DataFrame()
        if not df.empty:
            df.columns = [
                f"{label_l} Row", f"{label_l} Display", f"{label_l} Content",
                "Rank",
                f"{label_r} Row", f"{label_r} Display", f"{label_r} Content",
                "Cosine Score", "Rerank Score", "LLM Score", "Final Score",
            ]
        with pd.ExcelWriter(buffer, engine="openpyxl") as writer:
            df.to_excel(writer, sheet_name="All Matches", index=False)

        filename = f"{name_slug}_lens_compare_raw.xlsx"

    else:
        with pd.ExcelWriter(buffer, engine="openpyxl") as writer:

            # Sheet 1: Confirmed Matches
            with get_cursor() as (cur, _conn):
                cur.execute(
                    f"""
                    SELECT
                        lr.original_row       AS left_row,
                        lr.display_value      AS left_display,
                        lr.contextual_content AS left_contextual,
                        rr.original_row       AS right_row,
                        rr.display_value      AS right_display,
                        rr.contextual_content AS right_contextual,
                        m.cosine_score,
                        m.rerank_score,
                        m.llm_score,
                        m.final_score,
                        d.decided_at
                    FROM {schema}.{dec_table} d
                    JOIN {schema}.records lr ON lr.id = d.left_id
                    JOIN {schema}.records rr ON rr.id = d.matched_right_id
                    JOIN {schema}.{match_table} m
                        ON m.left_id = d.left_id AND m.right_id = d.matched_right_id
                    WHERE d.matched_right_id IS NOT NULL
                    ORDER BY lr.original_row ASC
                    """,
                )
                confirmed_rows = [dict(r) for r in cur.fetchall()]

            df_confirmed = pd.DataFrame(confirmed_rows) if confirmed_rows else pd.DataFrame()
            if not df_confirmed.empty:
                df_confirmed.columns = [
                    f"{label_l} Row", f"{label_l} Display", f"{label_l} Content",
                    f"{label_r} Row", f"{label_r} Display", f"{label_r} Content",
                    "Cosine Score", "Rerank Score", "LLM Score", "Final Score", "Decided At",
                ]
            df_confirmed.to_excel(writer, sheet_name="Confirmed Matches", index=False)

            # Sheet 2: Unique Left (no-match + unreviewed)
            with get_cursor() as (cur, _conn):
                cur.execute(
                    f"""
                    SELECT
                        lr.original_row       AS left_row,
                        lr.display_value      AS left_display,
                        lr.contextual_content AS left_contextual,
                        CASE WHEN d.left_id IS NOT NULL THEN 'no match' ELSE '' END AS human_review
                    FROM {schema}.records lr
                    LEFT JOIN {schema}.{dec_table} d
                        ON d.left_id = lr.id AND d.matched_right_id IS NULL
                    LEFT JOIN {schema}.{dec_table} d2
                        ON d2.left_id = lr.id AND d2.matched_right_id IS NOT NULL
                    WHERE lr.side = 'left'
                      AND d2.left_id IS NULL
                    ORDER BY lr.original_row ASC
                    """,
                )
                unique_left_rows = [dict(r) for r in cur.fetchall()]

            df_unique_left = pd.DataFrame(unique_left_rows) if unique_left_rows else pd.DataFrame()
            if not df_unique_left.empty:
                df_unique_left.columns = [
                    f"{label_l} Row", f"{label_l} Display", f"{label_l} Content", "Human Review",
                ]
            df_unique_left.to_excel(writer, sheet_name=f"Unique {label_l}", index=False)

            # Sheet 3: Unique Right (never selected)
            with get_cursor() as (cur, _conn):
                cur.execute(
                    f"""
                    SELECT rr.original_row AS right_row, rr.display_value AS right_display,
                           rr.contextual_content AS right_contextual
                    FROM {schema}.records rr
                    WHERE rr.side = 'right'
                      AND rr.id NOT IN (
                          SELECT matched_right_id FROM {schema}.{dec_table}
                          WHERE matched_right_id IS NOT NULL
                      )
                    ORDER BY rr.original_row ASC
                    """,
                )
                unique_right_rows = [dict(r) for r in cur.fetchall()]

            df_unique_right = pd.DataFrame(unique_right_rows) if unique_right_rows else pd.DataFrame()
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
    return {
        "id": row["id"],
        "name": row["name"],
        "notes": row.get("notes"),
        "label_left": row["label_left"],
        "label_right": row["label_right"],
        "sheet_name_left": row.get("sheet_name_left"),
        "sheet_name_right": row.get("sheet_name_right"),
        "row_filters_left": _decode_job_filters(row.get("row_filters_left")),
        "row_filters_right": _decode_job_filters(row.get("row_filters_right")),
        "schema_name": row["schema_name"],
        "status": row["status"],
        "status_message": _safe_status_message(row.get("status_message")),
        "row_count_left": row.get("row_count_left"),
        "row_count_right": row.get("row_count_right"),
        "embed_url": row.get("embed_url"),
        "embed_model": row.get("embed_model"),
        "created_at": row["created_at"],
    }


def _serialize_run(row: dict) -> dict:
    return {
        "id": row["id"],
        "job_id": row["job_id"],
        "name": row.get("name"),
        "status": row["status"],
        "status_message": row.get("status_message"),
        "top_k": row["top_k"],
        "vector_enabled": row["vector_enabled"],
        "reranker_enabled": row["reranker_enabled"],
        "reranker_model": row.get("reranker_model"),
        "reranker_url": row.get("reranker_url"),
        "llm_judge_enabled": row["llm_judge_enabled"],
        "llm_judge_url": row.get("llm_judge_url"),
        "llm_judge_model": row.get("llm_judge_model"),
        "llm_judge_prompt": row.get("llm_judge_prompt"),
        "row_count_left": row.get("row_count_left"),
        "created_at": row["created_at"],
        "completed_at": row.get("completed_at"),
    }


def _run_or_404(run_id: int, job_id: int) -> dict:
    with get_cursor() as (cur, _conn):
        cur.execute(
            "SELECT * FROM public.compare_runs WHERE id = %s AND job_id = %s",
            [run_id, job_id],
        )
        row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Run not found")
    return dict(row)


def _run_response(run_id: int) -> CompareRunResponse:
    with get_cursor() as (cur, _conn):
        cur.execute("SELECT * FROM public.compare_runs WHERE id = %s", [run_id])
        row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Run not found")
    return CompareRunResponse(**_serialize_run(dict(row)))


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
    return CompareJobResponse(**_serialize_job(job))

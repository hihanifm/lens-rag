"""
compare_router.py — FastAPI routes for the Compare project flavor.

Preset templates (`/compare/prompt-templates`) use shared DB rows (optional starters may be
seeded at init); canonical Compare LLM judge text when a run has no custom prompt is still
defined in code (`comparator`), not by seeded rows.

Job-level routes:
  POST /compare/preview-left          upload left file → columns + tmp_path
  POST /compare/preview-right         upload right file → columns + tmp_path
  POST /compare/preview-context       preview merged text strings
  POST /compare/preview-row-stats     row counts after sheet + filters
  POST /compare/preview-column-values distinct values for a column (filter picker)
  POST /compare/preview-column-samples   first N row(s) per column (column picker; default 1)
  GET  /compare/llm-judge-defaults      built-in default judge prompt + suffix snippet + token settings
  GET  /compare/prompt-templates       list LLM judge preset names (id + name)
  GET  /compare/prompt-templates/{id}  full preset body
  POST /compare/prompt-templates       create preset
  PATCH /compare/prompt-templates/{id} update preset
  DELETE /compare/prompt-templates/{id} delete preset
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
  PATCH /compare/{job_id}/runs/{run_id}                rename run
  GET  /compare/{job_id}/runs/{run_id}/execute          SSE: run pipeline (Phase 2); optional ?max_left_rows=N
  GET  /compare/{job_id}/runs/{run_id}/review           stats
  GET  /compare/{job_id}/runs/{run_id}/review/next      next ReviewItem (?text_contains= left or candidate-right text)
  POST /compare/{job_id}/runs/{run_id}/review/{left_id} submit decision
  DELETE /compare/{job_id}/runs/{run_id}/review/{left_id} clear decision (back to pending)
  POST /compare/{job_id}/runs/{run_id}/retry-llm-judge/{left_id}  re-run LLM judge for one left row (stored candidates)
  GET  /compare/{job_id}/runs/{run_id}/export           Excel download
  DELETE /compare/{job_id}/runs/{run_id}                delete run
"""
import io
import json
import logging
import os
import pathlib
import re
import shutil
import tempfile
import threading
import time

import yaml

import pandas as pd
import psycopg2
from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import Response, StreamingResponse

from comparator import (
    DEFAULT_LLM_JUDGE_PROMPT,
    LLM_JUDGE_PROMPT_SUFFIX,
    LLM_JUDGE_TEMPERATURE,
    rerun_llm_judge_for_left,
    run_ingest_job,
    run_pipeline,
)
from config import (
    COMPARE_PIPELINE_MAX_LEFT_ROWS_CAP,
    COMPARE_UPLOADS_DIR,
    EMBEDDING_DIMS,
    LLM_JUDGE_MAX_REQUESTS_PER_MINUTE,
    LLM_JUDGE_MAX_TOKENS,
    OLLAMA_BASE_URL,
)
from db import (
    create_compare_schema,
    create_run_tables,
    drop_compare_schema,
    drop_run_tables,
    get_cursor,
    validate_pgvector_embedding_dims,
)
from embedder import (
    embed as _embed_probe,
    effective_embed_model as _effective_embed_model,
    effective_llm_judge_model as _effective_llm_judge_model,
)
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
    CompareLlmJudgeDefaultsResponse,
    ComparePreviewColumnValuesRequest,
    ComparePreviewColumnValuesResponse,
    ComparePreviewColumnSamplesRequest,
    ComparePreviewColumnSamplesResponse,
    ComparePreviewRowStatsRequest,
    ComparePreviewRowStatsResponse,
    ComparePromptTemplateCreate,
    ComparePromptTemplateResponse,
    ComparePromptTemplateSummary,
    ComparePromptTemplateUpdate,
    CompareRunCreate,
    CompareRunResponse,
    CompareRunUpdate,
    CompareRowFilter,
    ReviewItem,
)

logger = logging.getLogger("lens.compare_router")

_REVIEW_OUTCOME_VALUES = frozenset({"no_match", "partial", "fail", "system_fail"})
router = APIRouter()


def _dedupe_matched_right_ids(ids: list) -> list[int]:
    seen: set[int] = set()
    out: list[int] = []
    for x in ids:
        if x is None:
            continue
        xi = int(x)
        if xi not in seen:
            seen.add(xi)
            out.append(xi)
    return out


def _effective_ids_from_dec_row(dec: dict | None) -> list[int]:
    if not dec:
        return []
    raw = dec.get("matched_right_ids")
    if raw is not None:
        got = list(raw) if not isinstance(raw, list) else raw
        return _dedupe_matched_right_ids(got)
    mid = dec.get("matched_right_id")
    if mid is not None:
        return [int(mid)]
    return []


def _resolve_submit_matched_right_ids(data: CompareDecision, outcome: str | None) -> list[int]:
    if outcome == "no_match":
        return []
    if data.matched_right_ids is not None:
        return _dedupe_matched_right_ids(data.matched_right_ids)
    if data.matched_right_id is not None:
        return [int(data.matched_right_id)]
    return []

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


def _coerce_llm_judge_meta(v) -> dict | None:
    """Normalize JSONB / string from Postgres into a dict for API models."""
    if v is None:
        return None
    if isinstance(v, dict):
        return v
    if isinstance(v, str):
        try:
            return json.loads(v)
        except Exception:
            return None
    return None


def _llm_judge_meta_for_excel_cell(meta) -> str:
    if meta is None:
        return ""
    if isinstance(meta, dict):
        return json.dumps(meta, ensure_ascii=False)
    return str(meta)


_REVIEW_TEXT_CONTAINS_MAX_LEN = 500


def _review_text_contains_clause(schema: str, match_table: str, raw: str | None) -> tuple[str, list]:
    """SQL fragment + binds: left contextual/display matches, OR any candidate right row for this run matches."""
    if not raw:
        return "", []
    t = raw.strip()
    if not t:
        return "", []
    if len(t) > _REVIEW_TEXT_CONTAINS_MAX_LEN:
        raise HTTPException(status_code=422, detail="text_contains exceeds maximum length")
    esc = t.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    pat = f"%{esc}%"
    fragment = (
        " AND ("
        " (r.contextual_content ILIKE %s ESCAPE '\\' OR COALESCE(r.display_value, '') ILIKE %s ESCAPE '\\')"
        " OR EXISTS ("
        f" SELECT 1 FROM {schema}.{match_table} mx"
        f" INNER JOIN {schema}.records rr ON rr.id = mx.right_id AND rr.side = 'right'"
        " WHERE mx.left_id = r.id"
        "   AND (rr.contextual_content ILIKE %s ESCAPE '\\' OR COALESCE(rr.display_value, '') ILIKE %s ESCAPE '\\')"
        " )"
        ")"
    )
    return fragment, [pat, pat, pat, pat]


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

    samples: list[str] = []
    n = max(1, min(int(body.n or 3), 5))
    # Stream rows — to_dict(orient="records") materializes every row and is very slow on large sheets.
    col_list = list(df.columns)
    for tup in df.itertuples(index=False, name=None):
        row = dict(zip(col_list, tup))
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
    """First n row(s) per column (strings), after sheet selection and row filters."""
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

    n = max(1, min(int(body.n or 1), 10))
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

    try:
        validate_pgvector_embedding_dims(resolved_dims)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

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
                embed_dims, embed_url, embed_api_key, embed_model,
                embed_query_prefix, embed_doc_prefix,
                all_columns_left, all_columns_right
            ) VALUES (
                %s, %s, %s, 'compare_placeholder',
                %s, %s, %s,
                %s, %s, %s,
                %s, %s,
                %s, %s,
                %s, %s,
                %s, %s,
                %s, %s, %s, %s,
                %s, %s,
                %s, %s
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
                data.embed_query_prefix if data.embed_query_prefix is not None else None,
                data.embed_doc_prefix   if data.embed_doc_prefix   is not None else None,
                data.all_columns_left or [], data.all_columns_right or [],
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

    # Persist the original Excel files so per-run LLM judge column selection can re-read them.
    # Derive extensions from original filenames to preserve pandas engine detection.
    left_ext  = pathlib.Path(data.source_filename_left  or "").suffix or ".xlsx"
    right_ext = pathlib.Path(data.source_filename_right or "").suffix or ".xlsx"
    job_dir   = os.path.join(COMPARE_UPLOADS_DIR, str(job_id))
    try:
        os.makedirs(job_dir, exist_ok=True)
        perm_left  = os.path.join(job_dir, f"left{left_ext}")
        perm_right = os.path.join(job_dir, f"right{right_ext}")
        shutil.move(data.tmp_path_left,  perm_left)
        shutil.move(data.tmp_path_right, perm_right)
        with get_cursor() as (cur, _conn):
            cur.execute(
                "UPDATE public.compare_jobs SET tmp_path_left=%s, tmp_path_right=%s WHERE id=%s",
                [perm_left, perm_right, job_id],
            )
    except Exception as e:
        logger.error("compare create: failed to persist upload files for job_id=%d — %s", job_id, e)
        shutil.rmtree(job_dir, ignore_errors=True)
        from db import drop_compare_schema as _drop
        _drop(job_id)
        raise HTTPException(status_code=500, detail=f"Failed to persist upload files: {e}")

    return _job_response(job_id)


@router.get("/", response_model=list[CompareJobResponse])
def list_compare_jobs():
    with get_cursor() as (cur, _conn):
        cur.execute(
            "SELECT * FROM public.compare_jobs ORDER BY created_at DESC"
        )
        rows = cur.fetchall()
    return [_serialize_job(dict(r)) for r in rows]


@router.get("/llm-judge-defaults", response_model=CompareLlmJudgeDefaultsResponse)
def get_llm_judge_defaults():
    """
    Expose the built-in judge prompt used when `llm_judge_prompt` is empty, plus the suffix
    snippet for UI reference (that suffix is part of the default blob only — custom run prompts
    replace the entire system message).
    """
    return CompareLlmJudgeDefaultsResponse(
        default_system_prompt=DEFAULT_LLM_JUDGE_PROMPT,
        fixed_suffix=LLM_JUDGE_PROMPT_SUFFIX,
        max_tokens=LLM_JUDGE_MAX_TOKENS,
        temperature=LLM_JUDGE_TEMPERATURE,
        default_max_requests_per_minute=max(0, LLM_JUDGE_MAX_REQUESTS_PER_MINUTE),
        default_llm_judge_url=OLLAMA_BASE_URL or "",
        default_llm_judge_model=_effective_llm_judge_model() or "",
    )


def _serialize_prompt_template_row(row: dict) -> ComparePromptTemplateResponse:
    return ComparePromptTemplateResponse(
        id=row["id"],
        name=row["name"],
        body=row["body"],
        version=int(row.get("version") or 1),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


@router.get("/prompt-templates", response_model=list[ComparePromptTemplateSummary])
def list_prompt_templates():
    """Named LLM judge domain overlays (id + name + version); fetch full body via GET …/prompt-templates/{id}."""
    with get_cursor() as (cur, _conn):
        cur.execute(
            """
            SELECT id, name, version FROM public.compare_llm_prompt_templates
            ORDER BY name ASC
            """
        )
        rows = cur.fetchall()
    return [
        ComparePromptTemplateSummary(
            id=r["id"], name=r["name"], version=int(r.get("version") or 1)
        )
        for r in rows
    ]


@router.get("/prompt-templates/{template_id}", response_model=ComparePromptTemplateResponse)
def get_prompt_template(template_id: int):
    with get_cursor() as (cur, _conn):
        cur.execute(
            "SELECT * FROM public.compare_llm_prompt_templates WHERE id = %s",
            [template_id],
        )
        row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Prompt template not found")
    return _serialize_prompt_template_row(dict(row))


@router.post("/prompt-templates", response_model=ComparePromptTemplateResponse)
def create_prompt_template(data: ComparePromptTemplateCreate):
    name = data.name.strip()
    body = (data.body or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="name cannot be empty")
    if not body:
        raise HTTPException(status_code=422, detail="body cannot be empty")
    try:
        with get_cursor() as (cur, _conn):
            cur.execute(
                """
                INSERT INTO public.compare_llm_prompt_templates (name, body, version)
                VALUES (%s, %s, 1)
                RETURNING *
                """,
                [name, body],
            )
            row = cur.fetchone()
    except psycopg2.IntegrityError as e:
        if getattr(e, "pgcode", None) == "23505":
            raise HTTPException(
                status_code=409,
                detail="A preset with this name already exists.",
            )
        raise
    return _serialize_prompt_template_row(dict(row))


@router.patch("/prompt-templates/{template_id}", response_model=ComparePromptTemplateResponse)
def update_prompt_template(template_id: int, data: ComparePromptTemplateUpdate):
    patch = data.model_dump(exclude_unset=True)
    with get_cursor() as (cur, _conn):
        cur.execute(
            "SELECT * FROM public.compare_llm_prompt_templates WHERE id = %s",
            [template_id],
        )
        old_row = cur.fetchone()
    if not old_row:
        raise HTTPException(status_code=404, detail="Prompt template not found")
    old = dict(old_row)

    if not patch:
        return _serialize_prompt_template_row(old)

    if "name" in patch and patch["name"] is not None:
        patch["name"] = str(patch["name"]).strip()
        if not patch["name"]:
            raise HTTPException(status_code=422, detail="name cannot be empty")
    if "body" in patch and patch["body"] is not None:
        patch["body"] = str(patch["body"]).strip()
        if not patch["body"]:
            raise HTTPException(status_code=422, detail="body cannot be empty")

    bump_version = False
    if "body" in patch and patch["body"] != old.get("body"):
        bump_version = True

    sets = []
    vals = []
    if "name" in patch:
        sets.append("name = %s")
        vals.append(patch["name"])
    if "body" in patch:
        sets.append("body = %s")
        vals.append(patch["body"])
    if bump_version:
        sets.append("version = version + 1")
    sets.append("updated_at = NOW()")
    vals.append(template_id)

    try:
        with get_cursor() as (cur, _conn):
            cur.execute(
                f"""
                UPDATE public.compare_llm_prompt_templates
                SET {", ".join(sets)}
                WHERE id = %s
                RETURNING *
                """,
                vals,
            )
            row = cur.fetchone()
    except psycopg2.IntegrityError as e:
        if getattr(e, "pgcode", None) == "23505":
            raise HTTPException(
                status_code=409,
                detail="A preset with this name already exists.",
            )
        raise
    if not row:
        raise HTTPException(status_code=404, detail="Prompt template not found")
    return _serialize_prompt_template_row(dict(row))


@router.delete("/prompt-templates/{template_id}")
def delete_prompt_template(template_id: int):
    with get_cursor() as (cur, _conn):
        cur.execute(
            "DELETE FROM public.compare_llm_prompt_templates WHERE id = %s RETURNING id",
            [template_id],
        )
        deleted = cur.fetchone()
    if not deleted:
        raise HTTPException(status_code=404, detail="Prompt template not found")
    return {"ok": True}


@router.get("/{job_id}", response_model=CompareJobResponse)
def get_compare_job(job_id: int):
    return _job_response(job_id)


# ── Config export / import ────────────────────────────────────────────────

def _job_to_yaml_dict(row: dict) -> dict:
    left_cols = list(row.get("context_columns_left") or [])
    if row.get("content_column_left") and row["content_column_left"] not in left_cols:
        left_cols.append(row["content_column_left"])
    right_cols = list(row.get("context_columns_right") or [])
    if row.get("content_column_right") and row["content_column_right"] not in right_cols:
        right_cols.append(row["content_column_right"])
    return {
        "name": row["name"],
        "label_left": row.get("label_left") or "Left",
        "label_right": row.get("label_right") or "Right",
        "left_file": row.get("source_filename_left") or "left.xlsx",
        "right_file": row.get("source_filename_right") or "right.xlsx",
        "sheet_left": row.get("sheet_name_left"),
        "sheet_right": row.get("sheet_name_right"),
        "left_columns": left_cols,
        "right_columns": right_cols,
        "display_column_left": row.get("display_column_left"),
        "display_column_right": row.get("display_column_right"),
        "embed_url": row.get("embed_url") or OLLAMA_BASE_URL,
        "embed_model": row.get("embed_model") or _effective_embed_model(),
        "embed_query_prefix": row.get("embed_query_prefix"),
        "embed_doc_prefix": row.get("embed_doc_prefix"),
        # run-level fields — defaults (overwritten by _run_to_yaml_dict on run export)
        "top_k": 5,
        "vector_enabled": True,
        "reranker_enabled": False,
        "reranker_url": None,
        "reranker_model": None,
        "llm_judge_enabled": False,
        "llm_judge_url": OLLAMA_BASE_URL,
        "llm_judge_model": _effective_llm_judge_model() or None,
        "llm_judge_prompt": None,
        "llm_judge_max_requests_per_minute": None,
        "llm_left_columns": [],
        "llm_right_columns": [],
    }


def _run_to_yaml_dict(row: dict) -> dict:
    return {
        "top_k": row["top_k"],
        "vector_enabled": row["vector_enabled"],
        "reranker_enabled": row["reranker_enabled"],
        "reranker_url": row.get("reranker_url"),
        "reranker_model": row.get("reranker_model"),
        "llm_judge_enabled": row["llm_judge_enabled"],
        "llm_judge_url": row.get("llm_judge_url") or OLLAMA_BASE_URL,
        "llm_judge_model": row.get("llm_judge_model") or _effective_llm_judge_model() or None,
        "llm_judge_prompt": row.get("llm_judge_prompt"),
        "llm_judge_max_requests_per_minute": row.get("llm_judge_max_requests_per_minute"),
        "llm_left_columns": row.get("llm_judge_left_columns") or [],
        "llm_right_columns": row.get("llm_judge_right_columns") or [],
    }


@router.get("/{job_id}/export-config")
def export_job_config(job_id: int, run_id: int | None = Query(default=None)):
    """Download compare.yml for a job. Pass ?run_id=N to merge run values into the file."""
    job = _job_or_404(job_id)
    d = _job_to_yaml_dict(job)
    if run_id is not None:
        with get_cursor() as (cur, _conn):
            cur.execute(
                "SELECT * FROM public.compare_runs WHERE id = %s AND job_id = %s",
                [run_id, job_id],
            )
            run_row = cur.fetchone()
        if not run_row:
            raise HTTPException(status_code=404, detail="Run not found")
        d.update(_run_to_yaml_dict(dict(run_row)))
    body = yaml.dump(d, allow_unicode=True, sort_keys=False, default_flow_style=False)
    return Response(
        body,
        media_type="text/yaml",
        headers={"Content-Disposition": 'attachment; filename="compare.yml"'},
    )


@router.post("/import-config")
async def import_compare_config(
    config: UploadFile = File(...),
    left_file: UploadFile = File(...),
    right_file: UploadFile = File(...),
):
    """Parse + validate compare.yml against the two Excel files. Returns parsed config + tmp paths."""
    try:
        cfg = yaml.safe_load(await config.read()) or {}
    except yaml.YAMLError as e:
        raise HTTPException(status_code=400, detail=f"Invalid YAML: {e}")

    # Filename check
    yaml_left = cfg.get("left_file") or ""
    yaml_right = cfg.get("right_file") or ""
    if yaml_left and left_file.filename != yaml_left:
        raise HTTPException(
            status_code=400,
            detail=f"left_file mismatch: config says '{yaml_left}', uploaded '{left_file.filename}'",
        )
    if yaml_right and right_file.filename != yaml_right:
        raise HTTPException(
            status_code=400,
            detail=f"right_file mismatch: config says '{yaml_right}', uploaded '{right_file.filename}'",
        )

    left_bytes = await left_file.read()
    right_bytes = await right_file.read()

    try:
        df_left = pd.read_excel(io.BytesIO(left_bytes), nrows=0, dtype=str)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Cannot read left file: {e}")
    try:
        df_right = pd.read_excel(io.BytesIO(right_bytes), nrows=0, dtype=str)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Cannot read right file: {e}")

    # Column check
    missing_left = [c for c in (cfg.get("left_columns") or []) if c not in df_left.columns]
    missing_right = [c for c in (cfg.get("right_columns") or []) if c not in df_right.columns]
    if missing_left or missing_right:
        raise HTTPException(
            status_code=400,
            detail={
                "message": "Column mismatch between config and uploaded files",
                "missing_left": missing_left,
                "missing_right": missing_right,
            },
        )

    # Write to tmp files (same pattern as _preview_file)
    left_ext = pathlib.Path(left_file.filename).suffix or ".xlsx"
    right_ext = pathlib.Path(right_file.filename).suffix or ".xlsx"
    with tempfile.NamedTemporaryFile(delete=False, suffix=left_ext) as tmp:
        tmp.write(left_bytes)
        tmp_left = tmp.name
    with tempfile.NamedTemporaryFile(delete=False, suffix=right_ext) as tmp:
        tmp.write(right_bytes)
        tmp_right = tmp.name

    return {
        "config": cfg,
        "tmp_path_left": tmp_left,
        "tmp_path_right": tmp_right,
        "columns_left": list(df_left.columns),
        "columns_right": list(df_right.columns),
    }


@router.post("/parse-yaml")
async def parse_compare_yaml(request: Request):
    """Parse raw YAML text and return as JSON (for run config pre-fill in the UI)."""
    body = await request.body()
    try:
        cfg = yaml.safe_load(body) or {}
    except yaml.YAMLError as e:
        raise HTTPException(status_code=400, detail=f"Invalid YAML: {e}")
    return cfg


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
    shutil.rmtree(os.path.join(COMPARE_UPLOADS_DIR, str(job_id)), ignore_errors=True)
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
    if not data.vector_enabled:
        if not data.llm_judge_enabled:
            raise HTTPException(
                status_code=422,
                detail="When vector retrieval is off, LLM judge must be enabled to score left×right pairs.",
            )
        if not (data.llm_judge_url or "").strip() or not (data.llm_judge_model or "").strip():
            raise HTTPException(
                status_code=422,
                detail="LLM-only runs require llm_judge_url and llm_judge_model.",
            )

    prompt_snap = (data.llm_judge_prompt or "").strip()
    preset_tag = (data.llm_judge_prompt_preset_tag or "").strip()[:240] or None
    if not data.llm_judge_enabled or not prompt_snap:
        preset_tag = None

    with get_cursor() as (cur, _conn):
        notes_val = (data.notes or "").strip() or None
        llm_left_cols  = (data.llm_judge_left_columns  or []) if data.llm_judge_enabled else None
        llm_right_cols = (data.llm_judge_right_columns or []) if data.llm_judge_enabled else None
        cur.execute("""
            INSERT INTO public.compare_runs
                (job_id, name, status, top_k, vector_enabled,
                 llm_compare_max_rights,
                 reranker_enabled, reranker_model, reranker_url,
                 llm_judge_enabled, llm_judge_url, llm_judge_model, llm_judge_prompt,
                 llm_judge_prompt_preset_tag,
                 llm_judge_max_requests_per_minute, notes,
                 llm_judge_left_columns, llm_judge_right_columns)
            VALUES (%s, %s, 'pending', %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id
        """, [
            job_id,
            data.name or None,
            data.top_k,
            data.vector_enabled,
            data.llm_compare_max_rights if not data.vector_enabled else None,
            data.reranker_enabled,
            data.reranker_model or None,
            data.reranker_url or None,
            data.llm_judge_enabled,
            data.llm_judge_url or None,
            data.llm_judge_model or None,
            data.llm_judge_prompt or None,
            preset_tag,
            data.llm_judge_max_requests_per_minute if data.llm_judge_enabled else None,
            notes_val,
            llm_left_cols or None,
            llm_right_cols or None,
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


@router.patch("/{job_id}/runs/{run_id}", response_model=CompareRunResponse)
def patch_run(job_id: int, run_id: int, data: CompareRunUpdate):
    _job_or_404(job_id)
    _run_or_404(run_id, job_id)
    payload = data.model_dump(exclude_unset=True)
    if not payload:
        return _run_response(run_id)
    sets: list[str] = []
    vals: list = []
    if "name" in payload:
        raw = payload["name"]
        name_val = None if raw is None else ((raw or "").strip() or None)
        sets.append("name = %s")
        vals.append(name_val)
    if "notes" in payload:
        raw = payload["notes"]
        notes_val = None if raw is None else ((raw or "").strip() or None)
        sets.append("notes = %s")
        vals.append(notes_val)
    if not sets:
        return _run_response(run_id)
    vals.extend([run_id, job_id])
    with get_cursor() as (cur, _conn):
        cur.execute(
            f"UPDATE public.compare_runs SET {', '.join(sets)} WHERE id = %s AND job_id = %s",
            vals,
        )
    return _run_response(run_id)


@router.delete("/{job_id}/runs/{run_id}")
def delete_run(job_id: int, run_id: int):
    job = _job_or_404(job_id)
    _run_or_404(run_id, job_id)
    drop_run_tables(job["schema_name"], run_id)
    return {"ok": True}


# ── Run pipeline SSE ───────────────────────────────────────────────────────

@router.get("/{job_id}/runs/{run_id}/execute")
def execute_run(
    job_id: int,
    run_id: int,
    max_left_rows: int | None = Query(
        default=None,
        ge=1,
        le=COMPARE_PIPELINE_MAX_LEFT_ROWS_CAP,
        description=(
            "Optional: process only the first N left rows (by database id order). "
            "Omit for a full run — useful for quick model/settings checks."
        ),
    ),
):
    """
    SSE — Phase 2: run the search/rank pipeline for an existing run.

    Query `max_left_rows` optionally limits the pipeline to the first N left rows (id order)
    for faster iteration; omit for the full job.

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
            for event in run_pipeline(job_id, run_id, max_left_rows=max_left_rows):
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

        cur.execute(
            f"""
            SELECT COUNT(*) AS cnt FROM {schema}.{dec_table}
            WHERE NOT (
                (matched_right_ids IS NOT NULL AND COALESCE(cardinality(matched_right_ids), 0) > 0)
                OR (matched_right_id IS NOT NULL)
            )
            """
        )
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
                m.llm_judge_meta       AS llm_judge_meta,
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
    text_contains: str | None = Query(
        default=None,
        description="Substring match on left contextual/display text or any this-run candidate right row",
    ),
):
    job = _job_or_404(job_id)
    _run_or_404(run_id, job_id)
    schema      = job["schema_name"]
    match_table = f"run_{run_id}_matches"
    dec_table   = f"run_{run_id}_decisions"
    text_frag, text_params = _review_text_contains_clause(schema, match_table, text_contains)

    if include_decided:
        query = f"""
            SELECT r.id, r.contextual_content, r.display_value
            FROM {schema}.records r
            JOIN {schema}.{match_table} m ON m.left_id = r.id AND m.rank = 1
            WHERE r.side = 'left'
              AND m.final_score >= %s
              {text_frag}
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
              {text_frag}
            ORDER BY r.id
            LIMIT 1 OFFSET %s
        """

    q_params = [min_score, *text_params, offset]

    with get_cursor() as (cur, _conn):
        cur.execute(query, q_params)
        left_row = cur.fetchone()

    if not left_row:
        raise HTTPException(status_code=404, detail="No more rows to review")

    left_id = left_row["id"]

    with get_cursor() as (cur, _conn):
        cur.execute(
            f"""
            SELECT m.right_id, m.cosine_score, m.rerank_score, m.llm_score, m.llm_judge_meta, m.final_score, m.rank,
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
            llm_judge_meta=_coerce_llm_judge_meta(mr.get("llm_judge_meta")),
            final_score=float(mr["final_score"] or 0),
            rank=mr["rank"],
        )
        for mr in match_rows
    ]

    with get_cursor() as (cur, _conn):
        cur.execute(
            f"""
            SELECT matched_right_id, matched_right_ids, review_comment, review_outcome
            FROM {schema}.{dec_table} WHERE left_id = %s
            """,
            [left_id],
        )
        dec = cur.fetchone()

    raw_oc = (dec.get("review_outcome") if dec else None) or None
    norm_oc = raw_oc if raw_oc in _REVIEW_OUTCOME_VALUES else None
    eff_ids = _effective_ids_from_dec_row(dict(dec) if dec else None)

    return ReviewItem(
        left_id=left_id,
        contextual_content=left_row["contextual_content"] or "",
        display_value=left_row["display_value"],
        candidates=candidates,
        matched_right_ids=eff_ids,
        is_decided=dec is not None,
        review_comment=(dec.get("review_comment") or "") if dec else "",
        review_outcome=norm_oc,
    )


@router.post("/{job_id}/runs/{run_id}/review/{left_id}", status_code=204)
def submit_decision(job_id: int, run_id: int, left_id: int, data: CompareDecision):
    job = _job_or_404(job_id)
    _run_or_404(run_id, job_id)
    schema      = job["schema_name"]
    dec_table   = f"run_{run_id}_decisions"
    match_table = f"run_{run_id}_matches"

    outcome = data.review_outcome
    if outcome is not None and outcome not in _REVIEW_OUTCOME_VALUES:
        raise HTTPException(
            status_code=400,
            detail="review_outcome must be no_match, partial, fail, system_fail, or null",
        )

    ids = _resolve_submit_matched_right_ids(data, outcome)
    first_right = ids[0] if ids else None

    if ids:
        with get_cursor() as (cur, _conn):
            cur.execute(
                f"""
                SELECT m.right_id FROM {schema}.{match_table} m
                WHERE m.left_id = %s AND m.right_id = ANY(%s)
                """,
                [left_id, ids],
            )
            ok = {row["right_id"] for row in cur.fetchall()}
        missing = [rid for rid in ids if rid not in ok]
        if missing:
            raise HTTPException(
                status_code=400,
                detail=f"matched_right_ids not among candidates for this left row: {missing}",
            )

    with get_cursor() as (cur, _conn):
        cur.execute(
            f"""
            INSERT INTO {schema}.{dec_table}
                (left_id, matched_right_id, matched_right_ids, decided_at, review_comment, review_outcome)
            VALUES (%s, %s, %s, NOW(), %s, %s)
            ON CONFLICT (left_id) DO UPDATE
                SET matched_right_id = EXCLUDED.matched_right_id,
                    matched_right_ids = EXCLUDED.matched_right_ids,
                    decided_at = NOW(),
                    review_comment = EXCLUDED.review_comment,
                    review_outcome = EXCLUDED.review_outcome
            """,
            [left_id, first_right, ids, data.review_comment or "", outcome],
        )


@router.delete("/{job_id}/runs/{run_id}/review/{left_id}", status_code=204)
def clear_decision(job_id: int, run_id: int, left_id: int):
    """Remove the decision row so this left row is pending again."""
    job = _job_or_404(job_id)
    _run_or_404(run_id, job_id)
    schema = job["schema_name"]
    dec_table = f"run_{run_id}_decisions"

    with get_cursor() as (cur, _conn):
        cur.execute(f"DELETE FROM {schema}.{dec_table} WHERE left_id = %s", [left_id])


_RETRY_LLM_JUDGE_ERR = {
    "JOB_OR_RUN_NOT_FOUND": (404, "Job or run not found."),
    "JOB_NOT_READY": (400, "Job embeddings are not ready."),
    "RUN_NOT_READY": (400, "Run must be complete before retrying the judge."),
    "LLM_JUDGE_DISABLED": (400, "LLM judge is not enabled for this run."),
    "LLM_JUDGE_NOT_CONFIGURED": (400, "LLM judge URL or model is missing."),
    "NO_MATCHES_FOR_LEFT": (404, "No stored match rows for this left row — run the pipeline first."),
}


@router.post("/{job_id}/runs/{run_id}/retry-llm-judge/{left_id}")
def retry_llm_judge_endpoint(job_id: int, run_id: int, left_id: int):
    """Re-score one left row with the LLM judge using existing candidate rows (no vector/rerank rerun)."""
    try:
        return rerun_llm_judge_for_left(job_id, run_id, left_id)
    except ValueError as e:
        code = str(e)
        tup = _RETRY_LLM_JUDGE_ERR.get(code)
        if tup:
            raise HTTPException(status_code=tup[0], detail=tup[1])
        logger.exception("retry_llm_judge unexpected ValueError: %s", code)
        raise HTTPException(status_code=500, detail="Retry failed.") from e


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
                    m.llm_judge_meta,
                    m.final_score,
                    CASE COALESCE(d.review_outcome, '')
                        WHEN 'no_match' THEN 'no match'
                        WHEN 'partial' THEN 'partial'
                        WHEN 'fail' THEN 'fail'
                        WHEN 'system_fail' THEN 'system failure'
                        ELSE ''
                    END AS review_outcome_display,
                    COALESCE(d.review_comment, '') AS review_comment
                FROM {schema}.{match_table} m
                JOIN {schema}.records lr ON lr.id = m.left_id
                JOIN {schema}.records rr ON rr.id = m.right_id
                LEFT JOIN {schema}.{dec_table} d ON d.left_id = m.left_id
                ORDER BY lr.original_row ASC, m.rank ASC
                """,
            )
            rows = [dict(r) for r in cur.fetchall()]
        for r in rows:
            if "llm_judge_meta" in r:
                r["llm_judge_meta"] = _llm_judge_meta_for_excel_cell(r.get("llm_judge_meta"))

        df = pd.DataFrame(rows) if rows else pd.DataFrame()
        if not df.empty:
            df.columns = [
                f"{label_l} Row", f"{label_l} Display", f"{label_l} Content",
                "Rank",
                f"{label_r} Row", f"{label_r} Display", f"{label_r} Content",
                "Cosine Score", "Rerank Score", "LLM Score", "LLM Meta (JSON)", "Final Score",
                "Review Outcome",
                "Review Comment",
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
                        m.llm_judge_meta,
                        m.final_score,
                        CASE
                            WHEN d.matched_right_ids IS NOT NULL
                                AND COALESCE(cardinality(d.matched_right_ids), 0) > 0
                                THEN COALESCE(cardinality(d.matched_right_ids), 0)
                            WHEN d.matched_right_id IS NOT NULL THEN 1
                            ELSE 0
                        END AS selected_rights_count,
                        u.match_index,
                        CASE COALESCE(d.review_outcome, '')
                            WHEN 'no_match' THEN 'no match'
                            WHEN 'partial' THEN 'partial'
                            WHEN 'fail' THEN 'fail'
                            WHEN 'system_fail' THEN 'system failure'
                            ELSE 'matched'
                        END AS review_outcome_display,
                        COALESCE(d.review_comment, '') AS review_comment,
                        d.decided_at
                    FROM {schema}.{dec_table} d
                    JOIN LATERAL (
                        SELECT x.right_id, x.match_index
                        FROM unnest(
                            CASE
                                WHEN d.matched_right_ids IS NOT NULL
                                    AND COALESCE(cardinality(d.matched_right_ids), 0) > 0
                                    THEN d.matched_right_ids
                                WHEN d.matched_right_id IS NOT NULL
                                    THEN ARRAY[d.matched_right_id]::INTEGER[]
                                ELSE ARRAY[]::INTEGER[]
                            END
                        ) WITH ORDINALITY AS x(right_id, match_index)
                    ) u ON TRUE
                    JOIN {schema}.records lr ON lr.id = d.left_id
                    JOIN {schema}.records rr ON rr.id = u.right_id
                    JOIN {schema}.{match_table} m
                        ON m.left_id = d.left_id AND m.right_id = u.right_id
                    ORDER BY lr.original_row ASC, u.match_index ASC
                    """,
                )
                confirmed_rows = [dict(r) for r in cur.fetchall()]
            for r in confirmed_rows:
                if "llm_judge_meta" in r:
                    r["llm_judge_meta"] = _llm_judge_meta_for_excel_cell(r.get("llm_judge_meta"))

            df_confirmed = pd.DataFrame(confirmed_rows) if confirmed_rows else pd.DataFrame()
            if not df_confirmed.empty:
                df_confirmed.columns = [
                    f"{label_l} Row", f"{label_l} Display", f"{label_l} Content",
                    f"{label_r} Row", f"{label_r} Display", f"{label_r} Content",
                    "Cosine Score", "Rerank Score", "LLM Score", "LLM Meta (JSON)", "Final Score",
                    "Selected rights count",
                    "Match index",
                    "Review Outcome",
                    "Review Comment", "Decided At",
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
                        CASE
                            WHEN d.left_id IS NULL THEN ''
                            WHEN d.review_outcome = 'partial' THEN 'partial'
                            WHEN d.review_outcome = 'fail' THEN 'fail'
                            WHEN d.review_outcome = 'system_fail' THEN 'system failure'
                            WHEN d.review_outcome = 'no_match' THEN 'no match'
                            WHEN COALESCE(cardinality(d.matched_right_ids), 0) = 0
                                AND d.matched_right_id IS NULL THEN 'no match'
                            ELSE ''
                        END AS human_review,
                        COALESCE(d.review_comment, '') AS review_comment
                    FROM {schema}.records lr
                    LEFT JOIN {schema}.{dec_table} d ON d.left_id = lr.id
                    WHERE lr.side = 'left'
                      AND lr.id NOT IN (
                          SELECT left_id FROM {schema}.{dec_table}
                          WHERE (matched_right_ids IS NOT NULL
                                 AND COALESCE(cardinality(matched_right_ids), 0) > 0)
                             OR matched_right_id IS NOT NULL
                      )
                    ORDER BY lr.original_row ASC
                    """,
                )
                unique_left_rows = [dict(r) for r in cur.fetchall()]

            df_unique_left = pd.DataFrame(unique_left_rows) if unique_left_rows else pd.DataFrame()
            if not df_unique_left.empty:
                df_unique_left.columns = [
                    f"{label_l} Row", f"{label_l} Display", f"{label_l} Content",
                    "Human Review", "Review Comment",
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
                          SELECT DISTINCT rid FROM (
                              SELECT unnest(matched_right_ids) AS rid
                              FROM {schema}.{dec_table}
                              WHERE matched_right_ids IS NOT NULL
                                AND COALESCE(cardinality(matched_right_ids), 0) > 0
                              UNION ALL
                              SELECT matched_right_id AS rid
                              FROM {schema}.{dec_table}
                              WHERE matched_right_id IS NOT NULL
                          ) t WHERE rid IS NOT NULL
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
        "embed_dims": row.get("embed_dims"),
        "embed_query_prefix": row.get("embed_query_prefix"),
        "embed_doc_prefix":   row.get("embed_doc_prefix"),
        "all_columns_left":  row.get("all_columns_left")  or [],
        "all_columns_right": row.get("all_columns_right") or [],
        "context_columns_left":  row.get("context_columns_left") or [],
        "content_column_left":   row.get("content_column_left"),
        "context_columns_right": row.get("context_columns_right") or [],
        "content_column_right":  row.get("content_column_right"),
        "created_at": row["created_at"],
    }


def _serialize_run(row: dict) -> dict:
    return {
        "id": row["id"],
        "job_id": row["job_id"],
        "name": row.get("name"),
        "notes": row.get("notes"),
        "status": row["status"],
        "status_message": row.get("status_message"),
        "top_k": row["top_k"],
        "vector_enabled": row["vector_enabled"],
        "llm_compare_max_rights": row.get("llm_compare_max_rights"),
        "reranker_enabled": row["reranker_enabled"],
        "reranker_model": row.get("reranker_model"),
        "reranker_url": row.get("reranker_url"),
        "llm_judge_enabled": row["llm_judge_enabled"],
        "llm_judge_url": row.get("llm_judge_url"),
        "llm_judge_model": row.get("llm_judge_model"),
        "llm_judge_prompt": row.get("llm_judge_prompt"),
        "llm_judge_prompt_preset_tag": row.get("llm_judge_prompt_preset_tag"),
        "llm_judge_max_requests_per_minute": row.get("llm_judge_max_requests_per_minute"),
        "llm_judge_left_columns":  row.get("llm_judge_left_columns"),
        "llm_judge_right_columns": row.get("llm_judge_right_columns"),
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

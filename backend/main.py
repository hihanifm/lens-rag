import os
import json
import logging
import tempfile
import time
import threading
import mimetypes
from fastapi import FastAPI, UploadFile, File, HTTPException, BackgroundTasks, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
import pandas as pd
from starlette.responses import Response

from config import CORS_ORIGINS, TOP_K_DEFAULT, TOP_K_MAX, TOP_K_RETRIEVAL, ROOT_PATH, LOG_LEVEL
from config import (
    EMBEDDING_PROVIDER,
    EMBEDDING_MODEL,
    EMBEDDING_DIMS,
    RERANKER_ENABLED,
    RERANKER_MODEL,
)

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL.upper(), logging.DEBUG),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("lens.main")
from db import init_db, get_cursor
from models import ProjectCreate, ProjectUpdate, SearchRequest, EvalRequest, ClusterRequest, ClusterFilterItem, SystemConfigResponse
from projects import (
    create_project,
    get_all_projects,
    get_project,
    get_project_raw,
    delete_project,
    update_project,
    get_project_columns,
    update_project_status,
    verify_project_pin,
)
from ingestion import read_excel, ingest
from search import search as do_search, topic_search_stream
from evaluate import stream_ragas_export
from clustering import cluster as do_cluster, stream_cluster

app = FastAPI(title="LENS API", version="1.4.0", root_path=ROOT_PATH)
_STARTED_AT = time.time()

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup():
    logger.info("LENS API starting up (log level: %s)", LOG_LEVEL)
    # Some Linux images don't ship with a mime.types mapping for .xlsx/.xls, which can
    # cause downloads to be served as text/plain. Register explicitly for consistency.
    mimetypes.add_type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx")
    mimetypes.add_type("application/vnd.ms-excel", ".xls")
    init_db()
    logger.info("DB initialised")

_SAMPLES_DIR = os.environ.get("SAMPLES_DIR", "samples")
if os.path.isdir(_SAMPLES_DIR):
    app.mount("/samples", StaticFiles(directory=_SAMPLES_DIR), name="samples")

# Tracks live ingestion progress keyed by project_id.
# Written by background ingestion threads; read by SSE polling loop.
_ingest_progress: dict[int, dict] = {}


def _static_frontend_app():
  dist_dir = os.environ.get("FRONTEND_DIST_DIR", "frontend/dist")
  if not os.path.isdir(dist_dir):
    return None
  return StaticFiles(directory=dist_dir, html=True)


_FRONTEND = _static_frontend_app() if os.environ.get("SERVE_FRONTEND", "").lower() == "true" else None

# ── Projects ──────────────────────────────────────────────────────────────

def _check_pin(project_raw: dict, request: Request):
    stored = (project_raw.get("pin") or "").strip()
    if not stored:
        return
    provided = request.headers.get("X-Project-Pin", "")
    if provided != stored:
        raise HTTPException(status_code=401, detail="PIN required")


MAX_CLUSTER_FILTERS = 10
MAX_CLUSTER_SUBSTRING_TOTAL = 100  # cap OR predicates across all columns


def _cluster_item_values(item: ClusterFilterItem) -> list[str]:
    """Coalesce legacy single `value` and `values`; strip, dedupe, preserve order."""
    if item.values:
        raw = item.values
    elif item.value is not None and str(item.value).strip():
        raw = [item.value]
    else:
        raw = []
    vals = [str(v).strip() for v in raw if v is not None and str(v).strip()]
    return list(dict.fromkeys(vals))


def _normalize_cluster_filters(project_raw: dict, req: ClusterRequest) -> list[tuple[str, list[str]]]:
    """Merge legacy filter_column/filter_value + filters[]; duplicate columns → last wins.
    Per column, multiple values are OR’d in SQL (substring ILIKE).
    """
    raw: list[tuple[str, list[str]]] = []
    if req.filter_column and req.filter_value is not None:
        fc = (req.filter_column or "").strip()
        fv = str(req.filter_value).strip()
        if fc and fv:
            raw.append((fc, [fv]))
    for item in req.filters or []:
        fc = (item.column or "").strip()
        vals = _cluster_item_values(item)
        if fc and vals:
            raw.append((fc, vals))

    merged: dict[str, list[str]] = {}
    for col, vals in raw:
        merged[col] = vals

    if len(merged) > MAX_CLUSTER_FILTERS:
        raise HTTPException(
            status_code=422,
            detail=f"At most {MAX_CLUSTER_FILTERS} distinct filter columns allowed",
        )

    total_sub = sum(len(v) for v in merged.values())
    if total_sub > MAX_CLUSTER_SUBSTRING_TOTAL:
        raise HTTPException(
            status_code=422,
            detail=f"At most {MAX_CLUSTER_SUBSTRING_TOTAL} substring values across all filters",
        )

    allowed = set(get_project_columns(project_raw))
    for col in merged:
        if col not in allowed:
            raise HTTPException(status_code=422, detail=f"Unknown filter column: {col!r}")

    return [(c, merged[c]) for c in merged]


@app.get("/projects")
def list_projects():
    return get_all_projects()


@app.get("/projects/{project_id}")
def get_project_detail(project_id: int):
    project = get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


@app.post("/projects/{project_id}/verify-pin")
def verify_pin_endpoint(project_id: int, body: dict):
    pin = (body or {}).get("pin", "")
    if verify_project_pin(project_id, pin):
        return {"ok": True}
    raise HTTPException(status_code=401, detail="Incorrect PIN")


@app.patch("/projects/{project_id}")
def update_project_endpoint(project_id: int, data: ProjectUpdate, request: Request):
    project_raw = get_project_raw(project_id)
    if not project_raw:
        raise HTTPException(status_code=404, detail="Project not found")
    _check_pin(project_raw, request)
    updated = update_project(project_id, data.name, data.display_columns, data.default_k)
    return updated


@app.delete("/projects/{project_id}")
def delete_project_endpoint(project_id: int, request: Request):
    project_raw = get_project_raw(project_id)
    if not project_raw:
        raise HTTPException(status_code=404, detail="Project not found")
    _check_pin(project_raw, request)
    deleted = delete_project(project_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Project not found")
    return {"ok": True}


@app.get("/projects/{project_id}/browse")
def browse_project(project_id: int, request: Request):
    # Browser page navigation sends Accept: text/html — serve the SPA instead of JSON.
    if _FRONTEND and "text/html" in request.headers.get("accept", ""):
        from fastapi.responses import FileResponse
        dist_dir = os.environ.get("FRONTEND_DIST_DIR", "frontend/dist")
        return FileResponse(os.path.join(dist_dir, "index.html"))
    project_raw = get_project_raw(project_id)
    if not project_raw:
        raise HTTPException(status_code=404, detail="Project not found")
    _check_pin(project_raw, request)
    schema = project_raw['schema_name']
    with get_cursor() as (cur, conn):
        cur.execute(f"SELECT * FROM {schema}.records LIMIT 10")
        rows = [dict(r) for r in cur.fetchall()]
    for row in rows:
        if row.get('embedding') is not None:
            emb = row['embedding']
            if isinstance(emb, str):
                vals = [float(v) for v in emb.strip('[]').split(',')]
            else:
                vals = [float(v) for v in emb]
            row['embedding'] = f"[{', '.join(f'{v:.3f}' for v in vals[:3])} \u2026 +{len(vals)-3} more]"
        if row.get('search_vector') is not None:
            row['search_vector'] = str(row['search_vector'])
    return {"records": rows, "total": project_raw['row_count']}


@app.get("/projects/{project_id}/columns")
def get_columns_endpoint(project_id: int, request: Request):
    project_raw = get_project_raw(project_id)
    if not project_raw:
        raise HTTPException(status_code=404, detail="Project not found")
    _check_pin(project_raw, request)
    columns = get_project_columns(project_raw)
    return {"columns": columns}


@app.get("/projects/{project_id}/system-config", response_model=SystemConfigResponse)
def get_system_config(project_id: int, request: Request):
    """
    Read-only server retrieval configuration (embedding provider, models, indexes,
    HNSW/BM25 summary). PIN-protected when project has a PIN.
    """
    project_raw = get_project_raw(project_id)
    if not project_raw:
        raise HTTPException(status_code=404, detail="Project not found")
    _check_pin(project_raw, request)

    pgvector_version = None
    hnsw_ef_search = None
    with get_cursor() as (cur, conn):
        cur.execute("SELECT extversion AS extversion FROM pg_extension WHERE extname = 'vector'")
        row = cur.fetchone()
        if row and row.get("extversion"):
            pgvector_version = str(row["extversion"])
        try:
            cur.execute("SELECT current_setting('hnsw.ef_search', true) AS v")
            r2 = cur.fetchone()
            if r2 and r2.get("v"):
                # May be '' if unset depending on Postgres / pgvector
                v = r2["v"]
                if v is not None and str(v).strip() != "":
                    hnsw_ef_search = str(v)
        except Exception as e:
            logger.debug("Could not read hnsw.ef_search: %s", e)

    hnsw_defaults_note = (
        "Index is created without explicit WITH (m, ef_construction); pgvector defaults apply "
        f"(typically m={16}, ef_construction=64). "
        f"Detected pgvector {pgvector_version or 'unknown'}."
    )

    vector_index = (
        "PostgreSQL pgvector HNSW on `records.embedding` using `vector_cosine_ops` "
        "(cosine distance / inner-product style retrieval per pgvector cosine ops)."
    )
    keyword_search = (
        "PostgreSQL full-text search: `search_vector` tsvector with GIN index generated from "
        "`contextual_content` (`english` configuration) optionally unioned with the ID "
        "column (`simple`) when configured — BM25-ish ranking via `ts_rank` / `plainto_tsquery` "
        "(not Elastic BM25)."
    )
    topic_pipeline = (
        "Topic mode: embed query → top-K cosine neighbors (HNSW) + top-K lexical matches "
        "→ merged (RRF or vector-primary) → optional reranker (Ollama cross-encoder) → top-k results."
    )

    return SystemConfigResponse(
        embedding_provider=EMBEDDING_PROVIDER,
        embedding_model=EMBEDDING_MODEL,
        embedding_dims=EMBEDDING_DIMS,
        reranker_enabled=RERANKER_ENABLED,
        reranker_model=RERANKER_MODEL,
        top_k_retrieval=TOP_K_RETRIEVAL,
        top_k_default=TOP_K_DEFAULT,
        top_k_max=TOP_K_MAX,
        pgvector_version=pgvector_version,
        vector_index=vector_index,
        keyword_search=keyword_search,
        topic_pipeline=topic_pipeline,
        hnsw_m_default=16,
        hnsw_ef_construction_default=64,
        hnsw_ef_search=hnsw_ef_search,
        hnsw_defaults_note=hnsw_defaults_note,
    )


# ── Excel Upload & Column Detection ───────────────────────────────────────

@app.post("/projects/preview")
async def preview_excel(file: UploadFile = File(...)):
    """
    Upload Excel file and return column names + sheet names + row count.
    Used in project creation step to let user pick columns.
    """
    if not file.filename.endswith(('.xlsx', '.xls')):
        raise HTTPException(status_code=400, detail="Only Excel files accepted")

    # Save to temp file
    with tempfile.NamedTemporaryFile(delete=False, suffix='.xlsx') as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name

    try:
        df, columns, sheet_names = read_excel(tmp_path)
        return {
            "columns": columns,
            "sheet_names": sheet_names,
            "row_count": len(df),
            "tmp_path": tmp_path  # returned so ingestion can use same file
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


# ── Project Creation + Ingestion ──────────────────────────────────────────

@app.post("/projects")
async def create_project_endpoint(data: ProjectCreate):
    """Create project metadata record. Returns project id."""
    stored = set(data.stored_columns)
    errors = []
    if data.content_column and data.content_column not in stored:
        errors.append(f"content_column '{data.content_column}' is not in stored_columns")
    bad_ctx = [c for c in data.context_columns if c not in stored]
    if bad_ctx:
        errors.append(f"context_columns not in stored_columns: {bad_ctx}")
    if data.id_column and data.id_column not in stored:
        errors.append(f"id_column '{data.id_column}' is not in stored_columns")
    bad_disp = [c for c in data.display_columns if c not in stored]
    if bad_disp:
        errors.append(f"display_columns not in stored_columns: {bad_disp}")
    if errors:
        raise HTTPException(status_code=422, detail="; ".join(errors))
    project = create_project(data)
    return project


@app.get("/projects/{project_id}/ingest")
async def ingest_project(project_id: int, tmp_path: str):
    """
    Stream ingestion progress via SSE.

    Ingestion runs in a background thread so it completes even if the client
    navigates away mid-stream. The SSE generator polls _ingest_progress and
    forwards events; when the client disconnects the thread keeps running and
    the DB status is always updated to 'ready' or 'error' on completion.
    """
    project = get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    if not os.path.exists(tmp_path):
        raise HTTPException(status_code=400, detail="Upload file not found. Please re-upload.")

    # If a thread is already running for this project (e.g. browser EventSource
    # auto-reconnected), just stream the existing progress instead of starting a
    # duplicate ingestion.
    if project_id in _ingest_progress:
        def _stream_existing():
            while True:
                prog = _ingest_progress.get(project_id, {'step': 'starting', 'message': 'Preparing ingestion...'})
                yield f"data: {json.dumps(prog)}\n\n"
                if prog.get('step') in ('complete', 'error'):
                    _ingest_progress.pop(project_id, None)
                    break
                time.sleep(1)
        return StreamingResponse(_stream_existing(), media_type="text/event-stream")

    _ingest_progress[project_id] = {'step': 'starting', 'message': 'Preparing ingestion...'}

    def _run_ingestion():
        logger.info("Ingestion thread started for project %d (schema=%s, file=%s)",
                    project_id, project['schema_name'], tmp_path)
        try:
            update_project_status(project_id, 'ingesting')
            for progress in ingest(
                filepath=tmp_path,
                project_id=project_id,
                schema_name=project['schema_name'],
                stored_columns=project['stored_columns'],
                content_column=project['content_column'],
                context_columns=project['context_columns'],
                id_column=project['id_column'],
                display_columns=project['display_columns'],
            ):
                _ingest_progress[project_id] = progress
                if progress.get('step') not in ('progress',):
                    logger.debug("Ingestion [project=%d] %s", project_id, progress)
        except Exception as e:
            logger.exception("Ingestion failed for project %d", project_id)
            update_project_status(project_id, 'error')
            _ingest_progress[project_id] = {'step': 'error', 'message': str(e)}
        finally:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
                logger.debug("Cleaned up tmp file %s", tmp_path)

    threading.Thread(target=_run_ingestion, daemon=True).start()

    def event_stream():
        while True:
            prog = _ingest_progress.get(project_id, {'step': 'starting', 'message': 'Preparing ingestion...'})
            yield f"data: {json.dumps(prog)}\n\n"
            if prog.get('step') in ('complete', 'error'):
                _ingest_progress.pop(project_id, None)
                break
            time.sleep(1)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


# ── Search ────────────────────────────────────────────────────────────────

def _parse_bool_param(val: str | None, default: bool = True) -> bool:
    """Parse a query-string boolean param ('true'/'false'/'1'/'0')."""
    if val is None:
        return default
    return val.lower() not in ("false", "0", "no")


def _validate_topic_pipeline(use_vector: bool, use_bm25: bool):
    if not use_vector and not use_bm25:
        raise HTTPException(
            status_code=400,
            detail="At least one retriever must be enabled: set use_vector=true and/or use_bm25=true."
        )


@app.get("/projects/{project_id}/search/stream")
def search_stream(
    project_id: int,
    query: str,
    mode: str = "topic",
    k: int = None,
    use_vector: str = None,
    use_bm25: str = None,
    use_rrf: str = None,
    use_rerank: str = None,
    request: Request = None,
):
    """
    SSE stream of search pipeline steps for the UI.
    Events: embedding → vector → bm25 → rrf → reranking → complete (with results+stats JSON).
    ID search falls back to a single complete event (it's instant).
    Topic pipeline flags (query params, default true): use_vector, use_bm25, use_rrf, use_rerank.
    """
    project_raw = get_project_raw(project_id)
    if not project_raw:
        raise HTTPException(status_code=404, detail="Project not found")
    _check_pin(project_raw, request)

    if project_raw['status'] != 'ready':
        raise HTTPException(status_code=400, detail=f"Project not ready (status: {project_raw['status']})")

    effective_k = min(k or project_raw['default_k'], 50)
    p_vector  = _parse_bool_param(use_vector)
    p_bm25    = _parse_bool_param(use_bm25)
    p_rrf     = _parse_bool_param(use_rrf)
    p_rerank  = _parse_bool_param(use_rerank)

    if mode != "id":
        _validate_topic_pipeline(p_vector, p_bm25)

    def event_stream():
        import json as _json
        try:
            if mode == "id" and project_raw['has_id_column']:
                result = do_search(
                    query=query, mode="id",
                    schema_name=project_raw['schema_name'],
                    id_column=project_raw['id_column'],
                    display_columns=project_raw['display_columns'],
                    k=effective_k,
                )
                payload = _json.dumps({"step": "complete", "results": result.dict()})
                yield f"data: {payload}\n\n"
            else:
                for event in topic_search_stream(
                    query=query,
                    schema_name=project_raw['schema_name'],
                    display_columns=project_raw['display_columns'],
                    k=effective_k,
                    use_vector=p_vector,
                    use_bm25=p_bm25,
                    use_rrf=p_rrf,
                    use_rerank=p_rerank,
                ):
                    if event['step'] == 'complete':
                        payload = _json.dumps({"step": "complete", "results": event['response'].dict()})
                    elif event['step'] == 'count':
                        payload = _json.dumps({"step": "count", "for_step": event['for_step'], "count": event['count']})
                    else:
                        payload = _json.dumps({"step": event['step'], "message": event['message']})
                    yield f"data: {payload}\n\n"
        except Exception as e:
            logger.exception("search_stream error project=%d query=%r", project_id, query)
            yield f"data: {_json.dumps({'step': 'error', 'message': str(e)})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.post("/projects/{project_id}/search")
def search_endpoint(project_id: int, req: SearchRequest, request: Request):
    project_raw = get_project_raw(project_id)
    if not project_raw:
        raise HTTPException(status_code=404, detail="Project not found")
    _check_pin(project_raw, request)

    if project_raw['status'] != 'ready':
        raise HTTPException(status_code=400, detail=f"Project not ready (status: {project_raw['status']})")

    if req.mode == "id" and not project_raw['has_id_column']:
        raise HTTPException(status_code=400, detail="This project has no ID column configured")

    if req.mode != "id":
        _validate_topic_pipeline(req.use_vector, req.use_bm25)

    k = req.k or project_raw['default_k']

    result = do_search(
        query=req.query,
        mode=req.mode,
        schema_name=project_raw['schema_name'],
        id_column=project_raw['id_column'],
        display_columns=project_raw['display_columns'],
        k=k,
        use_vector=req.use_vector,
        use_bm25=req.use_bm25,
        use_rrf=req.use_rrf,
        use_rerank=req.use_rerank,
    )

    return result


# ── Export ────────────────────────────────────────────────────────────────

@app.post("/projects/{project_id}/export")
def export_results(project_id: int, req: SearchRequest, request: Request):
    """Run search and return results as Excel file download."""
    from fastapi.responses import Response
    import io

    project_raw = get_project_raw(project_id)
    if not project_raw:
        raise HTTPException(status_code=404, detail="Project not found")
    _check_pin(project_raw, request)

    if req.mode != "id":
        _validate_topic_pipeline(req.use_vector, req.use_bm25)

    k = req.k or project_raw['default_k']
    result = do_search(
        query=req.query,
        mode=req.mode,
        schema_name=project_raw['schema_name'],
        id_column=project_raw['id_column'],
        display_columns=project_raw['display_columns'],
        k=k,
        use_vector=req.use_vector,
        use_bm25=req.use_bm25,
        use_rrf=req.use_rrf,
        use_rerank=req.use_rerank,
    )

    # Convert to DataFrame
    rows = [r.display_data for r in result.results]
    df = pd.DataFrame(rows)

    # Write to Excel in memory
    buffer = io.BytesIO()
    df.to_excel(buffer, index=False)
    buffer.seek(0)

    return Response(
        content=buffer.read(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename=lens_results.xlsx"}
    )


# ── Cluster ───────────────────────────────────────────────────────────────

@app.post("/projects/{project_id}/cluster")
def cluster_endpoint(project_id: int, req: ClusterRequest, request: Request):
    project_raw = get_project_raw(project_id)
    if not project_raw:
        raise HTTPException(status_code=404, detail="Project not found")
    _check_pin(project_raw, request)
    if project_raw["status"] != "ready":
        raise HTTPException(status_code=400, detail=f"Project not ready (status: {project_raw['status']})")

    filters = _normalize_cluster_filters(project_raw, req)

    def event_stream():
        import json as _json
        try:
            for event in stream_cluster(
                schema_name=project_raw["schema_name"],
                display_columns=project_raw["display_columns"],
                algorithm=req.algorithm,
                k=req.k,
                filters=filters,
            ):
                if event["step"] == "complete":
                    payload = _json.dumps({"step": "complete", "result": event["result"].dict()})
                elif event["step"] == "count":
                    payload = _json.dumps({"step": "count", "for_step": event["for_step"], "count": event["count"]})
                else:
                    payload = _json.dumps({"step": event["step"], "message": event["message"]})
                yield f"data: {payload}\n\n"
        except HTTPException as e:
            yield f"data: {_json.dumps({'step': 'error', 'message': e.detail})}\n\n"
        except Exception as e:
            logger.exception("cluster_stream error project=%d", project_id)
            yield f"data: {_json.dumps({'step': 'error', 'message': str(e)})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.post("/projects/{project_id}/cluster/export")
def cluster_export_endpoint(project_id: int, req: ClusterRequest, request: Request):
    """Run clustering and return results as an Excel file download."""
    import io
    project_raw = get_project_raw(project_id)
    if not project_raw:
        raise HTTPException(status_code=404, detail="Project not found")
    _check_pin(project_raw, request)
    if project_raw["status"] != "ready":
        raise HTTPException(status_code=400, detail=f"Project not ready (status: {project_raw['status']})")

    filters = _normalize_cluster_filters(project_raw, req)

    result = do_cluster(
        schema_name=project_raw["schema_name"],
        display_columns=project_raw["display_columns"],
        algorithm=req.algorithm,
        k=req.k,
        filters=filters,
    )

    rows = []
    for group in result.groups:
        for rec in group.records:
            row = {"cluster": group.label}
            row.update(rec.display_data)
            rows.append(row)

    df = pd.DataFrame(rows)
    buffer = io.BytesIO()
    df.to_excel(buffer, index=False)
    buffer.seek(0)

    return Response(
        content=buffer.read(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=lens_clusters.xlsx"},
    )


@app.get("/projects/{project_id}/column-values")
def column_values_endpoint(project_id: int, column: str, request: Request):
    """Return up to 50 distinct values for any column. Used by the Cluster filter picker."""
    from ingestion import safe_col_name as _safe
    project_raw = get_project_raw(project_id)
    if not project_raw:
        raise HTTPException(status_code=404, detail="Project not found")
    _check_pin(project_raw, request)
    schema = project_raw["schema_name"]
    safe = f'col_{_safe(column)}'
    with get_cursor() as (cur, _conn):
        # Fetch 51 rows — if we get 51 the list is truncated; we return at most 50.
        cur.execute(
            f'SELECT DISTINCT "{safe}" FROM {schema}.records '
            f'WHERE "{safe}" IS NOT NULL ORDER BY 1 LIMIT 51'
        )
        rows = [r[safe] for r in cur.fetchall()]
    truncated = len(rows) > 50
    return {"column": column, "values": rows[:50], "truncated": truncated}


# ── Evaluate ─────────────────────────────────────────────────────────────

@app.post("/projects/{project_id}/evaluate")
def evaluate_run(project_id: int, req: EvalRequest, request: Request):
    """Stream evaluation progress via SSE, one event per question, then a complete event."""
    project_raw = get_project_raw(project_id)
    if not project_raw:
        raise HTTPException(status_code=404, detail="Project not found")
    _check_pin(project_raw, request)

    _validate_topic_pipeline(req.use_vector, req.use_bm25)

    test_cases = [{"question": c.question, "ground_truth": c.ground_truth} for c in req.test_cases]
    return StreamingResponse(
        stream_ragas_export(
            test_cases,
            project_raw['schema_name'],
            req.k,
            use_vector=req.use_vector,
            use_bm25=req.use_bm25,
            use_rrf=req.use_rrf,
            use_rerank=req.use_rerank,
        ),
        media_type="text/event-stream"
    )


# ── Health ────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "LENS API",
        "version": app.version,
        "uptime_s": int(time.time() - _STARTED_AT),
    }


@app.get("/{full_path:path}")
async def spa_fallback(full_path: str, request: Request):
    """
    Production-only SPA fallback.
    If SERVE_FRONTEND=true and frontend dist is mounted, serve built assets + index.html.
    This route is defined last so it only triggers when no API route matched.
    """
    if _FRONTEND is None:
        raise HTTPException(status_code=404, detail="Not Found")

    # Let StaticFiles handle the request (assets + index.html fallback via html=True).
    resp = await _FRONTEND.get_response(full_path, request.scope)
    return resp

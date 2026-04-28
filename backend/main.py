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

from config import CORS_ORIGINS, TOP_K_DEFAULT, ROOT_PATH, LOG_LEVEL

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL.upper(), logging.DEBUG),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("lens.main")
from db import init_db, get_cursor
from models import ProjectCreate, ProjectUpdate, SearchRequest, EvalRequest
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
from search import search as do_search
from evaluate import build_ragas_export, stream_ragas_export

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

    k = req.k or project_raw['default_k']

    result = do_search(
        query=req.query,
        mode=req.mode,
        schema_name=project_raw['schema_name'],
        id_column=project_raw['id_column'],
        display_columns=project_raw['display_columns'],
        k=k
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

    k = req.k or project_raw['default_k']
    result = do_search(
        query=req.query,
        mode=req.mode,
        schema_name=project_raw['schema_name'],
        id_column=project_raw['id_column'],
        display_columns=project_raw['display_columns'],
        k=k
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


# ── Evaluate ─────────────────────────────────────────────────────────────

@app.post("/projects/{project_id}/evaluate")
def evaluate_run(project_id: int, req: EvalRequest, request: Request):
    """Stream evaluation progress via SSE, one event per question, then a complete event."""
    project_raw = get_project_raw(project_id)
    if not project_raw:
        raise HTTPException(status_code=404, detail="Project not found")
    _check_pin(project_raw, request)

    test_cases = [{"question": c.question, "ground_truth": c.ground_truth} for c in req.test_cases]
    return StreamingResponse(
        stream_ragas_export(test_cases, project_raw['schema_name'], req.k),
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

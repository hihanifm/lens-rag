import os
import json
import tempfile
from fastapi import FastAPI, UploadFile, File, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
import pandas as pd

from config import CORS_ORIGINS, TOP_K_DEFAULT
from db import init_db, get_cursor
from models import ProjectCreate, ProjectUpdate, SearchRequest, EvalRequest
from projects import create_project, get_all_projects, get_project, update_project, get_project_columns, update_project_status
from ingestion import read_excel, ingest
from search import search as do_search
from evaluate import build_ragas_export, stream_ragas_export

app = FastAPI(title="LENS API", version="1.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup():
    init_db()

app.mount("/samples", StaticFiles(directory="samples"), name="samples")

# ── Projects ──────────────────────────────────────────────────────────────

@app.get("/projects")
def list_projects():
    return get_all_projects()


@app.get("/projects/{project_id}")
def get_project_detail(project_id: int):
    project = get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


@app.patch("/projects/{project_id}")
def update_project_endpoint(project_id: int, data: ProjectUpdate):
    project = get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    updated = update_project(project_id, data.name, data.display_columns, data.default_k)
    return updated


@app.get("/projects/{project_id}/browse")
def browse_project(project_id: int):
    project = get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    schema = project['schema_name']
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
    return {"records": rows, "total": project['row_count']}


@app.get("/projects/{project_id}/columns")
def get_columns_endpoint(project_id: int):
    project = get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    columns = get_project_columns(project)
    return {"columns": columns}


# ── Excel Upload & Column Detection ───────────────────────────────────────

@app.post("/upload/preview")
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
    Client connects and receives progress events until complete.
    """
    project = get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    if not os.path.exists(tmp_path):
        raise HTTPException(status_code=400, detail="Upload file not found. Please re-upload.")

    def event_stream():
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
                yield f"data: {json.dumps(progress)}\n\n"

        except Exception as e:
            update_project_status(project_id, 'error')
            yield f"data: {json.dumps({'step': 'error', 'message': str(e)})}\n\n"
        finally:
            # Clean up temp file
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


# ── Search ────────────────────────────────────────────────────────────────

@app.post("/projects/{project_id}/search")
def search_endpoint(project_id: int, req: SearchRequest):
    project = get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    if project['status'] != 'ready':
        raise HTTPException(status_code=400, detail=f"Project not ready (status: {project['status']})")

    if req.mode == "id" and not project['has_id_column']:
        raise HTTPException(status_code=400, detail="This project has no ID column configured")

    k = req.k or project['default_k']

    result = do_search(
        query=req.query,
        mode=req.mode,
        schema_name=project['schema_name'],
        id_column=project['id_column'],
        display_columns=project['display_columns'],
        k=k
    )

    return result


# ── Export ────────────────────────────────────────────────────────────────

@app.post("/projects/{project_id}/export")
def export_results(project_id: int, req: SearchRequest):
    """Run search and return results as Excel file download."""
    from fastapi.responses import Response
    import io

    project = get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    k = req.k or project['default_k']
    result = do_search(
        query=req.query,
        mode=req.mode,
        schema_name=project['schema_name'],
        id_column=project['id_column'],
        display_columns=project['display_columns'],
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

@app.post("/projects/{project_id}/evaluate/run")
def evaluate_run(project_id: int, req: EvalRequest):
    """Stream evaluation progress via SSE, one event per question, then a complete event."""
    project = get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    test_cases = [{"question": c.question, "ground_truth": c.ground_truth} for c in req.test_cases]
    return StreamingResponse(
        stream_ragas_export(test_cases, project['schema_name'], req.k),
        media_type="text/event-stream"
    )


# ── Health ────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "service": "LENS API", "version": app.version}

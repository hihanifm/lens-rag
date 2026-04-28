# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# LENS — Lightweight ENgineering Search

## What is LENS?

A generic, on-premise RAG search portal for any Excel-based knowledge base.
Not a chatbot. Not a reasoning engine. Just smart search — fast and accurate.

Works for any domain, any Excel structure.

---

## Interaction Protocol (NEVER skip this)

Before writing any code or plan, Claude MUST:

1. Ask clarifying questions to fully understand the requirements
2. Wait for the user to respond
3. Only proceed to coding after the user confirms you have enough context

Do NOT jump straight into code. Always converse first.

---

## Best Practices

See [BEST_PRACTICES.md](BEST_PRACTICES.md) for coding conventions covering React, FastAPI, Git, and general rules.

---

## Design Principles (NEVER violate these)

1. **KISS** — If there's a simpler way, take it. Complexity only when simpler solution provably fails.
2. **Garbage In, Garbage Out** — Read what's there, store what's there, show what's there. Never clean or judge user data.
3. **On-Premise Only** — Zero external API calls. Zero data leaves the network. No exceptions. Ever.
4. **User Drives, System Follows** — User decides context columns, display columns, ID column, K value.
5. **No LLM in Query Path** — Search returns results. No explanation, synthesis, or summarization.
6. **Defer Complexity** — Build simplest thing first. Add complexity only when real users hit real limits.
7. **One Job, Done Well** — LENS is search. Not compliance, not knowledge graph, not reasoning.

---

## Hard Constraints

- **NO external API calls** — no OpenAI, no Anthropic, no cloud services, nothing outside the network
- **Embedding**: bge-m3 via Ollama running on host GPU server (A4000, 16GB VRAM)
- **Reranker**: bge-reranker-base via Ollama (same host)
- **All config in config.py** — never hardcode URLs or model names in logic files
- **Ollama runs on HOST** — not inside Docker (needs direct GPU access)
- **Docker Compose** manages: FastAPI + PostgreSQL only

---

## Tech Stack

### Backend

- Python + FastAPI
- PostgreSQL + pgvector extension
- pandas + openpyxl (Excel reading)
- openai Python client (Ollama by default; configurable to OpenAI for testing)
- psycopg2 (Postgres connection)

### Frontend

- React + Vite
- TanStack Table (results table)
- TanStack Query (data fetching)
- Tailwind CSS (styling)
- Axios (API calls)

### Infrastructure

- Docker Compose: lens-api (FastAPI) + lens-postgres (pgvector) + frontend (Vite dev server)
- Ollama: runs on host, outside Docker
- Communication: FastAPI → Ollama via host.docker.internal:11434

---

## System Config (env vars → config.py)

All values configurable via environment variables. Defaults shown.

```bash
# Embedding provider: "ollama" (on-prem) or "openai" (for testing)
EMBEDDING_PROVIDER=ollama

# Ollama settings (used when EMBEDDING_PROVIDER=ollama)
OLLAMA_BASE_URL=http://host.docker.internal:11434/v1
OLLAMA_EMBED_MODEL=bge-m3
EMBEDDING_DIMS=1024

# OpenAI settings (used when EMBEDDING_PROVIDER=openai)
OPENAI_API_KEY=sk-...
OPENAI_EMBED_MODEL=text-embedding-3-small
EMBEDDING_DIMS=1536   # override when switching to OpenAI

# Reranker — always Ollama, no OpenAI equivalent
RERANKER_ENABLED=true           # set false to skip reranking
RERANKER_MODEL=bbjson/bge-reranker-base:latest

# Database
DB_HOST=lens-postgres
DB_PORT=5432
DB_NAME=lens
DB_USER=lens_user
DB_PASSWORD=changeme

# Reverse proxy — set when serving under a sub-path (e.g. /lens-rag)
ROOT_PATH=          # e.g. /lens-rag  (empty = serve at root)
```

### Switching to OpenAI (e.g. testing from home)

```bash
EMBEDDING_PROVIDER=openai OPENAI_API_KEY=sk-... EMBEDDING_DIMS=1536 RERANKER_ENABLED=false make up
```

Or set in a local `.env` file (never commit it).

---

## Database Design

### One Postgres instance, one schema per project

```sql
-- Schema per project
CREATE SCHEMA project_{id};

-- Requirements table (generic — works for any domain)
CREATE TABLE project_{id}.records (
  id                  SERIAL PRIMARY KEY,
  sheet_name          TEXT,
  -- all original Excel columns stored as col_{name}
  -- e.g. col_product, col_category, col_id, col_description
  contextual_content  TEXT,         -- built by system at ingestion
  embedding           vector(N),    -- N = project's embed_dims (defaults to system EMBEDDING_DIMS)
  search_vector       tsvector      -- BM25 index, auto-generated
    GENERATED ALWAYS AS (
      to_tsvector('english', coalesce(contextual_content, '')) ||
      to_tsvector('simple',  coalesce(col_{id_column}, ''))   -- only if id_column chosen
    ) STORED
);

CREATE INDEX ON project_{id}.records USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON project_{id}.records USING gin  (search_vector);
-- NO btree index on id_column — ILIKE used instead at this scale
```

### Project metadata table (global)

```sql
CREATE TABLE public.projects (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  schema_name     TEXT NOT NULL,       -- project_{id}
  context_columns TEXT[],              -- chosen by user
  id_column       TEXT,                -- optional, chosen by user
  content_column  TEXT NOT NULL,       -- chosen by user
  display_columns TEXT[],              -- chosen by user
  has_id_column   BOOLEAN DEFAULT FALSE,
  default_k       INTEGER DEFAULT 10,
  status          TEXT DEFAULT 'pending', -- pending | ingesting | ready | error
  row_count       INTEGER,
  pin             TEXT,                   -- optional; plain text (on-prem only)
  source_filename TEXT,                   -- original uploaded Excel filename
  embed_url       TEXT,                   -- custom embedding endpoint (null = system default)
  embed_api_key   TEXT,                   -- custom API key (null = system default; plain text)
  embed_model     TEXT,                   -- custom model name (null = system default)
  embed_dims      INTEGER,                -- vector dims for this project (auto-probed at ingestion if null)
  created_at      TIMESTAMP DEFAULT NOW()
);
```

---

## Excel Ingestion

### Reading strategy (KISS — no cleaning, no judging data)

```python
import pandas as pd

def read_excel(filepath):
    all_sheets = pd.read_excel(filepath, sheet_name=None, dtype=str)
    frames = []
    for sheet_name, df in all_sheets.items():
        df = df.ffill()                # fill merged cells FIRST
        df = df.dropna(how='all')      # drop ONLY fully empty rows
        df['sheet_name'] = sheet_name  # always add sheet name
        frames.append(df)
    return pd.concat(frames, ignore_index=True)
```

### Contextual content builder

```python
def build_contextual_content(row, context_columns, sheet_name, content_column):
    parts = []
    parts.append(str(sheet_name))
    for col in context_columns:
        val = str(row.get(col, ''))
        if val and val != 'nan':
            parts.append(val)
    parts.append(str(row.get(content_column, '')))
    return ' | '.join(parts)
```

### Ingestion pipeline

1. Read Excel → all sheets → ffill → dropna(how='all')
2. Show user all columns → user picks content, context, id, display columns
3. For each row: build contextual_content → embed via bge-m3 → store
4. tsvector auto-generated by Postgres
5. Report progress via SSE (Server-Sent Events) to frontend

---

## Search Architecture

### Two modes only (v1)

**Mode 1 — ID Search** (shown only if id_column configured)

```python
# ILIKE — flexible, works for partial IDs too
# e.g. "1042" matches "PROD-1042"
WHERE col_{id_column} ILIKE '%{query}%'
AND schema = project_schema
LIMIT k
```

**Mode 2 — Topic / Keyword Search**

```
Step 1: embed query → bge-m3 (GPU ~50ms)
Step 2: vector search → top 50 candidates (pgvector)
Step 3: BM25 search  → top 50 candidates (tsvector)
Step 4: RRF merge    → top ~80 unique candidates
Step 5: rerank       → bge-reranker-base → top k
Step 6: return results + stats
```

### RRF merge

```python
def rrf_merge(vector_results, bm25_results, k=60):
    scores = {}
    for rank, doc in enumerate(vector_results):
        scores[doc.id] = scores.get(doc.id, 0) + 1 / (k + rank + 1)
    for rank, doc in enumerate(bm25_results):
        scores[doc.id] = scores.get(doc.id, 0) + 1 / (k + rank + 1)
    return sorted(scores.keys(), key=lambda x: scores[x], reverse=True)
```

---

## API Routes


| Method | Path                                    | Description                                                      |
| ------ | --------------------------------------- | ---------------------------------------------------------------- |
| GET    | `/projects`                             | List all projects                                                |
| GET    | `/projects/{id}`                        | Get project detail (includes `has_pin`, never returns raw `pin`) |
| POST   | `/projects`                             | Create project metadata                                          |
| PATCH  | `/projects/{id}`                        | Update name / display_columns / default_k (no re-ingest)         |
| DELETE | `/projects/{id}`                        | Delete project + schema                                          |
| GET    | `/projects/{id}/columns`                | All original column names for the project schema                 |
| GET    | `/projects/{id}/ingest?tmp_path=...`    | SSE ingestion stream                                             |
| GET    | `/projects/{id}/search/stream`          | Streaming search SSE (query params; used by frontend)            |
| POST   | `/projects/{id}/search`                 | Non-streaming search (id or topic mode)                          |
| POST   | `/projects/{id}/export`                 | Search + return Excel download                                   |
| GET    | `/projects/{id}/browse`                 | First 10 raw records (SELECT * LIMIT 10)                         |
| POST   | `/projects/{id}/evaluate`               | SSE RAGAS export stream                                          |
| POST   | `/projects/{id}/cluster`                | SSE cluster stream (KMeans/DBSCAN over embeddings)               |
| POST   | `/projects/{id}/cluster/filter`         | Cluster with column-value filters                                |
| GET    | `/projects/{id}/system-config`          | Embedding + reranker config locked at ingestion time             |
| POST   | `/projects/{id}/verify-pin`             | Verify PIN for a protected project                               |
| POST   | `/projects/preview`                     | Parse Excel → return columns + row count                         |
| GET    | `/models?url=...&api_key=...`           | Proxy /v1/models from any OpenAI-compatible endpoint             |
| GET    | `/system-config`                        | Live system config (embedding model, reranker, Ollama URL, etc.) |
| GET    | `/health`                               | Liveness check                                                   |


### Per-project PIN protection

Projects can optionally be created with a PIN (`public.projects.pin`, stored as plain text; on-prem internal tool).

- **If no PIN is set**: all endpoints behave as before.
- **If a PIN is set**: the following endpoints require `X-Project-Pin: <pin>` or they return `401`:
  - `PATCH /projects/{id}`
  - `GET /projects/{id}/columns`
  - `GET /projects/{id}/browse`
  - `POST /projects/{id}/search`
  - `POST /projects/{id}/export`
  - `POST /projects/{id}/evaluate/run`

To validate a PIN from the UI, call `POST /projects/{id}/verify-pin` with body `{ "pin": "..." }`.

---

## Per-Project Embedding Config

Projects can override the system-level embedding model. The config is locked at creation time and used for both ingestion and every search query.

**Flow:**
1. User provides `embed_url` + optional `embed_api_key` in the Connection step
2. Frontend calls `GET /models?url=...&api_key=...` — backend proxies `/v1/models` and returns model IDs
3. User picks a model; all four fields sent in `POST /projects` payload
4. At ingestion start, if `embed_url` is set but `embed_dims` is null, a probe `embed("probe")` call determines actual dims and writes them back to `public.projects.embed_dims`
5. `create_project_schema()` uses the resolved dims for the pgvector `vector(N)` column
6. Every `embed()` call in ingestion and search passes `base_url`, `api_key`, `model` kwargs; `embedder.py` constructs a fresh OpenAI client for overrides, falls back to the module singleton for nulls

**Fallback:** any null field falls through to the system config (`OLLAMA_BASE_URL`, `EMBEDDING_MODEL`, `EMBEDDING_DIMS`).

**`SystemConfigResponse`** now includes `embedding_url` so the Connection step can pre-fill the URL field and auto-fetch models on arrival.

---

## Cross-tab State — ProjectStateContext

`frontend/src/contexts/ProjectStateContext.jsx` persists search and eval state per project across the tab bar. Without it, switching from Search → Browse → Search would lose in-progress results.

Key points:
- `startSearch` / `startEval` live in the context, not in page components — this lets eval SSE keep running even when `EvaluateProject` is unmounted.
- Streaming search uses `fetch` + `ReadableStream` (not `EventSource`) so the PIN header (`X-Project-Pin`) can be sent; `EventSource` does not support custom headers.
- Each project gets its own search/eval slice keyed by `projectId`.

---

## Browser localStorage — Session History

All search and evaluation history is stored **client-side** in `localStorage` under the key `lens_history`. No backend involvement.

- Max 100 entries (oldest trimmed automatically)
- Utility in `frontend/src/utils/history.js`: `saveSearch()`, `saveEval()`, `loadHistory()`, `clearHistory()`, `exportHistoryCSV()`
- Each search entry stores: project_id, project_name, query, mode, k, results_returned, total_ms, display_columns, full results array, timestamp
- Each eval entry stores: project_id, project_name, test_case_count, k, full RAGAS results array, timestamp

---

## Export Filename Conventions

All client-side file exports follow the pattern `{project-name}_lens_{descriptor}_{YYYY-MM-DD}.ext`.
Project names are slugified: lowercase, spaces → hyphens, special chars stripped.


| Export                | Filename                                                              |
| --------------------- | --------------------------------------------------------------------- |
| Search → Excel        | `{project-name}_lens_results_{date}.xlsx`                             |
| Evaluate → RAGAS JSON | `{project-name}_lens_ragas_{date}.json`                               |
| History row → JSON    | `{project-name}_lens_ragas_{date}.json` (date from session timestamp) |
| History → CSV         | `lens_history_{date}.csv`                                             |


---

## API Response — always includes stats

```json
{
  "results": [
    {
      "display_columns": {"ID": "PROD-1042", "Category": "Hardware", ...},
      "score": 0.94
    }
  ],
  "stats": {
    "mode": "topic",
    "embedding_ms": 12,
    "vector_search_ms": 34,
    "bm25_search_ms": 8,
    "rrf_merge_ms": 2,
    "reranker_ms": 180,
    "total_ms": 247,
    "candidates_retrieved": 80,
    "results_returned": 10
  }
}
```

---

## Frontend Screens

### Screen 1 — Home

- Two-column layout: Projects list (left) + Recent Activity panel (right)
- Recent Activity shows last 5 history entries (search + eval) with quick re-run buttons
- [+ New Project] button

### Screen 2 — Create Project (multi-step, 8 steps)

- Step 1: Project name
- Step 2: Upload Excel → system reads and shows all columns
- Step 3: Store columns — which columns to write to DB (defaults to all)
- Step 4: Context columns (multi-select; concatenated into embedding input)
- Step 5: ID column (optional; enables ID search mode)
- Step 6: Display columns (shown in results; pre-filled with context + id)
- Step 7: **Connection** — override embedding endpoint URL + API key + model picker (auto-fetches models from the URL; blank = use system default; pre-filled with system defaults on arrival)
- Step 8: Settings — default K (5/10/20/50) + optional PIN
- [Create] → SSE progress bar → "Ready!"

### Screen 3 — Search (tab 1 of 5)

- Project name shown top with [Search] [Evaluate] [Browse] [Cluster] [Settings] tab nav
- Search mode toggle: [ID] [Topic] (ID only shown if has_id_column)
- Pipeline toggles: vector / BM25 / RRF / rerank (each independently on/off)
- Query input + K selector (5 / 10 / 20 / 50)
- Search streams live step-by-step via SSE (uses `fetch` + `ReadableStream`, not `EventSource` — needed for PIN header support)
- Results table (display columns only) + stats panel (timing breakdown)
- [Export to Excel] button — each search auto-saved to localStorage history

### Screen 4 — Evaluate (tab 2 of 5)

- Upload test set CSV (question + ground_truth columns)
- Pipeline toggles + K selector
- [Run Evaluation] → SSE live progress → results list
- [Export RAGAS JSON] button; each completed eval auto-saved to localStorage history

### Screen 5 — Browse (tab 3 of 5)

- Shows first 10 raw records from Postgres (SELECT * LIMIT 10)
- Horizontally-scrollable fixed-layout table
- All DB columns shown (col_* names, contextual_content, sheet_name, truncated embedding)
- Cells default to 2-line clamp; click row to expand fully

### Screen 6 — Cluster (tab 4 of 5) — `/projects/:id/cluster`

- Runs KMeans or DBSCAN clustering over all record embeddings for the project
- Filter panel: per-column substring filters to restrict which records are clustered
- Results show groups with representative records per cluster
- Clustering runs via `POST /projects/{id}/cluster` (streaming SSE) or `POST /projects/{id}/cluster/filter`

### Screen 7 — Settings (tab 5 of 5)

- Left card: read-only ingestion config (content column, context columns, ID column, row count, schema)
- Right card: editable fields — project name, default k, display columns (multi-select from full column list)
- Save calls PATCH /projects/{id}; invalidates TanStack Query cache

### Screen 8 — Per-project System Info — `/projects/:id/system`

- Read-only view of the embedding + reranker config that was active when the project was ingested
- Rendered by `SystemConfig.jsx`; data fetched from `GET /projects/{id}/system-config`

### Screen 9 — Global System Info — `/system`

- Read-only view of the live system config (embedding model, reranker, Ollama URL, etc.)
- Rendered by `System.jsx`; data fetched from `GET /system-config`

### Screen 10 — History (/history)

- Global view of all past searches and evaluations (stored in browser localStorage)
- Project filter dropdown
- Table with type badge (Search / Evaluate), project, query/session, mode, k, results, latency, time ago
- Click row to expand: search rows show full ResultsTable; eval rows show question preview + Download JSON
- Re-run button on search rows (navigates to Search page with query pre-filled)
- Export CSV + Clear all buttons

---

## Project Structure

```
lens/
  backend/
    config.py          ← ALL config here, nowhere else
    main.py            ← FastAPI app, routes
    db.py              ← Postgres connection, schema management
    embedder.py        ← Ollama embedding calls
    ingestion.py       ← Excel reading + ingestion pipeline
    search.py          ← vector + BM25 + RRF + reranker (streaming SSE)
    clustering.py      ← KMeans/DBSCAN over stored embeddings
    projects.py        ← project CRUD + update_project + get_project_columns
    models.py          ← Pydantic models (incl. ProjectUpdate, ClusterRequest, SystemConfigResponse)
    evaluate.py        ← RAGAS export builder + SSE streamer
  frontend/
    src/
      pages/
        Home.jsx           ← projects list + recent activity panel
        CreateProject.jsx
        Search.jsx
        EvaluateProject.jsx
        Browse.jsx         ← raw record viewer (SELECT * LIMIT 10)
        Cluster.jsx        ← embedding-space clustering with filter panel
        Settings.jsx       ← project config viewer + editable fields
        SystemConfig.jsx   ← per-project system/model config (read-only)
        System.jsx         ← global system config (read-only)
        History.jsx        ← global search/eval history from localStorage
      components/
        ResultsTable.jsx
        StatsPanel.jsx
        BottomBar.jsx      ← LENS home link + API status + History link
        Layout.jsx
        PinGate.jsx        ← PIN entry card rendered in place of page content when locked
      contexts/
        ProjectStateContext.jsx  ← persists search + eval state across tab navigation; runs eval SSE even when component unmounted
      hooks/
        useProjectPin.js   ← { isLocked, unlockWithPin } — used in Search/Evaluate/Browse/Settings
      utils/
        history.js         ← localStorage history helpers (saveSearch, saveEval, etc.)
        clusterRunManager.js ← manages cluster job lifecycle
      api/
        client.js          ← ALL axios calls here, nowhere else
      App.jsx
      main.jsx
    .env.development       ← VITE_API_URL= (dev only, committed; Vite proxies to :37002)
    package.json
    vite.config.js         ← base driven by VITE_BASE_PATH env var
    tailwind.config.js
  docker-compose.yml       ← uses --profile dev / --profile prod to switch stacks
  requirements.txt
  Makefile
  CLAUDE.md              ← this file
```

---

## What LENS is NOT (never add without explicit instruction)

- Not a compliance tracker
- Not a knowledge graph
- Not a cross-source comparison tool
- Not a version diff tool
- Not a standards linker
- Not a multi-column keyword index tool (deferred to v2)
- Not connected to any external API ever

---

## Design Decisions

Key choices made during design:

- pgvector vs dedicated vector DB — pgvector wins at this scale
- HNSW vs IVFFlat vs exact search — exact search sufficient at current scale
- Hybrid BM25 + vector + RRF + reranker pipeline
- On-premise constraint: bge-m3 + bge-reranker-base via Ollama on A4000 GPU
- Excel ingestion: ffill → dropna(how='all') → treat everything as plain text

---

## Dev Setup

### Prerequisites

1. Docker + Docker Compose installed
2. Ollama running on the host with GPU access:
  ```bash
  llama pull bge-m3
  llama pull bbjson/bge-reranker-base:latest
  ```

### Running the stack

```bash
make up       # start Postgres + API + frontend (dev) in background
make logs     # tail logs
make down     # stop everything
make build    # rebuild images after code changes
make restart  # down + up
```

Dev UI: `http://localhost:37001`  Dev API: `http://localhost:37002`

Backend API (dev): `http://localhost:37002`
Backend API (prod): `http://localhost:37000`
Postgres: `localhost:5432` (lens_user / changeme)

### Local Python (scripts / one-offs)

The backend runs inside Docker, so you don't need a local venv for the server. But for
one-off scripts (e.g. `backend/scripts/generate_samples.py`), use a venv:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python scripts/your_script.py
```

`.venv/` is gitignored. Never install packages system-wide (`pip install` without a venv).

### Dev vs Prod architecture

**Dev:** Vite dev server (`localhost:37001`) runs separately from FastAPI (`localhost:37002`).
Vite proxies `/projects`, `/health`, `/samples` to `http://localhost:37002` (CORS is not needed — the browser only ever talks to the Vite origin).

#### Lab setup notes (Linux host, Windows browsers)

In the lab, people often open the UI from Windows machines against a Linux Docker host (e.g. `http://<linux-ip>:37001`). A few gotchas routinely cause "works on host, broken in browser" issues:

- **Prefer single-origin dev**: keep `VITE_API_URL` empty so the browser always calls the Vite origin and Vite proxies API routes to the backend. If `VITE_API_URL` points at `:37002`, you bypass the proxy and can hit CORS / firewall surprises.
- **Vite proxy is prefix-based**: if you add a new backend route (e.g. `/models`), ensure it’s included in `frontend/vite.config.js` `server.proxy` so browser calls actually reach the API in dev.
- **Ollama reachability from the API container**: the backend calls Ollama on the Docker host (typically `http://host.docker.internal:11434`). On Linux this depends on Docker `host-gateway` / `extra_hosts` and the host firewall.
- **Firewall / bind addresses**: Vite is configured with `host: true`, but the Linux host still needs inbound `37001` open from Windows clients (and `37000` in prod if used).

**Prod — single port, FastAPI serves static files:**

1. Build the frontend: `make build-frontend` (sets `VITE_BASE_PATH=/lens-rag/`)
2. Mount `frontend/dist/` in FastAPI via `StaticFiles`
3. Set `ROOT_PATH=/lens-rag` on the `lens-api` Docker service
4. Point Caddy at the single FastAPI port:

```caddy
your.server {
    handle /lens-rag/* {
        uri strip_prefix /lens-rag
        reverse_proxy localhost:37000
    }
}
```

API calls from the browser go to `/lens-rag/projects/...` → Caddy strips the prefix → FastAPI sees `/projects/...`. React Router uses `basename=/lens-rag/` so all client-side routes resolve correctly.

To run prod via Docker Compose (single port `37000`), use:

```bash
make prod-up
# then open http://localhost:37000/lens-rag/
```

### Common Makefile targets

All `up`/`down`/`build`/`logs` commands use `--profile dev` internally. Prod variants use `--profile prod`.

| Command               | What it does                                                  |
| --------------------- | ------------------------------------------------------------- |
| `make up`             | Start dev stack detached (API + Postgres + Vite frontend)     |
| `make dev-up`         | Same as `up`, also tears down prod stack first                |
| `make down`           | Stop dev stack                                                |
| `make build`          | Rebuild dev Docker images                                     |
| `make logs`           | Follow all container logs                                     |
| `make logs-split`     | Split logs into 3 tmux panes (requires tmux)                  |
| `make restart`        | Stop + start dev stack (no rebuild)                           |
| `make ps`             | Show container status                                         |
| `make prod-up`        | Build frontend + start prod stack (single port 37000)         |
| `make prod-down`      | Stop prod stack                                               |
| `make prod-restart`   | Stop + start prod stack                                       |
| `make build-frontend` | Build frontend for prod (`/lens-rag/` base path)              |
| `make clean`          | Remove old pre-rename containers/volumes; prune images        |
| `make pip-cache`      | Pre-download Linux wheels into `pip-cache/` for offline build |
| `make e2e-up`         | Start dev stack + build, then run Playwright suite            |
| `make e2e`            | Run Playwright tests (stack must already be up)               |
| `make e2e-down`       | Tear down stack after tests                                   |


> **IMPORTANT:** Any change to backend Python files requires `make build && make up`.
> `make restart` alone does NOT pick up code changes — it only recreates containers from the existing image.

### E2E Tests (Playwright)

Requires the dev stack to be running (`make up`).

```bash
make e2e          # run full Playwright suite
make e2e-up       # start stack + build before running tests
make e2e-down     # tear down after

cd frontend
npm run e2e       # same as make e2e
npm run e2e:ui    # Playwright interactive UI mode
```

Test files live in `frontend/e2e/`:

- `smoke.spec.ts` — basic liveness checks
- `create_ingest.spec.ts` — project creation + ingestion flow
- `search_export.spec.ts` — search, export to Excel
- `major_flows.spec.ts` — end-to-end user journeys


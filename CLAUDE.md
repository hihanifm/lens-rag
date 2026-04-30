# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# LENS — Lightweight ENgineering Search

## What is LENS?

A generic, on-premise RAG search portal for any Excel-based knowledge base.
Not a chatbot. Not a reasoning engine. Just smart search — fast and accurate.

Two project flavors:
- **Search** — upload one Excel, embed it, query it with vector + BM25 + RRF + reranker.
- **Compare** — upload two Excels (Left and Right), embed both, run bidirectional vector search + reranker, then do card-by-card human review to confirm matches; export decisions as a 3-sheet Excel.

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
7. **One Job, Done Well** — LENS is search + structured comparison. Not compliance, not knowledge graph, not reasoning.

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

# Compare Jobs
COMPARE_TOP_K=3                 # candidates per left row stored at comparison time
COMPARE_MATCH_THRESHOLD=0.85    # used for color-coding in review UI (green ≥ this)
COMPARE_REVIEW_THRESHOLD=0.60   # amber ≥ this; gray below

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

### Search flavor — one schema per project

```sql
CREATE TABLE public.projects (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  schema_name     TEXT NOT NULL,       -- project_{id}
  context_columns TEXT[],
  id_column       TEXT,
  content_column  TEXT NOT NULL,
  display_columns TEXT[],
  has_id_column   BOOLEAN DEFAULT FALSE,
  default_k       INTEGER DEFAULT 10,
  status          TEXT DEFAULT 'pending', -- pending | ingesting | ready | error
  row_count       INTEGER,
  pin             TEXT,
  source_filename TEXT,
  embed_url       TEXT,
  embed_api_key   TEXT,
  embed_model     TEXT,
  embed_dims      INTEGER,
  created_at      TIMESTAMP DEFAULT NOW()
);

CREATE TABLE project_{id}.records (
  id                  SERIAL PRIMARY KEY,
  sheet_name          TEXT,
  -- original Excel columns stored as col_{name}
  contextual_content  TEXT,
  embedding           vector(N),
  search_vector       tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(contextual_content, '')) ||
    to_tsvector('simple',  coalesce(col_{id_column}, ''))
  ) STORED
);
CREATE INDEX ON project_{id}.records USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON project_{id}.records USING gin  (search_vector);
```

### Compare flavor — one schema per job

```sql
CREATE TABLE public.compare_jobs (
  id                       SERIAL PRIMARY KEY,
  name                     TEXT NOT NULL,
  label_left               TEXT NOT NULL,   -- user-chosen name for left file
  label_right              TEXT NOT NULL,   -- user-chosen name for right file
  schema_name              TEXT NOT NULL,   -- compare_{id}
  status                   TEXT DEFAULT 'pending', -- pending|ingesting|comparing|ready|error
  status_message           TEXT,
  row_count_left           INTEGER,
  row_count_right          INTEGER,
  context_columns_left     TEXT[],
  content_column_left      TEXT NOT NULL,
  display_column_left      TEXT,
  context_columns_right    TEXT[],
  content_column_right     TEXT NOT NULL,
  display_column_right     TEXT,
  source_filename_left     TEXT,
  source_filename_right    TEXT,
  tmp_path_left            TEXT,            -- transient; deleted after ingestion
  tmp_path_right           TEXT,
  top_k                    INTEGER DEFAULT 3,
  embed_dims               INTEGER,
  created_at               TIMESTAMP DEFAULT NOW()
);

-- Per-job schema compare_{id}:
CREATE TABLE compare_{id}.records (
  id                  SERIAL PRIMARY KEY,
  side                TEXT NOT NULL,        -- 'left' or 'right'
  original_row        INTEGER,
  sheet_name          TEXT,
  contextual_content  TEXT,
  display_value       TEXT,
  embedding           vector(N)
);
CREATE INDEX ON compare_{id}.records USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON compare_{id}.records (side);

CREATE TABLE compare_{id}.matches (
  id           SERIAL PRIMARY KEY,
  left_id      INTEGER NOT NULL,
  right_id     INTEGER NOT NULL,
  cosine_score FLOAT,
  rerank_score FLOAT,
  rank         INTEGER NOT NULL    -- 1 = best
);
CREATE INDEX ON compare_{id}.matches (left_id, rank);

CREATE TABLE compare_{id}.decisions (
  left_id          INTEGER PRIMARY KEY,
  matched_right_id INTEGER,         -- NULL = explicit "no match"
  decided_at       TIMESTAMP DEFAULT NOW()
);
```

`matches` is written once during the comparison phase and never mutated. `decisions` is the only mutable table; `POST /compare/{id}/review/{left_id}` upserts via `ON CONFLICT (left_id) DO UPDATE`.

---

## Excel Ingestion

### Reading strategy (KISS — no cleaning, no judging data)

```python
def read_excel(filepath):
    all_sheets = pd.read_excel(filepath, sheet_name=None, dtype=str)
    frames = []
    for sheet_name, df in all_sheets.items():
        df = df.ffill()                # fill merged cells FIRST
        df = df.dropna(how='all')      # drop ONLY fully empty rows
        df['sheet_name'] = sheet_name
        frames.append(df)
    return pd.concat(frames, ignore_index=True)
```

`read_excel()` and `build_contextual_content()` in `ingestion.py` are shared by both Search ingestion (`ingestion.py`) and Compare ingestion (`comparator.py`). Never duplicate them.

### Contextual content builder

```python
def build_contextual_content(row, context_columns, sheet_name, content_column):
    parts = [str(sheet_name)]
    for col in context_columns:
        val = str(row.get(col, ''))
        if val and val != 'nan':
            parts.append(val)
    parts.append(str(row.get(content_column, '')))
    return ' | '.join(parts)
```

---

## Search Architecture

### Two modes

**Mode 1 — ID Search** (shown only if id_column configured)

```python
WHERE col_{id_column} ILIKE '%{query}%'
LIMIT k
```

**Mode 2 — Topic / Keyword Search**

```
Step 1: embed query → bge-m3
Step 2: vector search → top 50 candidates (pgvector HNSW)
Step 3: BM25 search  → top 50 candidates (tsvector GIN)
Step 4: RRF merge    → top ~80 unique candidates
Step 5: rerank       → bge-reranker-base → top k
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

## Compare Architecture

`comparator.py` orchestrates the full pipeline via `run_compare_job(job_id)` (a generator):

1. `ingest_side(job_id, 'left', ...)` — embeds left rows one at a time into `compare_{id}.records`
2. `ingest_side(job_id, 'right', ...)` — same for right rows
3. `run_bidirectional_search(schema_name, top_k)` — for each left record, `ORDER BY embedding <=> $1 WHERE side='right' LIMIT top_k`; returns `(left_id, right_id, cosine)`
4. `run_reranking(schema_name, candidates)` — groups by left_id, calls `rerank(query=left_contextual, candidates=[right_contextuals...])` once per group
5. `write_matches(schema_name, scored_pairs, top_k)` — sorts per left_id by rerank desc, inserts with rank 1..top_k

Status transitions: `pending → ingesting → comparing → ready/error`

The SSE progress pattern in `compare_router.py` mirrors the `_ingest_progress` pattern in `main.py`: a module-level `_compare_progress: dict[int, dict]` is written by the background thread and polled by the SSE endpoint every 0.5 s.

---

## API Routes

### Search routes

| Method | Path                                    | Description                                                      |
| ------ | --------------------------------------- | ---------------------------------------------------------------- |
| GET    | `/projects`                             | List all projects                                                |
| GET    | `/projects/{id}`                        | Get project detail (includes `has_pin`, never returns raw `pin`) |
| POST   | `/projects`                             | Create project metadata                                          |
| PATCH  | `/projects/{id}`                        | Update name / display_columns / default_k (no re-ingest)         |
| DELETE | `/projects/{id}`                        | Delete project + schema                                          |
| GET    | `/projects/{id}/columns`                | All original column names for the project schema                 |
| GET    | `/projects/{id}/ingest?tmp_path=...`    | SSE ingestion stream                                             |
| GET    | `/projects/{id}/search/stream`          | Streaming search SSE (query params)                              |
| POST   | `/projects/{id}/search`                 | Non-streaming search (id or topic mode)                          |
| POST   | `/projects/{id}/export`                 | Search + return Excel download                                   |
| GET    | `/projects/{id}/browse`                 | First 10 raw records (SELECT * LIMIT 10)                         |
| POST   | `/projects/{id}/evaluate`               | SSE RAGAS export stream                                          |
| POST   | `/projects/{id}/cluster`                | SSE cluster stream (KMeans/DBSCAN over embeddings)               |
| POST   | `/projects/{id}/system-config`          | Embedding + reranker config locked at ingestion time             |
| POST   | `/projects/{id}/verify-pin`             | Verify PIN for a protected project                               |
| POST   | `/projects/preview`                     | Parse Excel → return columns + row count                         |
| GET    | `/models?url=...&api_key=...`           | Proxy /v1/models from any OpenAI-compatible endpoint             |
| GET    | `/system-config`                        | Live system config                                               |
| GET    | `/health`                               | Liveness check                                                   |

### Compare routes (registered at `/compare` prefix via `compare_router.py`)

| Method | Path                                               | Description                                              |
| ------ | -------------------------------------------------- | -------------------------------------------------------- |
| POST   | `/compare/preview-left`                            | Multipart upload → columns, sheet_names, row_count, tmp_path |
| POST   | `/compare/preview-right`                           | Same for right file                                      |
| POST   | `/compare/preview-context`                         | `{tmp_path, match_columns, n}` → sample merged-text strings (pre-ingest preview of what will be embedded) |
| POST   | `/compare/`                                        | Create compare job → `{id, schema_name, status, ...}`    |
| GET    | `/compare/`                                        | List all jobs                                            |
| GET    | `/compare/{job_id}`                                | Job detail (tmp_path fields stripped from response)      |
| GET    | `/compare/{job_id}/ingest`                         | SSE — drives full pipeline (ingest → search → rerank)    |
| GET    | `/compare/{job_id}/review`                         | `{total_left, reviewed, pending}`                        |
| GET    | `/compare/{job_id}/review/next?min_score&offset&include_decided` | Next ReviewItem (404 if none)              |
| POST   | `/compare/{job_id}/review/{left_id}`               | Upsert decision `{matched_right_id}` (null = no match)   |
| GET    | `/compare/{job_id}/export?type=raw`                | All left × top-N right pairs (single sheet)              |
| GET    | `/compare/{job_id}/export?type=confirmed`          | 3-sheet report (post-review)                             |
| DELETE | `/compare/{job_id}`                                | Drop schema + delete row                                 |

**Export details:**
- `?type=raw` — available immediately after job is ready; one row per (left, right candidate, rank); columns: `left_row, left_display, left_contextual, rank, right_row, right_display, right_contextual, cosine, rerank`.
- `?type=confirmed` — 3 sheets: `Confirmed Matches` (decided pairs), `Unique {label_left}` (no-match + unreviewed), `Unique {label_right}` (right rows never selected). Unreviewed left rows have a blank `human_review` column; explicit no-match rows have `"no match"`.

### Per-project PIN protection

Projects can optionally be created with a PIN (`public.projects.pin`, stored as plain text).

- **If a PIN is set**: `PATCH`, `GET /columns`, `GET /browse`, `POST /search`, `POST /export`, `POST /evaluate/run` all require `X-Project-Pin: <pin>` header (401 otherwise).
- Compare Jobs have no PIN in v1.

---

## Per-Project Embedding Config

Projects can override the system-level embedding model. The config is locked at creation time.

**Flow:**
1. User provides `embed_url` + optional `embed_api_key` in the Connection step
2. Frontend calls `GET /models?url=...` — backend proxies `/v1/models` and returns model IDs
3. At ingestion start, if `embed_url` is set but `embed_dims` is null, a probe `embed("probe")` call determines actual dims and writes them to `public.projects.embed_dims`
4. `create_project_schema()` uses the resolved dims for the pgvector `vector(N)` column
5. Every `embed()` call passes `base_url`, `api_key`, `model` kwargs; `embedder.py` constructs a fresh OpenAI client for overrides, falls back to module singleton for nulls

**Fallback:** null fields fall through to system config (`OLLAMA_BASE_URL`, `EMBEDDING_MODEL`, `EMBEDDING_DIMS`).

---

## Cross-tab State — ProjectStateContext

`frontend/src/contexts/ProjectStateContext.jsx` persists search and eval state per project across the tab bar.

Key points:
- `startSearch` / `startEval` live in the context, not in page components — lets eval SSE keep running even when `EvaluateProject` is unmounted.
- Streaming search uses `fetch` + `ReadableStream` (not `EventSource`) so the PIN header can be sent; `EventSource` does not support custom headers.
- Each project gets its own search/eval slice keyed by `projectId`.

---

## Browser localStorage — Session History

All search and evaluation history is stored client-side in `localStorage` under `lens_history` (max 100 entries). Compare Jobs are intentionally excluded from history in v1.

Utility in `frontend/src/utils/history.js`: `saveSearch()`, `saveEval()`, `loadHistory()`, `clearHistory()`, `exportHistoryCSV()`.

---

## Export Filename Conventions

Pattern: `{name-slug}_lens_{descriptor}_{YYYY-MM-DD}.ext`

| Export                    | Filename                                       |
| ------------------------- | ---------------------------------------------- |
| Search → Excel            | `{project-name}_lens_results_{date}.xlsx`      |
| Evaluate → RAGAS JSON     | `{project-name}_lens_ragas_{date}.json`        |
| History → CSV             | `lens_history_{date}.csv`                      |
| Compare raw export        | `{job-name}_lens_compare_raw_{date}.xlsx`      |
| Compare confirmed export  | `{job-name}_lens_compare_confirmed_{date}.xlsx`|

---

## API Response — Search (always includes stats)

```json
{
  "results": [{"display_columns": {"ID": "PROD-1042"}, "score": 0.94}],
  "stats": {
    "mode": "topic",
    "embedding_ms": 12, "vector_search_ms": 34, "bm25_search_ms": 8,
    "rrf_merge_ms": 2, "reranker_ms": 180, "total_ms": 247,
    "candidates_retrieved": 80, "results_returned": 10
  }
}
```

---

## Frontend Screens

### Home (`/`)

Two-tab layout: **Search Projects** | **Compare Jobs** (tabs switch the main list and the "+ New" button). Right column: Recent Activity (last 5 search/eval history entries from localStorage). Compare events are not tracked in history v1.

### Create Project (`/projects/new`) — 8 steps

Name → Upload Excel → Store columns → Context columns → ID column (optional) → Display columns → Connection (override embedding URL/key/model) → Settings (default K + optional PIN) → SSE progress → redirect to search.

### Create Compare Job (`/compare/new`) — 6 steps

Names (job name + label_left + label_right) → Upload Left → Columns Left (context multi-select, content required, display optional) → Upload Right → Columns Right → Review summary → SSE progress (ingest_left → ingest_right → searching → reranking → complete) → redirect to job page.

Both the Search and Compare upload steps have **one-click sample loaders** (Products / IT Assets / Books / HR). Clicking a sample fetches from `GET /samples/{filename}` (static files served by FastAPI) and passes the downloaded blob through the same preview flow as a real upload. No special backend handling needed.

The Compare Review step calls `POST /compare/preview-context` on the already-uploaded `tmp_path` to show 2 example merged-text strings, so users can verify their column picks before committing.

### Search (`/projects/:id/search`) — tab 1 of 5

Mode toggle (ID / Topic), pipeline toggles (vector/BM25/RRF/rerank), K selector, live SSE stream via `fetch`+`ReadableStream`, results table + stats panel, Excel export.

### Evaluate (`/projects/:id/evaluate`) — tab 2 of 5

Upload CSV test set, SSE progress, RAGAS results, JSON export.

### Browse (`/projects/:id/browse`) — tab 3 of 5

First 10 raw records from Postgres, all DB columns, click to expand.

### Cluster (`/projects/:id/cluster`) — tab 4 of 5

KMeans or DBSCAN over embeddings, per-column substring filters, streaming SSE.

### Settings (`/projects/:id/settings`) — tab 5 of 5

Read-only ingestion config + editable name/k/display columns; PATCH on save.

### Compare Job (`/compare/:jobId`)

Two tabs:

**Review tab** — Left card (~38% width) with `contextual_content` + `display_value` chip. Right area with 3 candidate cards in a row, each showing content, display chip, score badge (≥0.85 green / ≥0.60 amber / else gray), rank badge. Click card = confirm match; "No match" button = explicit rejection. Top bar: progress counter, score filter dropdown, "include decided" checkbox. Prev/Next navigation with offset. Auto-advances to next undecided row after a decision when `include_decided=false`.

**Export tab** — stats grid (reviewed/pending/total left), "Download Raw" button (available immediately), "Download Confirmed" button (3-sheet post-review report).

### History (`/history`), System (`/system`), Per-project System Info (`/projects/:id/system`)

History: localStorage-backed table with type filter, expand-to-results, re-run button, CSV export.
System pages: read-only config viewers.

---

## Project Structure

```
lens/
  backend/
    config.py          ← ALL config; never call os.environ in logic files
    main.py            ← FastAPI app; registers all routers; _ingest_progress dict
    db.py              ← get_cursor(), init_db(), create/drop project+compare schemas
    embedder.py        ← embed(), rerank(), list_models(); shared by search + compare
    ingestion.py       ← read_excel(), build_contextual_content(), ingest() for Search
    comparator.py      ← ingest_side(), run_bidirectional_search(), run_reranking(),
                         write_matches(), run_compare_job(); reuses embedder + ingestion
    compare_router.py  ← FastAPI router for /compare/*; _compare_progress dict;
                         registered in main.py with prefix="/compare"
    search.py          ← vector + BM25 + RRF + reranker (streaming SSE)
    clustering.py      ← KMeans/DBSCAN over stored embeddings
    projects.py        ← project CRUD helpers
    models.py          ← all Pydantic models (Search + Compare)
    evaluate.py        ← RAGAS export builder + SSE streamer
    samples/           ← small Excel files used in e2e tests
  frontend/
    src/
      pages/
        Home.jsx               ← two-tab home (SearchTab + CompareTab)
        CreateProject.jsx      ← 8-step Search project wizard
        CreateCompareJob.jsx   ← 6-step Compare job wizard
        CompareJob.jsx         ← review + export tabs
        Search.jsx
        EvaluateProject.jsx
        Browse.jsx
        Cluster.jsx
        Settings.jsx
        SystemConfig.jsx       ← per-project system config (read-only)
        System.jsx             ← global system config (read-only)
        History.jsx
      components/
        ResultsTable.jsx
        StatsPanel.jsx
        BottomBar.jsx          ← LENS home link + API status + History link
        Layout.jsx
        PinGate.jsx            ← PIN entry card rendered when project is locked
      contexts/
        ProjectStateContext.jsx ← persists search + eval state across tab nav
      hooks/
        useProjectPin.js       ← { isLocked, unlockWithPin }
      utils/
        history.js             ← localStorage helpers
        clusterRunManager.js   ← cluster job lifecycle
      api/
        client.js              ← ALL axios/fetch calls; never inline in components
      App.jsx
      main.jsx
    vite.config.js     ← catch-all proxy: all non-HTML/non-asset requests → backend
    playwright.config.ts
  docker-compose.yml   ← --profile dev / --profile prod
  Makefile
  BEST_PRACTICES.md
```

---

## Dev Setup

### Prerequisites

1. Docker + Docker Compose installed
2. Ollama running on the host with GPU access:
  ```bash
  ollama pull bge-m3
  ollama pull bbjson/bge-reranker-base:latest
  ```

### Running the stack

```bash
make up       # start Postgres + API + frontend (dev) in background
make logs     # tail logs
make down     # stop everything
make build    # rebuild images after backend code changes
make restart  # down + up (does NOT rebuild — frontend-only changes only)
```

> **IMPORTANT:** Any change to backend Python files requires `make build && make up`.
> `make restart` alone does NOT pick up code changes.

Dev UI: `http://localhost:37001`  Dev API: `http://localhost:37002`

### Local Python (scripts / one-offs)

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python scripts/your_script.py
```

### Dev vs Prod architecture

**Dev:** Vite dev server (`localhost:37001`) proxies all non-HTML/non-asset requests to FastAPI (`localhost:37002`) via a catch-all `/` rule in `vite.config.js`. Adding new backend routes does not require updating `vite.config.js`.

**Lab setup (Linux host, Windows browsers):** Keep `VITE_API_URL` empty so the browser always calls the Vite origin and the proxy handles routing. If `VITE_API_URL` points at `:37002` directly you bypass the proxy and hit CORS/firewall issues.

**Prod — single port, FastAPI serves static files:**

1. `make prod-up` — builds frontend under `/lens-rag/` base path, starts prod stack on port 37000.
2. Caddy config:
```caddy
your.server {
    handle /lens-rag/* {
        uri strip_prefix /lens-rag
        reverse_proxy localhost:37000
    }
}
```

### Common Makefile targets

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
| `make build-frontend` | Build frontend for prod (`/lens-rag/` base path)              |
| `make clean`          | Remove old pre-rename containers/volumes; prune images        |
| `make pip-cache`      | Pre-download Linux wheels into `pip-cache/` for offline build |
| `make e2e-up`         | Start dev stack + build, then run Playwright suite            |
| `make e2e`            | Run Playwright tests (stack must already be up)               |
| `make e2e-down`       | Tear down stack after tests                                   |

### E2E Tests (Playwright)

Requires the dev stack to be running (`make up`). Ingestion tests call `skipUnlessOllamaEmbedding()` from `frontend/e2e/skipUnlessOllama.ts` and are skipped automatically when `EMBEDDING_PROVIDER != ollama`.

```bash
make e2e          # run full suite
make e2e-up       # build + start stack + run
npm run e2e:ui    # Playwright interactive UI mode (from frontend/)

# Run a single spec:
cd frontend && npx playwright test e2e/smoke.spec.ts
```

Test files in `frontend/e2e/`:

- `smoke.spec.ts` — basic liveness (home loads, bottom bar present)
- `create_ingest.spec.ts` — project creation + ingestion flow (skipped if not Ollama)
- `search_export.spec.ts` — search, export to Excel
- `eval_export.spec.ts` — evaluation run + JSON export
- `cluster.spec.ts` — clustering flow
- `pin_gate.spec.ts` — PIN protection flow
- `major_flows.spec.ts` — end-to-end user journeys (covers create+ingest+search+export)

Sample Excel files used by tests live in `backend/samples/`.

---

## Design Decisions

- pgvector over dedicated vector DB — sufficient at this scale
- HNSW over IVFFlat/exact search — fast enough; no maintenance overhead
- Hybrid BM25 + vector + RRF + reranker pipeline for Search
- Compare uses left→right vector search only (bidirectional stored, v1 uses left→right)
- Compare `top_k` stored per-job and fixed at creation; changing it for an existing job requires deleting `matches` and re-running (no UI for this in v1)
- `records` in compare schemas holds both sides in one table with a `side` column — single HNSW index, cheap SQL filter at our scale
- On-premise constraint: bge-m3 + bge-reranker-base via Ollama on A4000 GPU

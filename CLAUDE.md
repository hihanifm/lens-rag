# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# LENS — Lightweight ENgineering Search

## What is LENS?

A generic, on-premise RAG search portal for any Excel-based knowledge base.
Not a chatbot. Not a reasoning engine. Just smart search — fast and accurate.

Two project flavors:

- **Search** — upload one Excel, embed it, query it with vector + BM25 + RRF + reranker (topic mode); optional legacy single-step retrieval; ID mode when an ID column is set.
- **Compare** — upload two Excels (Left and Right), create a **job** whose schema holds embedded **records** only. **Phase 1** (`GET /compare/{job_id}/ingest`): embed both sides. **Phase 2**: create one or more **runs** under the job; each run stores `top_k` plus toggles for vector similarity, reranker, and optional **LLM judge** scoring, then `GET .../execute` runs the pipeline into per-run `matches` / `decisions` tables. Human review and Excel export are **per run** (`/compare/{job_id}/runs/{run_id}/...`).

---

## Interaction Protocol (NEVER skip this)

Before writing any code or plan, Claude MUST:

1. Ask clarifying questions to fully understand the requirements
2. Wait for the user to respond
3. Only proceed to coding after the user confirms you have enough context

While planning an implementation (drafting or refining the approach, trade-offs, or steps before coding):

1. **KISS** — default to the smallest change that satisfies the request (fewest files, no new layers, no “nice to have” scope creep). Escalate complexity only when the minimal approach is clearly insufficient.
2. **`karpathy-guidelines` skill** — read and apply it when available: state assumptions, surface trade-offs, avoid speculative abstractions, define verifiable success criteria.

Planning should explicitly reconcile **KISS + karpathy** (simple plan, honest assumptions, checkable outcomes). Do not produce plans that add APIs, tables, or UI chrome “for symmetry” unless the user asked or the minimal fix requires it.

When you deliver a **written implementation plan** (steps, files, trade-offs), include an explicit **Planning discipline** note: state whether **KISS** was applied to scope the work (yes/no; if no, one line why a larger scope was required), and whether the **`karpathy-guidelines`** skill was **read and applied** (yes/no; if the skill was unavailable, say so). Do not omit this—readers should see at a glance whether those principles governed the plan.

3. **Version** — If the agreed plan is **reasonably big** (e.g. new surface area across backend + frontend, migrations, multiple routes or screens—not a one-file tweak), **ask the user** whether to bump the **minor** version before coding. If yes, update `backend/main.py` (`FastAPI(..., version=...)`) and `frontend/package.json` / matching root entries in `frontend/package-lock.json` in the same release habit as the rest of the repo.

Do NOT jump straight into code. Always converse first.

---

## Best Practices

**General coding rules** (Claude + developer — always apply):

- **KISS** — if a simpler approach exists, take it; add complexity only when the simpler path provably fails
- **No external API calls** — zero data leaves the network; no OpenAI, no cloud services
- **No LLM in the query path** — search returns results, nothing more
- **Config in one place** — `config.py` for backend, `client.js` for frontend API base
- **No speculative abstractions** — solve the real problem in front of you; three similar lines beat a premature helper
- **No comments explaining what code does** — only add a comment when the why is non-obvious (a workaround, a hidden constraint, a subtle invariant)
- **No cleanup beyond the task** — a bug fix does not need surrounding refactoring; keep diffs small and reviewable

Stack-specific detail (React, FastAPI, Git, workflow): [BEST_PRACTICES.md](BEST_PRACTICES.md).

---

## Design Principles (NEVER violate these)

1. **KISS** — If there's a simpler way, take it. Complexity only when simpler solution provably fails.
2. **Garbage In, Garbage Out** — Read what's there, store what's there, show what's there. Never clean or judge user data.
3. **On-Premise Only** — Zero external API calls. Zero data leaves the network. No exceptions. Ever.
4. **User Drives, System Follows** — User decides context columns, display columns, ID column, K value.
5. **No LLM in Query Path** — Search returns ranked rows only (no answer synthesis). Compare **may** optionally call a user-configured OpenAI-compatible chat endpoint to score candidate pairs inside a **run** (off by default); that is separate from Search retrieval.
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
- **Compare LLM judge (optional)** — if enabled on a run, scores candidates via a user-configured OpenAI-compatible URL (same trust model as per-project embedding overrides); intended for on-prem inference, not mandatory for Compare.
- **Compare `llm_judge_prompt`** — stores **domain-only** guidance; `comparator.effective_llm_judge_system_prompt()` always appends the fixed suffix (input-shape text, scoring rubric, JSON `scores` contract) so the response parser stays valid.

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
# Compare LLM judge: minimum per-batch max_tokens floor (completion budget also capped at 8192 in code).
# Reasoning models may need a higher value; truncation (finish_reason=length) is logged on the API server.
LLM_JUDGE_MAX_TOKENS=2048

# Database
DB_HOST=lens-postgres
DB_PORT=5432
DB_NAME=lens
DB_USER=lens_user
DB_PASSWORD=changeme

# Reverse proxy — set when serving under a sub-path (e.g. /lens-rag)
ROOT_PATH=          # e.g. /lens-rag  (empty = serve at root)

# Logging — set DEBUG for verbose output (defaults to DEBUG in dev, INFO in prod)
LOG_LEVEL=INFO
```

### Switching to OpenAI (e.g. testing from home)

```bash
EMBEDDING_PROVIDER=openai OPENAI_API_KEY=sk-... EMBEDDING_DIMS=1536 RERANKER_ENABLED=false make up
```

Or set in a local `.env` file (never commit it).

Candidate pool sizes for Search (`TOP_K_RETRIEVAL`, `TOP_K_DEFAULT`, `TOP_K_MAX`) and related limits live as constants in `config.py` (not all exposed as env vars). Compare `**top_k**` is stored per **run** in `public.compare_runs`; `COMPARE_TOP_K` / thresholds still apply to defaults and UI coloring.

---

## Database Design

### Search flavor — one schema per project

Authoritative DDL and migrations: `db.py` (`init_db`). Summary:

```sql
CREATE TABLE public.projects (
  id                  SERIAL PRIMARY KEY,
  name                TEXT NOT NULL,
  schema_name         TEXT NOT NULL,       -- project_{id}
  stored_columns      TEXT[] NOT NULL DEFAULT '{}',
  context_columns     TEXT[] NOT NULL DEFAULT '{}',
  id_column           TEXT,
  content_column      TEXT NOT NULL,
  display_columns     TEXT[] NOT NULL DEFAULT '{}',
  has_id_column       BOOLEAN DEFAULT FALSE,
  default_k           INTEGER DEFAULT 5,
  status              TEXT DEFAULT 'pending', -- pending | ingesting | ready | error
  row_count           INTEGER,
  total_rows          INTEGER,
  pin                 TEXT,
  source_filename     TEXT,
  embed_url           TEXT,
  embed_api_key       TEXT,
  embed_model         TEXT,
  embed_dims          INTEGER,
  rerank_enabled      BOOLEAN DEFAULT TRUE,
  rerank_model        TEXT,
  ingested_at         TIMESTAMP,
  ingestion_ms        INTEGER,
  ingestion_started_at TIMESTAMP,
  created_at          TIMESTAMP DEFAULT NOW()
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

### Compare flavor — `public.compare_jobs` + `public.compare_runs` + per-job schema

- `**public.compare_jobs**` — job metadata, column mapping, optional per-job `embed_url` / `embed_api_key` / `embed_model` / `embed_dims`, optional `notes`. Legacy `top_k` / `rerank_*` columns may exist for migrated rows; new jobs store pipeline settings on **runs**.
- `**public.compare_runs`** — one row per pipeline execution: `top_k`, `vector_enabled`, `reranker_*`, `llm_judge_*`, `status`, timestamps.
- **Schema `compare_{job_id}`** — shared `**records**` table (left + right embeddings only). Per-run tables: `**run_{run_id}_matches**` (candidates + `cosine_score`, `rerank_score`, `llm_score`, `final_score`, `rank`) and `**run_{run_id}_decisions**` (`left_id` PK, `matched_right_id` nullable for explicit no-match).

```sql
-- Per-job schema compare_{id} — embeddings only
CREATE TABLE compare_{id}.records (
  id                  SERIAL PRIMARY KEY,
  side                TEXT NOT NULL CHECK (side IN ('left','right')),
  original_row        INTEGER,
  sheet_name          TEXT,
  contextual_content  TEXT,
  display_value       TEXT,
  embedding           vector(N)
);
CREATE INDEX ON compare_{id}.records USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON compare_{id}.records (side);

-- Per-run tables (created when a run is inserted)
CREATE TABLE compare_{id}.run_{run_id}_matches (
  id              SERIAL PRIMARY KEY,
  left_id         INTEGER NOT NULL,
  right_id        INTEGER NOT NULL,
  cosine_score    FLOAT,
  rerank_score    FLOAT,
  llm_score       FLOAT,
  final_score     FLOAT NOT NULL DEFAULT 0,
  rank            INTEGER NOT NULL
);
CREATE INDEX ON compare_{id}.run_{run_id}_matches (left_id, rank);

CREATE TABLE compare_{id}.run_{run_id}_decisions (
  left_id            INTEGER PRIMARY KEY,
  matched_right_id   INTEGER,          -- legacy single-id (still readable)
  matched_right_ids  INTEGER[],        -- authoritative multi-select ([] = explicit no-match)
  review_comment     TEXT,
  review_outcome     TEXT,             -- no_match | partial | fail | system_fail
  decided_at         TIMESTAMP DEFAULT NOW()
);

-- Shared across all jobs: LLM judge prompt presets
CREATE TABLE public.compare_llm_prompt_templates (
  id      SERIAL PRIMARY KEY,
  name    TEXT NOT NULL,               -- unique
  body    TEXT NOT NULL,               -- domain-only overlay (suffix appended by code)
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT NOW()
);
```

`run_*_matches` is written when a run’s pipeline completes and is not mutated afterward. `run_*_decisions` is mutable; `POST /compare/{job_id}/runs/{run_id}/review/{left_id}` upserts decisions. Startup runs `migrate_legacy_compare_jobs()` to wrap pre-runs jobs that still had flat `matches` / `decisions` tables into a synthetic `compare_runs` row + `run_1_*` tables.

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
def build_contextual_content(row, context_columns, content_column, sheet_name):
    parts = [str(sheet_name)]
    for col in context_columns:
        val = str(row.get(col, '')) if row.get(col) is not None else ''
        if val and val.lower() != 'nan':
            parts.append(val)
    if content_column:
        content = str(row.get(content_column, '')) if row.get(content_column) is not None else ''
        if content and content.lower() != 'nan':
            parts.append(content)
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

**Phase 1 — job embedding** (`comparator.run_ingest_job`, driven by `GET /compare/{job_id}/ingest`):

1. Ingest left and right rows into `compare_{job_id}.records` (shared embedder + `ingestion.read_excel` / `build_contextual_content`).
2. Deletes temp upload files when complete. Job status ends in `ready` (or `error`).

**Phase 2 — run pipeline** (`comparator.run_pipeline`, driven by `GET /compare/{job_id}/runs/{run_id}/execute`):

1. For each left row, optional vector retrieval against right embeddings (`top_k` from the run).
2. Optional reranker (Ollama cross-encoder) and optional LLM judge merge into `final_score` per candidate.
3. Writes `compare_{job_id}.run_{run_id}_matches` (immutable) with ranks 1..top_k.

SSE progress: `compare_router.py` uses `_job_ingest_progress[job_id]` for Phase 1 and `_run_progress[run_id]` for Phase 2 (background thread updates dict; stream polls ~1 s — similar spirit to `_ingest_progress` in `main.py`).

---

## API Routes

### Search routes


| Method | Path                                 | Description                                                                                  |
| ------ | ------------------------------------ | -------------------------------------------------------------------------------------------- |
| GET    | `/projects`                          | List all projects                                                                            |
| GET    | `/projects/{id}`                     | Get project detail (includes `has_pin`, never returns raw `pin`)                             |
| POST   | `/projects`                          | Create project metadata                                                                      |
| PATCH  | `/projects/{id}`                     | Update name / display_columns / default_k / `rerank_enabled` / `rerank_model` (no re-ingest) |
| DELETE | `/projects/{id}`                     | Delete project + schema                                                                      |
| GET    | `/projects/{id}/columns`             | All original column names for the project schema                                             |
| GET    | `/projects/{id}/ingest?tmp_path=...` | SSE ingestion stream                                                                         |
| GET    | `/projects/{id}/search/stream`       | Streaming search SSE (query params; topic / id / legacy)                                     |
| POST   | `/projects/{id}/search`              | Non-streaming search                                                                         |
| POST   | `/projects/{id}/export`              | Search + return Excel download                                                               |
| GET    | `/projects/{id}/browse`              | First 10 raw records (SELECT * LIMIT 10)                                                     |
| POST   | `/projects/{id}/evaluate`            | SSE RAGAS export stream                                                                      |
| POST   | `/projects/{id}/cluster`             | SSE cluster stream (KMeans/DBSCAN over embeddings)                                           |
| POST   | `/projects/{id}/cluster/export`      | Same clustering as POST cluster, returns Excel download                                      |
| GET    | `/projects/{id}/column-values`       | Distinct values for a column (cluster filter picker; max 100)                                |
| GET    | `/projects/{id}/system-config`       | Read-only retrieval stack summary (PIN if project locked)                                    |
| POST   | `/projects/{id}/verify-pin`          | Body `{ "pin": "..." }` → `{ "ok": true }` or 401                                            |
| POST   | `/projects/preview`                  | Multipart Excel → columns, sheet_names, row_count, tmp_path                                  |
| GET    | `/models?url=...&api_key=...`        | Proxy `/v1/models` from an OpenAI-compatible endpoint                                        |
| POST   | `/embedding/verify`                  | Probe embed with optional URL/key/model (Create flow)                                        |
| POST   | `/rerank/verify`                     | Probe reranker model (returns strategy)                                                      |
| GET    | `/system-config`                     | Global live system config (no PIN)                                                           |
| GET    | `/health`                            | Liveness + API `version`                                                                     |


### Compare routes (registered at `/compare` prefix via `compare_router.py`)

See module docstring in `compare_router.py` for the full list. Summary:


| Method | Path                                               | Description                                                                                                                              |
| ------ | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/compare/preview-left` / `preview-right`                   | Multipart upload → columns, sheet_names, row_count, tmp_path                                                                             |
| POST   | `/compare/preview-context`                                  | `{ tmp_path, match_columns, n }` → sample merged strings (server splits match_columns into context vs content heuristically for preview) |
| POST   | `/compare/preview-row-stats`                                | Row counts after sheet + column filters                                                                                                  |
| POST   | `/compare/preview-column-values`                            | Distinct values for a column (filter picker)                                                                                             |
| POST   | `/compare/preview-column-samples`                           | First N row(s) per column (column picker; default 1)                                                                                     |
| GET    | `/compare/llm-judge-defaults`                               | Built-in default judge prompt + suffix snippet + token settings                                                                          |
| GET    | `/compare/prompt-templates`                                 | List LLM judge preset names (id + name)                                                                                                  |
| GET    | `/compare/prompt-templates/{id}`                            | Full preset body                                                                                                                         |
| POST   | `/compare/prompt-templates`                                 | Create preset                                                                                                                            |
| PATCH  | `/compare/prompt-templates/{id}`                            | Update preset                                                                                                                            |
| DELETE | `/compare/prompt-templates/{id}`                            | Delete preset                                                                                                                            |
| POST   | `/compare/`                                                 | Create job + schema (embed settings only; no pipeline yet)                                                                               |
| GET    | `/compare/`                                                 | List jobs                                                                                                                                |
| GET    | `/compare/{job_id}`                                         | Job detail (secrets / tmp paths stripped)                                                                                                |
| PATCH  | `/compare/{job_id}`                                         | Update `name` / `notes`                                                                                                                  |
| DELETE | `/compare/{job_id}`                                         | Drop job schema + job + all runs                                                                                                         |
| GET    | `/compare/{job_id}/ingest`                                  | SSE Phase 1 — embed left + right into `records`                                                                                          |
| POST   | `/compare/{job_id}/runs`                                    | Create run (`top_k`, vector / reranker / llm_judge flags + URLs/models)                                                                  |
| GET    | `/compare/{job_id}/runs`                                    | List runs                                                                                                                                |
| GET    | `/compare/{job_id}/runs/{run_id}`                           | Run detail                                                                                                                               |
| PATCH  | `/compare/{job_id}/runs/{run_id}`                           | Rename run                                                                                                                               |
| DELETE | `/compare/{job_id}/runs/{run_id}`                           | Drop run tables + row                                                                                                                    |
| GET    | `/compare/{job_id}/runs/{run_id}/execute`                   | SSE Phase 2 — populate `run_{run_id}_matches`; optional `?max_left_rows=N`                                                               |
| GET    | `/compare/{job_id}/runs/{run_id}/review`                    | `{ total_left, reviewed, pending, no_match, matched }`                                                                                   |
| GET    | `/compare/{job_id}/runs/{run_id}/review/next`               | Next `ReviewItem` (optional `?text_contains=`; **run-scoped**)                                                                           |
| POST   | `/compare/{job_id}/runs/{run_id}/review/{left_id}`          | Upsert decision (204); body `matched_right_ids` (authoritative array), optional `review_comment`, optional `review_outcome` (`no_match`, `partial`, `fail`, `system_fail`) |
| DELETE | `/compare/{job_id}/runs/{run_id}/review/{left_id}`          | Clear decision (back to pending)                                                                                                         |
| POST   | `/compare/{job_id}/runs/{run_id}/retry-llm-judge/{left_id}` | Re-run LLM judge for one left row (uses stored candidates)                                                                               |
| GET    | `/compare/{job_id}/runs/{run_id}/export`                    | Excel download; `type=raw` or `type=confirmed` (per run)                                                                                 |
| GET    | `/compare/{job_id}/browse`                                  | Paginated raw `records` (optional `side=left|right`)                                                                                     |
| GET    | `/compare/{job_id}/runs/{run_id}/browse-raw`                | Slice of match pairs + scores for UI                                                                                                     |
| GET    | `/compare/{job_id}/config-stats`                            | Job config + stats blob for UI / debugging                                                                                               |


**Export details** (`export?type=` on a **run**):

- `type=raw` — one row per (left, candidate right, rank); includes cosine, rerank, LLM, and **final** scores when present.
- `type=confirmed` — same three-sheet semantics as before (`Confirmed Matches`, unique left including `human_review`, unique right), scoped to that run’s `matches` / `decisions`.

### Per-project PIN protection

Projects can optionally be created with a PIN (`public.projects.pin`, stored as plain text).

- **If a PIN is set**, these require header `X-Project-Pin: <pin>` (401 otherwise): `PATCH /projects/{id}`, `DELETE /projects/{id}`, `GET /projects/{id}/columns`, `GET /projects/{id}/browse`, `GET /projects/{id}/search/stream`, `POST /projects/{id}/search`, `POST /projects/{id}/export`, `POST /projects/{id}/cluster`, `POST /projects/{id}/cluster/export`, `GET /projects/{id}/column-values`, `GET /projects/{id}/system-config`, `POST /projects/{id}/evaluate`.
- `**GET /projects/{id}/ingest`** is not PIN-gated (used right after create with a fresh `tmp_path`); treat project URLs accordingly.
- `POST /projects/{id}/verify-pin` checks the PIN in the JSON body (no `X-Project-Pin` required on that route).
- Compare Jobs have no PIN in v1.

---

## Per-Project Embedding Config

Projects can override the system-level embedding model. Embedding URL / key / model / dims are fixed at **project create** (ingestion uses those fields).

**Flow:**

1. User provides `embed_url` + optional `embed_api_key` in the Connection step
2. Frontend calls `GET /models?url=...` — backend proxies `/v1/models` and returns model IDs
3. `POST /embedding/verify` can validate the endpoint before submit
4. At ingestion start, if `embed_url` is set but `embed_dims` is null, a probe `embed("probe")` call determines dims and writes `public.projects.embed_dims`
5. `create_project_schema()` uses the resolved dims for the pgvector `vector(N)` column
6. Every `embed()` call passes `base_url`, `api_key`, `model` kwargs; `embedder.py` builds a client for overrides or falls back to the module singleton

**Rerank:** `public.projects.rerank_enabled` + `rerank_model` gate Search/export/eval/cluster reranking (`PATCH` from Settings or `RerankConfigModal`). Null/empty `rerank_model` → system `RERANKER_MODEL`.

**Fallback:** null embed fields fall through to system config (`OLLAMA_BASE_URL` / OpenAI settings + `EMBEDDING_MODEL` + `EMBEDDING_DIMS` from `config.py`).

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


| Export                   | Filename                                        |
| ------------------------ | ----------------------------------------------- |
| Search → Excel           | `{project-name}_lens_results_{date}.xlsx`       |
| Evaluate → RAGAS JSON    | `{project-name}_lens_ragas_{date}.json`         |
| History → CSV            | `lens_history_{date}.csv`                       |
| Compare raw export       | `{job-name}_lens_compare_raw_{date}.xlsx`       |
| Compare confirmed export | `{job-name}_lens_compare_confirmed_{date}.xlsx` |


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

### Create Compare Job (`/compare/new`) — 7 steps

Names → Upload Left → Columns Left (multi-select “match columns” merged for embedding + optional display column) → Upload Right → Columns Right → **Connection** (optional per-job embedding URL / key / model; dims probed at create) → Review & create → **redirect to job page** (`/compare/:jobId`).

Embedding runs on the job page via `GET /compare/{job_id}/ingest` (SSE). After the job is `ready`, users create **runs** (vector / reranker / LLM judge / `top_k`) and execute each with `GET .../runs/{run_id}/execute` (SSE). Review and export are scoped to the selected run.

Both the Search and Compare upload steps have **one-click sample loaders** (Products / IT Assets / Books / HR). Clicking a sample fetches from `GET /samples/{filename}` (static files under `backend/samples/`, mount path configurable with `SAMPLES_DIR`) and passes the downloaded blob through the same preview flow as a real upload.

The Compare Review step calls `POST /compare/preview-context` on the chosen side’s `tmp_path` with `{ match_columns, n }` so users see sample merged strings before create.

### Search (`/projects/:id/search`) — tab 1 of 5

Mode toggle (ID / Topic / **Legacy**), pipeline toggles (vector/BM25/RRF/rerank) for topic mode, K selector, live SSE stream via `fetch` + `ReadableStream`, results table + stats panel, Excel export.

### Evaluate (`/projects/:id/evaluate`) — tab 2 of 5

Upload CSV test set, SSE progress, RAGAS results, JSON export.

### Browse (`/projects/:id/browse`) — tab 3 of 5

First 10 raw records from Postgres, all DB columns, click to expand.

### Cluster (`/projects/:id/cluster`) — tab 4 of 5

KMeans or DBSCAN over embeddings, per-column substring filters, streaming SSE.

### Settings (`/projects/:id/settings`) — tab 5 of 5

Read-only ingestion config + editable name / default K / display columns; rerank enable + model override (with `RerankConfigModal` + `POST /rerank/verify`); PATCH on save. Uses `GET /system-config` and `GET /projects/{id}/system-config` for readouts.

### Compare Job (`/compare/:jobId`)

Job-level: ingest status, optional **Browse** embedded rows, **Config / stats** panel (`GET /compare/{job_id}/config-stats`), **Runs** list (create / delete / select). Each run: **Execute** pipeline (SSE), then **Review** (same card UX as before; primary score prefers `final_score`, then normalized rerank, else cosine). Candidate badges can show **C / R / LLM** when scores exist. **Export** raw vs confirmed is **per run**. Top-k and pipeline toggles are chosen when creating the run, not at job create time.

### Prompt Presets (`/prompts`)

CRUD page for `public.compare_llm_prompt_templates`. Lists saved presets; create / edit / delete via `prompt-templates` API. Presets are domain-only overlays — the fixed suffix (scoring rubric, JSON contract) is appended by `comparator.effective_llm_judge_system_prompt()`, not stored here.

### History (`/history`), System (`/system`)

History: localStorage-backed table with type filter, expand-to-results, re-run button, CSV export.

Global **System** (`/system`): read-only `GET /system-config`. Per-project retrieval detail uses `GET /projects/{id}/system-config` from Settings (no separate route in `App.jsx`).

---

## Project Structure

Repository root (not a `lens/` subfolder):

```
backend/
  config.py          ← ALL config; never call os.environ in logic files
  main.py            ← FastAPI app; registers routers; _ingest_progress; static/samples mounts
  db.py              ← get_cursor(), init_db(), project + compare schemas + per-run tables;
                       migrate_legacy_compare_jobs()
  embedder.py        ← embed(), rerank(), list_models(); shared by search + compare
  ingestion.py       ← read_excel(), build_contextual_content(), ingest() for Search
  comparator.py      ← run_ingest_job(), run_pipeline(), vector/rerank/LLM stages;
                       reuses embedder + ingestion
  compare_router.py  ← /compare/*; _job_ingest_progress, _run_progress
  prompt_seeds.py    ← starter rows for compare_llm_prompt_templates (seeded at init)
  search.py          ← vector + BM25 + RRF + reranker (streaming SSE)
  clustering.py      ← KMeans/DBSCAN over stored embeddings
  projects.py        ← project CRUD helpers
  models.py          ← Pydantic models (Search + Compare)
  evaluate.py        ← RAGAS export builder + SSE streamer
  samples/           ← small Excel files for e2e + UI sample loaders
frontend/
  src/
    pages/
      Home.jsx
      CreateProject.jsx
      CreateCompareJob.jsx
      CompareJob.jsx
      Search.jsx
      EvaluateProject.jsx
      Browse.jsx
      Cluster.jsx
      Settings.jsx
      System.jsx
      History.jsx
      PromptPresets.jsx    ← LLM judge prompt template CRUD (/prompts)
    components/
      ResultsTable.jsx
      StatsPanel.jsx
      BottomBar.jsx
      Layout.jsx
      PinGate.jsx
      RerankConfigModal.jsx
      FileDropZone.jsx
    contexts/
      ProjectStateContext.jsx
    hooks/
      useProjectPin.js
    utils/
      history.js
      clusterRunManager.js
    api/
      client.js
    App.jsx
    main.jsx
  vite.config.js
  playwright.config.ts
docker-compose.yml
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

**Lab setup (Linux host, Windows browsers):** Keep `VITE_API_PROXY_TARGET` unset (or pointing at the container name) so the Vite proxy handles routing. If the browser directly calls `:37002` you bypass the proxy and hit CORS/firewall issues.

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
| `make logs-api`       | Follow API container logs only                                |
| `make logs-frontend`  | Follow frontend container logs only                           |
| `make logs-db`        | Follow Postgres container logs only                           |
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
- `compare_flow.spec.ts` — compare job creation + review + export flow
- `major_flows.spec.ts` — end-to-end user journeys (covers create+ingest+search+export)

Sample Excel files used by tests live in `backend/samples/`.

---

## Design Decisions

- pgvector over dedicated vector DB — sufficient at this scale
- HNSW over IVFFlat/exact search — fast enough; no maintenance overhead
- Hybrid BM25 + vector + RRF + reranker pipeline for Search (plus optional legacy single-shot mode)
- Compare embeddings live once per job (`records`); **runs** recompute candidate sets and scores into `run_{id}_matches` so operators can A/B pipelines (`top_k`, reranker, LLM judge) without re-embedding
- Compare vector stage is left→right nearest-neighbor over the shared `records` table (`side` filter)
- `records` in compare job schemas holds both sides with a `side` column — single HNSW index per job
- On-premise default: bge-m3 + bge-reranker-base via Ollama on host GPU; OpenAI embedding path is opt-in for development only


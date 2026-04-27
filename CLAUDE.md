# LENS — Lightweight ENgineering Search

## What is LENS?
A generic, on-premise RAG search portal for any Excel-based knowledge base.
Not a chatbot. Not a reasoning engine. Just smart search — fast and accurate.

Originally designed for telecom MNO device requirement specifications (VZW, AT&T, TMO)
but intentionally generic — works for any domain, any Excel structure.

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
- openai Python client (pointed at Ollama — NOT OpenAI servers)
- psycopg2 (Postgres connection)

### Frontend
- React + Vite
- TanStack Table (results table)
- TanStack Query (data fetching)
- Tailwind CSS (styling)
- Axios (API calls)

### Infrastructure
- Docker Compose: lens-api (FastAPI) + lens-postgres (pgvector)
- Ollama: runs on host, outside Docker
- Communication: FastAPI → Ollama via host.docker.internal:11434

---

## System Config (config.py)

```python
# Embedding
EMBEDDING_BASE_URL = "http://host.docker.internal:11434/v1"
EMBEDDING_MODEL    = "bge-m3"
EMBEDDING_DIMS     = 1024

# Reranker
RERANKER_MODEL     = "bge-reranker-base"

# Search defaults
TOP_K_RETRIEVAL    = 50     # internal candidate pool
TOP_K_DEFAULT      = 10     # default results shown to user
TOP_K_MAX          = 50     # user cannot exceed this

# Database
DB_HOST            = "lens-postgres"
DB_PORT            = 5432
DB_NAME            = "lens"
DB_USER            = "lens_user"
DB_PASSWORD        = "changeme"

# Projects
PROJECTS_BASE_DIR  = "/data/projects"
```

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
  -- e.g. col_mno, col_module, col_req_id, col_content
  contextual_content  TEXT,         -- built by system at ingestion
  embedding           vector(1024), -- bge-m3 output
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
# e.g. "29550" matches "VZ_REQ_LTESMS_29550"
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

## API Response — always includes stats

```json
{
  "results": [
    {
      "display_columns": {"REQ_ID": "VZ_REQ_LTESMS_29550", "MNO": "VZW", ...},
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

## Frontend Screens (4 only)

### Screen 1 — Home
- List of projects (name, status, row count, created date)
- [+ New Project] button

### Screen 2 — Create Project (multi-step)
- Step 1: Project name
- Step 2: Upload Excel → system reads and shows all columns
- Step 3: Pick content column (single select)
- Step 4: Pick context columns (multi-select, excludes content column)
- Step 5: Pick ID column (optional, single select or None)
- Step 6: Pick display columns (multi-select, pre-filled with context + id columns)
- Step 7: Set default K (5/10/20/50, default 10)
- [Create] → SSE progress bar → "Ready!"

### Screen 3 — Search
- Project name shown top
- Search mode toggle: [ID] [Topic] (ID only shown if has_id_column)
- Query input
- K selector: 5 / 10 / 20 / 50
- [Search] button
- Results table (display columns only, configured at project creation)
- Stats panel (timing breakdown)
- [Export to Excel] button

### Screen 4 — (future) Admin settings

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
    search.py          ← vector + BM25 + RRF + reranker
    projects.py        ← project CRUD
    models.py          ← Pydantic models
  frontend/
    src/
      pages/
        Home.jsx
        CreateProject.jsx
        Search.jsx
      components/
        ResultsTable.jsx
        StatsPanel.jsx
        ProgressBar.jsx
        ColumnPicker.jsx
      api/
        client.js      ← ALL axios calls here, nowhere else
      App.jsx
      main.jsx
    package.json
    vite.config.js
    tailwind.config.js
  docker-compose.yml
  requirements.txt
  CLAUDE.md            ← this file
```

---

## What LENS is NOT (never add without explicit instruction)

- Not a compliance tracker
- Not a knowledge graph
- Not a cross-MNO comparison tool
- Not a version diff tool
- Not a standards linker (3GPP etc.)
- Not a filter/browse tool (deferred to next project)
- Not a multi-column keyword index tool (deferred to v2)
- Not connected to any external API ever

---

## Origin Context

LENS was designed through an extensive design conversation covering:
- Telecom MNO requirement documents (VZW LTESMS, LTEB13NAC)
- Question taxonomy (Tier 1-8, only Tier 1-4 in scope for v1)
- Why pure RAG is sufficient vs knowledge graph (graph deferred to v2)
- pgvector vs dedicated vector DB (pgvector wins at this scale)
- HNSW vs IVFFlat vs exact search (exact search at current scale)
- Hybrid BM25 + vector + RRF + reranker pipeline
- Slowly changing dimension for release management (deprecated_in IS NULL = latest)
- On-premise constraint: bge-m3 + bge-reranker-base via Ollama on A4000 GPU
- Excel ingestion: ffill → dropna(how='all') → treat everything as plain text

The director's full NORA design (knowledge graph, compliance agent, cross-MNO) 
is a valid v3. LENS is the validated v1 foundation.

---

## Dev Setup

### Prerequisites
1. Docker + Docker Compose installed
2. Ollama running on the host with GPU access:
   ```bash
   ollama pull bge-m3
   ollama pull bge-reranker-base
   ```

### Running the stack
```bash
make up       # start FastAPI + PostgreSQL in background
make logs     # tail logs
make down     # stop everything
make build    # rebuild images after code changes
make restart  # down + up
```

Frontend runs separately (dev mode):
```bash
cd frontend
npm install
npm run dev   # http://localhost:5173
```

Backend API: `http://localhost:8000`
Postgres: `localhost:5432` (lens_user / changeme)

### Common Makefile targets
| Command | What it does |
|---|---|
| `make up` | Start stack detached |
| `make down` | Stop stack |
| `make build` | Rebuild Docker images |
| `make logs` | Follow all container logs |
| `make restart` | Full restart |
| `make ps` | Show container status |

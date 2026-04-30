# Plan: Compare Runs — Modular Pipeline

## Goal
Decouple compare job creation (embedding only) from pipeline execution. After a job is created, users can run multiple **Runs** against the same embedded documents, each with a different pipeline configuration (retrieval strategy + reranker + LLM judge). Each run has its own matches, review, and export.

---

## What changes

### Phase 1 — Job creation (lighter)
**Current:** upload → configure → create job → SSE (embed left + embed right + vector search + rerank) → ready  
**New:** upload → configure → create job → SSE (embed left + embed right only) → ready

The job status `ready` now means "embeddings stored, ready for runs" — not "matches computed".

---

## Database

### `public.compare_jobs` — remove `top_k`
`top_k` moves to per-run config. All other fields stay.

### New table: `public.compare_runs`
```sql
CREATE TABLE public.compare_runs (
  id                    SERIAL PRIMARY KEY,
  job_id                INTEGER NOT NULL REFERENCES public.compare_jobs(id),
  name                  TEXT,                      -- optional user label, e.g. "bge rerank only"
  status                TEXT DEFAULT 'pending',    -- pending | running | ready | error
  status_message        TEXT,
  top_k                 INTEGER NOT NULL DEFAULT 3,
  -- Retrieval
  vector_enabled        BOOLEAN DEFAULT TRUE,
  bm25_enabled          BOOLEAN DEFAULT FALSE,
  -- Reranker
  reranker_enabled      BOOLEAN DEFAULT TRUE,
  reranker_model        TEXT,                      -- null = system default
  reranker_url          TEXT,
  -- LLM Judge
  llm_judge_enabled     BOOLEAN DEFAULT FALSE,
  llm_judge_url         TEXT,
  llm_judge_model       TEXT,
  llm_judge_prompt      TEXT,
  -- Results summary
  row_count_left        INTEGER,                   -- filled after run completes
  created_at            TIMESTAMP DEFAULT NOW(),
  completed_at          TIMESTAMP
);
```

### Per-run tables — inside `compare_{job_id}` schema
Replace the single `matches` / `decisions` pair with run-scoped tables:

```sql
-- created when a run is created
CREATE TABLE compare_{job_id}.run_{run_id}_matches (
  id           SERIAL PRIMARY KEY,
  left_id      INTEGER NOT NULL,
  right_id     INTEGER NOT NULL,
  cosine_score FLOAT,
  rerank_score FLOAT,
  llm_score    FLOAT,
  final_score  FLOAT NOT NULL,   -- last pipeline stage score used for ranking
  rank         INTEGER NOT NULL  -- 1 = best
);
CREATE INDEX ON compare_{job_id}.run_{run_id}_matches (left_id, rank);

CREATE TABLE compare_{job_id}.run_{run_id}_decisions (
  left_id          INTEGER PRIMARY KEY,
  matched_right_id INTEGER,
  decided_at       TIMESTAMP DEFAULT NOW()
);
```

### Migration — existing jobs
Jobs already in `ready` status have the old `matches` / `decisions` tables. On startup, `init_db()` will detect these and create a synthetic `run_1` row in `compare_runs` pointing at those tables (renamed to `run_1_matches` / `run_1_decisions`). This is a one-time migration.

---

## Backend

### `db.py`
- `create_run_tables(job_id, run_id)` — creates `run_{run_id}_matches` + `run_{run_id}_decisions` in `compare_{job_id}` schema
- `drop_run_tables(job_id, run_id)`
- `migrate_legacy_matches(job_id, run_id)` — rename `matches` → `run_{run_id}_matches` etc. for old jobs

### `models.py`
New Pydantic models:
- `CompareRunCreate` — pipeline config fields + optional name
- `CompareRunResponse` — full run row
- `CompareRunStatus` — for SSE progress

### `comparator.py`
Split `run_compare_job()` into two generators:
- `run_ingest_job(job_id)` — embed left + embed right only (what job creation now calls)
- `run_pipeline(job_id, run_id, run_config)` — vector search + BM25 + RRF + rerank + LLM judge + write matches

Add `run_llm_judge(schema_name, run_id, candidates, config)`:
- Groups candidates by left_id
- For each group: builds a prompt from `llm_judge_prompt` + left text + candidate right texts
- Calls OpenAI-compatible chat completion at `llm_judge_url`
- Parses scores (0–1 float per candidate)
- Returns `(left_id, right_id, llm_score)` list

### `compare_router.py`
New routes (all nested under `/compare/{job_id}/runs`):

| Method | Path | Description |
|--------|------|-------------|
| POST | `/compare/{job_id}/runs` | Create a run (inserts row, creates tables) |
| GET | `/compare/{job_id}/runs` | List all runs for a job |
| GET | `/compare/{job_id}/runs/{run_id}` | Run detail |
| GET | `/compare/{job_id}/runs/{run_id}/execute` | SSE — execute the pipeline |
| GET | `/compare/{job_id}/runs/{run_id}/review` | `{total_left, reviewed, pending}` |
| GET | `/compare/{job_id}/runs/{run_id}/review/next` | Next ReviewItem |
| POST | `/compare/{job_id}/runs/{run_id}/review/{left_id}` | Upsert decision |
| GET | `/compare/{job_id}/runs/{run_id}/export` | Export (raw or confirmed) |
| DELETE | `/compare/{job_id}/runs/{run_id}` | Delete run + its tables |

Existing review/export/decision routes on the job level are removed.

`_compare_progress` dict in `compare_router.py` keys on `run_id` (not `job_id`) since multiple runs can exist per job.

---

## Frontend

### `CreateCompareJob.jsx`
- SSE progress step: remove "searching" and "reranking" steps from the step labels
- After embedding completes → redirect to `/compare/{id}` (same as today)

### `CompareJob.jsx` — full rewrite
**Top section:** job metadata (labels, file names, row counts, status)

**Main area — Runs list:**
- Table of runs: name, pipeline config summary (chips for enabled stages), status badge, created_at, action buttons
- "New Run" button → opens `NewRunModal`
- Each ready run row has "Review" + "Export" quick-action buttons that navigate to run detail

**Run detail view** (replaces current Review + Export tabs):
- Back link to job
- Header: run name + pipeline config summary
- Two tabs: **Review** | **Export**
- Review tab: identical to current review UI, data scoped to `run_id`
- Export tab: identical to current export UI, data scoped to `run_id`

### New `NewRunModal.jsx`
Form fields:
- Run name (optional text input)
- Top-K (number input, default 3)
- Retrieval toggles: `[Vector]` `[BM25]` — at least one required (validation)
- Reranker toggle + configure button → opens existing `RerankConfigModal` pattern (URL + model)
- LLM Judge toggle + configure button → opens `LLMJudgeConfigModal` (URL + model + prompt textarea)
- Submit → `POST /compare/{job_id}/runs` → navigate to SSE execute

### New `LLMJudgeConfigModal.jsx`
Three fields: Endpoint URL, Model name, System prompt (textarea).  
Default prompt: `"Given the following query text and a candidate text, return a similarity score between 0 and 1. Reply with only a JSON object: {\"score\": <float>}."`

### `api/client.js`
Add run CRUD + review + export functions. Remove old job-level review/decision/export functions.

---

## Steps

1. **DB** — add `compare_runs` table to `init_db()`, add `create_run_tables()` / `drop_run_tables()`, write migration for legacy jobs
2. **models.py** — add `CompareRunCreate`, `CompareRunResponse`
3. **comparator.py** — split `run_compare_job()` into `run_ingest_job()` + `run_pipeline()`; add `run_llm_judge()`
4. **compare_router.py** — add run routes; remove job-level review/decision/export; key `_compare_progress` on `run_id`
5. **CreateCompareJob.jsx** — strip matching/reranking steps from SSE progress UI
6. **CompareJob.jsx** — rewrite to runs list + run detail tabs
7. **NewRunModal.jsx** + **LLMJudgeConfigModal.jsx** — new components
8. **api/client.js** — update API functions

---

## What does NOT change
- `compare_{job_id}.records` table — unchanged, holds embeddings for both sides
- Job creation wizard steps (Names → Upload Left → Columns Left → Upload Right → Columns Right → Review summary → SSE embed)
- Review UI card layout and decision logic — just scoped to a run
- Export format (raw + confirmed) — just scoped to a run
- BM25 for compare: currently only vector search is implemented. BM25 requires adding `search_vector` tsvector column to compare records. This can be deferred to a follow-up — add toggle to UI but show "coming soon" or disable until implemented.

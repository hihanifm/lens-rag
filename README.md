# LENS — Lightweight ENgineering Search

A generic, on-premise RAG search portal for any Excel-based knowledge base.

## Prerequisites

- Docker + Docker Compose
- Ollama installed and running on the host machine
- Node.js 18+ (for frontend dev)

## Startup

### Step 1 — Start Ollama and pull models (once)

```bash
ollama serve
ollama pull bge-m3
ollama pull bge-reranker-base
```

### Step 2 — Start backend + database

```bash
docker compose up --build
```

API runs at: http://localhost:8000
Postgres runs at: localhost:5432

### Step 3 — Start frontend (dev)

```bash
cd frontend
npm install
npm run dev
```

Frontend runs at: http://localhost:5173

## Usage

1. Open http://localhost:5173
2. Click **+ New Project**
3. Upload your Excel file
4. Map columns (content, context, ID, display)
5. Wait for ingestion to complete
6. Search!

## Architecture

```
frontend (React)  →  FastAPI  →  PostgreSQL + pgvector
                             →  Ollama (bge-m3, bge-reranker-base)
```

Everything runs on-premise. Zero external API calls.

## Design Principles

1. KISS — Keep It Simple, Stupid
2. Garbage In, Garbage Out — we don't clean your data
3. On-Premise Only — no data leaves the network
4. No LLM in query path — pure search, no hallucination risk

## Project Structure

```
lens/
  backend/
    config.py      ← all config here
    main.py        ← FastAPI routes
    db.py          ← Postgres connection
    embedder.py    ← Ollama calls
    ingestion.py   ← Excel → database
    search.py      ← hybrid search pipeline
    projects.py    ← project CRUD
    models.py      ← Pydantic models
  frontend/
    src/
      pages/       ← Home, CreateProject, Search
      components/  ← ResultsTable, StatsPanel
      api/         ← all API calls
  docker-compose.yml
  CLAUDE.md        ← full design spec for Claude Code
```

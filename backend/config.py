# config.py — ALL system config lives here. Never hardcode in logic files.
import os

# ── Embedding ──────────────────────────────────────────────────────────────
# Provider: "ollama" or "openai"
EMBEDDING_PROVIDER = os.environ.get("EMBEDDING_PROVIDER", "ollama")

# Ollama settings (used when EMBEDDING_PROVIDER=ollama)
OLLAMA_BASE_URL    = os.environ.get("OLLAMA_BASE_URL", "http://host.docker.internal:11434/v1")
OLLAMA_EMBED_MODEL = os.environ.get("OLLAMA_EMBED_MODEL", "bge-m3")

# Base URL for native Ollama HTTP APIs (/api/...), derived from OpenAI-compatible .../v1 base
_oba = (OLLAMA_BASE_URL or "").rstrip("/")
OLLAMA_NATIVE_ORIGIN = _oba[:-3] if _oba.endswith("/v1") else _oba

# OpenAI settings (used when EMBEDDING_PROVIDER=openai)
OPENAI_API_KEY     = os.environ.get("OPENAI_API_KEY", "")
OPENAI_EMBED_MODEL = os.environ.get("OPENAI_EMBED_MODEL", "text-embedding-3-small")

# Resolved at startup based on provider
if EMBEDDING_PROVIDER == "openai":
    EMBEDDING_MODEL = OPENAI_EMBED_MODEL
    EMBEDDING_DIMS  = int(os.environ.get("EMBEDDING_DIMS", 1536))
else:
    EMBEDDING_MODEL = OLLAMA_EMBED_MODEL
    EMBEDDING_DIMS  = int(os.environ.get("EMBEDDING_DIMS", 1024))

# pgvector HNSW indexes enforce a maximum vector width (often 2000; pgvector 0.5.2+ raised
# many installs to 4096). Exceeding it causes: program_limit_exceeded / cannot have more than N dimensions.
PGVECTOR_MAX_INDEXED_DIMS = int(os.environ.get("PGVECTOR_MAX_INDEXED_DIMS", "2000"))

# ── Reranker ───────────────────────────────────────────────────────────────
# Reranker always runs via Ollama (no OpenAI equivalent)
RERANKER_ENABLED   = os.environ.get("RERANKER_ENABLED", "true").lower() == "true"
RERANKER_MODEL     = os.environ.get("RERANKER_MODEL", "bbjson/bge-reranker-base:latest")

# ── Search ─────────────────────────────────────────────────────────────────
TOP_K_RETRIEVAL    = 50    # internal candidate pool size
TOP_K_DEFAULT      = 5     # default results shown to user
TOP_K_MAX          = 50    # hard ceiling — user cannot exceed this

# ── Database ───────────────────────────────────────────────────────────────
DB_HOST            = os.environ.get("DB_HOST", "lens-postgres")
DB_PORT            = int(os.environ.get("DB_PORT", 5432))
DB_NAME            = os.environ.get("DB_NAME", "lens")
DB_USER            = os.environ.get("DB_USER", "lens_user")
DB_PASSWORD        = os.environ.get("DB_PASSWORD", "changeme")

# ── Projects ───────────────────────────────────────────────────────────────
PROJECTS_BASE_DIR  = "/data/projects"

# ── CORS (frontend dev server) ─────────────────────────────────────────────
CORS_ORIGINS = [
    "http://localhost:37001",  # Vite dev server
    "http://localhost:3000",
]

# ── Reverse proxy ──────────────────────────────────────────────────────────
# Set to the sub-path prefix when running behind a reverse proxy.
# e.g. ROOT_PATH=/lens-rag
# Leave empty when running at root.
ROOT_PATH = os.environ.get("ROOT_PATH", "")

# ── Comparator ─────────────────────────────────────────────────────────────
COMPARE_TOP_K          = int(os.getenv("COMPARE_TOP_K", "3"))
COMPARE_MATCH_THRESHOLD  = float(os.getenv("COMPARE_MATCH_THRESHOLD", "0.85"))
COMPARE_REVIEW_THRESHOLD = float(os.getenv("COMPARE_REVIEW_THRESHOLD", "0.60"))

# Compare LLM judge: max HTTP chat completions per rolling minute (0 = no throttle).
# Runs may override via llm_judge_max_requests_per_minute; NULL uses this default.
LLM_JUDGE_MAX_REQUESTS_PER_MINUTE = int(os.getenv("LLM_JUDGE_MAX_REQUESTS_PER_MINUTE", "0"))

# LLM-only compare runs (vector retrieval off): max right rows paired per left (run column overrides default).
LLM_COMPARE_MAX_RIGHTS_DEFAULT = int(os.getenv("LLM_COMPARE_MAX_RIGHTS_DEFAULT", "100"))
LLM_COMPARE_MAX_RIGHTS_CAP = int(os.getenv("LLM_COMPARE_MAX_RIGHTS_CAP", "500"))

# Compare run pipeline: optional ?max_left_rows= on execute — cap (sanity upper bound).
COMPARE_PIPELINE_MAX_LEFT_ROWS_CAP = int(os.getenv("COMPARE_PIPELINE_MAX_LEFT_ROWS_CAP", "50000"))

# ── Logging ────────────────────────────────────────────────────────────────
# Set LOG_LEVEL=DEBUG for verbose output. Defaults to INFO.
LOG_LEVEL = os.environ.get("LOG_LEVEL", "DEBUG" if os.environ.get("ENV", "dev").lower() == "dev" else "INFO")

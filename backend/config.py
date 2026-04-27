# config.py — ALL system config lives here. Never hardcode in logic files.

# ── Embedding ──────────────────────────────────────────────────────────────
EMBEDDING_BASE_URL = "http://host.docker.internal:11434/v1"
EMBEDDING_MODEL    = "bge-m3"
EMBEDDING_DIMS     = 1024

# ── Reranker ───────────────────────────────────────────────────────────────
RERANKER_MODEL     = "bge-reranker-base"

# ── Search ─────────────────────────────────────────────────────────────────
TOP_K_RETRIEVAL    = 50    # internal candidate pool size
TOP_K_DEFAULT      = 10    # default results shown to user
TOP_K_MAX          = 50    # hard ceiling — user cannot exceed this

# ── Database ───────────────────────────────────────────────────────────────
DB_HOST            = "lens-postgres"
DB_PORT            = 5432
DB_NAME            = "lens"
DB_USER            = "lens_user"
DB_PASSWORD        = "changeme"

# ── Projects ───────────────────────────────────────────────────────────────
PROJECTS_BASE_DIR  = "/data/projects"

# ── CORS (frontend dev server) ─────────────────────────────────────────────
CORS_ORIGINS = [
    "http://localhost:5173",   # Vite dev server
    "http://localhost:3000",
]

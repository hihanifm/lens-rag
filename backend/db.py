import psycopg2
import psycopg2.extras
from contextlib import contextmanager
from config import (
    DB_HOST,
    DB_PORT,
    DB_NAME,
    DB_USER,
    DB_PASSWORD,
    EMBEDDING_DIMS,
    PGVECTOR_MAX_INDEXED_DIMS,
)

from prompt_seeds import PROMPT_TEMPLATE_SEEDS


def embedding_dimension_exceeded_message(model_dims: int | None = None) -> str:
    """
    User-facing explanation for pgvector HNSW dimension limits (embedding model too wide for the DB index).
    """
    prefix = (
        f"This embedding model outputs {model_dims} dimensions, but "
        if model_dims is not None
        else ""
    )
    return (
        f"{prefix}"
        "PostgreSQL pgvector cannot build the vector search index (HNSW): the embedding width "
        f"exceeds this server's limit ({PGVECTOR_MAX_INDEXED_DIMS} dimensions). "
        "Use an embedding model with fewer output dimensions, or after upgrading pgvector set "
        "PGVECTOR_MAX_INDEXED_DIMS if your installation supports a higher limit."
    )


def _is_pgvector_dimension_index_limit_error(exc: BaseException) -> bool:
    """Detect raw Postgres/pgvector errors like program_limit_exceeded / cannot have more than N dimensions."""
    s = (str(exc) or "").lower()
    if "program_limit_exceeded" in s:
        return True
    if "cannot have more than" in s and "dimension" in s:
        return True
    if "halfvec" in s and "dimension" in s:
        return False
    return "dimension" in s and ("limit" in s or "exceed" in s)


def validate_pgvector_embedding_dims(dims: int) -> None:
    """Raise ValueError if embedding width cannot be indexed with pgvector HNSW (LENS default index)."""
    if dims > PGVECTOR_MAX_INDEXED_DIMS:
        raise ValueError(embedding_dimension_exceeded_message(dims))


def get_connection():
    return psycopg2.connect(
        host=DB_HOST,
        port=DB_PORT,
        dbname=DB_NAME,
        user=DB_USER,
        password=DB_PASSWORD
    )


@contextmanager
def get_cursor():
    conn = get_connection()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        yield cur, conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    """Create global tables on startup."""
    with get_cursor() as (cur, conn):
        # Enable pgvector
        cur.execute("CREATE EXTENSION IF NOT EXISTS vector;")

        # Global projects metadata table
        cur.execute("""
            CREATE TABLE IF NOT EXISTS public.projects (
                id              SERIAL PRIMARY KEY,
                name            TEXT NOT NULL,
                schema_name     TEXT NOT NULL,
                content_column  TEXT NOT NULL,
                context_columns TEXT[] NOT NULL DEFAULT '{}',
                id_column       TEXT,
                display_columns TEXT[] NOT NULL DEFAULT '{}',
                has_id_column   BOOLEAN DEFAULT FALSE,
                default_k       INTEGER DEFAULT 5,
                status          TEXT DEFAULT 'pending',
                row_count       INTEGER,
                created_at      TIMESTAMP DEFAULT NOW()
            );
        """)

        # Optional project PIN (on-prem internal tool; stored in plain text).
        # Safe to run on every startup.
        cur.execute("ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS pin TEXT;")
        cur.execute("ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS source_filename TEXT;")
        cur.execute("ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS ingested_at TIMESTAMP;")
        cur.execute("ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS ingestion_ms INTEGER;")
        cur.execute("ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS stored_columns TEXT[] NOT NULL DEFAULT '{}';")
        cur.execute("ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS total_rows INTEGER;")
        cur.execute("ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS ingestion_started_at TIMESTAMP;")
        cur.execute("ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS embed_url TEXT;")
        cur.execute("ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS embed_api_key TEXT;")
        cur.execute("ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS embed_model TEXT;")
        cur.execute("ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS embed_dims INTEGER;")
        cur.execute("ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS rerank_model TEXT;")
        cur.execute(
            "ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS rerank_enabled BOOLEAN DEFAULT TRUE;"
        )

        # ── Compare jobs global table ──────────────────────────────────────
        cur.execute("""
            CREATE TABLE IF NOT EXISTS public.compare_jobs (
                id                       SERIAL PRIMARY KEY,
                name                     TEXT NOT NULL,
                notes                    TEXT,
                label_left               TEXT NOT NULL,
                label_right              TEXT NOT NULL,
                schema_name              TEXT NOT NULL,
                status                   TEXT DEFAULT 'pending',
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
                tmp_path_left            TEXT,
                tmp_path_right           TEXT,
                embed_dims               INTEGER,
                embed_url                TEXT,
                embed_api_key            TEXT,
                embed_model              TEXT,
                created_at               TIMESTAMP DEFAULT NOW()
            );
        """)
        # Migration: add new columns to existing compare_jobs tables
        cur.execute("ALTER TABLE public.compare_jobs ADD COLUMN IF NOT EXISTS notes TEXT;")
        cur.execute("ALTER TABLE public.compare_jobs ADD COLUMN IF NOT EXISTS embed_url TEXT;")
        cur.execute("ALTER TABLE public.compare_jobs ADD COLUMN IF NOT EXISTS embed_api_key TEXT;")
        cur.execute("ALTER TABLE public.compare_jobs ADD COLUMN IF NOT EXISTS embed_model TEXT;")
        # Legacy columns kept for migrate_legacy_compare_jobs() to read initial run config
        cur.execute("ALTER TABLE public.compare_jobs ADD COLUMN IF NOT EXISTS top_k INTEGER DEFAULT 3;")
        cur.execute("ALTER TABLE public.compare_jobs ADD COLUMN IF NOT EXISTS rerank_enabled BOOLEAN DEFAULT TRUE;")
        cur.execute("ALTER TABLE public.compare_jobs ADD COLUMN IF NOT EXISTS rerank_model TEXT;")
        cur.execute("ALTER TABLE public.compare_jobs ADD COLUMN IF NOT EXISTS sheet_name_left TEXT;")
        cur.execute("ALTER TABLE public.compare_jobs ADD COLUMN IF NOT EXISTS sheet_name_right TEXT;")
        cur.execute(
            "ALTER TABLE public.compare_jobs ADD COLUMN IF NOT EXISTS row_filters_left TEXT DEFAULT '[]';"
        )
        cur.execute(
            "ALTER TABLE public.compare_jobs ADD COLUMN IF NOT EXISTS row_filters_right TEXT DEFAULT '[]';"
        )
        cur.execute(
            "ALTER TABLE public.compare_jobs ADD COLUMN IF NOT EXISTS all_columns_left TEXT[] DEFAULT '{}';"
        )
        cur.execute(
            "ALTER TABLE public.compare_jobs ADD COLUMN IF NOT EXISTS all_columns_right TEXT[] DEFAULT '{}';"
        )

        # ── Compare runs table ─────────────────────────────────────────────
        cur.execute("""
            CREATE TABLE IF NOT EXISTS public.compare_runs (
                id                    SERIAL PRIMARY KEY,
                job_id                INTEGER NOT NULL REFERENCES public.compare_jobs(id),
                name                  TEXT,
                status                TEXT NOT NULL DEFAULT 'pending',
                status_message        TEXT,
                top_k                 INTEGER NOT NULL DEFAULT 3,
                vector_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
                reranker_enabled      BOOLEAN NOT NULL DEFAULT FALSE,
                reranker_model        TEXT,
                reranker_url          TEXT,
                llm_judge_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
                llm_judge_url         TEXT,
                llm_judge_model       TEXT,
                llm_judge_prompt      TEXT,
                row_count_left        INTEGER,
                created_at            TIMESTAMP DEFAULT NOW(),
                completed_at          TIMESTAMP
            );
        """)
        cur.execute(
            "ALTER TABLE public.compare_runs ADD COLUMN IF NOT EXISTS llm_judge_max_requests_per_minute INTEGER;"
        )
        cur.execute(
            "ALTER TABLE public.compare_runs ADD COLUMN IF NOT EXISTS llm_compare_max_rights INTEGER;"
        )
        cur.execute(
            "ALTER TABLE public.compare_runs ADD COLUMN IF NOT EXISTS notes TEXT;"
        )
        cur.execute(
            "ALTER TABLE public.compare_runs ADD COLUMN IF NOT EXISTS llm_judge_prompt_preset_tag TEXT;"
        )
        cur.execute(
            "ALTER TABLE public.compare_runs ADD COLUMN IF NOT EXISTS llm_judge_left_columns TEXT[];"
        )
        cur.execute(
            "ALTER TABLE public.compare_runs ADD COLUMN IF NOT EXISTS llm_judge_right_columns TEXT[];"
        )

        # Global LLM judge domain-overlay presets (Compare runs — reusable named prompts).
        cur.execute("""
            CREATE TABLE IF NOT EXISTS public.compare_llm_prompt_templates (
                id          SERIAL PRIMARY KEY,
                name        TEXT NOT NULL,
                body        TEXT NOT NULL,
                version     INTEGER NOT NULL DEFAULT 1,
                created_at  TIMESTAMP DEFAULT NOW(),
                updated_at  TIMESTAMP DEFAULT NOW()
            );
        """)
        cur.execute(
            "ALTER TABLE public.compare_llm_prompt_templates ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;"
        )
        cur.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS compare_llm_prompt_templates_name_uq
                ON public.compare_llm_prompt_templates (name);
            """
        )

        _seed_prompt_templates(cur)


def _seed_prompt_templates(cur):
    """Insert starter presets once per DB name (idempotent)."""
    for row in PROMPT_TEMPLATE_SEEDS:
        name = row["name"]
        body = row["body"]
        cur.execute(
            """
            INSERT INTO public.compare_llm_prompt_templates (name, body, version)
            SELECT %s, %s, 1
            WHERE NOT EXISTS (
                SELECT 1 FROM public.compare_llm_prompt_templates WHERE name = %s
            )
            """,
            [name, body, name],
        )


def create_compare_schema(job_id: int, dims: int):
    """Create per-job schema with records table only. Matches/decisions are per-run."""
    validate_pgvector_embedding_dims(dims)
    schema = f"compare_{job_id}"
    try:
        with get_cursor() as (cur, conn):
            cur.execute(f"CREATE SCHEMA IF NOT EXISTS {schema};")
            cur.execute(f"""
                CREATE TABLE IF NOT EXISTS {schema}.records (
                    id                  SERIAL PRIMARY KEY,
                    side                TEXT NOT NULL,
                    original_row        INTEGER,
                    sheet_name          TEXT,
                    contextual_content  TEXT,
                    display_value       TEXT,
                    embedding           vector({dims})
                );
            """)
            cur.execute(f"""
                ALTER TABLE {schema}.records
                    ADD CONSTRAINT records_side_chk CHECK (side IN ('left','right'));
            """)
            cur.execute(f"""
                CREATE INDEX IF NOT EXISTS {schema}_records_emb_idx
                    ON {schema}.records USING hnsw (embedding vector_cosine_ops);
                CREATE INDEX IF NOT EXISTS {schema}_records_side_idx
                    ON {schema}.records (side);
            """)
    except Exception as e:
        if _is_pgvector_dimension_index_limit_error(e):
            raise ValueError(embedding_dimension_exceeded_message(dims)) from e
        raise


def drop_compare_schema(job_id: int):
    """Drop the per-job schema and delete compare_jobs + compare_runs rows."""
    schema = f"compare_{job_id}"
    with get_cursor() as (cur, conn):
        cur.execute(f"DROP SCHEMA IF EXISTS {schema} CASCADE;")
        cur.execute("DELETE FROM public.compare_runs WHERE job_id = %s;", (job_id,))
        cur.execute("DELETE FROM public.compare_jobs WHERE id = %s;", (job_id,))


def create_run_tables(schema_name: str, run_id: int):
    """Create per-run matches and decisions tables inside the job schema."""
    with get_cursor() as (cur, conn):
        cur.execute(f"""
            CREATE TABLE IF NOT EXISTS {schema_name}.run_{run_id}_matches (
                id              SERIAL PRIMARY KEY,
                left_id         INTEGER NOT NULL,
                right_id        INTEGER NOT NULL,
                cosine_score    FLOAT,
                rerank_score    FLOAT,
                llm_score       FLOAT,
                llm_judge_meta  JSONB,
                final_score     FLOAT NOT NULL DEFAULT 0,
                rank            INTEGER NOT NULL
            );
        """)
        cur.execute(f"""
            CREATE INDEX IF NOT EXISTS {schema_name}_run_{run_id}_matches_left_rank_idx
                ON {schema_name}.run_{run_id}_matches (left_id, rank);
        """)
        cur.execute(f"""
            CREATE TABLE IF NOT EXISTS {schema_name}.run_{run_id}_decisions (
                left_id             INTEGER PRIMARY KEY,
                matched_right_id    INTEGER,
                matched_right_ids   INTEGER[],
                decided_at          TIMESTAMP DEFAULT NOW(),
                review_comment      TEXT,
                review_outcome        TEXT
            );
        """)


def drop_run_tables(schema_name: str, run_id: int):
    """Drop per-run matches and decisions tables."""
    with get_cursor() as (cur, conn):
        cur.execute(f"DROP TABLE IF EXISTS {schema_name}.run_{run_id}_matches CASCADE;")
        cur.execute(f"DROP TABLE IF EXISTS {schema_name}.run_{run_id}_decisions CASCADE;")
        cur.execute("DELETE FROM public.compare_runs WHERE id = %s;", (run_id,))


def migrate_compare_decisions_review_comment():
    """Add review_comment to existing per-run decisions tables (safe on every startup)."""
    with get_cursor() as (cur, _conn):
        cur.execute("""
            SELECT table_schema, table_name
            FROM information_schema.tables
            WHERE table_schema ~ '^compare_[0-9]+$'
              AND table_name ~ '^run_[0-9]+_decisions$'
        """)
        for row in cur.fetchall():
            schema = row["table_schema"]
            table = row["table_name"]
            cur.execute(
                f'ALTER TABLE "{schema}"."{table}" ADD COLUMN IF NOT EXISTS review_comment TEXT;'
            )


def migrate_compare_decisions_review_outcome():
    """Add review_outcome (no_match | partial | fail | system_fail, …) to per-run decisions tables."""
    with get_cursor() as (cur, _conn):
        cur.execute("""
            SELECT table_schema, table_name
            FROM information_schema.tables
            WHERE table_schema ~ '^compare_[0-9]+$'
              AND table_name ~ '^run_[0-9]+_decisions$'
        """)
        for row in cur.fetchall():
            schema = row["table_schema"]
            table = row["table_name"]
            cur.execute(
                f'ALTER TABLE "{schema}"."{table}" ADD COLUMN IF NOT EXISTS review_outcome TEXT;'
            )


def migrate_compare_decisions_matched_right_ids():
    """Add matched_right_ids (multi-select confirms) and backfill from matched_right_id."""
    with get_cursor() as (cur, _conn):
        cur.execute("""
            SELECT table_schema, table_name
            FROM information_schema.tables
            WHERE table_schema ~ '^compare_[0-9]+$'
              AND table_name ~ '^run_[0-9]+_decisions$'
        """)
        for row in cur.fetchall():
            schema = row["table_schema"]
            table = row["table_name"]
            cur.execute(
                f'ALTER TABLE "{schema}"."{table}" ADD COLUMN IF NOT EXISTS matched_right_ids INTEGER[];'
            )
            cur.execute(
                f"""
                UPDATE "{schema}"."{table}"
                SET matched_right_ids = ARRAY[matched_right_id]
                WHERE matched_right_id IS NOT NULL
                  AND matched_right_ids IS NULL;
                """
            )


def migrate_compare_matches_llm_judge_meta():
    """Add llm_judge_meta (JSONB) to existing per-run matches tables."""
    with get_cursor() as (cur, _conn):
        cur.execute("""
            SELECT table_schema, table_name
            FROM information_schema.tables
            WHERE table_schema ~ '^compare_[0-9]+$'
              AND table_name ~ '^run_[0-9]+_matches$'
        """)
        for row in cur.fetchall():
            schema = row["table_schema"]
            table = row["table_name"]
            cur.execute(
                f'ALTER TABLE "{schema}"."{table}" ADD COLUMN IF NOT EXISTS llm_judge_meta JSONB;'
            )


def migrate_legacy_compare_jobs():
    """
    One-time migration: jobs that were created before the Runs feature was added
    have a flat matches/decisions table at schema level. Wrap them in a run_1 row.
    Safe to call on every startup — skips jobs that already have runs.
    """
    import logging
    logger = logging.getLogger("lens.db.migrate")

    # Find compare jobs with no runs
    with get_cursor() as (cur, _conn):
        cur.execute("""
            SELECT cj.id, cj.schema_name,
                   COALESCE(cj.top_k, 3)              AS top_k,
                   COALESCE(cj.rerank_enabled, TRUE)   AS rerank_enabled,
                   cj.rerank_model
            FROM public.compare_jobs cj
            LEFT JOIN public.compare_runs cr ON cr.job_id = cj.id
            WHERE cr.id IS NULL
        """)
        candidates = [dict(r) for r in cur.fetchall()]

    for job in candidates:
        schema = job["schema_name"]
        # Check schema exists and has a legacy 'matches' table
        with get_cursor() as (cur, _conn):
            cur.execute("""
                SELECT 1 FROM information_schema.tables
                WHERE table_schema = %s AND table_name = 'matches'
            """, [schema])
            has_matches = cur.fetchone() is not None

        if not has_matches:
            continue

        logger.info("migrate_legacy_compare_jobs: migrating job_id=%d schema=%s", job["id"], schema)

        with get_cursor() as (cur, _conn):
            # Create a legacy run row
            cur.execute("""
                INSERT INTO public.compare_runs
                    (job_id, name, status, top_k, vector_enabled,
                     reranker_enabled, reranker_model, created_at, completed_at)
                VALUES (%s, 'Legacy run', 'ready', %s, TRUE, %s, %s, NOW(), NOW())
                RETURNING id
            """, [
                job["id"],
                job["top_k"],
                bool(job["rerank_enabled"]),
                job.get("rerank_model"),
            ])
            run_id = cur.fetchone()["id"]

            # Rename legacy tables into per-run namespace
            cur.execute(f"ALTER TABLE {schema}.matches RENAME TO run_{run_id}_matches;")

            # Add new score columns if missing
            cur.execute(f"ALTER TABLE {schema}.run_{run_id}_matches ADD COLUMN IF NOT EXISTS llm_score FLOAT;")
            cur.execute(f"ALTER TABLE {schema}.run_{run_id}_matches ADD COLUMN IF NOT EXISTS llm_judge_meta JSONB;")
            cur.execute(f"ALTER TABLE {schema}.run_{run_id}_matches ADD COLUMN IF NOT EXISTS final_score FLOAT;")
            cur.execute(f"""
                UPDATE {schema}.run_{run_id}_matches
                SET final_score = COALESCE(
                    CASE WHEN rerank_score BETWEEN 0 AND 1 THEN rerank_score ELSE NULL END,
                    cosine_score, 0
                )
                WHERE final_score IS NULL;
            """)

            # Rename decisions if it exists
            cur.execute("""
                SELECT 1 FROM information_schema.tables
                WHERE table_schema = %s AND table_name = 'decisions'
            """, [schema])
            if cur.fetchone():
                cur.execute(f"ALTER TABLE {schema}.decisions RENAME TO run_{run_id}_decisions;")

        logger.info("migrate_legacy_compare_jobs: done job_id=%d run_id=%d", job["id"], run_id)


def create_project_schema(schema_name: str, columns: list, id_column: str = None, dims: int = None):
    """
    Create a schema and records table for a project.
    All original Excel columns stored as col_{name}.
    """
    eff_dims = dims or EMBEDDING_DIMS
    validate_pgvector_embedding_dims(eff_dims)
    try:
        with get_cursor() as (cur, conn):
            # Create schema
            cur.execute(f"CREATE SCHEMA IF NOT EXISTS {schema_name};")

            # Build dynamic column definitions
            col_defs = "\n".join([
                f'    "col_{col.lower().replace(" ", "_")}" TEXT,'
                for col in columns
            ])

            # Build tsvector expression
            tsvector_expr = "to_tsvector('english', coalesce(contextual_content, ''))"
            if id_column:
                safe_id = id_column.lower().replace(" ", "_")
                tsvector_expr += f" || to_tsvector('simple', coalesce(\"col_{safe_id}\", ''))"

            cur.execute(f"""
                CREATE TABLE IF NOT EXISTS {schema_name}.records (
                    id                  SERIAL PRIMARY KEY,
                    sheet_name          TEXT,
                    {col_defs}
                    contextual_content  TEXT,
                    embedding           vector({eff_dims}),
                    search_vector       tsvector
                        GENERATED ALWAYS AS ({tsvector_expr}) STORED
                );

                CREATE INDEX IF NOT EXISTS {schema_name}_embedding_idx
                    ON {schema_name}.records
                    USING hnsw (embedding vector_cosine_ops);

                CREATE INDEX IF NOT EXISTS {schema_name}_search_idx
                    ON {schema_name}.records
                    USING gin (search_vector);
            """)
    except Exception as e:
        if _is_pgvector_dimension_index_limit_error(e):
            raise ValueError(embedding_dimension_exceeded_message(eff_dims)) from e
        raise

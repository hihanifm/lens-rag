import psycopg2
import psycopg2.extras
from contextlib import contextmanager
from config import DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, EMBEDDING_DIMS


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
                default_k       INTEGER DEFAULT 10,
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


def create_project_schema(schema_name: str, columns: list, id_column: str = None, dims: int = None):
    """
    Create a schema and records table for a project.
    All original Excel columns stored as col_{name}.
    """
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
                embedding           vector({dims or EMBEDDING_DIMS}),
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

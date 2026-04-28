from db import get_cursor
from models import ProjectCreate, ProjectResponse


def _to_public_project(project: dict | None) -> dict | None:
    if not project:
        return None
    has_pin = bool(project.get("pin") or "")
    pub = dict(project)
    pub.pop("pin", None)
    pub["has_pin"] = has_pin
    return pub


def create_project(data: ProjectCreate) -> dict:
    """Create a new project record in the metadata table."""
    pin = (data.pin or "").strip() or None
    with get_cursor() as (cur, conn):
        cur.execute("""
            INSERT INTO public.projects
                (name, schema_name, stored_columns, content_column, context_columns,
                 id_column, display_columns, has_id_column, default_k, pin,
                 source_filename, embed_url, embed_api_key, embed_model, embed_dims, status)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'pending')
            RETURNING *
        """, [
            data.name,
            f"project_{data.name.lower().replace(' ', '_')}",  # temp, updated with id
            data.stored_columns,
            data.content_column,
            data.context_columns,
            data.id_column,
            data.display_columns,
            data.id_column is not None,
            data.default_k,
            pin,
            data.source_filename or None,
            data.embed_url or None,
            data.embed_api_key or None,
            data.embed_model or None,
            data.embed_dims or None,
        ])
        project = dict(cur.fetchone())

    # Update schema_name to include real id
    schema_name = f"project_{project['id']}"
    with get_cursor() as (cur, conn):
        cur.execute("""
            UPDATE public.projects SET schema_name = %s WHERE id = %s
        """, [schema_name, project['id']])
        project['schema_name'] = schema_name

    return _to_public_project(project)


def _get_all_projects_raw() -> list[dict]:
    with get_cursor() as (cur, conn):
        cur.execute("""
            SELECT * FROM public.projects ORDER BY created_at DESC
        """)
        return [dict(row) for row in cur.fetchall()]


def get_all_projects() -> list[dict]:
    return [_to_public_project(p) for p in _get_all_projects_raw()]


def _get_project_raw(project_id: int) -> dict | None:
    with get_cursor() as (cur, conn):
        cur.execute("SELECT * FROM public.projects WHERE id = %s", [project_id])
        row = cur.fetchone()
        return dict(row) if row else None


def get_project_raw(project_id: int) -> dict | None:
    return _get_project_raw(project_id)


def get_project(project_id: int) -> dict | None:
    return _to_public_project(_get_project_raw(project_id))


def verify_project_pin(project_id: int, provided_pin: str) -> bool:
    project = _get_project_raw(project_id)
    if not project:
        return False
    stored = (project.get("pin") or "").strip()
    if not stored:
        return True
    return (provided_pin or "") == stored


def delete_project(project_id: int) -> dict | None:
    project = _get_project_raw(project_id)
    if not project:
        return None

    schema = project.get("schema_name")
    with get_cursor() as (cur, conn):
        if schema:
            cur.execute(f"DROP SCHEMA IF EXISTS {schema} CASCADE;")
        cur.execute("DELETE FROM public.projects WHERE id = %s;", [project_id])

    return _to_public_project(project)


def update_project(project_id: int, name: str = None, display_columns: list = None, default_k: int = None) -> dict | None:
    """Update cheap fields — no re-ingestion required."""
    fields = []
    values = []
    if name is not None:
        fields.append("name = %s")
        values.append(name)
    if display_columns is not None:
        fields.append("display_columns = %s")
        values.append(display_columns)
    if default_k is not None:
        fields.append("default_k = %s")
        values.append(default_k)
    if not fields:
        return get_project(project_id)
    values.append(project_id)
    with get_cursor() as (cur, conn):
        cur.execute(
            f"UPDATE public.projects SET {', '.join(fields)} WHERE id = %s RETURNING *",
            values
        )
        row = cur.fetchone()
        return _to_public_project(dict(row) if row else None)


def get_project_columns(project: dict) -> list[str]:
    """Return all original column names available in the project's records table.

    DB stores columns as col_{lowercased_underscored}, but the project metadata
    holds the original names (e.g. 'Asset ID'). We build a reverse map so the
    returned names match what's stored in display_columns / context_columns etc.

    For new projects, `stored_columns` in the metadata is the canonical source.
    For old projects (stored_columns empty), fall back to querying the schema.
    """
    stored = list(project.get('stored_columns') or [])

    if stored:
        # Fast path: stored_columns is the canonical list for new projects
        return stored

    # Fallback for old projects: reconstruct from known column metadata + schema
    known: dict[str, str] = {}
    for col in (
        list(project.get('context_columns') or [])
        + list(project.get('display_columns') or [])
        + ([project['content_column']] if project.get('content_column') else [])
        + ([project['id_column']] if project.get('id_column') else [])
    ):
        known[col.lower().replace(' ', '_')] = col

    with get_cursor() as (cur, conn):
        cur.execute("""
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = %s
              AND table_name = 'records'
              AND column_name LIKE 'col\\_%%'
            ORDER BY ordinal_position
        """, [project['schema_name']])
        normalized = [row['column_name'][4:] for row in cur.fetchall()]

    return [known.get(n, n) for n in normalized]


def update_project_status(project_id: int, status: str, row_count: int = None):
    with get_cursor() as (cur, conn):
        cur.execute("""
            UPDATE public.projects
            SET status = %s,
                row_count = %s,
                ingestion_started_at = CASE WHEN %s = 'ingesting'
                    THEN NOW() ELSE ingestion_started_at END
            WHERE id = %s
        """, [status, row_count, status, project_id])

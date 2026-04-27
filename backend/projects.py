from db import get_cursor
from models import ProjectCreate, ProjectResponse


def create_project(data: ProjectCreate) -> dict:
    """Create a new project record in the metadata table."""
    with get_cursor() as (cur, conn):
        cur.execute("""
            INSERT INTO public.projects
                (name, schema_name, content_column, context_columns,
                 id_column, display_columns, has_id_column, default_k, status)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'pending')
            RETURNING *
        """, [
            data.name,
            f"project_{data.name.lower().replace(' ', '_')}",  # temp, updated with id
            data.content_column,
            data.context_columns,
            data.id_column,
            data.display_columns,
            data.id_column is not None,
            data.default_k
        ])
        project = dict(cur.fetchone())

    # Update schema_name to include real id
    schema_name = f"project_{project['id']}"
    with get_cursor() as (cur, conn):
        cur.execute("""
            UPDATE public.projects SET schema_name = %s WHERE id = %s
        """, [schema_name, project['id']])
        project['schema_name'] = schema_name

    return project


def get_all_projects() -> list[dict]:
    with get_cursor() as (cur, conn):
        cur.execute("""
            SELECT * FROM public.projects ORDER BY created_at DESC
        """)
        return [dict(row) for row in cur.fetchall()]


def get_project(project_id: int) -> dict | None:
    with get_cursor() as (cur, conn):
        cur.execute("SELECT * FROM public.projects WHERE id = %s", [project_id])
        row = cur.fetchone()
        return dict(row) if row else None


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
        return dict(row) if row else None


def get_project_columns(schema_name: str) -> list[str]:
    """Return all original column names available in the project's records table."""
    with get_cursor() as (cur, conn):
        cur.execute("""
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = %s
              AND table_name = 'records'
              AND column_name LIKE 'col\\_%%'
            ORDER BY ordinal_position
        """, [schema_name])
        return [row['column_name'][4:] for row in cur.fetchall()]


def update_project_status(project_id: int, status: str, row_count: int = None):
    with get_cursor() as (cur, conn):
        cur.execute("""
            UPDATE public.projects
            SET status = %s, row_count = %s
            WHERE id = %s
        """, [status, row_count, project_id])

import pandas as pd
from typing import Generator
from db import get_cursor, create_project_schema
from embedder import embed
import json


def read_excel(filepath: str) -> tuple[pd.DataFrame, list[str], list[str]]:
    """
    Read all sheets from Excel.
    Returns: (dataframe, column_names, sheet_names)

    Rules (KISS — treat everything as plain text, don't judge the data):
    - ffill first (merged cells), then dropna(how='all') (fully empty rows only)
    - sheet_name column always added
    - All values read as str
    """
    all_sheets = pd.read_excel(filepath, sheet_name=None, dtype=str)

    frames = []
    sheet_names = list(all_sheets.keys())

    for sheet_name, df in all_sheets.items():
        df = df.ffill()           # fill merged cells FIRST
        df = df.dropna(how='all') # drop ONLY fully empty rows
        df['sheet_name'] = sheet_name
        frames.append(df)

    combined = pd.concat(frames, ignore_index=True)

    # Original columns (excludes sheet_name we added)
    original_columns = [c for c in combined.columns if c != 'sheet_name']

    return combined, original_columns, sheet_names


def build_contextual_content(
    row: dict,
    context_columns: list[str],
    content_column: str,
    sheet_name: str
) -> str:
    """
    Build contextual content string for embedding.
    Format: sheet_name | ctx1 | ctx2 | ... | content
    """
    parts = [str(sheet_name)]

    for col in context_columns:
        val = str(row.get(col, '')) if row.get(col) is not None else ''
        if val and val.lower() != 'nan':
            parts.append(val)

    content = str(row.get(content_column, '')) if row.get(content_column) is not None else ''
    parts.append(content)

    return ' | '.join(parts)


def safe_col_name(col: str) -> str:
    """Convert column name to safe Postgres column name."""
    return col.lower().replace(' ', '_').replace('-', '_').replace('/', '_')


def ingest(
    filepath: str,
    project_id: int,
    schema_name: str,
    content_column: str,
    context_columns: list[str],
    id_column: str | None,
    display_columns: list[str],
) -> Generator[dict, None, None]:
    """
    Full ingestion pipeline with progress reporting.
    Yields progress dicts for SSE streaming.
    """
    # Step 1: Read Excel
    yield {"step": "reading", "message": "Reading Excel file..."}
    df, original_columns, sheet_names = read_excel(filepath)

    total_rows = len(df)
    yield {
        "step": "read_complete",
        "message": f"Found {total_rows} rows across {len(sheet_names)} sheet(s)",
        "total_rows": total_rows,
        "sheets": sheet_names
    }

    # Step 2: Create schema and table
    yield {"step": "schema", "message": "Creating database schema..."}
    create_project_schema(schema_name, original_columns, id_column)
    yield {"step": "schema_complete", "message": "Database ready"}

    # Step 3: Ingest rows
    yield {"step": "embedding", "message": "Starting ingestion..."}

    records = df.to_dict(orient='records')
    batch_size = 10  # embed in small batches

    for i, row in enumerate(records):
        sheet_name = row.get('sheet_name', '')

        # Build contextual content
        contextual_content = build_contextual_content(
            row, context_columns, content_column, sheet_name
        )

        # Embed
        vector = embed(contextual_content)

        # Build column dict for DB insert
        col_data = {}
        for col in original_columns:
            safe = safe_col_name(col)
            val = row.get(col)
            col_data[f'col_{safe}'] = str(val) if val is not None and str(val) != 'nan' else None

        # Insert into DB
        with get_cursor() as (cur, conn):
            col_names = ', '.join([f'"{k}"' for k in col_data.keys()])
            col_values = list(col_data.values())
            placeholders = ', '.join(['%s'] * len(col_data))

            cur.execute(f"""
                INSERT INTO {schema_name}.records
                    (sheet_name, {col_names}, contextual_content, embedding)
                VALUES
                    (%s, {placeholders}, %s, %s)
            """, [sheet_name] + col_values + [contextual_content, vector])

        # Report progress every 10 rows
        if (i + 1) % 10 == 0 or (i + 1) == total_rows:
            yield {
                "step": "progress",
                "processed": i + 1,
                "total": total_rows,
                "percent": round(((i + 1) / total_rows) * 100)
            }

    # Step 4: Update project status
    with get_cursor() as (cur, conn):
        cur.execute("""
            UPDATE public.projects
            SET status = 'ready', row_count = %s
            WHERE id = %s
        """, [total_rows, project_id])

    yield {
        "step": "complete",
        "message": f"Ingestion complete. {total_rows} records indexed.",
        "total_rows": total_rows
    }

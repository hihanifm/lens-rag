import logging
import re
import time

import pandas as pd
from typing import Generator
from db import get_cursor, create_project_schema
from embedder import embed
import json

logger = logging.getLogger("lens.ingestion")


def read_excel(filepath: str) -> tuple[pd.DataFrame, list[str], list[str]]:
    """
    Read all sheets from Excel.
    Returns: (dataframe, column_names, sheet_names)

    Rules (KISS — treat everything as plain text, don't judge the data):
    - ffill first (merged cells), then dropna(how='all') (fully empty rows only)
    - sheet_name column always added
    - All values read as str
    """
    logger.debug("read_excel() path=%s", filepath)
    t0 = time.monotonic()
    all_sheets = pd.read_excel(filepath, sheet_name=None, dtype=str)

    frames = []
    sheet_names = list(all_sheets.keys())
    logger.debug("read_excel() sheets=%s", sheet_names)

    for sheet_name, df in all_sheets.items():
        before = len(df)
        df = df.ffill()
        df = df.dropna(how='all')
        df['sheet_name'] = sheet_name
        logger.debug("  sheet=%r rows_before=%d rows_after=%d cols=%s",
                     sheet_name, before, len(df), list(df.columns))
        frames.append(df)

    combined = pd.concat(frames, ignore_index=True)
    original_columns = [c for c in combined.columns if c != 'sheet_name']
    logger.info("read_excel() total_rows=%d columns=%s elapsed_ms=%d",
                len(combined), original_columns, int((time.monotonic() - t0) * 1000))
    return combined, original_columns, sheet_names


def read_excel_single_sheet(filepath: str, sheet_name: str) -> pd.DataFrame:
    """Read one sheet with the same ffill / drop-all-empty rules as read_excel."""
    df = pd.read_excel(filepath, sheet_name=sheet_name, dtype=str)
    df = df.ffill()
    df = df.dropna(how="all")
    df["sheet_name"] = sheet_name
    return df


def excel_sheet_previews(filepath: str) -> list[dict]:
    """Per-sheet column names and row counts (no concat)."""
    all_sheets = pd.read_excel(filepath, sheet_name=None, dtype=str)
    out: list[dict] = []
    for sn, df in all_sheets.items():
        d2 = df.ffill().dropna(how="all")
        out.append({
            "sheet_name": str(sn),
            "columns": [str(c) for c in d2.columns],
            "row_count": len(d2),
        })
    return out


def read_compare_dataframe(filepath: str, sheet_name: str | None) -> pd.DataFrame:
    """
    Load data for compare ingestion.
    sheet_name None: all sheets concatenated (legacy).
    sheet_name set: that sheet only.
    """
    if sheet_name:
        return read_excel_single_sheet(filepath, sheet_name)
    df, _cols, _sheets = read_excel(filepath)
    return df


def _row_cell_str(row: dict, col: str) -> str:
    v = row.get(col)
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return ""
    s = str(v).strip()
    if s.lower() == "nan":
        return ""
    return s


def apply_compare_row_filters(df: pd.DataFrame, filters: list[dict]) -> pd.DataFrame:
    """
    AND-combine row filters. All values compared as plain text (case-insensitive for contains/equals).
    """
    if not filters:
        return df

    def row_ok(row: pd.Series) -> bool:
        rd = row.to_dict()
        for f in filters:
            col = str(f.get("column") or "").strip()
            if not col or col not in df.columns:
                return False
            op = str(f.get("op") or "contains").strip().lower()
            val = _row_cell_str(rd, col)
            needle = str(f.get("value") if f.get("value") is not None else "").strip()

            if op == "empty":
                if val != "":
                    return False
            elif op == "not_empty":
                if val == "":
                    return False
            elif op == "contains":
                if needle.lower() not in val.lower():
                    return False
            elif op == "not_contains":
                if needle.lower() in val.lower():
                    return False
            elif op == "equals":
                if val.lower() != needle.lower():
                    return False
            elif op == "not_equals":
                if val.lower() == needle.lower():
                    return False
            elif op == "regex":
                try:
                    if not re.search(needle, val):
                        return False
                except re.error:
                    return False
            else:
                return False
        return True

    mask = df.apply(row_ok, axis=1)
    return df.loc[mask].reset_index(drop=True)


def build_contextual_content(
    row: dict,
    context_columns: list[str],
    content_column: str,
    sheet_name: str
) -> str:
    """
    Build contextual content string for embedding.
    Format: sheet_name | ctx1 | ctx2 | ... [| content if set]
    content_column is optional; omitted when empty.
    """
    parts = [str(sheet_name)]

    for col in context_columns:
        val = str(row.get(col, '')) if row.get(col) is not None else ''
        if val and val.lower() != 'nan':
            parts.append(val)

    if content_column:
        content = str(row.get(content_column, '')) if row.get(content_column) is not None else ''
        if content and content.lower() != 'nan':
            parts.append(content)

    return ' | '.join(parts)


def safe_col_name(col: str) -> str:
    """Convert column name to safe Postgres column name."""
    return col.lower().replace(' ', '_').replace('-', '_').replace('/', '_')


def ingest(
    filepath: str,
    project_id: int,
    schema_name: str,
    stored_columns: list[str],
    content_column: str,
    context_columns: list[str],
    id_column: str | None,
    display_columns: list[str],
    embed_url: str | None = None,
    embed_api_key: str | None = None,
    embed_model: str | None = None,
    embed_dims: int | None = None,
) -> Generator[dict, None, None]:
    """
    Full ingestion pipeline with progress reporting.
    Yields progress dicts for SSE streaming.
    Only `stored_columns` are written to the DB table as col_* fields.
    """
    logger.info("ingest() start project_id=%d schema=%s stored_cols=%s content_col=%r context_cols=%s id_col=%r",
                project_id, schema_name, stored_columns, content_column, context_columns, id_column)
    t_pipeline_start = time.monotonic()

    # Step 1: Read Excel
    yield {"step": "reading", "message": "Reading Excel file..."}
    df, original_columns, sheet_names = read_excel(filepath)

    total_rows = len(df)
    logger.info("ingest() rows=%d sheets=%s columns=%s", total_rows, sheet_names, original_columns)

    # Persist total so the Home page can show "10 / 100 records" before completion
    with get_cursor() as (cur, conn):
        cur.execute(
            "UPDATE public.projects SET total_rows = %s WHERE id = %s",
            [total_rows, project_id]
        )

    yield {
        "step": "read_complete",
        "message": f"Found {total_rows} rows across {len(sheet_names)} sheet(s)",
        "total_rows": total_rows,
        "sheets": sheet_names
    }

    # Step 2: Create schema and table — only for stored_columns
    # Probe actual embedding dims when a custom model is in use and dims weren't supplied.
    resolved_dims = embed_dims
    if embed_url and not resolved_dims:
        try:
            probe = embed("probe", base_url=embed_url, api_key=embed_api_key, model=embed_model)
            resolved_dims = len(probe)
            logger.info("ingest() probed embed dims=%d from %s model=%s", resolved_dims, embed_url, embed_model)
            # Persist the resolved dims so search can read them
            with get_cursor() as (cur, conn):
                cur.execute(
                    "UPDATE public.projects SET embed_dims = %s WHERE id = %s",
                    [resolved_dims, project_id]
                )
        except Exception as e:
            logger.error("ingest() embed probe failed — %s: %s", type(e).__name__, e)
            raise

    yield {"step": "schema", "message": "Creating database schema..."}
    logger.debug("ingest() creating schema %s with stored_columns=%s", schema_name, stored_columns)
    create_project_schema(schema_name, stored_columns, id_column, dims=resolved_dims)
    logger.debug("ingest() schema created")
    yield {"step": "schema_complete", "message": "Database ready"}

    # Step 3: Ingest rows
    yield {"step": "embedding", "message": "Starting ingestion..."}

    records = df.to_dict(orient='records')
    t_ingest_start = time.monotonic()

    for i, row in enumerate(records):
        sheet_name = row.get('sheet_name', '')

        # Build contextual content
        contextual_content = build_contextual_content(
            row, context_columns, content_column, sheet_name
        )
        logger.debug("row %d/%d sheet=%r content_len=%d text=%r",
                     i + 1, total_rows, sheet_name, len(contextual_content),
                     contextual_content[:120])

        # Embed
        try:
            vector = embed(contextual_content, base_url=embed_url, api_key=embed_api_key, model=embed_model)
        except Exception as e:
            logger.error("embed failed on row %d/%d — %s: %s", i + 1, total_rows, type(e).__name__, e)
            raise

        # Build column dict — only for stored_columns
        col_data = {}
        for col in stored_columns:
            safe = safe_col_name(col)
            val = row.get(col)
            col_data[f'col_{safe}'] = str(val) if val is not None and str(val) != 'nan' else None

        # Insert into DB
        try:
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
        except Exception as e:
            logger.error("DB insert failed on row %d/%d — %s: %s", i + 1, total_rows, type(e).__name__, e)
            raise

        # Report progress every 10 rows and flush row_count to DB
        # so the Home page polling sees live progress without a new endpoint.
        if (i + 1) % 10 == 0 or (i + 1) == total_rows:
            elapsed = int((time.monotonic() - t_ingest_start) * 1000)
            rate = (i + 1) / max(elapsed / 1000, 0.001)
            logger.info("ingest() progress %d/%d (%.0f%%) elapsed_ms=%d rate=%.1f rows/s",
                        i + 1, total_rows, ((i + 1) / total_rows) * 100, elapsed, rate)
            with get_cursor() as (cur, conn):
                cur.execute(
                    "UPDATE public.projects SET row_count = %s WHERE id = %s",
                    [i + 1, project_id]
                )
            yield {
                "step": "progress",
                "processed": i + 1,
                "total": total_rows,
                "percent": round(((i + 1) / total_rows) * 100)
            }

    total_elapsed = int((time.monotonic() - t_ingest_start) * 1000)
    logger.info("ingest() embedding+insert done rows=%d elapsed_ms=%d", total_rows, total_elapsed)

    # Step 4: Update project status + stamp ingested_at + record total duration
    ingestion_ms = int((time.monotonic() - t_pipeline_start) * 1000)
    with get_cursor() as (cur, conn):
        cur.execute("""
            UPDATE public.projects
            SET status = 'ready', row_count = %s, ingested_at = NOW(), ingestion_ms = %s
            WHERE id = %s
        """, [total_rows, ingestion_ms, project_id])
    logger.info("ingest() project %d marked ready — total_ms=%d", project_id, ingestion_ms)

    yield {
        "step": "complete",
        "message": f"Ingestion complete. {total_rows} records indexed.",
        "total_rows": total_rows
    }

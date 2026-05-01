# Excel handling guidelines

Portable rules for building **reliable, predictable** Excel ingest/export in data pipelines (RAG, ETL, internal tools).  
Derived from production patterns: **treat the sheet as the source of truth**, optimize for **clarity and speed**, avoid **silent data loss**.

**How to use this doc**

- **With coding agents:** paste a section (e.g. *Reading* + *Pitfalls*) as constraints for implementation or review.
- **With humans:** share as-is; sections are ordered from principles → mechanics → checklists.

---

## 1. Core principles


| #   | Principle                             | Implication                                                                                                                                            |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1  | **Garbage in, garbage out**           | Store and surface user data as read; do not “fix” IDs, spelling, or formats unless the product explicitly promises it.                                 |
| P2  | **Text-first for hybrid columns**     | Read with **string dtype** so dates/numbers don’t round or locale-shift before you decide how to use them.                                             |
| P3  | **Merged cells are layout, not data** | Resolve merges **before** dropping empty rows, or you drop valid rows.                                                                                 |
| P4  | **One consistent pipeline**           | Preview, ingest, and filters should share the same read rules (`ffill`, `dropna`, dtypes).                                                             |
| P5  | **Measure row-wise work**             | Avoid `row.to_dict()` or repeated scans over huge frames for filters—prefer vectorized ops or scalar reads per cell when profiling showed bottlenecks. |


---

## 2. Reading workbooks

### 2.1 Multisheet vs single sheet

- `**sheet_name=None`**: load **all** sheets when the product treats the workbook as one logical table (concatenate with a `sheet_name` column).
- **Named sheet**: load one sheet when the user pins ingestion to a single tab—still apply the **same** row rules below.

### 2.2 Recommended pandas recipe (smooth & predictable)

Apply **in this order** per sheet:

1. `**dtype=str`** on `read_excel` so every cell starts as text (avoid float artifacts, date surprises).
2. `**ffill()`** along columns to fill **merged / visually joined** header or label cells into every data row.
3. `**dropna(how="all")`** only—drop rows where **every** column is empty; do **not** drop rows that still have partial data.
4. Append a `**sheet_name`** column before concatenating sheets so embeddings and UI can disambiguate source tab.

```text
read → str dtype → ffill → drop all-empty rows → tag sheet → concat
```

### 2.3 Empty cells and sentinels

- Treat `**NaN**`, `**None**`, and string `**"nan"**` (after coercion) as empty when building merged display/search strings—otherwise noise leaks into vectors and FTS.

### 2.4 Headers

- Assume the **first row** is headers unless your UX explicitly supports multi-row headers (avoid unless necessary).
- Normalize header strings **once** (trim, stable casing only if you document it)—don’t rename columns silently on ingest.

---

## 3. Writing / exporting workbooks


| Topic     | Guideline                                                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine    | Prefer `**openpyxl`** for `.xlsx` with pandas `ExcelWriter`; pin versions in `requirements.txt`.                                            |
| Streams   | Build exports **in memory** (`BytesIO`) for downloads; avoid temp files unless size forces it.                                              |
| Sheets    | One logical export per **sheet name** you promise in the product spec; multi-sheet exports document sheet purpose (raw vs confirmed, etc.). |
| Filenames | Use a **stable, slugged** pattern: `{project}_lens_{descriptor}_{YYYY-MM-DD}.xlsx` (or your org’s equivalent).                              |


---

## 4. HTTP and deployment

- Accept `**.xlsx` / `.xls`** consistently on upload routes.
- Some Linux images lack MIME mappings for Office types—**register** `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` for `.xlsx` where uploads rely on `content-type`.
- Use a deterministic temp suffix (`.xlsx`) when persisting uploads for parsing.

---

## 5. Performance (scale-minded)


| Area                    | Do                                                              | Avoid                                                       |
| ----------------------- | --------------------------------------------------------------- | ----------------------------------------------------------- |
| Filters on large frames | Vectorized masks; per-cell string coercion only where measured  | `apply(axis=1)` with heavy Python per row without profiling |
| Distinct / picker lists | Cap distinct values (e.g. max 100) and signal truncation in API | Returning unbounded unique sets from wide sheets            |
| Logging                 | Log sheet names, row counts, elapsed ms at **info** for ingest  | Logging full cell payloads                                  |
| Preview APIs            | Reuse the **same** read path as ingest                          | A “fast” preview that skips `ffill`                         |


---

## 6. Row filters (subset scans)

When users filter rows **before** ingest or compare:

- Combine filters with **AND** semantics unless the product specifies OR.
- Operators (`contains`, `equals`, `regex`, …) should use **plain text** comparison consistent with **scalar cell** extraction—same function for preview and ingest.
- **Regex:** catch `**re.error`** and fail closed for that predicate (don’t crash the whole job silently).

---

## 7. Building text for search / embeddings

- Concatenate **sheet + context columns + optional body column** with an explicit, documented delimiter (e.g. `|`).
- Omit empty parts so you don’t embed strings of repeated separators.
- Keep **ID columns** available for exact lookup mode separately from “blob” text—don’t strip IDs from stored columns if users expect ID search.

---

## 8. Pitfalls checklist (quick audit)

Use before shipping a new Excel feature:

- Same `**read_excel` rules** for preview, ingest, and exports that re-read uploads.
- `**ffill` before** dropping empty rows.
- **String dtype** on read for heterogeneous sheets.
- `**"nan"`** string filtered after `astype`/pandas coercion.
- **MIME type** for `.xlsx` in server config if uploads break in Linux containers.
- **Large sheet** path: no accidental full-DataFrame `to_dict` per row in hot loops.
- **User-facing** copy states when distinct lists or exports are **truncated**.

---

## 9. Minimal reference implementation (sketch)

```python
import pandas as pd

def read_excel_all_sheets(path: str) -> pd.DataFrame:
    all_sheets = pd.read_excel(path, sheet_name=None, dtype=str)
    frames = []
    for sheet_name, df in all_sheets.items():
        df = df.ffill()
        df = df.dropna(how="all")
        df["sheet_name"] = sheet_name
        frames.append(df)
    return pd.concat(frames, ignore_index=True)
```

Extend with logging, column lists, and your app’s column allowlist as needed.

---

## 10. Versioning

- **Document** any change to read order (`ffill` / `dropna` / dtypes) in release notes—users with “weird” sheets will depend on stable behavior.
- When adding **new** Excel features, add a **small fixture file** in tests (happy path + merged cells + empty row).

---

*End of guidelines — copy sections as needed for other projects or agent prompts.*
#!/usr/bin/env python3
"""
batch_compare.py — Automate Compare job creation + execution for a folder tree.

Usage:
    python batch_compare.py <root_folder> [--api-url URL] [--dry-run] [--run-name NAME]

Each immediate subfolder of root_folder is treated as one Compare job. Any
.yml file in the subfolder is used as the config; folders without one are
skipped with a warning. If multiple .yml files exist, the first (alphabetically)
is used.

See the config schema in the project docs or the EXAMPLE_CONFIG string below.
"""

import argparse
import json
import os
import sys
import pathlib
import requests
import yaml

EXAMPLE_CONFIG = """
# compare config (.yml) — all fields optional except left_columns / right_columns
name: "My Job"             # default: subfolder name
label_left: "Left"         # default: "Left"
label_right: "Right"       # default: "Right"
left_file: left.xlsx       # default: left.xlsx (falls back to left.xls)
right_file: right.xlsx     # default: right.xlsx (falls back to right.xls)
sheet_left: ~              # omit for single-sheet workbooks
sheet_right: ~
left_columns: [Name, Description]      # REQUIRED: columns to embed for left side
right_columns: [Title, Specs]          # REQUIRED: columns to embed for right side
llm_left_columns: [Name]               # optional LLM judge override (default: left_columns)
llm_right_columns: [Title]             # optional LLM judge override (default: right_columns)
display_column_left: SKU               # optional display column in review UI
display_column_right: PartNumber
top_k: 5               # default: 5
vector_enabled: true   # default: true
reranker_enabled: false
embed_url: ~
embed_api_key: ~
embed_model: ~
llm_judge_enabled: false
llm_judge_url: ~
llm_judge_model: ~
llm_judge_prompt: ~
llm_judge_max_requests_per_minute: ~
"""

# ──────────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────────

def _log(msg, prefix=""):
    print(f"{prefix}{msg}", flush=True)


def _warn(msg):
    print(f"  ⚠  {msg}", flush=True)


def _err(msg):
    print(f"  ✗  {msg}", flush=True)


def stream_sse(url):
    """Consume an SSE endpoint, yielding parsed event dicts until complete/error."""
    with requests.get(url, stream=True, timeout=3600) as r:
        r.raise_for_status()
        for raw in r.iter_lines():
            if not raw:
                continue
            if isinstance(raw, bytes):
                raw = raw.decode("utf-8", errors="replace")
            if not raw.startswith("data:"):
                continue
            try:
                evt = json.loads(raw[5:].strip())
            except json.JSONDecodeError:
                continue
            yield evt
            if evt.get("type") in ("complete", "error"):
                return


def find_excel(folder: pathlib.Path, stem: str) -> pathlib.Path | None:
    """Return folder/stem.xlsx or folder/stem.xls, whichever exists first."""
    for ext in (".xlsx", ".xls"):
        p = folder / (stem + ext)
        if p.exists():
            return p
    return None


def resolve_file(folder: pathlib.Path, cfg_value: str | None, default_stem: str) -> pathlib.Path | None:
    if cfg_value:
        p = folder / cfg_value
        return p if p.exists() else None
    return find_excel(folder, default_stem)


def derive_run_name(cfg: dict, cli_run_name: str | None) -> str:
    if cli_run_name:
        return cli_run_name
    base = cfg.get("name") or "Left vs Right"
    embed_model = cfg.get("embed_model") or "bge-m3"
    k = cfg.get("top_k", 5)
    parts = [embed_model]
    if cfg.get("llm_judge_enabled"):
        parts.append(cfg.get("llm_judge_model") or "llm")
    parts.append(f"k={k}")
    return f"{base} [{', '.join(parts)}]"


# ──────────────────────────────────────────────────────────────────────────────
# Per-job logic
# ──────────────────────────────────────────────────────────────────────────────

def upload_preview(api_url: str, side: str, filepath: pathlib.Path) -> dict:
    url = f"{api_url}/compare/preview-{side}"
    with filepath.open("rb") as fh:
        r = requests.post(url, files={"file": (filepath.name, fh)}, timeout=120)
    r.raise_for_status()
    return r.json()


def create_job(api_url: str, payload: dict) -> dict:
    r = requests.post(f"{api_url}/compare/", json=payload, timeout=30)
    r.raise_for_status()
    return r.json()


def create_run(api_url: str, job_id: int, payload: dict) -> dict:
    r = requests.post(f"{api_url}/compare/{job_id}/runs", json=payload, timeout=30)
    r.raise_for_status()
    return r.json()


def run_job_folder(folder: pathlib.Path, api_url: str, cli_run_name: str | None, dry_run: bool) -> bool:
    """Process a single job folder. Returns True on success."""
    _log(f"\n{'─'*60}")
    _log(f"Folder: {folder.name}")

    # ── load config ──────────────────────────────────────────────────────────
    yml_files = sorted(folder.glob("*.yml"))
    if not yml_files:
        _warn("No .yml config found — skipping")
        return False
    cfg_path = yml_files[0]
    if len(yml_files) > 1:
        _warn(f"Multiple .yml files found — using {cfg_path.name}")

    with cfg_path.open() as f:
        cfg = yaml.safe_load(f) or {}

    # ── resolve files ─────────────────────────────────────────────────────────
    left_path = resolve_file(folder, cfg.get("left_file"), "left")
    right_path = resolve_file(folder, cfg.get("right_file"), "right")

    if not left_path:
        _warn(f"Left file not found (expected {cfg.get('left_file', 'left.xlsx/.xls')}) — skipping")
        return False
    if not right_path:
        _warn(f"Right file not found (expected {cfg.get('right_file', 'right.xlsx/.xls')}) — skipping")
        return False

    # ── validate required columns ─────────────────────────────────────────────
    if not cfg.get("left_columns"):
        _warn("left_columns not specified in compare.yml — skipping")
        return False
    if not cfg.get("right_columns"):
        _warn("right_columns not specified in compare.yml — skipping")
        return False

    # ── strict: filename must match what is declared in the YAML ─────────────
    if cfg.get("left_file") and left_path.name != cfg["left_file"]:
        _warn(f"left_file mismatch: compare.yml says '{cfg['left_file']}', found '{left_path.name}' — fix the filename or update compare.yml")
        return False
    if cfg.get("right_file") and right_path.name != cfg["right_file"]:
        _warn(f"right_file mismatch: compare.yml says '{cfg['right_file']}', found '{right_path.name}' — fix the filename or update compare.yml")
        return False

    # ── strict: all declared columns must exist in the Excel headers ──────────
    try:
        import pandas as _pd
        for side, path, col_key in [
            ("left",  left_path,  "left_columns"),
            ("right", right_path, "right_columns"),
        ]:
            df_head = _pd.read_excel(path, nrows=0, dtype=str)
            missing = [c for c in cfg[col_key] if c not in df_head.columns]
            if missing:
                _warn(f"{col_key} not found in {path.name}: {missing} — fix compare.yml or the Excel file")
                return False
    except Exception as e:
        _warn(f"Could not read Excel headers for column validation: {e}")
        return False

    name = cfg.get("name") or folder.name
    run_name = derive_run_name(cfg, cli_run_name)

    _log(f"  Job: {name}")
    _log(f"  Left:  {left_path.name}  columns={cfg['left_columns']}")
    _log(f"  Right: {right_path.name}  columns={cfg['right_columns']}")
    _log(f"  Run:   {run_name}")

    if dry_run:
        _log("  [dry-run] would proceed — no API calls made")
        return True

    try:
        # ── upload previews ───────────────────────────────────────────────────
        _log("  Uploading files...")
        left_preview  = upload_preview(api_url, "left",  left_path)
        right_preview = upload_preview(api_url, "right", right_path)

        # ── build job creation payload ────────────────────────────────────────
        left_cols  = cfg["left_columns"]
        right_cols = cfg["right_columns"]

        job_payload = {
            "name":                  name,
            "label_left":            cfg.get("label_left")  or "Left",
            "label_right":           cfg.get("label_right") or "Right",
            "tmp_path_left":         left_preview["tmp_path"],
            "tmp_path_right":        right_preview["tmp_path"],
            "source_filename_left":  left_path.name,
            "source_filename_right": right_path.name,
            "context_columns_left":  left_cols,
            "content_column_left":   left_cols[-1],
            "context_columns_right": right_cols,
            "content_column_right":  right_cols[-1],
            "all_columns_left":      left_preview.get("columns", []),
            "all_columns_right":     right_preview.get("columns", []),
            "created_from_config_import": True,
            "config_import_filename": cfg_path.name,
        }

        if cfg.get("sheet_left"):
            job_payload["sheet_name_left"] = cfg["sheet_left"]
        if cfg.get("sheet_right"):
            job_payload["sheet_name_right"] = cfg["sheet_right"]
        if cfg.get("display_column_left"):
            job_payload["display_column_left"] = cfg["display_column_left"]
        if cfg.get("display_column_right"):
            job_payload["display_column_right"] = cfg["display_column_right"]
        if cfg.get("embed_url"):
            job_payload["embed_url"] = cfg["embed_url"]
        if cfg.get("embed_api_key"):
            job_payload["embed_api_key"] = cfg["embed_api_key"]
        if cfg.get("embed_model"):
            job_payload["embed_model"] = cfg["embed_model"]

        # ── create job ────────────────────────────────────────────────────────
        _log("  Creating job...")
        job = create_job(api_url, job_payload)
        job_id = job["id"]
        _log(f"  Job created  id={job_id}")

        # ── Phase 1: ingest ───────────────────────────────────────────────────
        _log("  Ingesting (embedding)...")
        ingest_url = f"{api_url}/compare/{job_id}/ingest"
        for evt in stream_sse(ingest_url):
            t = evt.get("type", "")
            if t == "error":
                raise RuntimeError(f"Ingest error: {evt.get('message', '(no message)')}")
            if t in ("ingest_left", "ingest_right"):
                pct = evt.get("percent", "")
                _log(f"    {t}  {pct}%", prefix="")
        _log("  Ingest complete")

        # ── build run creation payload ────────────────────────────────────────
        run_payload = {
            "name":               run_name,
            "top_k":              cfg.get("top_k", 5),
            "vector_enabled":     cfg.get("vector_enabled", True),
            "reranker_enabled":   cfg.get("reranker_enabled", False),
            "llm_judge_enabled":  cfg.get("llm_judge_enabled", False),
        }

        if cfg.get("reranker_url"):
            run_payload["reranker_url"] = cfg["reranker_url"]
        if cfg.get("reranker_model"):
            run_payload["reranker_model"] = cfg["reranker_model"]

        llm_enabled = cfg.get("llm_judge_enabled", False)
        if llm_enabled:
            if cfg.get("llm_judge_url"):
                run_payload["llm_judge_url"] = cfg["llm_judge_url"]
            if cfg.get("llm_judge_model"):
                run_payload["llm_judge_model"] = cfg["llm_judge_model"]
            if cfg.get("llm_judge_prompt"):
                run_payload["llm_judge_prompt"] = cfg["llm_judge_prompt"]
            if cfg.get("llm_judge_max_requests_per_minute") is not None:
                run_payload["llm_judge_max_requests_per_minute"] = cfg["llm_judge_max_requests_per_minute"]
            if cfg.get("llm_left_columns"):
                run_payload["llm_judge_left_columns"] = cfg["llm_left_columns"]
            if cfg.get("llm_right_columns"):
                run_payload["llm_judge_right_columns"] = cfg["llm_right_columns"]

        # ── create run ────────────────────────────────────────────────────────
        _log("  Creating run...")
        run = create_run(api_url, job_id, run_payload)
        run_id = run["id"]
        _log(f"  Run created  id={run_id}")

        # ── Phase 2: execute ──────────────────────────────────────────────────
        _log("  Executing pipeline...")
        exec_url = f"{api_url}/compare/{job_id}/runs/{run_id}/execute"
        for evt in stream_sse(exec_url):
            t = evt.get("type", "")
            if t == "error":
                raise RuntimeError(f"Execute error: {evt.get('message', '(no message)')}")
            if t in ("matching", "reranking", "llm_judging"):
                pct = evt.get("percent", "")
                _log(f"    {t}  {pct}%", prefix="")
        _log("  Pipeline complete")

        _log(f"  ✓  job_id={job_id}  run_id={run_id}  status=ready")
        return True

    except requests.HTTPError as e:
        body = ""
        try:
            body = e.response.json().get("detail", "")
        except Exception:
            pass
        _err(f"HTTP {e.response.status_code}: {body or str(e)}")
        return False
    except Exception as e:
        _err(str(e))
        return False


# ──────────────────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Batch-run Compare jobs from a folder tree.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=f"Example compare.yml:\n{EXAMPLE_CONFIG}",
    )
    parser.add_argument("root_folder", help="Folder containing one subfolder per Compare job")
    parser.add_argument("--api-url", default="http://localhost:37002", help="LENS API base URL (default: http://localhost:37002)")
    parser.add_argument("--dry-run", action="store_true", help="Discover and print jobs without calling the API")
    parser.add_argument("--run-name", default=None, help="Override the run name for every job (default: derived from config)")
    args = parser.parse_args()

    root = pathlib.Path(args.root_folder).expanduser().resolve()
    if not root.is_dir():
        print(f"Error: {root} is not a directory", file=sys.stderr)
        sys.exit(1)

    subfolders = sorted(p for p in root.iterdir() if p.is_dir())
    if not subfolders:
        print("No subfolders found — nothing to do.")
        sys.exit(0)

    _log(f"Root: {root}  ({len(subfolders)} subfolders)")
    if args.dry_run:
        _log("[dry-run mode — no API calls will be made]")

    ok = 0
    failed = 0
    skipped = 0

    for folder in subfolders:
        result = run_job_folder(folder, args.api_url, args.run_name, args.dry_run)
        if result is True:
            ok += 1
        elif result is False:
            if not any(folder.glob("*.yml")):
                skipped += 1
            else:
                failed += 1

    _log(f"\n{'═'*60}")
    _log(f"Done.  ✓ {ok} succeeded  ✗ {failed} failed  — {skipped} skipped (no .yml config)")


if __name__ == "__main__":
    main()

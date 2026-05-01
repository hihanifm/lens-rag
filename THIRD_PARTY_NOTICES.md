# Third-Party Notices

This file lists third-party software used by this repository and provides attribution information to the best of our ability based on dependency metadata and lockfiles.

## Compliance flags (review required)

- **LGPL dependency present (Python, runtime)**: `psycopg2-binary==2.9.9` is reported as **GNU LGPL** (project site: `https://psycopg.org/`).  
  This conflicts with the goal of “no GPL/LGPL/AGPL/SSPL dependencies”. If that goal is strict, `psycopg2-binary` must be replaced (and any transitive dependencies re-checked).

## Docker base images (from Dockerfiles / Compose)

- **`python:3.11-slim`** (backend image base)
- **`node:20-bookworm-slim`** (frontend dev image base; override via `NODE_IMAGE` build arg)
- **`pgvector/pgvector:pg16`** (Postgres + pgvector service image)

Image licensing is governed by upstream projects and the image publishers; if you distribute images externally, consider producing an image SBOM and/or including the relevant upstream notices in your distribution process.

## Direct Python dependencies (from `backend/requirements.txt`)

- `fastapi` — MIT — `https://github.com/tiangolo/fastapi`
- `uvicorn` — BSD-3-Clause — `https://www.uvicorn.org/`
- `psycopg2-binary` — LGPL — `https://psycopg.org/`
- `pgvector` — MIT — `https://github.com/pgvector/pgvector-python`
- `pandas` — BSD — `https://pandas.pydata.org`
- `scikit-learn` — BSD-3-Clause — `https://scikit-learn.org`
- `openpyxl` — MIT — `https://openpyxl.readthedocs.io`
- `openai` — Apache-2.0 — `https://github.com/openai/openai-python`
- `httpx` — BSD — `https://github.com/encode/httpx`
- `python-multipart` — Apache-2.0 — `https://github.com/andrew-d/python-multipart`
- `pydantic` — MIT — `https://github.com/pydantic/pydantic`

## Direct npm dependencies (from `frontend/package.json`)

- `react` — MIT — `https://github.com/facebook/react`
- `react-dom` — MIT — `https://github.com/facebook/react`
- `react-router-dom` — MIT — `https://github.com/remix-run/react-router`
- `@tanstack/react-query` — MIT — `https://github.com/TanStack/query`
- `@tanstack/react-table` — MIT — `https://github.com/TanStack/table`
- `axios` — MIT — `https://github.com/axios/axios`

## Direct npm devDependencies (from `frontend/package.json`)

- `vite` — MIT — `https://github.com/vitejs/vite`
- `@vitejs/plugin-react` — MIT — `https://github.com/vitejs/vite-plugin-react`
- `tailwindcss` — MIT — `https://github.com/tailwindlabs/tailwindcss`
- `postcss` — MIT — `https://github.com/postcss/postcss`
- `autoprefixer` — MIT — `https://github.com/postcss/autoprefixer`
- `@playwright/test` — Apache-2.0 — `https://github.com/microsoft/playwright`
- `@types/react` — MIT — `https://github.com/DefinitelyTyped/DefinitelyTyped`
- `@types/react-dom` — MIT — `https://github.com/DefinitelyTyped/DefinitelyTyped`

## How to reproduce full (direct + transitive) inventories

These commands generate inventories based on the current lockfiles:

- **npm (direct + transitive)**:

```bash
cd frontend
npm ci
npx --yes license-checker-rseidelsohn --production=false
```

- **Python (direct + transitive)** (use Python 3.11 to ensure wheels resolve cleanly):

```bash
python3.11 -m venv /tmp/lens_license_venv311
source /tmp/lens_license_venv311/bin/activate
python -m pip install --upgrade pip
python -m pip install -r backend/requirements.txt pip-licenses
pip-licenses --with-urls --with-license-file --with-description
```

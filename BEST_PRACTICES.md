# LENS — Best Practices

Shared reference for the developer and Claude. Covers React, FastAPI, and Git. General coding rules live in [CLAUDE.md](CLAUDE.md).
All practices are grounded in the actual patterns already in this codebase — nothing speculative.

---

## 1. React / Frontend

### Component structure

- Functional components only — no class components
- One component per file; filename matches component name (PascalCase)
- Pages go in `src/pages/`, reusable pieces in `src/components/`
- Default-export the component; named-export only for utilities

### State management

- `useState` for local UI state (form inputs, toggles, loading/error flags)
- TanStack Query (`useQuery`, `useMutation`) for all server state — no manual fetch-in-useEffect
- No Redux, no Context API — they're not needed at this scale
- Don't use `useEffect` to derive state; use `useMemo` or compute inline instead

### API calls

- All `axios` calls live in `src/api/client.js` — never inline `fetch` or `axios` in a component
- Functions are plain async functions returning `r.data`; components just `await` them
- SSE (ingestion progress) uses `EventSource`; close it in the `useEffect` cleanup function

### Error handling

- Always show a user-facing message (e.g. "Search failed. Please try again.")
- Log the raw error to the console for debugging — don't swallow it silently
- Use `[error, setError] = useState(null)` and render the message in JSX

### Styling (Tailwind)

- Utility classes inline only — no separate CSS files except `index.css` for globals
- Conditional classes via template literals: `px-4 ${isActive ? 'bg-blue-600' : 'bg-gray-100'}`
- No custom CSS unless there is genuinely no Tailwind equivalent

### General

- No TypeScript (project decision) — compensate with descriptive prop and variable names
- Use `useMemo` for expensive column definitions (TanStack Table pattern already in place)
- Never hardcode API base URLs in components — they're in `client.js` via Vite proxy

---

## 2. FastAPI / Backend

### Python environment — always use a venv

```bash
# First time
python -m venv .venv

# Every session before running pip or python
source .venv/bin/activate

# Install deps
pip install -r backend/requirements.txt
```

**Never install packages globally.** Claude must activate `.venv` before running any `pip` or `python` command.

### Route handlers

- Validate early — raise `HTTPException` before doing any DB or compute work
- Always include a meaningful `detail` string: `"Project not ready (status: ingesting)"`
- Use explicit HTTP status codes: 404 for missing resource, 400 for bad state, 422 for bad input
- Never put DB logic directly in route handlers — delegate to `projects.py`, `search.py`, etc.

### Database

- All queries use parameterized placeholders: `cur.execute("SELECT ... WHERE id = %s", [id])`
- Never use f-strings or `.format()` to build SQL values — SQL injection risk
- Always use the `get_cursor()` context manager — never open a connection manually
- Schema names are safe (generated from integer project IDs, no user input touches them)

### Configuration

- Read all config from `config.py` — never call `os.environ.get()` in logic files
- If a new config value is needed, add it to `config.py` first, then import it

### Pydantic models

- Define a `BaseModel` for every request body and response body
- Use `Optional[Type] = None` for optional fields; use typed lists `List[str]`, not bare `list`
- Keep models in `models.py`; don't define inline in route files

### Streaming (SSE)

- Long operations (ingestion) yield dicts from a generator, wrapped in `StreamingResponse`
- Yield `{"step": "progress", "percent": N}` during work, `{"step": "complete"}` at the end
- Frontend uses `EventSource` to consume the stream

---

## 3. Git & Workflow

### Commit messages

- Imperative present tense, under 72 characters
- Good: `Add SSE progress bar to ingestion`, `Fix SSE base URL mismatch in CreateProject`
- Bad: `fixed the bug`, `changes`, `WIP`

### Commits

- One logical change per commit — don't bundle unrelated fixes or refactors
- Never commit `.env`, secrets, or API keys — they go in a local `.env` file only
- Check `git status` before committing to avoid accidental file inclusion

### Branches

- `feature/short-description` for new functionality
- `fix/short-description` for bug fixes
- Keep branches short-lived; merge or rebase frequently against `main`

### Before pushing

- Run `make build` to confirm the Docker image still compiles cleanly
- Verify the frontend builds without errors: `cd frontend && npm run build`

---

## 4. Docker

### Offline / proxy-restricted builds — pip-cache pattern

Lab environments often block PyPI. The pattern: pre-download wheels to a local `pip-cache/` directory, `COPY` them into the image, and install with `--no-index --find-links`. Fall back to PyPI only when the cache directory is empty (fresh clone).

```dockerfile
COPY pip-cache/ /tmp/pip-cache/
RUN if [ "$(ls /tmp/pip-cache/*.whl /tmp/pip-cache/*.tar.gz 2>/dev/null)" ]; then \
      pip install --no-cache-dir --no-index --find-links /tmp/pip-cache -r requirements.txt; \
    else \
      pip install --no-cache-dir \
        --trusted-host pypi.org \
        --trusted-host pypi.python.org \
        --trusted-host files.pythonhosted.org \
        -r requirements.txt; \
    fi && rm -rf /tmp/pip-cache
```

### Multi-arch awareness — detect host arch, download the right wheels

`pip download` with `--platform` only downloads wheels for one architecture at a time. Detect the host with `uname -m` and target accordingly — Mac Apple Silicon is `arm64`, lab Linux is `x86_64`:

```makefile
pip-cache:
	@ARCH=$$(uname -m); \
	if [ "$$ARCH" = "arm64" ] || [ "$$ARCH" = "aarch64" ]; then \
	  PLAT="--platform manylinux_2_17_aarch64 --platform linux_aarch64"; \
	else \
	  PLAT="--platform manylinux_2_17_x86_64 --platform manylinux2014_x86_64 --platform linux_x86_64"; \
	fi; \
	pip download $$PLAT \
	  --python-version 3.11 --implementation cp --abi cp311 \
	  --only-binary=:all: \
	  -r backend/requirements.txt \
	  -d pip-cache/
```

Do **not** hardcode `platform: linux/amd64` in `docker-compose.yml` — it breaks native arm64 builds and the pip-cache detection above already handles it.

### pip-cache discipline

- Run `make pip-cache` once after adding or removing anything from `requirements.txt`.
- Do **not** explicitly declare packages that are already transitive dependencies — they may not have a prebuilt binary wheel for the target platforms, breaking `--only-binary=:all:`. If a package you need is already pulled in transitively, just use it without adding it to `requirements.txt`.
- The `pip-cache/` directory should be committed to the repo so lab machines with no internet can `git pull` + `make build` without needing PyPI access.
- `--only-binary=:all:` is intentional — source distributions require a compiler in the build image; wheels do not.

### Rebuild vs restart

- **Any Python file change** → `make build && make up` (image must be rebuilt).
- **Frontend-only change** → `make restart` (Vite volume-mounts source, no rebuild needed).
- When in doubt, rebuild. A stale image is harder to debug than a slow build.

## 5. General Rules (Claude + Developer)

The canonical list lives in [CLAUDE.md](CLAUDE.md) under **Best Practices → General coding rules** so Claude Code always loads it. This document focuses on React, FastAPI, and Git specifics below.
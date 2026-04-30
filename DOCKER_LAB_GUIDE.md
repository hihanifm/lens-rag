# Docker Lab Guide (Agent Reference)

This is a **generic reference** for building a smooth Docker Compose setup for a typical **web app**:

- **Frontend** (dev server in development)
- **Backend API** (FastAPI/Express/etc.)
- **Database** (Postgres/Redis/etc.)

The intent is to give a coding agent (or a human) enough structure to implement a predictable workflow in **any repo**, especially in lab environments with proxies or restricted egress.

## The standard shape (keep it simple)

### Dev: split frontend + backend

- Frontend runs as a dev server on `DEV_UI_PORT`
- Backend API runs on `DEV_API_PORT`
- Browser talks to the frontend origin only; the frontend dev server **proxies `/api` → backend** (single-origin dev, fewer CORS issues)

### Prod: single origin (bundle frontend once)

- Build frontend to static assets (`dist/`, `build/`)
- Backend serves those static assets (or reverse proxy does)
- Browser hits **one origin / one port** (`PROD_PORT`)

## Port convention (run dev + prod simultaneously)

Pick a `BASE_PORT` and use this pattern:

- **prod**: `PROD_PORT = BASE_PORT`
- **dev UI**: `DEV_UI_PORT = BASE_PORT + 1`
- **dev API**: `DEV_API_PORT = BASE_PORT + 2`

Example (just an example):

- `BASE_PORT=37000`
- prod = `37000`, dev UI = `37001`, dev API = `37002`

Notes:

- Keep DB ports either **unpublished** (best) or pick a different range to avoid collisions.
- If you run multiple projects on the same machine, pick a different `BASE_PORT` per project.

## Compose structure (what to implement in any repo)

Use **profiles** (or separate compose files) to model “dev vs prod”.

- **dev profile**:
  - db service(s)
  - api service (published on `DEV_API_PORT`)
  - frontend dev server service (published on `DEV_UI_PORT`)
- **prod profile**:
  - db service(s) (optional separate volume/name)
  - api-prod service (published on `PROD_PORT`)
  - frontend build artifacts mounted into api-prod OR baked into the api-prod image

If you want dev + prod to run at the same time, ensure:

- Published ports do not collide (`BASE`, `BASE+1`, `BASE+2`)
- Container names do not collide (either different names, or avoid `container_name:` entirely)
- Optional: set `COMPOSE_PROJECT_NAME` to keep networks/containers isolated when running multiple stacks

## Proxy-friendly builds (must-have in labs)

### Pass standard proxy variables into Docker builds

Support these env vars:

- `HTTP_PROXY`
- `HTTPS_PROXY`
- `NO_PROXY` (include `localhost,127.0.0.1`, and any internal hostnames)

In compose, pass them as `build.args` for images that run `apt`, `pip`, `npm`, etc.

### “pip-cache” pattern (Python): pre-download wheels for offline Docker builds

If Docker builds fail at `pip install` due to proxy/egress, add a `pip-cache/` flow:

- One-time (or CI job) downloads Linux wheels for your `requirements.txt` into `pip-cache/`
- Dockerfile installs from `pip-cache/` first (fast, deterministic; no external PyPI needed during build)

Generic command template (adapt per Python version):

```bash
pip download \
  --platform manylinux2014_x86_64 \
  --python-version 3.11 \
  --implementation cp \
  --abi cp311 \
  --only-binary=:all: \
  -r backend/requirements.txt \
  -d pip-cache/
```

If you have an internal PyPI mirror, you can also configure pip:

```bash
pip config set global.index-url "https://<your-mirror>/simple"
pip config set global.trusted-host "<your-mirror-host>"
```

## Logs: make it easy to see what’s happening

Provide both:

- **simple**: `docker compose logs -f`
- **focused**: one command/target per service (API-only is the most common)
- **nice**: a `logs-split` helper that tails API/FE/DB in separate panes (tmux is common in labs)

Fallback (no tmux): document per-service log commands.

## Day-2 operations (common gotchas)

- **Code changes not picked up**: if you bake code into images, you need `build` + `up` (not just restart).
- **Single-origin dev is easiest**: keep the browser talking to the FE dev server; proxy API calls internally.
- **Host-only dependencies** (optional): if you call a host service (GPU model server, etc.), document `host.docker.internal` and any `extra_hosts` needed.

## Example from this repo (for coding agents)

This section shows small, concrete snippets from this repository to demonstrate the patterns above. Use as reference only; keep other repos generic.

### Makefile patterns: dev/prod profiles + logs-split + pip-cache

```makefile
up:
	docker compose --profile dev up -d

build:
	docker compose --profile dev build

prod-up: build-frontend
	docker compose --profile dev down --remove-orphans
	docker compose --profile prod up -d --build
```

```makefile
logs-split:
	tmux new-session -d -s lens-logs "docker compose --profile dev logs -f lens-rag-api" \; \
	  split-window -h "docker compose --profile dev logs -f lens-rag-frontend" \; \
	  split-window -v "docker compose --profile dev logs -f lens-rag-postgres" \; \
	  select-pane -t 0 \; \
	  attach -t lens-logs
```

```makefile
logs-api:
	docker compose --profile dev logs -f lens-rag-api

prod-logs-api:
	docker compose --profile prod logs -f lens-rag-api-prod
```

```makefile
pip-cache:
	pip download \
	  --platform manylinux2014_x86_64 \
	  --python-version 3.11 \
	  --implementation cp \
	  --abi cp311 \
	  --only-binary=:all: \
	  -r backend/requirements.txt \
	  -d pip-cache/
```

### Compose patterns: profiles, port split in dev, single port in prod, proxy args

```yaml
  lens-rag-api:
    profiles: ["dev"]
    build:
      args:
        HTTP_PROXY: ${HTTP_PROXY:-}
        HTTPS_PROXY: ${HTTPS_PROXY:-}
        NO_PROXY: ${NO_PROXY:-}
    ports:
      - "37002:8000" # dev API port (BASE+2 example)
```

```yaml
  lens-rag-frontend:
    profiles: ["dev"]
    ports:
      - "37001:37001" # dev UI port (BASE+1 example)
    environment:
      - VITE_API_PROXY_TARGET=http://lens-rag-api:8000
```

```yaml
  lens-rag-api-prod:
    profiles: ["prod"]
    ports:
      - "37000:8000" # prod single origin (BASE example)
    environment:
      SERVE_FRONTEND: "true"
    volumes:
      - ./frontend/dist:/app/frontend/dist:ro
```


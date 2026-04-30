---
name: docker-lab
description: Enforces a predictable, proxy-friendly Docker Compose dev/prod workflow for lab environments.
version: 1.0
applies_to: ["docker", "docker-compose", "compose", "lab", "proxy", "pip", "npm", "dev-server", "ports", "profiles", "tmux"]
rules:
  - Always separate dev (FE dev server + API) from prod (single-origin static + API).
  - Always use Compose profiles (or equivalent) to model dev vs prod.
  - Always pass HTTP_PROXY/HTTPS_PROXY/NO_PROXY into Docker builds in restricted egress environments.
  - Always keep browser traffic single-origin in dev (frontend dev server proxies to API).
  - Never assume `docker compose restart` applies code changes; rebuild when code is baked into images.
usage:
  - Use this guideline when creating or repairing Docker Compose workflows for web apps in lab/proxy environments.
  - Apply by enforcing the port convention, profiles, proxy args, and documenting daily commands + verification checks.
---

# SKILL: Docker Lab Compose Guidelines

## Purpose

Create a predictable Docker Compose workflow for typical web apps (frontend + backend API + database) that works reliably in lab environments (proxies, restricted egress) and is friendly to non-interactive agents.

## Non-negotiable rules

- **Always split dev and prod**.
  - **Dev**: frontend dev server + backend API, separate ports.
  - **Prod**: single origin/port; frontend is built once and served as static assets.
- **Always keep dev single-origin for the browser**.
  - Browser talks to frontend dev server only.
  - Frontend dev server proxies API routes to backend (avoid CORS complexity).
- **Always model dev vs prod with Compose profiles** (or separate compose files).
- **Always use a consistent port convention** so dev + prod can run simultaneously without collisions.
- **Always pass proxy variables into Docker builds** when the environment might require it.
  - Support: `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`.
  - Ensure `NO_PROXY` includes `localhost,127.0.0.1` plus internal hostnames.
- **Never rely on `restart` to pick up changes**.
  - If code is baked into images, you must rebuild (`build` + `up`).

## Setup (one-time)

### Pick ports (dev + prod can coexist)

Pick a `BASE_PORT` and use:

- **Prod**: `PROD_PORT = BASE_PORT`
- **Dev UI**: `DEV_UI_PORT = BASE_PORT + 1`
- **Dev API**: `DEV_API_PORT = BASE_PORT + 2`

Example:

- `BASE_PORT=37000`
- prod = `37000`, dev UI = `37001`, dev API = `37002`

Notes:

- Prefer keeping DB ports **unpublished** (best). If you must publish, choose a separate range.
- If multiple projects share a host, allocate a different `BASE_PORT` per project.

### Compose structure (profiles)

Implement profiles like:

- **dev profile**:
  - db service(s)
  - api service (published on `DEV_API_PORT`)
  - frontend dev server (published on `DEV_UI_PORT`)
- **prod profile**:
  - db service(s) (optionally separate volume/name)
  - api-prod service (published on `PROD_PORT`)
  - frontend build artifacts mounted into api-prod OR baked into api-prod image

If dev + prod can run at the same time:

- **Never collide published ports**.
- **Never collide container names** (use distinct names or avoid `container_name`).
- Optionally set `COMPOSE_PROJECT_NAME` to isolate networks/containers across stacks.

### Proxy-friendly builds (labs)

Always pass proxy variables as **build args** for images that execute networked package managers (`apt`, `pip`, `npm`).

Minimum required behavior:

- If proxy env vars are set on the host, builds should succeed without editing Dockerfiles.
- If proxy env vars are absent, builds must still work (args default to empty).

### Python offline build pattern: `pip-cache/`

If Docker builds fail during `pip install` due to egress/proxy constraints, use a `pip-cache/` flow:

- Pre-download Linux wheels for the backend requirements into `pip-cache/`.
- Dockerfile installs from `pip-cache/` first (offline, deterministic).
- Only fall back to PyPI when `pip-cache/` is empty.

Generic command template (adapt Python version/ABI):

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

If using an internal mirror, configure pip explicitly:

```bash
pip config set global.index-url "https://<your-mirror>/simple"
pip config set global.trusted-host "<your-mirror-host>"
```

## Daily commands

These are the minimum commands to document in every repo.

### Start dev stack

```bash
docker compose --profile dev up -d
```

Verification (non-interactive):

```bash
docker compose --profile dev ps
docker compose --profile dev logs --no-color --tail=200
```

### Rebuild after backend/containerized code changes

If code is baked into images (typical for API):

```bash
docker compose --profile dev build
docker compose --profile dev up -d
```

### Follow logs

Simple:

```bash
docker compose --profile dev logs -f
```

Focused (preferred for agents):

```bash
docker compose --profile dev logs -f <service-name>
```

Nice (optional; requires tmux):

```bash
tmux new-session -d -s app-logs "docker compose --profile dev logs -f <api-service>" \; \
  split-window -h "docker compose --profile dev logs -f <frontend-service>" \; \
  split-window -v "docker compose --profile dev logs -f <db-service>" \; \
  select-pane -t 0 \; \
  attach -t app-logs
```

### Stop stack

```bash
docker compose --profile dev down --remove-orphans
```

## Examples (copy/paste)

### Compose snippets (profiles, ports, proxy args)

Dev API service: pass proxy args + publish `DEV_API_PORT`:

```yaml
services:
  api:
    profiles: ["dev"]
    build:
      context: .
      dockerfile: backend/Dockerfile
      args:
        HTTP_PROXY: ${HTTP_PROXY:-}
        HTTPS_PROXY: ${HTTPS_PROXY:-}
        NO_PROXY: ${NO_PROXY:-}
    ports:
      - "37002:8000" # dev API port (BASE+2 example)
```

Dev frontend service: publish `DEV_UI_PORT` and proxy to API over the Compose network:

```yaml
services:
  frontend:
    profiles: ["dev"]
    ports:
      - "37001:37001" # dev UI port (BASE+1 example)
    environment:
      - VITE_API_PROXY_TARGET=http://api:8000
```

Prod API service: single port, serve frontend build output:

```yaml
services:
  api-prod:
    profiles: ["prod"]
    ports:
      - "37000:8000" # prod single origin (BASE example)
    environment:
      SERVE_FRONTEND: "true"
    volumes:
      - ./frontend/dist:/app/frontend/dist:ro
```

### Makefile targets (dev/prod + logs)

```makefile
up:
	docker compose --profile dev up -d

build:
	docker compose --profile dev build

restart:
	docker compose --profile dev down --remove-orphans
	docker compose --profile dev up -d

logs:
	docker compose --profile dev logs -f

logs-api:
	docker compose --profile dev logs -f api
```

### Day-2 gotchas checklist (agent-friendly)

- **If changes don’t show up**: rebuild images (don’t just restart).
- **If the browser hits CORS**: ensure it talks to FE dev server only; FE proxies to API.
- **If builds fail in lab**: verify proxy args are passed; use `pip-cache/` to avoid PyPI at build time.
- **If calling host-only services**: document `host.docker.internal` usage and any required `extra_hosts`.

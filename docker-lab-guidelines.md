---
name: docker-lab-guidelines
description: >-
  Guides Docker Compose + Makefile setup for web apps (frontend + backend API + database)
  in lab environments with proxies, restricted egress, or mixed Mac/Linux dev teams.
  Use when scaffolding a new project, adding offline build support, fixing proxy issues,
  or setting up a dev/prod workflow with a predictable Makefile interface.
---

# Docker Lab Compose Guidelines

Use this when building or repairing a Docker Compose workflow for a typical web app in a **lab or enterprise environment** — restricted egress, Docker Hub blocks, mixed Mac/Linux developers, offline builds.

## When to apply

- New project needing a `docker-compose.yml` + `Makefile`
- Existing project where `make build` fails due to proxy or network issues
- Mac developer hitting arch mismatch with wheels built for Linux
- Lab machine with no internet access needing offline `pip install`
- Any project where dev and prod run on the same host

---

## Non-negotiable rules

- **Always split dev and prod** — dev server + API on separate ports; prod on a single origin.
- **Browser talks to the frontend dev server only** — frontend proxies API calls internally; no CORS complexity.
- **Model dev vs prod with Compose profiles** — `profiles: ["dev"]` / `profiles: ["prod"]`.
- **Always pass proxy vars into Docker builds** — `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`.
- **Never rely on `restart` to pick up code changes** — if code is baked into the image, rebuild.
- **Do not hardcode `platform:` in `docker-compose.yml`** — let Docker build natively for the host arch; pip-cache handles the rest.
- **`make` (no args) prints help** — `help` is the first target; developers discover all commands there.
- **Unprefixed Makefile targets are dev** — `make up`, `make build`, `make logs` always target dev.
- **Prod is always explicit** — `make prod-up`, `make prod-down`, `make prod-logs`; no accidental prod ops.

---

## Port convention

Pick one `BASE_PORT` per project so dev and prod can run simultaneously without collisions:

| Purpose  | Port          |
|----------|---------------|
| prod     | `BASE_PORT`   |
| dev UI   | `BASE_PORT+1` |
| dev API  | `BASE_PORT+2` |

Example: `BASE_PORT=37000` → prod `37000`, dev UI `37001`, dev API `37002`.

- Keep DB ports **unpublished** (best) or pick a separate range.
- Different projects on the same host → different `BASE_PORT`.
- When dev + prod run together: container names must not collide; set `COMPOSE_PROJECT_NAME` to isolate networks.

---

## Implementation

### Compose structure

```yaml
services:
  # ── dev profile ───────────────────────────────────────────────
  api:
    profiles: ["dev"]
    build:
      context: .
      dockerfile: backend/Dockerfile
      args:
        PYTHON_IMAGE: ${PYTHON_IMAGE:-public.ecr.aws/docker/library/python:3.11-slim}
        HTTP_PROXY: ${HTTP_PROXY:-}
        HTTPS_PROXY: ${HTTPS_PROXY:-}
        NO_PROXY: ${NO_PROXY:-}
    ports:
      - "37002:8000"   # BASE+2

  frontend:
    profiles: ["dev"]
    ports:
      - "37001:37001"  # BASE+1
    environment:
      - VITE_API_PROXY_TARGET=http://api:8000

  # ── prod profile ──────────────────────────────────────────────
  api-prod:
    profiles: ["prod"]
    ports:
      - "37000:8000"   # BASE
    environment:
      SERVE_FRONTEND: "true"
    volumes:
      - ./frontend/dist:/app/frontend/dist:ro
```

### Base images — registry mirrors

Docker Hub is often blocked in labs. Default to AWS Public ECR (no auth, mirrors Docker Official Images), overridable via `.env`:

```dockerfile
ARG PYTHON_IMAGE=public.ecr.aws/docker/library/python:3.11-slim
FROM ${PYTHON_IMAGE}
```

```yaml
# docker-compose.yml build args
args:
  PYTHON_IMAGE: ${PYTHON_IMAGE:-public.ecr.aws/docker/library/python:3.11-slim}
  NODE_IMAGE: ${NODE_IMAGE:-public.ecr.aws/docker/library/node:20-bookworm-slim}
```

### pip-cache — offline Python wheel install

Pre-download wheels into `pip-cache/`; Dockerfile installs offline, falls back to PyPI when cache is empty:

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

Populate the cache with arch detection — one run, correct wheels for the host (arm64 on Mac, x86_64 on lab Linux):

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

### Makefile

`help` is the first target — `make` alone shows the cheat sheet. All unprefixed targets are dev; prod is always prefixed.

```makefile
# Quick reference (visible in editors):
#   make build && make up   — pick up Dockerfile / dependency changes (required after backend edits)
#   make rebuild            — full --no-cache rebuild + up (after git pull if containers act stale)
#   make rebuild-api        — API image only (faster when only backend/ changed)
.PHONY: help up down build rebuild rebuild-api logs logs-api logs-split restart ps \
        prod-up prod-down prod-logs prod-logs-api pip-cache clean

help:
	@echo "Dev:"
	@echo "  make build && make up   Build images + start dev stack"
	@echo "  make rebuild            Full --no-cache rebuild + up"
	@echo "  make rebuild-api        Rebuild API image only (faster)"
	@echo "  make restart            down + up without rebuild"
	@echo "  make logs               Tail all dev logs"
	@echo "  make logs-api           Tail API logs only"
	@echo "  make ps                 Container status"
	@echo ""
	@echo "Prod (explicit):"
	@echo "  make prod-up            Build frontend + start prod stack"
	@echo "  make prod-down          Stop prod stack"
	@echo "  make prod-logs          Tail prod logs"
	@echo ""
	@echo "Maintenance:"
	@echo "  make pip-cache          Re-download wheels for offline builds"
	@echo "  make clean              Remove old containers/volumes; prune images"

up:
	docker compose --profile dev up -d

down:
	docker compose --profile dev down --remove-orphans

build:
	docker compose --profile dev build

rebuild:
	docker compose --profile dev build --no-cache
	docker compose --profile dev up -d

rebuild-api:
	docker compose --profile dev build --no-cache api
	docker compose --profile dev up -d api

restart:
	docker compose --profile dev down --remove-orphans
	docker compose --profile dev up -d

logs:
	docker compose --profile dev logs -f

logs-api:
	docker compose --profile dev logs -f api

logs-split:
	tmux new-session -d -s app-logs "docker compose --profile dev logs -f api" \; \
	  split-window -h "docker compose --profile dev logs -f frontend" \; \
	  split-window -v "docker compose --profile dev logs -f db" \; \
	  select-pane -t 0 \; \
	  attach -t app-logs

ps:
	docker compose ps

prod-up: build-frontend
	docker compose --profile dev down --remove-orphans
	docker compose --profile prod up -d --build

prod-down:
	docker compose --profile prod down --remove-orphans

prod-logs:
	docker compose --profile prod logs -f

prod-logs-api:
	docker compose --profile prod logs -f api-prod

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

---

## Implementation checklist

When scaffolding or reviewing a project against this guideline:

- [ ] `help` is the **first Makefile target**; `make` alone prints it.
- [ ] Unprefixed targets (`up`, `build`, `logs`) target **dev only**.
- [ ] Prod targets are **explicitly prefixed** (`prod-up`, `prod-down`, `prod-logs`).
- [ ] Dev and prod use **separate Compose profiles**.
- [ ] Ports follow the `BASE`, `BASE+1`, `BASE+2` convention; no collisions.
- [ ] `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` passed as **build args**.
- [ ] Base images default to **AWS Public ECR** mirror, overridable via `.env`.
- [ ] `pip-cache/` exists, is committed, and is populated for the **correct arch** (`uname -m`).
- [ ] Dockerfile uses the **offline-first** pip install pattern.
- [ ] `NO_PROXY` includes `localhost,127.0.0.1` plus any internal hostnames.
- [ ] Host-only services (e.g. GPU inference) use **`host.docker.internal`** + `extra_hosts`.
- [ ] **No `platform:` hardcoded** in `docker-compose.yml`.

---

## Anti-patterns

- **Hardcoding `platform: linux/amd64`** — forces emulation on Apple Silicon; unnecessary when pip-cache is arch-aware.
- **Declaring transitive dependencies in `requirements.txt`** — they may lack a binary wheel for the target platform, breaking `--only-binary=:all:`.
- **Using `make restart` after backend code changes** — restart skips the build step; stale image silently runs old code.
- **Committing `.env`** — proxy credentials and secrets must stay local.
- **Bare `docker compose` commands without `--profile`** — behaves differently across compose versions; always be explicit.
- **Single port for dev + prod** — impossible to run both simultaneously; debug prod issues without a running dev stack.
- **Not documenting `make help`** — teams re-discover commands by reading compose files instead of one `make`.

---

*Skill scope: Docker Compose + Makefile workflow for lab/proxy environments. For app-specific configuration (DB schemas, API routes, frontend build steps), compose separately.*

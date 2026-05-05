# Docker Lab Guide (Agent Reference)

Generic reference for building a predictable Docker Compose + Makefile setup for a typical web app (frontend + backend API + database) in lab environments with proxies or restricted egress.

---

## Non-negotiable rules

- **Always split dev and prod** — dev server + API on separate ports; prod on a single origin.
- **Browser talks to the frontend dev server only** — frontend proxies API calls internally (avoids CORS).
- **Model dev vs prod with Compose profiles** (or separate compose files).
- **Always pass proxy vars into Docker builds** — `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`.
- **Never rely on `restart` to pick up code changes** — if code is baked into the image, rebuild.
- **Do not hardcode `platform:` in `docker-compose.yml`** — let Docker build natively for the host arch.
- **`make` (no args) prints help** — `help` is the first target in the Makefile and is the default.
- **Unprefixed commands are dev** — `make up`, `make build`, `make logs` always target the dev stack.
- **Prod is always explicit** — `make prod-up`, `make prod-down`, `make prod-logs`; no accidents.

---

## Port convention (dev + prod run simultaneously)

Pick a `BASE_PORT` per project:

| Purpose  | Port          |
|----------|---------------|
| prod     | `BASE_PORT`   |
| dev UI   | `BASE_PORT+1` |
| dev API  | `BASE_PORT+2` |

Example: `BASE_PORT=37000` → prod `37000`, dev UI `37001`, dev API `37002`.

- Keep DB ports **unpublished** (best) or pick a separate range.
- Different projects on the same host → different `BASE_PORT`.
- When running dev + prod together: container names must not collide; optionally set `COMPOSE_PROJECT_NAME`.

---

## Compose structure

```yaml
services:
  # ── dev profile ───────────────────────────────────────────────
  api:
    profiles: ["dev"]
    build:
      args:
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

---

## Proxy-friendly builds

### Pass proxy vars as build args

```yaml
build:
  args:
    HTTP_PROXY: ${HTTP_PROXY:-}
    HTTPS_PROXY: ${HTTPS_PROXY:-}
    NO_PROXY: ${NO_PROXY:-}
```

`NO_PROXY` should include `localhost,127.0.0.1` plus any internal hostnames.

### Base images — prefer registry mirrors in labs

Docker Hub is often blocked in lab environments. Use a mirror as the default, overridable via `.env`:

```dockerfile
ARG PYTHON_IMAGE=public.ecr.aws/docker/library/python:3.11-slim
FROM ${PYTHON_IMAGE}
```

```yaml
# docker-compose.yml
build:
  args:
    PYTHON_IMAGE: ${PYTHON_IMAGE:-public.ecr.aws/docker/library/python:3.11-slim}
```

AWS Public ECR (`public.ecr.aws/docker/library/`) mirrors the Docker Official Images library — no auth required and usually reachable when Docker Hub is blocked.

### pip-cache pattern (Python) — offline wheel install

Pre-download wheels into `pip-cache/`; Dockerfile installs offline, falls back to PyPI only when cache is empty:

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

**Populate the cache with `uname -m` arch detection** — Mac Apple Silicon is `arm64`, lab Linux is `x86_64`. One run, correct wheels, no duplication:

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

**pip-cache discipline:**
- Commit `pip-cache/` — lab machines with no internet need it for `make build`.
- Re-run after every `requirements.txt` change — stale cache → offline build failure.
- `--only-binary=:all:` is intentional — source distributions require a compiler; wheels do not.
- Do not explicitly declare transitive dependencies — they may lack a binary wheel, breaking `--only-binary=:all:`.
- Do not hardcode `platform: linux/amd64` in `docker-compose.yml` — the `uname -m` detection above handles arch; hardcoding forces emulation on Apple Silicon.

If using an internal PyPI mirror instead:

```bash
pip config set global.index-url "https://<your-mirror>/simple"
pip config set global.trusted-host "<your-mirror-host>"
```

---

## Makefile template

`help` is the first target — `make` alone prints the cheat sheet. Unprefixed targets are dev; prod is always explicit.

```makefile
# Quick-reference comment block at the top (visible in editors, not in make help output):
#   make build && make up     — pick up Dockerfile / dependency changes (required after backend edits)
#   make rebuild              — full --no-cache rebuild + up (after git pull if containers act stale)
#   make rebuild-api          — API image only (faster when only backend/ changed)
.PHONY: help up down build rebuild rebuild-api logs logs-api logs-split restart ps \
        prod-up prod-down prod-logs prod-logs-api pip-cache clean

help:
	@echo "Dev (default):"
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
	@echo "  make pip-cache          Re-download wheels for offline builds (run after requirements.txt changes)"
	@echo "  make clean              Remove old containers/volumes; prune images"

# ── Dev ──────────────────────────────────────────────────────────────────────

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

# ── Prod ─────────────────────────────────────────────────────────────────────

prod-up: build-frontend
	docker compose --profile dev down --remove-orphans
	docker compose --profile prod up -d --build

prod-down:
	docker compose --profile prod down --remove-orphans

prod-logs:
	docker compose --profile prod logs -f

prod-logs-api:
	docker compose --profile prod logs -f api-prod

# ── Maintenance ───────────────────────────────────────────────────────────────

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

## Day-2 gotchas checklist

- **Changes not picked up** → rebuild images (`make build && make up`), not just `make restart`. `restart` skips the build step.
- **Containers act stale after `git pull`** → `make rebuild` (full `--no-cache`); avoids Docker layer cache serving old code.
- **Only backend changed** → `make rebuild-api` is faster than rebuilding everything.
- **Browser hits CORS** → ensure browser talks to FE dev server only; FE proxies to API over the internal Docker network.
- **Offline build fails** → `pip-cache/` is stale or missing; re-run `make pip-cache` on the correct host.
- **Wrong arch wheels** → `pip-cache` was built on a different machine type (e.g. pushed from Linux, pulled on Mac); re-run `make pip-cache` locally.
- **Docker Hub blocked** → set `PYTHON_IMAGE` / `NODE_IMAGE` in `.env` to use the AWS Public ECR mirror.
- **Calling host-only services** (e.g. GPU inference server) → use `host.docker.internal` + `extra_hosts: ["host.docker.internal:host-gateway"]` in the service.
- **Port collision across projects** → allocate a different `BASE_PORT` per project.
- **Dev + prod collide** → check container names don't overlap; consider `COMPOSE_PROJECT_NAME`.

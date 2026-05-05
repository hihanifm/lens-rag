# Docker Lab Guide (Agent Reference)

Generic reference for building a predictable Docker Compose setup for a typical web app (frontend + backend API + database) in lab environments with proxies or restricted egress.

---

## Non-negotiable rules

- **Always split dev and prod** — dev server + API on separate ports; prod on a single origin.
- **Browser talks to the frontend dev server only** — frontend proxies API calls internally (avoids CORS).
- **Model dev vs prod with Compose profiles** (or separate compose files).
- **Always pass proxy vars into Docker builds** — `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`.
- **Never rely on `restart` to pick up code changes** — if code is baked into the image, rebuild.
- **Do not hardcode `platform:` in `docker-compose.yml`** — let Docker build natively for the host arch.

---

## Port convention (dev + prod can run simultaneously)

Pick a `BASE_PORT` per project:

| Purpose  | Port          |
|----------|---------------|
| prod     | `BASE_PORT`   |
| dev UI   | `BASE_PORT+1` |
| dev API  | `BASE_PORT+2` |

Example: `BASE_PORT=37000` → prod `37000`, dev UI `37001`, dev API `37002`.

- Keep DB ports **unpublished** (best) or pick a separate range.
- Different projects on the same machine → different `BASE_PORT`.
- When running dev + prod together: container names must not collide; optionally set `COMPOSE_PROJECT_NAME`.

---

## Compose structure

```yaml
services:
  # dev profile: db + api + frontend dev server
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

  # prod profile: db + api-prod (serves static frontend)
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

## Daily commands

### Start / stop dev stack

```bash
docker compose --profile dev up -d
docker compose --profile dev down --remove-orphans
```

Verify (non-interactive):

```bash
docker compose --profile dev ps
docker compose --profile dev logs --no-color --tail=200
```

### Rebuild after backend/containerized code changes

```bash
docker compose --profile dev build
docker compose --profile dev up -d
```

### Logs

```bash
docker compose --profile dev logs -f              # all services
docker compose --profile dev logs -f <service>    # focused (preferred for agents)
```

With tmux (optional, nice for humans):

```bash
tmux new-session -d -s app-logs "docker compose --profile dev logs -f api" \; \
  split-window -h "docker compose --profile dev logs -f frontend" \; \
  split-window -v "docker compose --profile dev logs -f db" \; \
  select-pane -t 0 \; \
  attach -t app-logs
```

---

## Day-2 gotchas checklist

- **Changes not picked up** → rebuild images (`build` + `up`), not just `restart`.
- **Browser hits CORS** → ensure browser talks to FE dev server only; FE proxies to API.
- **Offline build fails** → verify `pip-cache/` is populated and matches current `requirements.txt`; re-run `make pip-cache`.
- **Wrong arch wheels** → `pip-cache` was built on a different machine type; re-run `make pip-cache` on the correct host.
- **Calling host-only services** (e.g. GPU inference) → use `host.docker.internal` + `extra_hosts: ["host.docker.internal:host-gateway"]`.
- **Port collision across projects** → allocate a different `BASE_PORT` per project.

---

## Makefile template

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

prod-up: build-frontend
	docker compose --profile dev down --remove-orphans
	docker compose --profile prod up -d --build

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

# Dev stack (compose profile "dev"):
#   make build && make up        — pick up Dockerfile / dependency changes (required after backend edits)
#   make rebuild                 — full --no-cache rebuild + up (after git pull if API/UI acts stale, e.g. 405s)
#   make rebuild-api             — API image only (faster when only backend/ changed)
#   make e2e-up                  — up with build (CI / fresh checkout)
# Base images default to AWS Public ECR mirrors (see .env.example: PYTHON_IMAGE / NODE_IMAGE). Daemon proxy may still be required for pulls.
.PHONY: help up down build rebuild rebuild-api rebuild-frontend logs logs-api logs-frontend logs-db logs-split prod-logs prod-logs-api prod-logs-db prod-logs-split restart prod-restart ps dev-up prod-up prod-down build-frontend e2e-up e2e e2e-down pip-cache clean

help:
	@echo "LENS — common Make targets"
	@echo ""
	@echo "  make build && make up     Build dev images, start stack (Postgres + API + Vite)"
	@echo "  make rebuild              Build dev images with --no-cache, then up (lab: after git pull)"
	@echo "  make rebuild-api          Same, API service only (faster)"
	@echo "  make rebuild-frontend     Same, frontend service only"
	@echo "  make restart              down then up (no rebuild — does not pick up code changes)"
	@echo "  make logs-api             Follow API container logs"
	@echo "  make ps                   docker compose ps"
	@echo "  make pip-cache            Download wheels into pip-cache/ (offline-friendly make build)"
	@echo ""

up:
	docker compose --profile dev up -d

down:
	docker compose down

build:
	docker compose --profile dev build

rebuild:
	docker compose --profile dev build --no-cache
	docker compose --profile dev up -d

rebuild-api:
	docker compose --profile dev build --no-cache lens-rag-api
	docker compose --profile dev up -d lens-rag-api

rebuild-frontend:
	docker compose --profile dev build --no-cache lens-rag-frontend
	docker compose --profile dev up -d lens-rag-frontend

logs:
	docker compose --profile dev logs -f

# Focused logs (dev)
logs-api:
	docker compose --profile dev logs -f lens-rag-api

logs-frontend:
	docker compose --profile dev logs -f lens-rag-frontend

logs-db:
	docker compose --profile dev logs -f lens-rag-postgres

# Split logs into 3 tmux panes (API / frontend / postgres).
# Requires tmux installed.
logs-split:
	tmux new-session -d -s lens-logs "docker compose --profile dev logs -f lens-rag-api" \; \
	  split-window -h "docker compose --profile dev logs -f lens-rag-frontend" \; \
	  split-window -v "docker compose --profile dev logs -f lens-rag-postgres" \; \
	  select-pane -t 0 \; \
	  attach -t lens-logs

restart:
	docker compose --profile dev down && docker compose --profile dev up -d

prod-restart:
	docker compose --profile prod down && docker compose --profile prod up -d

ps:
	docker compose ps

prod-up: build-frontend
	docker compose --profile dev down --remove-orphans
	docker compose --profile prod up -d --build

dev-up:
	docker compose --profile prod down --remove-orphans
	docker compose --profile dev up -d

prod-down:
	docker compose --profile prod down

# Split prod logs into 2 tmux panes (API / postgres).
prod-logs-split:
	tmux new-session -d -s lens-prod-logs "docker compose --profile prod logs -f lens-rag-api-prod" \; \
	  split-window -h "docker compose --profile prod logs -f lens-rag-postgres-prod" \; \
	  select-pane -t 0 \; \
	  attach -t lens-prod-logs

prod-logs:
	docker compose --profile prod logs -f

# Focused logs (prod)
prod-logs-api:
	docker compose --profile prod logs -f lens-rag-api-prod

prod-logs-db:
	docker compose --profile prod logs -f lens-rag-postgres-prod

# Build frontend for production under /lens-rag sub-path.
# Output goes to frontend/dist/ — copy or mount into the FastAPI container.
build-frontend:
	cd frontend && npm install && VITE_BASE_PATH=${ROOT_PATH:-/} npm run build

e2e-up:
	docker compose --profile dev up -d --build

e2e:
	cd frontend && npx playwright install chromium && npm run e2e

e2e-down:
	docker compose --profile dev down --remove-orphans

# Remove old lens-* containers/volumes (pre-rename leftovers) + prune networks and images.
# Does NOT touch lens-rag-* volumes — your data is safe.
clean:
	@echo "Stopping all lens-rag containers..."
	docker compose --profile dev down --remove-orphans 2>/dev/null || true
	docker compose --profile prod down --remove-orphans 2>/dev/null || true
	@echo "Removing old lens-* containers (pre-rename)..."
	docker rm -f lens-postgres lens-api lens-frontend lens-api-prod 2>/dev/null || true
	@echo "Removing old lens-* volumes (pre-rename)..."
	docker volume rm lens-postgres-data lens-uploads 2>/dev/null || true
	@echo "Pruning unused networks..."
	docker network prune -f
	@echo "Pruning unused images..."
	docker image prune -a -f
	@echo "Done. lens-rag-postgres-data and lens-rag-uploads are untouched."

# Downloads Linux wheels for both amd64 (lab) and arm64 (Mac) into pip-cache/.
# Run once after changing requirements.txt, from any machine with internet access.
pip-cache:
	pip download \
	  --platform manylinux_2_17_x86_64 \
	  --platform manylinux2014_x86_64 \
	  --platform linux_x86_64 \
	  --python-version 3.11 \
	  --implementation cp \
	  --abi cp311 \
	  --only-binary=:all: \
	  -r backend/requirements.txt \
	  -d pip-cache/
	pip download \
	  --platform manylinux_2_17_aarch64 \
	  --platform linux_aarch64 \
	  --python-version 3.11 \
	  --implementation cp \
	  --abi cp311 \
	  --only-binary=:all: \
	  -r backend/requirements.txt \
	  -d pip-cache/

.PHONY: up down build logs logs-split prod-logs-split restart prod-restart ps dev-up prod-up prod-down prod-logs build-frontend e2e-up e2e e2e-down pip-cache clean

up:
	docker compose --profile dev up -d

down:
	docker compose down

build:
	docker compose --profile dev build

logs:
	docker compose logs -f

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

# Run this once on the Linux server (where pip works) before make build.
# Downloads Linux/Python 3.11 compatible wheels so Docker installs offline.
pip-cache:
	pip download \
	  --platform manylinux2014_x86_64 \
	  --platform manylinux_2_17_x86_64 \
	  --platform linux_x86_64 \
	  --python-version 3.11 \
	  --implementation cp \
	  --abi cp311 \
	  --only-binary=:all: \
	  -r backend/requirements.txt \
	  -d pip-cache/

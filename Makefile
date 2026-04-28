.PHONY: up down build logs restart ps dev-up prod-up prod-down prod-logs build-frontend e2e-up e2e e2e-down pip-cache

up:
	docker compose --profile dev up -d

down:
	docker compose down

build:
	docker compose --profile dev build

logs:
	docker compose logs -f

restart:
	docker compose --profile dev down && docker compose --profile dev up -d

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

prod-logs:
	docker compose --profile prod logs -f

# Build frontend for production under /lens-rag sub-path.
# Output goes to frontend/dist/ — copy or mount into the FastAPI container.
build-frontend:
	cd frontend && VITE_BASE_PATH=/lens-rag/ npm run build

e2e-up:
	docker compose --profile dev up -d --build

e2e:
	cd frontend && npm run e2e

e2e-down:
	docker compose --profile dev down --remove-orphans

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

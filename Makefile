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
	docker compose --profile prod up -d --build

prod-down:
	docker compose --profile prod down

prod-logs:
	docker compose --profile prod logs -f

# Build frontend for production under /lens-rag sub-path.
# Output goes to frontend/dist/ — copy or mount into the FastAPI container.
build-frontend:
	cd frontend && VITE_BASE_PATH=/lens-rag/ npm run build

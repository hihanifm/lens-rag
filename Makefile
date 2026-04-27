up:
	docker compose up -d

down:
	docker compose down

build:
	docker compose build

logs:
	docker compose logs -f

restart:
	docker compose down && docker compose up -d

ps:
	docker compose ps

# Build frontend for production under /lens-rag sub-path.
# Output goes to frontend/dist/ — copy or mount into the FastAPI container.
build-frontend:
	cd frontend && VITE_BASE_PATH=/lens-rag/ npm run build

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In Docker dev: VITE_API_PROXY_TARGET=http://lens-rag-api:8000 (set in docker-compose.yml)
// Local dev (no Docker): falls back to http://localhost:37000
const API_PROXY_TARGET = process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:37000'

export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? '/',
  plugins: [react()],
  server: {
    host: true,
    port: 37001,
    strictPort: true,
    proxy: {
      '/projects': API_PROXY_TARGET,
      '/health':   API_PROXY_TARGET,
    }
  }
})

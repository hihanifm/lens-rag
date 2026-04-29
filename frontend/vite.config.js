import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In Docker dev: VITE_API_PROXY_TARGET=http://lens-rag-api:8000 (set in docker-compose.yml)
// Local dev (no Docker): falls back to http://localhost:37002
const API_PROXY_TARGET = process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:37002'

export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? '/',
  plugins: [react()],
  server: {
    host: true,
    port: 37001,
    strictPort: true,
    proxy: {
      // Proxy *all* API calls to the backend so adding new endpoints never
      // requires updating this file. We only bypass HTML navigations (SPA) and
      // Vite internal/module requests.
      '/': {
        target: API_PROXY_TARGET,
        bypass: (req) => {
          const url = req.url || ''

          // SPA navigation: serve index.html from Vite
          if (req.headers.accept?.includes('text/html')) return '/index.html'

          // Vite internals / module graph / assets should NOT be proxied
          if (
            url.startsWith('/@') ||
            url.startsWith('/src/') ||
            url.startsWith('/node_modules/') ||
            url.startsWith('/assets/') ||
            url === '/favicon.ico'
          ) return url
        },
      },
    }
  }
})

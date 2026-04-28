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
      '/projects': {
        target: API_PROXY_TARGET,
        // Browser page navigations send Accept: text/html — skip the proxy and
        // let Vite serve index.html so React Router handles the route.
        // Axios API calls send Accept: application/json and go straight through.
        bypass: (req) => {
          if (req.headers.accept?.includes('text/html')) return '/index.html'
        },
      },
      '/system-config': { target: API_PROXY_TARGET },
      '/models': { target: API_PROXY_TARGET },
      '/health':  { target: API_PROXY_TARGET },
      '/samples': { target: API_PROXY_TARGET },
    }
  }
})

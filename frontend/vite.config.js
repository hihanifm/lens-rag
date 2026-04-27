import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Set VITE_BASE_PATH=/lens-rag/ for production builds served under a sub-path.
  // Leave unset (or '/') for dev — dev always runs at localhost root.
  base: process.env.VITE_BASE_PATH ?? '/',
  plugins: [react()],
  server: {
    host: true,
    port: 37001,
    strictPort: true,
  }
})

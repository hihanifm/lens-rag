import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 37001,
    proxy: {
      '/api': 'http://localhost:37000'
    }
  }
})

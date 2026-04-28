import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  // Create+ingest flows can exceed 2 minutes on slower hosts (Ollama + 100 rows).
  timeout: 6 * 60 * 1000,
  expect: { timeout: 15_000 },
  retries: 0,
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:37001',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    acceptDownloads: true,
  },
  reporter: [['list']],
})


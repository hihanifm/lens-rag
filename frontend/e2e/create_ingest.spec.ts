import { test, expect } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function sampleXlsxPath() {
  // frontend/e2e -> repo root -> backend/samples/...
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  return path.resolve(__dirname, '../../backend/samples/product_catalog.xlsx')
}

test('create project + ingest completes', async ({ page }) => {
  test.skip(true, 'Covered by major_flows.spec.ts (create+ingest+search+export).')
  await page.goto('/')
  await page.getByTestId('new-project').click()

  // Step 0: Name
  await page.getByTestId('project-name').fill(`E2E Product Catalog ${Date.now()}`)
  await page.getByTestId('continue').click()

  // Step 1: Upload
  await page.getByTestId('file-input').setInputFiles(sampleXlsxPath())
  await page.getByTestId('upload-continue').click()

  // Step 2: Content column
  await page.getByRole('button', { name: 'Description' }).click()
  await page.getByTestId('content-continue').click()

  // Step 3: Context columns
  await page.getByRole('button', { name: /Category/ }).click()
  await page.getByRole('button', { name: /Name/ }).click()
  await page.getByTestId('context-continue').click()

  // Step 4: ID column
  await page.getByRole('button', { name: 'Product ID' }).click()
  await page.getByTestId('id-continue').click()

  // Step 5: Display columns
  // Pre-filled from context/id/content; just continue.
  await page.getByTestId('display-continue').click()

  // Step 6: Settings -> Create -> ingestion screen
  await page.getByTestId('create-project').click()

  // Ingestion can take a bit; wait for complete marker, then redirect to search.
  await expect(page.getByTestId('ingest-complete')).toBeVisible({ timeout: 120_000 })
  await expect(page).toHaveURL(/\/projects\/\d+\/search/, { timeout: 60_000 })
})


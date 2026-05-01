import { test, expect } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { skipUnlessOllamaEmbedding } from './skipUnlessOllama'

function sampleXlsxPath() {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  return path.resolve(__dirname, '../../backend/samples/product_catalog.xlsx')
}

test.describe.serial('compare flow', () => {
  test('create compare job + run comparison + tabs render', async ({ page, request }) => {
    await skipUnlessOllamaEmbedding(request, test)

    await page.goto('/compare/new')

    // Step 1: Names
    await page.getByLabel('Job name').fill(`E2E Compare ${Date.now()}`)
    await page.getByLabel('Left file label').fill('Baseline')
    await page.getByLabel('Right file label').fill('Candidate')
    await page.getByRole('button', { name: /Continue →/ }).click()

    // Step 2: Upload left
    await page.locator('input[type="file"][accept=".xlsx,.xls"]').setInputFiles(sampleXlsxPath())
    await page.getByRole('button', { name: /Continue →/ }).click()

    // Step 3: Columns left (match columns + identifier)
    await page.getByRole('checkbox', { name: 'Description' }).check()
    await page.getByRole('checkbox', { name: 'Category' }).check()
    await page.getByRole('checkbox', { name: 'Specs' }).check()
    await page.getByLabel(/Identifier column/).selectOption({ label: 'Product ID' })
    await page.getByRole('button', { name: /Continue →/ }).click()

    // Step 4: Upload right
    await page.locator('input[type="file"][accept=".xlsx,.xls"]').setInputFiles(sampleXlsxPath())
    await page.getByRole('button', { name: /Continue →/ }).click()

    // Step 5: Columns right
    await page.getByRole('checkbox', { name: 'Description' }).check()
    await page.getByRole('checkbox', { name: 'Category' }).check()
    await page.getByRole('checkbox', { name: 'Specs' }).check()
    await page.getByLabel(/Identifier column/).selectOption({ label: 'Product ID' })
    await page.getByRole('button', { name: /Continue →/ }).click()

    // Step 6: Review & create
    await page.getByRole('button', { name: /Create & Start Comparison/ }).click()

    // Ingestion + compare run (SSE). Wait for redirect to job page.
    await expect(page).toHaveURL(/\/compare\/\d+/, { timeout: 300_000 })

    // Open the pending run and start pipeline (UX requires explicit start).
    await page.locator('div.cursor-pointer.rounded-xl').first().click({ timeout: 120_000 })
    await page.getByRole('button', { name: 'Run pipeline' }).click()

    // Run detail: Review tab appears after pipeline completes (Ollama may be slow).
    await expect(page.getByRole('button', { name: /Review/ })).toBeVisible({ timeout: 300_000 })
    await expect(page.getByRole('button', { name: /Browse/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /Config/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /Export/ })).toBeVisible()

    // Browse shows raw records table headers
    await page.getByRole('button', { name: /Browse/ }).click()
    await expect(page.getByText(/Browse raw compare records/)).toBeVisible()
    await expect(page.getByRole('columnheader', { name: 'contextual_content' })).toBeVisible({ timeout: 30_000 })

    // Config shows stats section
    await page.getByRole('button', { name: /Config/ }).click()
    await expect(page.getByRole('heading', { name: 'Config' })).toBeVisible()
    await expect(page.getByText(/Cost \/ volume/)).toBeVisible()
  })
})


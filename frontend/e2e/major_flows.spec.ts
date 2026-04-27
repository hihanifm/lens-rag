import { test, expect } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function sampleXlsxPath() {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  return path.resolve(__dirname, '../../backend/samples/product_catalog.xlsx')
}

test.describe.serial('major flows', () => {
  test('create + ingest + search + export', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('new-project').click()

    // Step 0: Name
    await page.getByTestId('project-name').fill(`E2E Product Catalog ${Date.now()}`)
    await page.getByTestId('continue').click()

    // Step 1: Upload sample
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
    await page.getByTestId('display-continue').click()

    // Step 6: Create + ingest
    await page.getByTestId('create-project').click()
    await expect(page.getByTestId('ingest-complete')).toBeVisible({ timeout: 120_000 })
    await expect(page).toHaveURL(/\/projects\/\d+\/search/, { timeout: 60_000 })

    // Search
    await page.getByTestId('search-query').fill('laptop')
    await page.getByTestId('search-submit').click()
    await expect(page.getByTestId('results-table')).toBeVisible({ timeout: 60_000 })

    // Export
    const downloadPromise = page.waitForEvent('download', { timeout: 60_000 })
    await page.getByTestId('export-excel').click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(/\.xlsx$/)
  })
})


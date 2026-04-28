import { test, expect } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function sampleXlsxPath() {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  return path.resolve(__dirname, '../../backend/samples/product_catalog.xlsx')
}

test.describe.serial('project PIN', () => {
  test('PIN gate blocks until unlocked, then search works', async ({ page }) => {
    const pin = '1234'

    await page.goto('/')
    await page.getByTestId('new-project').click()

    // Step 0: Name
    await page.getByTestId('project-name').fill(`E2E Pinned Project ${Date.now()}`)
    await page.getByTestId('continue').click()

    // Step 1: Upload sample
    await page.getByTestId('file-input').setInputFiles(sampleXlsxPath())
    await page.getByTestId('upload-continue').click()

    // Step 2: Store columns (default: all selected)
    await page.getByTestId('store-continue').click()

    // Step 3: Context columns
    await page.getByRole('button', { name: /Category/ }).click()
    await page.getByRole('button', { name: /Name/ }).click()
    await page.getByRole('button', { name: /Description/ }).click()
    await page.getByTestId('context-continue').click()

    // Step 4: ID column
    await page.getByRole('button', { name: 'Product ID' }).click()
    await page.getByTestId('id-continue').click()

    // Step 5: Results columns
    await page.getByTestId('display-continue').click()

    // Step 6: Settings -> set PIN -> Create + ingest
    await page.getByPlaceholder('Leave blank for open access').fill(pin)
    await page.getByTestId('create-project').click()

    await expect(page.getByTestId('ingest-complete')).toBeVisible({ timeout: 120_000 })
    await expect(page).toHaveURL(/\/projects\/\d+\/search/, { timeout: 60_000 })

    // Should land on Search page but gated
    await expect(page.getByText('This project is PIN protected')).toBeVisible()

    // Wrong PIN shows error
    await page.getByPlaceholder('PIN').fill('0000')
    await page.getByRole('button', { name: 'Unlock' }).click()
    await expect(page.getByText('Incorrect PIN.')).toBeVisible()

    // Correct PIN unlocks and Search UI appears
    await page.getByPlaceholder('PIN').fill(pin)
    await page.getByRole('button', { name: 'Unlock' }).click()
    await expect(page.getByTestId('search-query')).toBeVisible({ timeout: 30_000 })

    // Search should work now
    await page.getByTestId('search-query').fill('laptop')
    await page.getByTestId('search-submit').click()
    await expect(page.getByTestId('results-table')).toBeVisible({ timeout: 60_000 })
  })
})


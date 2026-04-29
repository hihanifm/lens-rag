import { test, expect } from '@playwright/test'

test('search returns results and export download works', async ({ page }) => {
  test.skip(true, 'Redundant: covered by major_flows.spec.ts (create+ingest+search+export). Keep skipped to avoid duplicate runtime.')

  await page.getByTestId('search-query').fill('laptop')
  await page.getByTestId('search-submit').click()

  await expect(page.getByTestId('results-table')).toBeVisible({ timeout: 60_000 })

  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 })
  await page.getByTestId('export-excel').click()
  const download = await downloadPromise

  const filename = download.suggestedFilename()
  expect(filename).toMatch(/\.xlsx$/)
})


import { test, expect } from '@playwright/test'

test('search returns results and export download works', async ({ page }) => {
  await page.goto('/')

  // Prefer an existing ready project if present (common in dev), otherwise fall back to creating one.
  const firstReadyProject = page.locator('a[href^="/projects/"][href$="/search"]').first()
  if (await firstReadyProject.count()) {
    await firstReadyProject.click()
  } else {
    // If none exist, guide user to create first (covered by create_ingest.spec.ts).
    test.skip(true, 'No ready projects found; create_ingest.spec.ts should create one.')
  }

  await page.getByTestId('search-query').fill('laptop')
  await page.getByTestId('search-submit').click()

  await expect(page.getByTestId('results-table')).toBeVisible({ timeout: 60_000 })

  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 })
  await page.getByTestId('export-excel').click()
  const download = await downloadPromise

  const filename = download.suggestedFilename()
  expect(filename).toMatch(/\.xlsx$/)
})


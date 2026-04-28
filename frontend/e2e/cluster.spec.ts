import { test, expect } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function sampleXlsxPath() {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  return path.resolve(__dirname, '../../backend/samples/product_catalog.xlsx')
}

test.describe.serial('cluster tab', () => {
  test('k-means cluster, scatter view, filter, and export', async ({ page }) => {
    // ── Create + ingest project ──────────────────────────────────────────
    await page.goto('/')
    await page.getByTestId('new-project').click()

    await page.getByTestId('project-name').fill(`E2E Cluster ${Date.now()}`)
    await page.getByTestId('continue').click()

    await page.getByTestId('file-input').setInputFiles(sampleXlsxPath())
    await page.getByTestId('upload-continue').click()

    // Store columns (default: all selected)
    await page.getByTestId('store-continue').click()

    // Context columns
    await page.getByRole('button', { name: /Category/ }).click()
    await page.getByRole('button', { name: /Name/ }).click()
    await page.getByRole('button', { name: /Description/ }).click()
    await page.getByTestId('context-continue').click()

    // ID column
    await page.getByRole('button', { name: 'Product ID' }).click()
    await page.getByTestId('id-continue').click()

    // Display columns (pre-filled)
    await page.getByTestId('display-continue').click()

    // Create + wait for ingestion
    await page.getByTestId('create-project').click()
    await expect(page.getByTestId('ingest-complete')).toBeVisible({ timeout: 120_000 })
    await expect(page).toHaveURL(/\/projects\/\d+\/search/, { timeout: 60_000 })

    // ── Navigate to Cluster tab ──────────────────────────────────────────
    await page.getByRole('link', { name: 'Cluster' }).click()
    await expect(page).toHaveURL(/\/projects\/\d+\/cluster/)

    // K-Means is the default; K input should be visible
    await expect(page.getByRole('spinbutton')).toBeVisible()

    // ── Run K-Means with K=4 ────────────────────────────────────────────
    await page.getByRole('spinbutton').fill('4')
    await page.getByTestId('cluster-run').click()

    // Results panel appears
    await expect(page.getByTestId('cluster-results')).toBeVisible({ timeout: 60_000 })

    // Exactly 4 cluster group headers rendered
    await expect(page.getByTestId('cluster-group')).toHaveCount(4)

    // ── Switch to Scatter view ───────────────────────────────────────────
    await page.getByTestId('cluster-view-scatter').click()
    await expect(page.getByTestId('cluster-scatter')).toBeVisible()

    // SVG circles (data points) should be present
    const circles = page.locator('[data-testid="cluster-scatter"] circle')
    await expect(circles.first()).toBeVisible()
    const count = await circles.count()
    expect(count).toBeGreaterThan(0)

    // ── Column filter ────────────────────────────────────────────────────
    // Select the Category column — expect a value dropdown to appear
    await page.getByTestId('cluster-filter-column').selectOption('Category')
    // Wait for the value dropdown to populate
    const valueSelect = page.locator('select').nth(1)
    await expect(valueSelect).toBeVisible({ timeout: 10_000 })

    // Pick the first non-empty option (any category)
    const options = await valueSelect.locator('option').all()
    const firstValue = await options[1]?.textContent() // index 0 = "All values"
    if (firstValue) {
      await valueSelect.selectOption(firstValue.trim())
    }

    // Run clustering again with filter applied
    await page.getByTestId('cluster-run').click()
    await expect(page.getByTestId('cluster-results')).toBeVisible({ timeout: 60_000 })

    // Filtered record count should be less than the full 100 records
    const statsText = await page.getByTestId('cluster-results').textContent()
    const match = statsText?.match(/(\d+)\s+records/)
    if (match) {
      const recordCount = parseInt(match[1], 10)
      expect(recordCount).toBeLessThan(100)
    }

    // ── Export ───────────────────────────────────────────────────────────
    const downloadPromise = page.waitForEvent('download', { timeout: 60_000 })
    await page.getByTestId('cluster-export').click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(/lens_clusters.*\.xlsx$/)
  })

  test('dbscan produces clusters or warns on degenerate result', async ({ page }) => {
    // Pick the first ready project from the home page rather than re-creating one
    await page.goto('/')
    const projectLink = page.locator('[data-testid="project-card"]').first()
    await expect(projectLink).toBeVisible({ timeout: 10_000 })
    const href = await projectLink.getAttribute('href')
    const projectId = href?.match(/\/projects\/(\d+)/)?.[1]
    if (!projectId) {
      test.skip(true, 'No ready project found on home page')
      return
    }

    await page.goto(`/projects/${projectId}/cluster`)
    await expect(page).toHaveURL(/\/projects\/\d+\/cluster/)

    // Switch to DBSCAN
    await page.getByRole('button', { name: 'DBSCAN (auto)' }).click()
    // K input should no longer be visible
    await expect(page.getByRole('spinbutton')).not.toBeVisible()

    // Run
    await page.getByTestId('cluster-run').click()
    await expect(page.getByTestId('cluster-results')).toBeVisible({ timeout: 60_000 })

    // Either we get cluster groups, or a degenerate warning banner is shown
    const hasGroups = await page.getByTestId('cluster-group').count()
    const hasWarning = await page.getByText(/DBSCAN found no clusters|DBSCAN produced/).isVisible().catch(() => false)
    expect(hasGroups > 0 || hasWarning).toBe(true)
  })
})

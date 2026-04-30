import { test, expect } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function sampleXlsxPath() {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  return path.resolve(__dirname, '../../backend/samples/product_catalog.xlsx')
}

test.describe.serial('evaluate export', () => {
  test('exported RAGAS JSON includes embedding config metadata', async ({ page }) => {
    // ── Create + ingest project ──────────────────────────────────────────
    await page.goto('/')
    await page.getByTestId('new-project').click()

    await page.getByTestId('project-name').fill(`E2E Eval Export ${Date.now()}`)
    await page.getByTestId('continue').click()

    await page.getByTestId('file-input').setInputFiles(sampleXlsxPath())
    await page.getByTestId('upload-continue').click()

    await page.getByTestId('store-continue').click()

    await page.getByRole('button', { name: /Category/ }).click()
    await page.getByRole('button', { name: /Name/ }).click()
    await page.getByRole('button', { name: /Description/ }).click()
    await page.getByTestId('context-continue').click()

    await page.getByRole('button', { name: 'Product ID' }).click()
    await page.getByTestId('id-continue').click()

    await page.getByTestId('display-continue').click()

    // Connection step (force Ollama embed for e2e reliability)
    await page.getByTestId('embed-url').fill('http://host.docker.internal:11434/v1')
    await page.getByTestId('embed-model-input').fill('qwen3-embedding:0.6b')
    await page.getByTestId('connection-continue').click()
  await page.getByTestId('rerank-continue').click()

    await page.getByTestId('create-project').click()
    await expect(page.getByTestId('ingest-complete')).toBeVisible({ timeout: 300_000 })
    await expect(page).toHaveURL(/\/projects\/\d+\/search/, { timeout: 60_000 })

    // ── Evaluate ─────────────────────────────────────────────────────────
    await page.getByRole('link', { name: /Evaluate/ }).click()
    await expect(page).toHaveURL(/\/projects\/\d+\/evaluate/)

    // Upload a tiny 1-row test set to keep e2e fast and stable.
    const csv = 'question,ground_truth\n\"What is a laptop?\",\"A portable computer\"\n'
    await page.locator('#eval-file-input').setInputFiles({
      name: 'tiny_testset.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csv, 'utf-8'),
    })
    await expect(page.getByText(/1 question loaded/i)).toBeVisible({ timeout: 15_000 })

    // Make it faster / less flaky: k=5, vector-only, no rerank
    await page.getByRole('button', { name: '5', exact: true }).click()
    await page.getByLabel('BM25 (keyword)').uncheck()
    await page.getByLabel('Rerank').uncheck()

    await page.getByTestId('eval-run').click()

    // Ensure the new cancel control is present while running (prevents "stuck" UX regressions).
    await expect(page.getByTestId('eval-cancel')).toBeVisible({ timeout: 30_000 })

    // Wait for results to appear then export JSON
    await expect(page.getByRole('heading', { name: 'Results' })).toBeVisible({ timeout: 300_000 })

    const downloadPromise = page.waitForEvent('download', { timeout: 60_000 })
    await page.getByTestId('eval-export').click()
    const download = await downloadPromise

    // Validate payload contains embedding metadata
    const raw = await download.createReadStream()
    if (!raw) throw new Error('No download stream')
    const chunks: Buffer[] = []
    for await (const c of raw) chunks.push(Buffer.from(c))
    const text = Buffer.concat(chunks).toString('utf-8')
    const json = JSON.parse(text)

    expect(json).toHaveProperty('_lens.project.embedding')
    expect(json._lens.project.embedding).toHaveProperty('url')
    expect(json._lens.project.embedding).toHaveProperty('model')
    expect(json._lens.project.embedding).toHaveProperty('dims')
  })
})


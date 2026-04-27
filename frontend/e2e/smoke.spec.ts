import { test, expect } from '@playwright/test'

test('smoke: home loads and shows projects + bottom bar', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByRole('link', { name: 'LENS' }).first()).toBeVisible()
  await expect(page.getByTestId('new-project')).toBeVisible()

  // Bottom bar renders API status text (online/offline depends on timing; just ensure present)
  await expect(page.getByText(/API (online|offline)/)).toBeVisible()
})


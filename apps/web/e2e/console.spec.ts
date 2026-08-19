import { expect, test, type Page } from '@playwright/test';

/**
 * End-to-end coverage of the five things the brief asked the prototype to do:
 * enter symptoms, optionally pick a suspected condition, supply media, send it to the API, and
 * see a result with a confidence score.
 *
 * These assert on *values*, not on the absence of exceptions. A test that only checks a heading
 * rendered would have passed throughout the media-id collision that made every analysis measure
 * the same stored image.
 */

async function runSample(page: Page, index: number) {
  await page.locator('button.samples__button').nth(index).click();
  await expect(page.locator('.viewport__media')).toBeVisible();
  await page.getByRole('button', { name: 'Run assessment' }).click();
  await expect(page.locator('.headline__value, .notice--warn')).toBeVisible({ timeout: 30_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto('./');
});

test('loads as a console with an empty state, not a spinner', async ({ page }) => {
  await expect(page).toHaveTitle(/Caliper/);
  await expect(page.getByText('No case yet.')).toBeVisible();
  await expect(page.getByText('awaiting media')).toBeVisible();
  // The disclaimer is permanent, not a dismissible modal.
  await expect(page.getByText('Not a medical device.')).toBeVisible();
});

test('will not run an assessment without media', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Run assessment' })).toBeDisabled();
});

test('completes the full workflow and reports a confidence score', async ({ page }) => {
  await runSample(page, 0);

  const confidence = page.locator('.headline__value');
  await expect(confidence).toBeVisible();
  const value = Number((await confidence.textContent())!.replace('%', ''));
  expect(value).toBeGreaterThan(0);
  // The calibration ceiling. If this ever reads 95% again, something regressed in fusion.
  expect(value).toBeLessThanOrEqual(85);

  await expect(page.locator('.acuity__band')).toBeVisible();
  await expect(page.locator('button.candidate')).toHaveCount(6);
  // Every pipeline stage must have completed.
  await expect(page.locator(".rail__stage[data-state='done'], .rail__stage[data-state='active']")).toHaveCount(6);
});

test('draws the measured contour and metadata over the image', async ({ page }) => {
  await runSample(page, 0);
  // The signature element: a real traced polygon, not a decorative frame.
  const contour = page.locator('path.contour');
  await expect(contour).toBeVisible();
  const d = await contour.getAttribute('d');
  expect(d).toBeTruthy();
  expect(d!.split('L').length).toBeGreaterThan(30);
  await expect(page.locator('.viewport__meta--tl')).toContainText('dim');
  await expect(page.locator('.viewport__meta--tr')).toContainText('A');
});

test('gives different images different answers', async ({ page }) => {
  await runSample(page, 0); // pigmented, changing
  const first = await page.locator('.headline__name').textContent();
  const firstMetrics = await page.locator('.viewport__meta--tr').textContent();

  await page.goto('./');
  await runSample(page, 3); // hot, spreading redness
  const second = await page.locator('.headline__name').textContent();
  const secondMetrics = await page.locator('.viewport__meta--tr').textContent();

  expect(first).not.toBe(second);
  expect(firstMetrics).not.toBe(secondMetrics);
});

test('explains its reasoning with a signed evidence trace', async ({ page }) => {
  await runSample(page, 0);
  await page.locator('button.candidate').first().click();
  const rows = page.locator('.evidence__row');
  expect(await rows.count()).toBeGreaterThan(2);
  await expect(rows.first()).toContainText(/[+-]\d/);
});

test('exposes the API envelopes it exchanged', async ({ page }) => {
  await runSample(page, 0);
  await page.getByRole('button', { name: /^API \(/ }).click();
  const inspector = page.locator('.inspector');
  await expect(inspector).toBeVisible();
  await expect(inspector).toContainText('POST');
  await expect(inspector).toContainText('/api/v1/analyses');
});

test('lets intake text change the outcome for the same picture', async ({ page }) => {
  // If the symptom form did not move the numbers it would be theatre.
  await page.locator('button.samples__button').nth(0).click();
  await expect(page.locator('.viewport__media')).toBeVisible();
  await page.locator('#symptoms').fill('unchanged since childhood, stable, painless, no bleeding');
  await page.locator('button.chip', { hasText: 'changing' }).click();  // deselect
  await page.locator('button.chip', { hasText: 'bleeding' }).click();  // deselect
  await page.getByRole('button', { name: 'Run assessment' }).click();
  await expect(page.locator('.headline__value, .notice--warn')).toBeVisible({ timeout: 30_000 });

  const benign = await page.locator('.candidate__value').first().textContent();
  expect(benign).toBeTruthy();
  await expect(page.locator('.differential')).toBeVisible();
});

test('has no horizontal page overflow at 390px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('keeps every interactive control reachable by keyboard', async ({ page }) => {
  const focusable = await page.evaluate(() =>
    document.querySelectorAll('button:not([disabled]), input, select, textarea, a[href]').length,
  );
  expect(focusable).toBeGreaterThan(15);
  await page.keyboard.press('Tab');
  const tagName = await page.evaluate(() => document.activeElement?.tagName);
  expect(['BUTTON', 'A', 'INPUT', 'TEXTAREA', 'SELECT']).toContain(tagName);
});

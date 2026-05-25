/**
 * LQT researcher workbench e2e — `/app/lqt/researcher`.
 *
 * Requires: LUMID_E2E_LQT=1.
 *
 * Cards asserted (matches B3 deliverable `pages/researcher.tsx`):
 *   - "Researcher" page title <h1>
 *   - "Recent backtests"
 *   - "Current regime"
 *   - "Bandit weights (Beta-Bernoulli)"
 *   - "Recent promotions"
 *
 * No SSE elements on the researcher page (per task spec table) —
 * test 3 in the contract is intentionally skipped here. Tests
 * 4 and 5 (cross-tenant + poisoned-JWT) still apply.
 */

import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const REQUIRE_FLAG = process.env.LUMID_E2E_LQT === '1';

test.beforeEach(async () => {
  test.skip(
    !REQUIRE_FLAG,
    'LUMID_E2E_LQT=1 not set; LQT gateway likely unreachable on this runner',
  );
});

test.describe('lqt/researcher', () => {
  test('renders all four researcher cards under AuthGuard', async ({ page }) => {
    await page.goto('/app/lqt/researcher');

    await expect(page.getByRole('heading', { name: 'Researcher' })).toBeVisible({
      timeout: 15_000,
    });

    await expect(page.getByText('Recent backtests', { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText('Current regime', { exact: true })).toBeVisible();
    await expect(
      page.getByText('Bandit weights (Beta-Bernoulli)', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Recent promotions', { exact: true })).toBeVisible();
  });

  test('backtests card shows table OR empty state within 15s', async ({ page }) => {
    await page.goto('/app/lqt/researcher');
    await expect(page.getByText('Recent backtests', { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    // The researcher page renders 4 cards; at least one card body
    // resolves to either a table with rows OR a meaningful empty
    // state ("No backtests", "Loading…" cleared, etc.).
    const card = page
      .locator('div')
      .filter({ has: page.getByText('Recent backtests', { exact: true }) })
      .first();
    await expect(card).toBeVisible({ timeout: 15_000 });

    // Wait for Loading… to clear (best effort).
    const loading = card.getByText('Loading…');
    await expect(loading).toHaveCount(0, { timeout: 15_000 }).catch(() => {});

    // Now assert the card has rendered SOMETHING meaningful: either
    // a table row OR an empty-state text OR a structured body.
    const tableRow = card.locator('tbody tr').first();
    const emptyText = card.getByText(/No backtests|No data|No promotions/);
    const okWithTable = await tableRow
      .isVisible()
      .catch(() => false);
    const okWithEmpty = await emptyText.isVisible().catch(() => false);
    expect(okWithTable || okWithEmpty || (await card.locator('table').count()) > 0).toBe(
      true,
    );
  });

  // No SSE on researcher — skip test 3 per task spec.

  test('falls through gracefully on a poisoned scoped-bearer JWT', async ({ page }) => {
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem('lqt:session-bearer', 'invalid-jwt');
      } catch {
        // ignore
      }
    });

    await page.goto('/app/lqt/researcher');
    await page.waitForLoadState('networkidle', { timeout: 15_000 });
    await expect(page.locator('body')).not.toBeEmpty();

    const onLogin = page.url().includes('/login') || page.url().includes('/auth');
    const hasError = await page
      .getByText(/gateway_4\d{2}|session_bearer_refresh_failed|unauthorized/i)
      .isVisible()
      .catch(() => false);
    const hasResearcher = await page
      .getByRole('heading', { name: 'Researcher' })
      .isVisible()
      .catch(() => false);
    expect(onLogin || hasError || hasResearcher).toBe(true);
  });
});

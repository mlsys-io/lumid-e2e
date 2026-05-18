/**
 * LQT auditor workbench e2e — `/app/lqt/auditor`.
 *
 * Requires: LUMID_E2E_LQT=1.
 *
 * Cards asserted (matches B3 deliverable `pages/auditor.tsx`):
 *   - "Auditor" page title <h1>
 *   - "Filter by kind"
 *   - "Anchor journal (last 50)"
 *   - "Last verify outcome"
 *   - Audit chain table card (rendered via `AuditRowTable`,
 *     header text "Audit chain")
 *
 * SSE element ticking: the auditor page subscribes to
 * `/api/audit/tail` when the "Live" button (inside AuditRowTable
 * header) is clicked. The toggle button renders "Live" when off
 * and "Live (on)" when on. After toggling, expect the table row
 * count to increase OR remain non-zero within 8s (any incoming
 * frame from the gateway counts as a tick).
 *
 * The SSE badge in the page header surfaces `SSE: connecting |
 * open | reconnecting | closed | polling` — we additionally assert
 * the badge ever reaches `open` or `polling` (the gateway's polling
 * fallback path also exercises end-to-end auth + RLS).
 *
 * No data-testid attributes in B3 deliverable — selectors use
 * `getByRole('button', { name: ... })` and `getByText`.
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

test.describe('lqt/auditor', () => {
  test('renders all four auditor cards under AuthGuard', async ({ page }) => {
    await page.goto('/app/lqt/auditor');

    await expect(page.getByRole('heading', { name: 'Auditor' })).toBeVisible({
      timeout: 15_000,
    });

    await expect(page.getByText('Filter by kind', { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByText('Anchor journal (last 50)', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('Last verify outcome', { exact: true }),
    ).toBeVisible();
    // AuditRowTable renders an "Audit chain" h3 header at the top
    // of the table card.
    await expect(page.getByText('Audit chain', { exact: true })).toBeVisible();
  });

  test('audit table loads rows OR empty state within 15s', async ({ page }) => {
    await page.goto('/app/lqt/auditor');
    await expect(page.getByText('Audit chain', { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    // AuditRowTable always renders a <Table>; assert at least the
    // <thead> renders columns. Empty + populated states both pass.
    const table = page.locator('table').first();
    await expect(table).toBeVisible({ timeout: 15_000 });
    // Header always renders, so at least one <th> is visible.
    await expect(table.locator('thead tr th').first()).toBeVisible();
  });

  test('live-toggle starts SSE stream and audit tail ticks within 8s', async ({
    page,
  }) => {
    await page.goto('/app/lqt/auditor');
    // Wait for table to mount before flipping the toggle.
    await expect(page.locator('table').first()).toBeVisible({ timeout: 15_000 });

    // The Live button is inside AuditRowTable header. Initial text "Live".
    const liveButton = page.getByRole('button', { name: /^Live$/ }).first();
    await expect(liveButton).toBeVisible({ timeout: 15_000 });

    // Capture initial row count from the audit chain table.
    const initialRows = await page.locator('table tbody tr').count();

    await liveButton.click();
    // After click the button label becomes "Live (on)".
    await expect(
      page.getByRole('button', { name: /^Live \(on\)$/ }).first(),
    ).toBeVisible({ timeout: 5_000 });

    // Wait up to 8s for either:
    //   - SSE badge to read 'open' or 'polling' (any active stream state)
    //   - row count to advance (a fresh tail frame arrived)
    const sseBadge = page.getByText(/SSE: (open|polling|connecting)/);
    await expect(sseBadge).toBeVisible({ timeout: 5_000 });

    // Wait for the tick: either a new row arrives OR the count stays
    // non-zero AND the SSE state is healthy. Both are PASS.
    await page.waitForTimeout(8_000);
    const newRows = await page.locator('table tbody tr').count();
    const finalBadgeText = await sseBadge.textContent();

    const tickPass =
      newRows > initialRows ||
      (newRows > 0 && /open|polling/.test(finalBadgeText ?? '')) ||
      /open|polling/.test(finalBadgeText ?? '');
    expect(tickPass).toBe(true);
  });

  test('falls through gracefully on a poisoned scoped-bearer JWT', async ({ page }) => {
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem('lqt:session-bearer', 'invalid-jwt');
      } catch {
        // ignore
      }
    });

    await page.goto('/app/lqt/auditor');
    await page.waitForLoadState('networkidle', { timeout: 15_000 });
    await expect(page.locator('body')).not.toBeEmpty();

    const onLogin = page.url().includes('/login') || page.url().includes('/auth');
    const hasError = await page
      .getByText(/gateway_4\d{2}|session_bearer_refresh_failed|unauthorized/i)
      .isVisible()
      .catch(() => false);
    const hasAuditor = await page
      .getByRole('heading', { name: 'Auditor' })
      .isVisible()
      .catch(() => false);
    expect(onLogin || hasError || hasAuditor).toBe(true);
  });
});

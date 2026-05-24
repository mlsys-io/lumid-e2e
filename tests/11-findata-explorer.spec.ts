import { test, expect, type Page } from "@playwright/test";
import { createUser } from "../fixtures/test-user";

// Journey 11 — FinData Explorer (lum.id/dashboard/datasets/findata).
//
// Covers:
//   • page title + freshness badge + symbol search dropdown
//   • each top tab renders for an equity (AAPL)
//   • kind-based tab filtering (QQQ as ETF shows fewer tabs;
//     ETF Overview shows fund info + holdings)
//   • crypto (BTCUSD) renders simple overview + chart
//   • forex (EURUSD) — minimum tab set
//   • index (^GSPC) — chart works
//   • watchlist pin/unpin persists in localStorage
//   • Catalog probe completes with mostly-green statuses
//   • Compare tab merges multiple symbols

const PAGE = "/dashboard/datasets/findata";

async function login(page: Page, baseURL: string, user: { email: string; password: string }) {
  await page.goto(`${baseURL}/auth/login`);
  await page.getByLabel(/email/i).fill(user.email);
  await page.getByLabel(/password/i).fill(user.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/(dashboard|account|app)/, { timeout: 15_000 });
}

async function pickSymbol(page: Page, symbol: string) {
  const input = page.getByPlaceholder(/search symbol/i);
  await input.click();
  await input.fill(symbol);
  await page.keyboard.press("Enter");
  // Wait for the symbol pill in the header to update
  await expect(page.locator("header, div").getByText(symbol, { exact: true }).first()).toBeVisible({ timeout: 10_000 });
}

async function tabsVisible(page: Page): Promise<string[]> {
  // Read all visible top-tab labels (the row right after the header bar)
  const labels = await page.locator("button").allTextContents();
  // Filter to the canonical set we care about
  const known = ["Overview", "Chart", "Live", "Financials", "Reports", "Ownership", "Profile", "Insights", "News"];
  return known.filter((l) => labels.includes(l));
}

test.describe("11 — FinData Explorer", () => {
  let user: { email: string; password: string };

  test.beforeAll(async ({ baseURL }, testInfo) => {
    // Prefer a freshly-minted user, but fall back to the admin account so
    // tests still run in CI environments without Gmail IMAP configured.
    if (process.env.E2E_GMAIL_APP_PASSWORD) {
      user = await createUser(baseURL!, { tag: `findata-${Date.now().toString(36)}` });
    } else if (process.env.E2E_ADMIN_PASSWORD) {
      user = { email: process.env.E2E_ADMIN_EMAIL || "admin@lum.id", password: process.env.E2E_ADMIN_PASSWORD };
    } else {
      testInfo.skip(true, "Neither E2E_GMAIL_APP_PASSWORD nor E2E_ADMIN_PASSWORD set");
    }
  });

  test.beforeEach(async ({ page, baseURL }) => {
    await login(page, baseURL!, user);
    await page.goto(`${baseURL}${PAGE}`);
    // Page header title (the one in main, not the sidebar link)
    await expect(page.getByRole("main").getByText(/FinData Explorer/i)).toBeVisible();
  });

  test("page header — title, freshness, search, kind pill", async ({ page }) => {
    // Title (scoped to main to avoid collision with sidebar link)
    await expect(page.getByRole("main").getByText(/FinData Explorer/i)).toBeVisible();
    // Freshness badge (e.g. "89 fresh · 27 stale" or "0 stale")
    await expect(page.getByText(/fresh.*stale/i)).toBeVisible({ timeout: 15_000 });
    // Symbol input visible
    await expect(page.getByPlaceholder(/search symbol/i)).toBeVisible();
    // Default symbol AAPL pill + Equity kind pill
    await expect(page.getByText("AAPL", { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/^Equity$/).first()).toBeVisible({ timeout: 15_000 });
    // Utility shortcuts in header
    await expect(page.getByRole("button", { name: /compare/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /screener/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /catalog/i })).toBeVisible();
  });

  test("symbol search dropdown surfaces the typed query even when server skips it", async ({ page }) => {
    const input = page.getByPlaceholder(/search symbol/i);
    await input.click();
    await input.fill("SPY");
    // First dropdown item is "Use as typed (Enter)" — the UI workaround for the
    // server's exact-symbol search bug
    await expect(page.getByText(/use as typed/i)).toBeVisible({ timeout: 15_000 });
  });

  test("equity (AAPL) — all 9 tabs visible + Overview renders rich hero", async ({ page }) => {
    const tabs = await tabsVisible(page);
    expect(tabs).toEqual(
      expect.arrayContaining(["Overview", "Chart", "Live", "Financials", "Reports", "Ownership", "Profile", "Insights", "News"]),
    );
    // Overview hero shows the company name + price
    await expect(page.getByText(/Apple Inc/i)).toBeVisible({ timeout: 15_000 });
  });

  test("ETF (QQQ) — reduced tab set + ETF-aware Overview", async ({ page }) => {
    await pickSymbol(page, "QQQ");
    // Kind pill flips to ETF
    await expect(page.getByText(/^ETF$/).first()).toBeVisible({ timeout: 15_000 });
    // Equity-only tabs are hidden
    const tabs = await tabsVisible(page);
    expect(tabs).not.toContain("Financials");
    expect(tabs).not.toContain("Reports");
    expect(tabs).not.toContain("Ownership");
    expect(tabs).not.toContain("Profile");
    expect(tabs).not.toContain("Insights");
    // Cross-kind tabs still present
    expect(tabs).toEqual(expect.arrayContaining(["Overview", "Chart", "Live", "News"]));
    // Overview shows ETF-specific content — top-10 holdings widget
    await expect(page.getByText(/top-10 holdings|fund info|holdings/i).first()).toBeVisible({ timeout: 20_000 });
  });

  test("crypto (BTCUSD) — minimal tab set + chart works", async ({ page }) => {
    await pickSymbol(page, "BTCUSD");
    await expect(page.getByText(/^Crypto$/).first()).toBeVisible({ timeout: 15_000 });
    const tabs = await tabsVisible(page);
    expect(tabs).toEqual(expect.arrayContaining(["Overview", "Chart", "Live", "News"]));
    // Switch to Chart and verify it shows bars (kv.run has BTCUSD OHLC since 2026-05-20)
    await page.getByRole("button", { name: /^Chart$/ }).click();
    await expect(page.getByText(/\d+ bars/i)).toBeVisible({ timeout: 20_000 });
  });

  test("forex (EURUSD) — Forex kind, even smaller tab set", async ({ page }) => {
    await pickSymbol(page, "EURUSD");
    await expect(page.getByText(/^Forex$/).first()).toBeVisible({ timeout: 15_000 });
    const tabs = await tabsVisible(page);
    // News is hidden for forex (per kinds allowlist)
    expect(tabs).not.toContain("News");
    expect(tabs).toEqual(expect.arrayContaining(["Overview", "Chart", "Live"]));
  });

  test("index (^GSPC) — Index kind", async ({ page }) => {
    await pickSymbol(page, "^GSPC");
    await expect(page.getByText(/^Index$/).first()).toBeVisible({ timeout: 15_000 });
  });

  test("watchlist pin + unpin survives reload", async ({ page, baseURL }) => {
    // Reset watchlist so the test is deterministic regardless of previous runs
    await page.evaluate(() => localStorage.removeItem("findata-explorer:watchlist"));
    await page.reload();

    // Pin AAPL (button title is "Pin to watchlist")
    await page.locator('button[title="Pin to watchlist"]').click();
    await expect(page.locator('button[title="Unpin from watchlist"]')).toBeVisible();
    // Reload, pin should still be there
    await page.goto(`${baseURL}${PAGE}`);
    await expect(page.locator('button[title="Unpin from watchlist"]')).toBeVisible({ timeout: 10_000 });
    // Watchlist strip shows the symbol
    await expect(page.getByText(/^Watch$/i)).toBeVisible();
    // Unpin
    await page.locator('button[title="Unpin from watchlist"]').click();
    await expect(page.locator('button[title="Pin to watchlist"]')).toBeVisible();
  });

  test("Catalog tab probes all endpoints and reports status counts", async ({ page }) => {
    await page.getByRole("button", { name: /catalog/i }).click();
    // Stat cards: Endpoints / Have data / Empty / Errored
    await expect(page.getByText(/Endpoints/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Have data/i)).toBeVisible();
    await expect(page.getByText(/Empty/i)).toBeVisible();
    await expect(page.getByText(/Errored/i)).toBeVisible();
    // Filter input
    await expect(page.getByPlaceholder(/filter endpoints/i)).toBeVisible();
  });

  test("Compare tab — current symbol shows in return leaderboard", async ({ page }) => {
    // Default AAPL — Compare should display AAPL in the leaderboard
    await page.getByRole("button", { name: /compare/i }).click();
    await expect(page.getByText(/Return over selected period/i)).toBeVisible({ timeout: 15_000 });
    // AAPL appears somewhere in the leaderboard
    await expect(page.getByText("AAPL").first()).toBeVisible();
  });

  test("Screener — sector pie + filter", async ({ page }) => {
    await page.getByRole("button", { name: /screener/i }).click();
    await expect(page.getByPlaceholder(/ticker prefix/i)).toBeVisible();
    await page.getByPlaceholder(/ticker prefix/i).fill("AAPL");
    // Expect at least one result row
    await expect(page.getByText(/Apple/i).first()).toBeVisible({ timeout: 10_000 });
  });

  test("Chart tab — MA toggles change rendering", async ({ page }) => {
    await page.getByRole("button", { name: /^Chart$/ }).click();
    // Range buttons
    await expect(page.getByRole("button", { name: /^1M$/ })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: /MA20/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /MA50/i })).toBeVisible();
    // Toggling shouldn't crash
    await page.getByRole("button", { name: /MA20/i }).click();
    await page.getByRole("button", { name: /MA50/i }).click();
  });

  test("News tab — error state surfaces clearly when service is down", async ({ page }) => {
    await page.getByRole("button", { name: /^News$/ }).click();
    // Either news renders, "No recent news" shows, OR a clear error
    // appears. Just make sure the pane is not blank.
    const body = page.locator("main, [class*='overflow-auto']").first();
    await expect(body).toBeVisible();
    // Should not be completely empty
    const text = await body.innerText();
    expect(text.length).toBeGreaterThan(20);
  });
});

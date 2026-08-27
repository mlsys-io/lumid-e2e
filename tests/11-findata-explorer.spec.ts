import { test, expect, type Page } from "@playwright/test";
import { watchConsole } from "../fixtures/console-watch";
import { createUser } from "../fixtures/test-user";
import { gotoRedirect } from "../fixtures/nav";

// Journey 11 — the Data system app at /studio/data.
//
// WHY THIS FILE IS A REWRITE, NOT A SELECTOR REFRESH
// --------------------------------------------------
// It used to drive the FinData Explorer at /dashboard/datasets/findata:
// symbol search, kind pills, watchlist pin, Chart / Compare / Screener /
// Catalog panes. A partial repair moved the PAGE constant to /studio/data on
// the assumption that the same page had simply been re-homed. It had not.
//
//   • The FinData Explorer component still exists — at
//     src/pages/deprecated/dashboard/datasets-findata.tsx — but NOTHING mounts
//     it. App.tsx does not import it, it is absent from NATIVE_SURFACES
//     (src/components/app-surface/native-registry.ts), and its old URL now
//     falls through `<Route path="/dashboard/*" element={<Navigate to="/studio" />}>`.
//     App.tsx says so directly: "Quant* + datasets-* page mounts retired
//     2026-06-19". So every symbol/watchlist/tab assertion below the fold was
//     asserting against dead code, and would fail on ANY url.
//   • /studio/data (src/pages/studio/data.tsx) is a DIFFERENT surface: a
//     first-party system app with three local-state tabs —
//     Catalog (DataLakeViewer), Explorer (DataAppBrowser), Query (SqlConsole).
//     No symbol search, no watchlist, no chart, no freshness badge.
//
// So this spec now covers what /studio/data actually is. The Query tab is
// deliberately NOT covered here — tests/23-studio-sql-console.spec.ts owns it
// end to end, including the three-tab strip.
//
// Coverage deliberately dropped: the FinData Explorer's own behaviour (kind
// detection, tab allowlist per instrument kind, watchlist persistence). That
// product surface is retired; if it is ever re-mounted, restore those tests
// from git history rather than reconstructing them.
const PAGE = "/studio/data";

async function login(page: Page, baseURL: string, user: { email: string; password: string }) {
  await gotoRedirect(page, `${baseURL}/auth/login`);
  await page.getByLabel(/email/i).fill(user.email);
  await page.getByLabel(/password/i).fill(user.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  // Studio is where login lands; the old trio all redirect there. Waiting on
  // only the old trio timed out in beforeEach, so every test in this file
  // failed before it reached its own assertions.
  await page.waitForURL(/\/(studio|dashboard|account|app)/, { timeout: 15_000 });
}

test.describe("11 — Studio Data app (Catalog + Explorer)", () => {
  let user: { email: string; password: string };

  test.beforeAll(async ({ baseURL }, testInfo) => {
    // Prefer a freshly-minted user — /studio/data is behind AuthGuard only,
    // no admin role required — but fall back to the admin account so this
    // still runs where Gmail IMAP isn't configured.
    if (process.env.E2E_GMAIL_APP_PASSWORD) {
      user = await createUser(baseURL!, { tag: `data-${Date.now().toString(36)}` });
    } else if (process.env.E2E_ADMIN_PASSWORD) {
      user = { email: process.env.E2E_ADMIN_EMAIL || "admin@lum.id", password: process.env.E2E_ADMIN_PASSWORD };
    } else {
      testInfo.skip(true, "Neither E2E_GMAIL_APP_PASSWORD nor E2E_ADMIN_PASSWORD set");
    }
  });

  test.beforeEach(async ({ page, baseURL }) => {
    await login(page, baseURL!, user);
    await gotoRedirect(page, `${baseURL}${PAGE}`);
    // The tab strip is the page's own chrome — it renders before either
    // panel's fetches resolve.
    await expect(page.getByRole("button", { name: /^Catalog$/ })).toBeVisible({ timeout: 20_000 });
  });

  test("Catalog is the default tab and the data-lake tree renders", async ({ page }) => {
    const errors = watchConsole(page);
    // Catalog mounts eagerly (seen = new Set(["catalog"])); Explorer and Query
    // mount lazily on first click.
    await expect(page.getByPlaceholder(/filter tables across all instances/i)).toBeVisible({ timeout: 20_000 });
    // Header summary: "<n>/3 instances · <n> schemas · <n> tables · read-only".
    // Asserted as a pattern, not a count — an offline instance is a legitimate
    // state here and must not turn this into a flake.
    await expect(page.getByText(/\d+\/3 instances .* tables/i)).toBeVisible({ timeout: 25_000 });
    expect(errors(), `console errors:\n${errors().join("\n")}`).toEqual([]);
  });

  test("Catalog lists all three lake instances", async ({ page }) => {
    const errors = watchConsole(page);
    // LAKE_INSTANCES in src/api/dataLake.ts — FinData, Lumid Data, LQT Data.
    // Each renders a tree row that reads either "<n> schemas" or "offline";
    // the label is what must always be there.
    for (const label of ["FinData", "Lumid Data", "LQT Data"]) {
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible({ timeout: 25_000 });
    }
    expect(errors(), `console errors:\n${errors().join("\n")}`).toEqual([]);
  });

  test("Explorer loads findata's endpoint catalog and can arm a request", async ({ page }) => {
    const errors = watchConsole(page);
    await page.getByRole("button", { name: /^Explorer$/ }).click();
    // DataAppBrowser fetches /dataapp-proxy/_sources then
    // /dataapp-proxy/findata/openapi.json. Both are same-origin and public.
    await expect(page.getByPlaceholder(/filter endpoints/i)).toBeVisible({ timeout: 25_000 });
    // "<n> endpoints" — a real catalog, not an empty shell. `[1-9]` rather
    // than `\d` so a 0 (catalog fetch failed) fails the test instead of
    // passing on the text alone.
    await expect(page.getByText(/[1-9]\d* endpoints/)).toBeVisible({ timeout: 25_000 });
    // Before an endpoint is picked, the right pane explains itself.
    await expect(page.getByText(/pick an endpoint to query/i)).toBeVisible();

    // Pick the first endpoint in the list. Endpoint buttons are monospaced
    // path labels inside the 320px left rail.
    const endpoints = page.locator("button.font-mono");
    await expect(endpoints.first()).toBeVisible({ timeout: 25_000 });
    await endpoints.first().click();
    // A REST endpoint arms a Run button; SSE/WS endpoints render a
    // "Streaming endpoint" / "WebSocket endpoint" explainer instead — both
    // are correct outcomes, so accept either rather than assuming ordering.
    await expect(
      page.getByRole("button", { name: /^Run$/ })
        .or(page.getByText(/streaming endpoint|websocket endpoint/i)),
    ).toBeVisible({ timeout: 20_000 });
    expect(errors(), `console errors:\n${errors().join("\n")}`).toEqual([]);
  });

  test("Explorer's source picker offers every allowlisted data app", async ({ page }) => {
    const errors = watchConsole(page);
    await page.getByRole("button", { name: /^Explorer$/ }).click();
    const select = page.locator("select").first();
    await expect(select).toBeVisible({ timeout: 25_000 });
    // /dataapp-proxy/_sources serves findata + lumid-data + lqt-data today.
    // Assert the configured default is selected and at least one sibling
    // exists, rather than pinning the exact roster.
    await expect(select).toHaveValue("findata");
    expect(await select.locator("option").count()).toBeGreaterThan(1);
    expect(errors(), `console errors:\n${errors().join("\n")}`).toEqual([]);
  });
});

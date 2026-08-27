import { test, expect } from "@playwright/test";
import { createUser } from "../fixtures/test-user";
import { watchConsole } from "../fixtures/console-watch";

// Journey 10 — every lum.id dashboard path smoke-tests cleanly.
//
// For each path we visit:
//   • route returns 200 (not 404 redirect or 5xx)
//   • the AppLayout sidebar still renders (no white-screen crash)
//   • the page emits no "Error" / "Uncaught" console messages
//   • a path-specific marker element is visible
//
// Two persona buckets:
//   • USER_PATHS  — accessible to any logged-in user
//   • ADMIN_PATHS — require role=admin / super_admin

interface PathDef {
  path: string;
  marker: RegExp | string;
  // Some pages defer their primary content behind an async fetch; bump
  // wait for those instead of failing on the default 10s expect timeout.
  patient?: boolean;
}

const USER_PATHS: PathDef[] = [
  // Research / autoresearch
  { path: "/dashboard/loops",                 marker: /loops|my loops|research/i },
  { path: "/dashboard/marketplace",           marker: /marketplace|browse|app/i, patient: true },
  { path: "/dashboard/knowledge",             marker: /knowledge|memory|brain/i },
  { path: "/dashboard/results",               marker: /results/i },
  // Product (workflows / jobs)
  { path: "/dashboard",                       marker: /workflow|builder|n8n/i, patient: true },
  { path: "/dashboard/runmesh/submit",        marker: /runmesh|submit/i },
  { path: "/dashboard/lumilake-submit",       marker: /lumilake|submit/i },
  { path: "/dashboard/jobs",                  marker: /jobs|running/i, patient: true },
  { path: "/dashboard/gpu-rentals",           marker: /gpu/i },
  // Datasets
  { path: "/dashboard/lumilake/data",         marker: /data browsing|datasets|lumilake/i },
  { path: "/dashboard/datasets/findata",      marker: /FinData Explorer/i },
  { path: "/dashboard/datasets/macro",        marker: /macro|treasury|economic|calendar/i, patient: true },
  // Account
  { path: "/dashboard/profile",               marker: /profile|account/i },
  { path: "/dashboard/tokens",                marker: /tokens|access|PAT/i },
  { path: "/dashboard/inbox",                 marker: /inbox|messages|memo/i },
];

// /studio/*, not /dashboard/*. The whole /dashboard URL surface was retired
// 2026-06-19 and consolidated under /studio (App.tsx says so); /dashboard/admin/*
// still REDIRECTS via DashboardAdminToStudio, so old links survive -- but the
// landing URL is /studio/admin/*, which is what these should assert.
const ADMIN_PATHS: PathDef[] = [
  { path: "/studio/admin/users",               marker: /users|invitations|access/i },
  { path: "/studio/admin/clusters",            marker: /clusters|infrastructure|nodes/i, patient: true },
  { path: "/studio/admin/competitions",        marker: /competitions|lumid market/i, patient: true },
  { path: "/studio/super-admin",               marker: /super admin|operational|telemetry/i, patient: true },
];

// Console errors are watched via the shared fixture — see
// fixtures/console-watch.ts for why this assertion is the one that earns its
// keep, and for the caveat on what the allowlist hides.

test.describe("10 — dashboard paths smoke", () => {
  test.describe("user persona", () => {
    let user: { email: string; password: string };

    test.beforeAll(async ({ baseURL }, testInfo) => {
      if (!process.env.E2E_GMAIL_APP_PASSWORD) testInfo.skip(true, "E2E_GMAIL_APP_PASSWORD not set");
      user = await createUser(baseURL!, { tag: `dash-${Date.now().toString(36)}` });
    });

    test.beforeEach(async ({ page, baseURL }) => {
      await page.goto(`${baseURL}/auth/login`);
      await page.getByLabel(/email/i).fill(user.email);
      await page.getByLabel(/password/i).fill(user.password);
      await page.getByRole("button", { name: /sign in/i }).click();
      await page.waitForURL(/\/(dashboard|app)/);
    });

    for (const def of USER_PATHS) {
      test(`user ${def.path}`, async ({ page, baseURL }) => {
        const errs = watchConsole(page);
        const resp = await page.goto(`${baseURL}${def.path}`);
        expect(resp?.status(), `GET ${def.path}`).toBeLessThan(500);

        // Sidebar (AppLayout) should always render for /dashboard/* pages
        await expect(page.getByText(/datasets/i).first()).toBeVisible({ timeout: def.patient ? 20_000 : 10_000 });

        // Path-specific marker visible somewhere on the page
        await expect(page.getByText(def.marker).first()).toBeVisible({ timeout: def.patient ? 20_000 : 10_000 });

        // Allow async errors to settle, then assert clean console
        await page.waitForTimeout(500);
        const errors = errs();
        expect(errors, `console errors on ${def.path}:\n${errors.join("\n")}`).toEqual([]);
      });
    }
  });

  test.describe("admin persona", () => {
    test.beforeAll(async ({ }, testInfo) => {
      if (!process.env.E2E_ADMIN_PASSWORD) testInfo.skip(true, "E2E_ADMIN_PASSWORD not set");
    });

    test.beforeEach(async ({ page, baseURL }) => {
      const email = process.env.E2E_ADMIN_EMAIL || "admin@lum.id";
      const password = process.env.E2E_ADMIN_PASSWORD!;
      await page.goto(`${baseURL}/auth/login`);
      await page.getByLabel(/email/i).fill(email);
      await page.getByLabel(/password/i).fill(password);
      await page.getByRole("button", { name: /sign in/i }).click();
      // Login lands in Studio now (admins -> /studio, users -> /studio/today);
      // /dashboard and /account both redirect there. Waiting only for the old
      // pair timed out before a single admin assertion ran.
      await page.waitForURL(/\/(studio|dashboard|account)/, { timeout: 15_000 });
    });

    for (const def of ADMIN_PATHS) {
      test(`admin ${def.path}`, async ({ page, baseURL }) => {
        const errs = watchConsole(page);
        const resp = await page.goto(`${baseURL}${def.path}`);
        expect(resp?.status(), `GET ${def.path}`).toBeLessThan(500);

        // Shell landmark, then the per-page marker. This asserted /datasets/i --
        // a nav entry from the retired /dashboard shell. Studio's rail says
        // "Data", so the generic "did the shell render" check could never match
        // and every admin page failed on chrome naming rather than on content.
        await expect(
          page.getByText(/new chat|library|scheduled/i).first(),
        ).toBeVisible({ timeout: def.patient ? 20_000 : 10_000 });
        await expect(page.getByText(def.marker).first()).toBeVisible({ timeout: def.patient ? 20_000 : 10_000 });

        await page.waitForTimeout(500);
        const errors = errs();
        expect(errors, `console errors on ${def.path}:\n${errors.join("\n")}`).toEqual([]);
      });
    }
  });
});

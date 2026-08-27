import { test, expect } from "@playwright/test";
import { loginAsAdmin, requireAdminCreds } from "../fixtures/admin-session";

// Journey 7 — admin reaches the canonical user directory.
//
// WHAT THIS USED TO TEST, AND WHY IT COULD NOT PASS
// -------------------------------------------------
// The original spec drove /auth/account/admin → an "Admin hub" card →
// /auth/account/admin/runmesh/users, and asserted the Runmesh-hosted user
// list federated in over the SSO bridge. Every one of those three things is
// gone from lumid_ui:
//
//   • the /auth basename was dropped (lumid_ui 88fe8d2) and the admin hub was
//     merged away (16d1768). /auth/account/admin is now a bare
//     <Navigate to="/dashboard"> (App.tsx), and /dashboard itself redirects
//     to /studio — so there is no "Admin hub" text to click, on any URL;
//   • the ported Runmesh UserManagement page was deleted in the Studio
//     cutover. src/runmesh/pages/ holds BillingManagement, SupplierManagement,
//     SupplierNodeConfig and WorkflowReview — and no user surface at all;
//   • the user directory is now lumid-identity's own /api/v1/admin/users,
//     rendered by src/admin/users/list.tsx and mounted at /studio/admin/users.
//     That page states the merge in its own subtitle: "Canonical identity —
//     no separate Runmesh / Lumilake / QuantArena user admin."
//
// So the claims worth asserting here are what survived the move:
//   1. AdminGuard admits role=admin (and super_admin) to /studio/admin/*
//   2. the admin section renders without an import/lazy-chunk error
//   3. the directory returns REAL rows from identity — proven by searching
//      for the admin's own account rather than trusting page-1 ordering
//   4. an anonymous context still bounces to /auth/login
//
// NOTE ON LOST COVERAGE: the lum.id → runmesh-admin SSO bridge
// (LumidSsoBridgeFilter + session-bearer) is no longer exercised by ANY
// user-visible admin page, so this spec cannot cover it any more. If it needs
// e2e coverage it belongs on a surviving /runmesh/*-backed surface —
// /studio/admin/workflow-review or /studio/admin/billing — as its own journey.

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL || "admin@lum.id";

test.describe("07 — admin access to the canonical user directory", () => {
	test.beforeAll(() => { requireAdminCreds(); });

	test("admin sees real users at /studio/admin/users", async ({ page }) => {
		await loginAsAdmin(page);

		// The admin section landing. AdminGuard bounces non-admins to /studio,
		// so simply arriving here proves the role was read off /api/v1/user.
		await page.goto("/studio/admin");
		await expect(page).toHaveURL(/\/studio\/admin$/);
		await expect(page.getByRole("heading", { name: "Admin", exact: true })).toBeVisible({ timeout: 15_000 });
		// StudioAdmin's own tab strip (Tenants / Loops / Build / Auth).
		await expect(page.getByRole("button", { name: /^Tenants$/ })).toBeVisible();

		// The directory. Deep-linked rather than clicked: /studio/admin has no
		// "user management" card — the entry point is the Studio rail.
		await page.goto("/studio/admin/users");
		// AdminSectionLayout's section title, then the page's own title.
		await expect(page.getByRole("heading", { name: /people & access/i })).toBeVisible({ timeout: 15_000 });
		await expect(page.getByRole("heading", { name: "Users", exact: true })).toBeVisible();
		// Column headers prove the table rendered, not just the chrome.
		await expect(page.getByRole("columnheader", { name: "Email" })).toBeVisible({ timeout: 20_000 });
		await expect(page.getByRole("columnheader", { name: "Role" })).toBeVisible();

		// Real data: search identity for the admin's own account. Asserting a
		// specific row beats "some row exists", and searching beats trusting
		// that admin@lum.id lands on page 1 of a created_at DESC list.
		// The input debounces 300ms before it re-queries.
		await page.getByPlaceholder(/email or name/i).fill(ADMIN_EMAIL);
		await expect(page.getByText(ADMIN_EMAIL, { exact: true }).first()).toBeVisible({ timeout: 20_000 });
		// That row must carry an elevated role — this account is what every
		// other admin spec logs in as.
		await expect(page.getByText(/^(admin|super_admin)$/).first()).toBeVisible({ timeout: 10_000 });
	});

	test("anonymous context bounces from /studio/admin/users to login", async ({ browser }, testInfo) => {
		// newContext({baseURL}), not a bare newContext(): a fresh context does
		// NOT inherit `use.baseURL` from the project, and the goto below is a
		// relative path. The old version of this test had the same latent bug.
		const baseURL = testInfo.project.use.baseURL ?? process.env.BASE_URL ?? "https://lum.id";
		const anon = await browser.newContext({ baseURL });
		const anonPage = await anon.newPage();
		// AdminGuard sends unauthenticated callers to
		// /auth/login?return_to=<here> rather than to /studio.
		await anonPage.goto("/studio/admin/users");
		await expect(anonPage).toHaveURL(/\/auth\/login/, { timeout: 15_000 });
		await anon.close();
	});
});

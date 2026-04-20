import { test, expect } from "@playwright/test";
import { loginAsAdmin, requireAdminCreds } from "../fixtures/admin-session";

// Journey 7 — admin logs into lum.id, navigates to the Runmesh admin
// UI hosted at /account/admin/runmesh/users. The page should show a
// real user list — proving that:
//   1. <AdminGuard> recognises role=admin from /api/v1/user
//   2. the ported Runmesh pages render without import errors
//   3. the session-bearer → runmesh.ai/system/user/list federation
//      via LumidSsoBridgeFilter returns real data

test.describe("07 — admin SSO bridge to Runmesh", () => {
	test.beforeAll(() => { requireAdminCreds(); });

	test("admin sees Runmesh user list at /account/admin/runmesh/users", async ({ page }) => {
		await loginAsAdmin(page);

		// Go via the Admin hub to prove the card-navigate flow works.
		await page.goto("/auth/account/admin");
		await expect(page.getByText(/admin hub/i)).toBeVisible();
		await page.getByText(/user management/i).click();
		await expect(page).toHaveURL(/\/auth\/account\/admin\/runmesh\/users/);

		// Wait for table to populate. Runmesh's admin user (userId=1,
		// userName=admin) is a stable row that will always be present.
		await expect(page.getByText(/^admin$/i).first()).toBeVisible({ timeout: 20_000 });
		// We also expect a nickname column cell somewhere.
		await expect(page.getByText(/admin@runmesh/i)).toBeVisible({ timeout: 10_000 });

		// Non-admin guard: a fresh context with no cookie should bounce.
		const anon = await page.context().browser()!.newContext();
		const anonPage = await anon.newPage();
		await anonPage.goto("/auth/account/admin/runmesh/users");
		await expect(anonPage).toHaveURL(/\/auth\/login/, { timeout: 10_000 });
		await anon.close();
	});
});

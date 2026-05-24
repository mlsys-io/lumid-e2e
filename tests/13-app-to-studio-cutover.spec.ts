// Tests the Phase S7 /app/* → /studio/* cutover from a user's POV.
//
// Each of the five legacy /app/* deep links should redirect to the
// Studio equivalent for a logged-in user. The redirects are React-
// Router <Navigate replace />, so the test asserts the *final URL*
// after navigation, not a 301 status (nginx still serves the SPA
// shell for both old and new paths — routing is client-side).

import { test, expect } from "@playwright/test";
import { loginAsAdmin } from "../fixtures/admin-session";

test.describe("13 — /app/* deep links redirect to Studio", () => {
	test.beforeEach(async ({ page }) => {
		await loginAsAdmin(page);
	});

	const cases: Array<[string, RegExp]> = [
		["/app",             /\/studio\/today/],
		["/app/loops",       /\/studio\/today/],
		["/app/marketplace", /\/studio\/skills/],
		["/app/knowledge",   /\/studio\/knowledge/],
		["/app/results",     /\/studio\/today/],
		// Unknown sub-path → falls through to catch-all
		["/app/this-does-not-exist", /\/studio\/today/],
	];

	for (const [from, to] of cases) {
		test(`${from} → studio`, async ({ page }) => {
			await page.goto(from);
			await expect(page).toHaveURL(to, { timeout: 10_000 });
		});
	}
});

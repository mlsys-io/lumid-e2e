import { test, expect } from "@playwright/test";
import { createUser } from "../fixtures/test-user";

// Journey 2 — returning-user login + logout.
//   * signs in via the UI with email/password
//   * lands on /account (dashboard renders)
//   * /api/v1/user returns 200 (cookie is live)
//   * clicks Sign out
//   * next GET /api/v1/user returns 401 AND /auth/account/admin
//     bounces to /auth/login?return_to=...

test.describe("02 — login + logout", () => {
	let user: { email: string; password: string; username: string };

	test.beforeAll(async ({ baseURL }, testInfo) => {
		// skip the whole suite if mailbox creds aren't set — fixture
		// throws otherwise and the error isn't super readable.
		if (!process.env.E2E_GMAIL_APP_PASSWORD) testInfo.skip(true, "E2E_GMAIL_APP_PASSWORD not set");
		if (!process.env.E2E_INVITATION_CODE) testInfo.skip(true, "E2E_INVITATION_CODE not set");
		user = await createUser(baseURL!, { tag: `login-${Date.now().toString(36)}` });
	});

	test("email+password login → dashboard → logout → protected 401", async ({ page, request }) => {
		await page.goto("/auth/login");
		await page.locator("#email").fill(user.email);
		await page.locator("#password").fill(user.password);
		await page.getByRole("button", { name: /sign in/i }).click();
		await expect(page).toHaveURL(/\/account(\/|$)/, { timeout: 15_000 });

		// Cookie is live — /api/v1/user succeeds
		const whoami1 = await page.request.get("/api/v1/user");
		expect(whoami1.status()).toBe(200);
		const body1 = await whoami1.json();
		expect(body1.data.email).toBe(user.email);

		// Click Sign out (present on dashboard header + on /account/profile).
		await page.getByRole("button", { name: /sign out/i }).first().click();
		await expect(page).toHaveURL(/\/auth\/login/, { timeout: 10_000 });

		// After logout, /api/v1/user should 401.
		const whoami2 = await page.request.get("/api/v1/user");
		expect(whoami2.status()).toBe(401);

		// Deep-linked protected route with no session bounces back to
		// /auth/login (the AuthGuard pattern).
		await page.goto("/auth/account/profile");
		await expect(page).toHaveURL(/\/auth\/login/, { timeout: 10_000 });
	});
});

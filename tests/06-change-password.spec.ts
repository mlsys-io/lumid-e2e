import { test, expect, type BrowserContext } from "@playwright/test";
import { createUser } from "../fixtures/test-user";

// Journey 6 — changing the password should sign out every OTHER
// device for the same account but keep THIS device authed.
//
// We simulate "two devices" by opening two Playwright browser contexts
// and signing the same user into both. Then on context A we change
// the password via /account/profile. On context B, the next call to
// /api/v1/user must come back 401.

test.describe("06 — change password revokes other sessions", () => {
	let user: { email: string; password: string; username: string };

	test.beforeAll(async ({ baseURL }, testInfo) => {
		if (!process.env.E2E_GMAIL_APP_PASSWORD) testInfo.skip(true, "E2E_GMAIL_APP_PASSWORD not set");
		if (!process.env.E2E_INVITATION_CODE) testInfo.skip(true, "E2E_INVITATION_CODE not set");
		user = await createUser(baseURL!, { tag: `chpw-${Date.now().toString(36)}` });
	});

	test("password change on device A kicks device B's session", async ({ browser }) => {
		const ctxA = await browser.newContext();
		const ctxB = await browser.newContext();

		try {
			// Both "devices" log in.
			await loginThrough(ctxA, user.email, user.password);
			await loginThrough(ctxB, user.email, user.password);

			// Confirm both are live.
			const aBefore = await ctxA.request.get("/api/v1/user");
			const bBefore = await ctxB.request.get("/api/v1/user");
			expect(aBefore.status()).toBe(200);
			expect(bBefore.status()).toBe(200);

			// Device A changes password.
			const pageA = await ctxA.newPage();
			await pageA.goto("/auth/account/profile");

			const newPassword = `Lumid-e2e-chpw-${Math.random().toString(36).slice(2, 10)}!`;
			await pageA.locator("#old-pw").fill(user.password);
			await pageA.locator("#new-pw").fill(newPassword);
			await pageA.locator("#confirm-pw").fill(newPassword);
			await pageA.getByRole("button", { name: /change password/i }).click();

			// Success toast surfaces; Sonner renders into a region/status.
			await expect(pageA.getByText(/password changed/i)).toBeVisible({ timeout: 10_000 });

			// Device A should STILL be logged in.
			const aAfter = await ctxA.request.get("/api/v1/user");
			expect(aAfter.status()).toBe(200);

			// Device B's next request should 401.
			const bAfter = await ctxB.request.get("/api/v1/user");
			expect(bAfter.status()).toBe(401);

			// Cleanly sign back in on device B with the new password.
			const pageB = await ctxB.newPage();
			await pageB.goto("/auth/login");
			await pageB.locator("#email").fill(user.email);
			await pageB.locator("#password").fill(newPassword);
			await pageB.getByRole("button", { name: /sign in/i }).click();
			await expect(pageB).toHaveURL(/\/account(\/|$)/);
		} finally {
			await ctxA.close();
			await ctxB.close();
		}
	});
});

async function loginThrough(
	ctx: BrowserContext,
	email: string,
	password: string,
): Promise<void> {
	const page = await ctx.newPage();
	await page.goto("/auth/login");
	await page.locator("#email").fill(email);
	await page.locator("#password").fill(password);
	await page.getByRole("button", { name: /sign in/i }).click();
	await page.waitForURL(/\/account(\/|$)/, { timeout: 15_000 });
	await page.close();
}

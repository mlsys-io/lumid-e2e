import { test, expect } from "@playwright/test";
import { createUser } from "../fixtures/test-user";
import { waitForEmail, extractResetToken } from "../fixtures/mailbox";

// Journey 4 — forgot-password end-to-end.
//   * fresh user is created via REST (so the mailbox has a clean
//     "signup" email that won't be confused with the reset email)
//   * visits /auth/login, clicks "Forgot password?"
//   * enters their email, clicks "Send reset link"
//   * sees the neutral confirmation panel (no email-enumeration)
//   * polls Gmail for the reset email, clicks the link
//   * enters a new password, submits
//   * old password fails at /auth/login
//   * new password succeeds

test.describe("04 — forgot password", () => {
	let user: { email: string; password: string; username: string };

	test.beforeAll(async ({ baseURL }, testInfo) => {
		if (!process.env.E2E_GMAIL_APP_PASSWORD) testInfo.skip(true, "E2E_GMAIL_APP_PASSWORD not set");
		if (!process.env.E2E_INVITATION_CODE) testInfo.skip(true, "E2E_INVITATION_CODE not set");
		user = await createUser(baseURL!, { tag: `forgot-${Date.now().toString(36)}` });
	});

	test("requests reset, clicks email link, sets new password, signs in", async ({ page }) => {
		// Step into the forgot-password form via the login page's link
		// so we cover the "Forgot password?" entry point too.
		await page.goto("/auth/login");
		await page.getByRole("button", { name: /forgot password/i }).click();
		await expect(page).toHaveURL(/\/auth\/forgot-password/);

		await page.locator("#email").fill(user.email);
		await page.getByRole("button", { name: /send reset link/i }).click();

		// Neutral success panel — the copy never tells us whether the
		// email exists (anti-enumeration).
		await expect(page.getByText(/reset link is on its way/i)).toBeVisible({ timeout: 15_000 });

		// Pull the token out of the emailed link
		const mail = await waitForEmail(user.email, { timeoutMs: 120_000 });
		const token = extractResetToken(mail.html, mail.text);
		expect(token.length).toBeGreaterThanOrEqual(32);

		// Navigate to the reset page with the token in the URL (exactly
		// what a user would do by clicking the email button).
		const newPassword = `Lumid-e2e-reset-${Math.random().toString(36).slice(2, 10)}!`;
		await page.goto(`/auth/reset-password?token=${token}`);

		await page.locator("#new-pw").fill(newPassword);
		await page.locator("#confirm-pw").fill(newPassword);
		await page.getByRole("button", { name: /update password/i }).click();

		// Success state + auto-redirect to login after ~2s
		await expect(page.getByText(/password updated/i)).toBeVisible({ timeout: 10_000 });
		await expect(page).toHaveURL(/\/auth\/login/, { timeout: 10_000 });

		// Old password should no longer work
		await page.locator("#email").fill(user.email);
		await page.locator("#password").fill(user.password);
		await page.getByRole("button", { name: /sign in/i }).click();
		await expect(page.getByText(/invalid email or password/i)).toBeVisible({ timeout: 10_000 });

		// New password should work
		await page.locator("#password").fill(newPassword);
		await page.getByRole("button", { name: /sign in/i }).click();
		await expect(page).toHaveURL(/\/account(\/|$)/, { timeout: 15_000 });
	});
});

import { test, expect } from "@playwright/test";
import { taggedAddress, waitForEmail, extractOtp } from "../fixtures/mailbox";

// Journey 1 — a brand-new user lands on /auth/register, enters email +
// password, clicks "Send code", waits for the OTP email, types it in,
// submits, and is routed to /account. Validates the full signup UI
// path end-to-end with a real inbox.

const INVITE = process.env.E2E_INVITATION_CODE;

test.describe("01 — signup", () => {
	test.skip(!INVITE, "E2E_INVITATION_CODE not set");

	test("new user signs up with email OTP and lands on dashboard", async ({ page }) => {
		const tag = `signup-${Date.now().toString(36)}`;
		const email = taggedAddress(tag);
		const password = `Lumid-e2e-${Math.random().toString(36).slice(2, 10)}!`;
		const username = `e2e-${tag}`;

		// Pre-fill the invitation code via URL param — the register
		// form accepts ?invite=<code> or ?code=<code>.
		await page.goto(`/auth/register?invite=${encodeURIComponent(INVITE!)}`);

		await page.locator("#username").fill(username);
		await page.locator("#register-email").fill(email);
		await page.locator("#new-password").fill(password);
		await page.getByPlaceholder("Confirm your password").fill(password);

		// Trigger the OTP send (button label varies — click the "send
		// code" button next to the verification-code input).
		await page.getByRole("button", { name: /send (code|verification)/i }).click();

		// Poll Gmail for the code. Longer timeout because real SMTP +
		// Gmail delivery + IMAP indexing can dawdle.
		const mail = await waitForEmail(email, { timeoutMs: 120_000 });
		const code = extractOtp(mail.html, mail.text);
		expect(code).toMatch(/^\d{6}$/);

		await page.getByPlaceholder("Enter 6-digit code").fill(code);

		// Submit registration
		await page.getByRole("button", { name: /register|sign up|create account/i }).click();

		// A successful registration bounces to /auth/login (our flow
		// asks the user to log in after verify); allow either /login
		// or /account in case the flow is changed to auto-login later.
		await expect(page).toHaveURL(/\/auth\/(login|account)/, { timeout: 15_000 });
	});
});

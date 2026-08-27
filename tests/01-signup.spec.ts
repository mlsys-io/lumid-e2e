import { test, expect } from "@playwright/test";
import { taggedAddress, waitForEmail, extractOtp } from "../fixtures/mailbox";
import { localOtpEnabled, readOtpFromRedis } from "../fixtures/otp-redis";

// Journey 1 — a brand-new user lands on /auth/register, enters email +
// password, clicks "Send code", waits for the OTP email, types it in,
// submits, and is routed to /account. Validates the full signup UI
// path end-to-end with a real inbox.

const INVITE = process.env.E2E_INVITATION_CODE;

test.describe("01 — signup", () => {
	test.skip(!INVITE, "E2E_INVITATION_CODE not set");
	// This spec drives the signup FORM, so unlike the others it does not go
	// through fixtures/test-user.ts::createUser -- it needs the OTP itself. It
	// therefore needs an OTP SOURCE, which the invitation-code gate above was
	// accidentally standing in for: with no code it never ran, and the moment a
	// code was supplied it began throwing inside taggedAddress() for want of a
	// Gmail app password. Two independent requirements, one gate.
	test.skip(
		!localOtpEnabled() && !process.env.E2E_GMAIL_APP_PASSWORD,
		"no OTP source: set E2E_GMAIL_APP_PASSWORD, or CI_E2E_LOCAL_OTP=1 for the Redis backdoor",
	);

	test("new user signs up with email OTP and lands on dashboard", async ({ page }) => {
		const tag = `signup-${Date.now().toString(36)}`;
		// Redis backdoor uses a synthetic address (nothing is delivered); the
		// mailbox path uses a +subaddress so concurrent runs cannot race on OTPs.
		const useLocalOtp = localOtpEnabled();
		const email = useLocalOtp ? `lumid-e2e-${tag}@yao.lu` : taggedAddress(tag);
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
		// The button is labelled "Send" — and "Resend" / "Resend (Ns)" once a code
		// has gone out. It has never read "Send code" or "Send verification", so
		// the old regex matched nothing and this timed out looking for a button
		// that does not exist. Anchored so it cannot match an unrelated button
		// whose label merely contains "send".
		await page.getByRole("button", { name: /^(send|resend)/i }).first().click();

		// Poll Gmail for the code. Longer timeout because real SMTP +
		// Gmail delivery + IMAP indexing can dawdle.
		let code: string;
		if (useLocalOtp) {
			code = await readOtpFromRedis(email, { timeoutMs: 30_000 });
		} else {
			const mail = await waitForEmail(email, { timeoutMs: 120_000 });
			code = extractOtp(mail.html, mail.text);
		}
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

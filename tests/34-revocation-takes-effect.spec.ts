import { test, expect, request as pwRequest } from "@playwright/test";
import { createUser } from "../fixtures/test-user";
import { localOtpEnabled } from "../fixtures/otp-redis";

// Journey 34 — revocation must take effect NOW, not at token expiry.
//
// Flipping `sessions.revoked_at` is the durable record, but pat.go's
// verified-JWT fast path never reads that column. Before v0.5.335 only
// change-password published to the Redis denylist, so a logged-out cookie kept
// working for up to 24h. The browser clears its own copy on logout, which is
// exactly why this is invisible from the UI — so the test replays the captured
// cookie by hand, the way a stolen one would be used.
test.describe("34 — logout kills the session immediately", () => {
	let user: { email: string; password: string; username: string };

	test.beforeAll(async ({ baseURL }, testInfo) => {
		if (!localOtpEnabled() && !process.env.E2E_GMAIL_APP_PASSWORD) testInfo.skip(true, "no OTP source");
		if (!process.env.E2E_INVITATION_CODE) testInfo.skip(true, "no invitation code");
		user = await createUser(baseURL!, { tag: `rev-${Date.now().toString(36)}` });
	});

	test("a captured cookie stops working the moment the user logs out", async ({ page, context, baseURL }) => {
		await page.goto(`${baseURL}/auth/login`);
		await page.getByLabel(/email/i).fill(user.email);
		await page.getByLabel(/password/i).fill(user.password);
		await page.getByRole("button", { name: /sign in/i }).click();
		await page.waitForURL(/\/(studio|app)/, { timeout: 30_000 });

		// HttpOnly, so only the context can read it — same as an attacker who
		// has exfiltrated the cookie rather than the page's JS.
		const jar = await context.cookies();
		const sess = jar.find((c) => c.name === "lm_session");
		expect(sess, "no lm_session cookie after login").toBeTruthy();

		const api = await pwRequest.newContext({
			baseURL,
			extraHTTPHeaders: { Cookie: `lm_session=${sess!.value}` },
		});

		const before = await api.get("/api/v1/user");
		expect(before.status(), "captured cookie should work while signed in").toBe(200);

		await page.evaluate(async () => {
			await fetch("/api/v1/logout", { method: "POST", credentials: "same-origin" });
		});

		const after = await api.get("/api/v1/user");
		expect(
			after.status(),
			"the captured cookie still authenticates AFTER logout — revocation did not take effect",
		).toBe(401);

		await api.dispose();
	});
});

import { test, expect } from "@playwright/test";
import { createUser } from "../fixtures/test-user";
import { localOtpEnabled } from "../fixtures/otp-redis";

test.describe("33 — unscoped xpio feeds are tenant-scoped", () => {
	let user: { email: string; password: string; username: string };
	test.beforeAll(async ({ baseURL }, testInfo) => {
		if (!localOtpEnabled() && !process.env.E2E_GMAIL_APP_PASSWORD) testInfo.skip(true, "no OTP source");
		if (!process.env.E2E_INVITATION_CODE) testInfo.skip(true, "no invitation code");
		user = await createUser(baseURL!, { tag: `uns-${Date.now().toString(36)}` });
	});

	test("a plain user reads none of another tenant's strategies or results", async ({ page, baseURL }) => {
		await page.goto(`${baseURL}/auth/login`);
		// Wait for the form before filling. Under a full-suite run the app is
		// loaded enough that fill()'s 15s default expires on a page that is
		// simply still rendering -- which reads as a product failure and is not.
		const email = page.getByLabel(/email/i);
		await email.waitFor({ state: "visible", timeout: 60_000 });
		await email.fill(user.email);
		await page.getByLabel(/password/i).fill(user.password);
		await page.getByRole("button", { name: /sign in/i }).click();
		await page.waitForURL(/\/(studio|app)/, { timeout: 30_000 });

		const out = await page.evaluate(async () => {
			const b = await fetch("/api/v1/session-bearer", { credentials: "same-origin" });
			const d = await b.json().catch(() => null);
			const tok = d?.data?.token ?? d?.token ?? null;
			const hit = async (p: string) => {
				const r = await fetch(p, { credentials: "same-origin", headers: { Authorization: `Bearer ${tok}` } });
				const j = await r.json().catch(() => null);
				const arr = Array.isArray(j) ? j : (j?.strategies ?? j?.results ?? j?.items ?? null);
				return { status: r.status, count: Array.isArray(arr) ? arr.length : null, scope: j?.scope ?? null };
			};
			return {
				strategies: await hit("/dataapp-proxy/lqt/xpio/strategies?limit=1000"),
				results: await hit("/dataapp-proxy/lqt/xpio/results?limit=1000"),
			};
		});
		console.log("UNSCOPED AS PLAIN USER:", JSON.stringify(out));
		expect(out.strategies.count, "a plain user must not read every tenant's strategies").toBe(0);
		expect(out.results.count, "a plain user must not read every tenant's results").toBe(0);
	});
});

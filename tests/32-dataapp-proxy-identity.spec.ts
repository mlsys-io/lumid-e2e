import { test, expect } from "@playwright/test";
import { createUser } from "../fixtures/test-user";
import { localOtpEnabled } from "../fixtures/otp-redis";

// Journey 32 — /dataapp-proxy/lqt/ must carry the CALLER's identity.
//
// nginx used to set `Authorization: $lqt_auth` unconditionally on this location,
// replacing whatever the caller sent with a single shared service PAT. Every
// request therefore reached lumid-data-service as one principal (db86775d), so
// the `self_tenant` endpoints scoped to the PROXY rather than to the user:
// /xpio/strategies/mine answered every caller with db86775d's rows.
//
// A regular user owns no strategies, so the correct answer for them is an empty
// list. Seeing rows named `result.xvenue:*` here means the override is back.
test.describe("32 — dataapp-proxy forwards caller identity", () => {
	let user: { email: string; password: string; username: string };

	test.beforeAll(async ({ baseURL }, testInfo) => {
		if (!localOtpEnabled() && !process.env.E2E_GMAIL_APP_PASSWORD) {
			testInfo.skip(true, "no OTP source");
		}
		if (!process.env.E2E_INVITATION_CODE) testInfo.skip(true, "E2E_INVITATION_CODE not set");
		user = await createUser(baseURL!, { tag: `dap-${Date.now().toString(36)}` });
	});

	test("a signed-in user sees their OWN scoped rows, not the proxy's", async ({ page, baseURL }) => {
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

		// Exactly what the surface layer does: mint a session-bearer, attach it.
		const res = await page.evaluate(async () => {
			const b = await fetch("/api/v1/session-bearer", { credentials: "same-origin" });
			const d = await b.json().catch(() => null);
			const tok = d?.data?.token ?? d?.token ?? null;
			if (!tok) return { minted: false as const };
			const r = await fetch("/dataapp-proxy/lqt/xpio/strategies/mine?limit=50", {
				credentials: "same-origin",
				headers: { Authorization: `Bearer ${tok}` },
			});
			const body = await r.json().catch(() => null);
			return { minted: true as const, status: r.status, rows: Array.isArray(body) ? body : null };
		});

		expect(res.minted, "session-bearer should mint for a signed-in user").toBe(true);
		if (!res.minted) return;

		// A browser session-bearer must be ACCEPTED (it is an identity-issued JWT;
		// neither /oauth/introspect nor the data service checks `aud`).
		expect(res.status, "session-bearer rejected by the data service").toBe(200);
		expect(Array.isArray(res.rows)).toBe(true);

		const names = (res.rows ?? []).map((r: any) => String(r?.name ?? ""));
		const leaked = names.filter((n) => n.startsWith("result.xvenue:"));
		expect(leaked, "proxy identity leaked another tenant's rows to this user").toEqual([]);
		expect(res.rows!.length, "a brand-new user owns no strategies").toBe(0);
	});
});

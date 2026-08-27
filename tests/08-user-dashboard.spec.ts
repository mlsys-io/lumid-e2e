import { test, expect } from "@playwright/test";
import { createUser } from "../fixtures/test-user";
import { localOtpEnabled } from "../fixtures/otp-redis";

// Journey 8 — product surface at lum.id/app/*.
//   * signs a regular user in
//   * visits each of /app, /app/workflows, /app/tasks, /app/billing
//   * asserts route returns 200 and the product sidebar renders
//   * verifies xp.io banner on /app/workflows links to xp.io/marketplace
//   * verifies session-bearer endpoint issues a runmesh:user scope JWT
//   * verifies identity pages at /auth/account/* still work
//     (coexistence with ported product pages)

test.describe("08 — /app/* product surface", () => {
	let user: { email: string; password: string; username: string };

	test.beforeAll(async ({ baseURL }, testInfo) => {
		if (!localOtpEnabled() && !process.env.E2E_GMAIL_APP_PASSWORD) {
			testInfo.skip(true, "no OTP source: set E2E_GMAIL_APP_PASSWORD, or CI_E2E_LOCAL_OTP=1 for the Redis backdoor");
		}
		if (!process.env.E2E_INVITATION_CODE) testInfo.skip(true, "E2E_INVITATION_CODE not set");
		user = await createUser(baseURL!, { tag: `app-${Date.now().toString(36)}` });
	});

	async function signIn(page: import("@playwright/test").Page, baseURL: string) {
		await page.goto(`${baseURL}/auth/login`);
		await page.getByLabel(/email/i).fill(user.email);
		await page.getByLabel(/password/i).fill(user.password);
		await page.getByRole("button", { name: /sign in/i }).click();
		// A role=user lands in Studio since the S5 cutover; /app/* itself was
		// retired in S7. Accept the whole modern landing set rather than the two
		// pre-cutover prefixes, which no longer match anything for this role.
		await page.waitForURL(/\/dashboard|\/studio|\/app(\/|$)/, { timeout: 20_000 });
	}

	// REPLACES two tests that asserted the /app/* shell: an AppLayout sidebar
	// (Apps/Workflows/Tasks/Billing) and an xp.io banner on /app/workflows.
	// That shell was retired in the S7 cutover -- App.tsx now maps every /app/*
	// path to a <Navigate>, and its lazy page imports were deleted in 2026-06.
	// Asserting its chrome finds a rename, not a bug.
	//
	// What is still worth protecting is the REDIRECTS themselves: /app/* URLs
	// are live deep links in older docs and bookmarks, and silently breaking
	// them is a real regression. So assert where they land, not what they render.
	test("retired /app/* deep links still redirect into Studio", async ({ page, baseURL }) => {
		await signIn(page, baseURL!);
		// The /studio/apps targets are asserted as "somewhere in Studio", not as an
		// exact path: /studio/apps is StudioWorkspace, which self-redirects again to
		// /studio/apps/<app> -- or back to /studio when the account has no apps
		// installed, which a fresh fixture user never does. Chromium happened to
		// assert between the two hops and Firefox after, so pinning the exact path
		// made this browser-dependent. The claim worth defending is that a retired
		// deep link lands in Studio rather than 404ing.
		const hops: [string, RegExp][] = [
			["/app", /\/studio(\/|$)/],
			["/app/loops", /\/studio(\/|$)/],
			["/app/knowledge", /\/studio\/knowledge/],
			["/app/results", /\/studio(\/|$)/],
			// Anything unmatched falls through the /app/* catch-all.
			["/app/nonexistent-surface", /\/studio(\/|$)/],
		];
		for (const [from, to] of hops) {
			// waitUntil:"commit" — these are client-side <Navigate> redirects, so the
			// SPA replaces the URL before "load" fires and Firefox rejects the goto
			// with "interrupted by another navigation" while Chromium tolerates it.
			// That interruption IS the redirect working; wait for commit and then
			// assert where we ended up.
			await page.goto(`${baseURL}${from}`, { waitUntil: "commit" }).catch(() => {});
			await expect(page, `GET ${from}`).toHaveURL(to, { timeout: 15_000 });
		}
	});

	test("session-bearer mints runmesh:user scope JWT", async ({ page, baseURL, request }) => {
		await signIn(page, baseURL!);
		// Same-origin request with the session cookie, asking for user scope.
		const resp = await request.get(`${baseURL}/api/v1/session-bearer?scope=user`, {
			headers: { Cookie: (await page.context().cookies()).map(c => `${c.name}=${c.value}`).join("; ") },
		});
		expect(resp.status()).toBe(200);
		const body = await resp.json();
		expect(body?.data?.token).toBeTruthy();

		// Decode the JWT payload (no signature check — we just want the scope)
		const payload = JSON.parse(
			Buffer.from(body.data.token.split(".")[1], "base64url").toString("utf-8")
		);
		// `scope` is a space-delimited STRING (the OAuth 2 convention), not an
		// array -- this asserted arrayContaining and failed on "runmesh:user".
		// Accept either shape, then assert membership rather than equality so an
		// added scope does not break it.
		const rawScope = payload?.scope ?? payload?.scopes;
		const scopes = Array.isArray(rawScope) ? rawScope : String(rawScope ?? "").split(/\s+/);
		expect(scopes).toContain("runmesh:user");
		// `aud` is legitimately either a string or an array of strings
		// (RFC 7519 4.1.3); identity emits the array form. Normalise the same
		// way as `scope` above rather than pinning one shape.
		const aud = Array.isArray(payload?.aud) ? payload.aud : [payload?.aud];
		expect(aud).toContain("runmesh");
	});

	test("invalid scope returns 400", async ({ request, baseURL }) => {
		// No auth needed to hit the error path — handler validates scope
		// first, but we don't have session cookies here. Accept either
		// 400 (scope invalid) if the handler checks scope before auth,
		// or 401 (unauth) if it doesn't. What we really care about is
		// that scope=bogus never mints a token.
		const resp = await request.get(`${baseURL}/api/v1/session-bearer?scope=definitely-not-valid`, {
			failOnStatusCode: false,
		});
		expect([400, 401]).toContain(resp.status());
	});

	test("identity pages at /auth/account/* still serve", async ({ page, baseURL }) => {
		await signIn(page, baseURL!);
		// Port didn't break the identity tree — confirm /dashboard/profile
		// (the new home of identity; /auth/account/* one-hop redirects).
		await page.goto(`${baseURL}/dashboard/profile`);
		await expect(page.getByText(/profile/i).first()).toBeVisible();
	});
});

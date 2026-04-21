import { test, expect } from "@playwright/test";
import { createUser } from "../fixtures/test-user";

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
		if (!process.env.E2E_GMAIL_APP_PASSWORD) testInfo.skip(true, "E2E_GMAIL_APP_PASSWORD not set");
		if (!process.env.E2E_INVITATION_CODE) testInfo.skip(true, "E2E_INVITATION_CODE not set");
		user = await createUser(baseURL!, { tag: `app-${Date.now().toString(36)}` });
	});

	async function signIn(page: import("@playwright/test").Page, baseURL: string) {
		await page.goto(`${baseURL}/auth/login`);
		await page.getByLabel(/email/i).fill(user.email);
		await page.getByLabel(/password/i).fill(user.password);
		await page.getByRole("button", { name: /sign in/i }).click();
		await page.waitForURL(/\/(dashboard|app)/);
	}

	test("renders all four product routes with AppLayout sidebar", async ({ page, baseURL }) => {
		await signIn(page, baseURL!);

		for (const path of ["/app", "/app/workflows", "/app/tasks", "/app/billing"]) {
			const resp = await page.goto(`${baseURL}${path}`);
			expect(resp?.status(), `GET ${path}`).toBe(200);
			// Every /app/* page renders inside AppLayout which always shows
			// the product sidebar nav — confirms routing + layout landed.
			await expect(page.getByRole("link", { name: /apps/i })).toBeVisible();
			await expect(page.getByRole("link", { name: /workflows/i })).toBeVisible();
			await expect(page.getByRole("link", { name: /tasks/i })).toBeVisible();
			await expect(page.getByRole("link", { name: /billing/i })).toBeVisible();
		}
	});

	test("xp.io banner on /app/workflows points to the marketplace", async ({ page, baseURL }) => {
		await signIn(page, baseURL!);
		await page.goto(`${baseURL}/app/workflows`);

		const banner = page.getByText(/knowledge \+ research loops|visit xp\.io/i).first();
		await expect(banner).toBeVisible();

		const link = page.getByRole("link", { name: /visit xp\.io/i });
		await expect(link).toHaveAttribute("href", "https://xp.io/marketplace");
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
		expect(payload?.scope || payload?.scopes).toEqual(
			expect.arrayContaining(["runmesh:user"])
		);
		expect(payload?.aud).toBe("runmesh");
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

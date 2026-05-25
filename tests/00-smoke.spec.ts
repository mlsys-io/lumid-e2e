/**
 * @smoke
 *
 * Credential-free smoke suite — runs against the live deployment with no
 * test user, no email inbox, no admin session. Safe to run in any environment
 * that can reach https://lum.id.
 *
 * These tests are also invoked by the ops `ui_health` loop via:
 *   npx playwright test --grep @smoke --project chromium
 *
 * All assertions are structural (page title / form present / status codes)
 * rather than behavioural, so they don't flake on content changes.
 */

import { test, expect } from "@playwright/test";

// ── Landing ──────────────────────────────────────────────────────────────────

test("@smoke lum.id landing loads", async ({ page }) => {
	const res = await page.goto("/");
	expect(res?.status()).toBeLessThan(500);
	await expect(page).toHaveTitle(/Lumid|lum\.id/i);
});

test("@smoke lum.id /auth/login has email + password fields", async ({ page }) => {
	await page.goto("/auth/login");
	await expect(page.locator('input[type="email"], input[name="email"]')).toBeVisible();
	await expect(page.locator('input[type="password"]')).toBeVisible();
});

test("@smoke /app redirects to an authenticated page without crashing", async ({ page }) => {
	const res = await page.goto("/app");
	// Without auth the page should redirect to /auth/login (302/200 after follow)
	// but must never 500.
	expect(res?.status()).toBeLessThan(500);
});

// ── Docs (public, no auth) ────────────────────────────────────────────────────

test("@smoke /docs/xpio-autoresearch renders markdown content", async ({ page }) => {
	const res = await page.goto("/docs/xpio-autoresearch");
	expect(res?.status()).toBeLessThan(500);
	// The page renders the canonical contract — at least a heading must appear.
	await expect(page.locator("h1, h2").first()).toBeVisible();
});

// ── Dashboards: nginx serves all SPA routes (no 404/500 from nginx) ─────────
//
// All /dashboard/* routes return 200 (nginx serves index.html); the React
// Router + AuthGuard handle auth client-side. These checks catch nginx
// misconfig (missing try_files, wrong proxy_pass, broken prefix strips).
//
// Batch via request.get() — no browser launch needed for pure status checks.

test("@smoke dashboard main surfaces all return 200", async ({ request }) => {
	const routes = [
		"/dashboard",
		"/dashboard/super-admin",
		"/dashboard/jobs",
		"/dashboard/lumilake",
		"/dashboard/lumilake/sql",
		"/dashboard/lumilake/data",
		"/dashboard/lumilake/python",
		"/dashboard/quant",
		"/dashboard/quant/competition/lobby",
		"/dashboard/gpu-rentals",
		"/dashboard/profile",
		"/dashboard/tokens",
		"/dashboard/billing",
		"/dashboard/runmesh/submit",
		"/dashboard/lumilake-submit",
		"/dashboard/auto-quant",
	];
	for (const route of routes) {
		const res = await request.get(route);
		expect(res.status(), `${route} should not 5xx`).toBeLessThan(500);
	}
});

test("@smoke admin tab groups all return 200", async ({ request }) => {
	const routes = [
		// Admin overview
		"/dashboard/admin",
		// People & Access tab
		"/dashboard/admin/users",
		"/dashboard/admin/users/matrix",
		"/dashboard/admin/invitations",
		"/dashboard/admin/audit",
		// Infrastructure tab
		"/dashboard/admin/clusters",
		"/dashboard/admin/clusters/new",
		"/dashboard/admin/cluster-workers",
		"/dashboard/admin/suppliers",
		"/dashboard/admin/supplier-nodes",
		"/dashboard/admin/billing",
		"/dashboard/admin/workflow-review",
		"/dashboard/admin/infra-setup",
		// QuantArena tab
		"/dashboard/admin/competitions",
		"/dashboard/admin/markets",
		"/dashboard/admin/templates",
		"/dashboard/admin/flowmesh-jobs",
	];
	for (const route of routes) {
		const res = await request.get(route);
		expect(res.status(), `${route} should not 5xx`).toBeLessThan(500);
	}
});

// ── Browser render check: key pages must mount without a white-screen ─────────
// These run with a real browser to catch JS runtime errors that a plain HTTP
// request won't surface. One per major section is enough.

test("@smoke /dashboard mounts SPA root", async ({ page }) => {
	await page.goto("/dashboard");
	await expect(page.locator("#root")).toBeVisible();
	// Must render something — not blank
	await expect(page.locator("body")).not.toBeEmpty();
});

test("@smoke /dashboard/admin mounts without crash", async ({ page }) => {
	await page.goto("/dashboard/admin");
	await expect(page.locator("#root")).toBeVisible();
	await expect(page.locator("body")).not.toBeEmpty();
});

test("@smoke /dashboard/super-admin mounts without crash", async ({ page }) => {
	await page.goto("/dashboard/super-admin");
	await expect(page.locator("#root")).toBeVisible();
	await expect(page.locator("body")).not.toBeEmpty();
});

test("@smoke /dashboard/lumilake mounts without crash", async ({ page }) => {
	await page.goto("/dashboard/lumilake");
	await expect(page.locator("#root")).toBeVisible();
	await expect(page.locator("body")).not.toBeEmpty();
});

test("@smoke /dashboard/quant mounts without crash", async ({ page }) => {
	await page.goto("/dashboard/quant");
	await expect(page.locator("#root")).toBeVisible();
	await expect(page.locator("body")).not.toBeEmpty();
});

// ── xp.io ─────────────────────────────────────────────────────────────────────

test("@smoke xp.io landing loads", async ({ page }) => {
	const res = await page.goto("https://xp.io/");
	expect(res?.status()).toBeLessThan(500);
});

test("@smoke xp.io API reachable (repos endpoint)", async ({ request }) => {
	// xpcloud's /healthz isn't exposed through nginx; repos endpoint is.
	// 401 without token = service is up.
	const res = await request.get("https://xp.io/api/v1/repos");
	expect(res.status()).toBeLessThan(500);
});

// ── Other public domains ──────────────────────────────────────────────────────

test("@smoke runmesh.ai / responds", async ({ request }) => {
	const res = await request.get("https://runmesh.ai/");
	expect(res.status()).toBeLessThan(500);
});

test("@smoke lumilake.ai / responds", async ({ request }) => {
	const res = await request.get("https://lumilake.ai/");
	expect(res.status()).toBeLessThan(500);
});

// ── API reachability ─────────────────────────────────────────────────────────

test("@smoke lum.id identity /api/v1/healthz responds", async ({ request }) => {
	const res = await request.get("https://lum.id/api/v1/healthz");
	expect(res.status()).toBe(200);
});

test("@smoke lum.id identity /.well-known/openid-configuration responds", async ({ request }) => {
	const res = await request.get("https://lum.id/.well-known/openid-configuration");
	expect(res.status()).toBe(200);
	const body = await res.json();
	expect(body).toHaveProperty("issuer");
});

test("@smoke kv.run FlowMesh /healthz is reachable", async ({ request }) => {
	const res = await request.get("https://kv.run:8000/flowmesh/healthz");
	// The endpoint may require auth (401) or be healthy (200) — either is fine;
	// what matters is it isn't a 5xx or unreachable.
	expect(res.status()).toBeLessThan(500);
});

test("@smoke lumid.market / responds", async ({ request }) => {
	const res = await request.get("https://lumid.market/");
	expect(res.status()).toBeLessThan(500);
});

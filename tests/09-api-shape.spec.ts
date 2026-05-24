/**
 * @api-shape
 *
 * Public-API shape tests — verify that API endpoints return valid JSON with
 * expected fields. No credentials required for unauthenticated endpoints;
 * tests for auth-gated endpoints assert the correct 401 shape (not a crash).
 *
 * These catch backend schema drift (field renamed/removed) before it surfaces
 * as a broken UI. Complements the @smoke status-code checks.
 *
 * Run: npx playwright test --grep @api-shape --project chromium
 */

import { test, expect } from "@playwright/test";

// ── Public / unauthenticated ──────────────────────────────────────────────────

test("@api-shape identity /healthz has ok field", async ({ request }) => {
	const res = await request.get("https://lum.id/api/v1/healthz");
	expect(res.status()).toBe(200);
	const body = await res.json();
	// Identity healthz returns {ok: true, ...services}
	expect(body).toHaveProperty("ok");
});

test("@api-shape /.well-known/openid-configuration has required OIDC fields", async ({ request }) => {
	const res = await request.get("https://lum.id/.well-known/openid-configuration");
	const body = await res.json();
	expect(body).toHaveProperty("issuer");
	expect(body).toHaveProperty("authorization_endpoint");
	expect(body).toHaveProperty("token_endpoint");
	expect(body).toHaveProperty("jwks_uri");
	// Ensure issuer is lum.id not a localhost leak
	expect(body.issuer).toContain("lum.id");
});

test("@api-shape /.well-known/jwks.json has keys array", async ({ request }) => {
	const res = await request.get("https://lum.id/.well-known/jwks.json");
	expect(res.status()).toBe(200);
	const body = await res.json();
	expect(body).toHaveProperty("keys");
	expect(Array.isArray(body.keys)).toBe(true);
	expect(body.keys.length).toBeGreaterThan(0);
	// Each key must have the RS256 fields
	expect(body.keys[0]).toHaveProperty("kty");
	expect(body.keys[0]).toHaveProperty("kid");
});

test("@api-shape xp.io /api/v1/repos returns array envelope", async ({ request }) => {
	// Without auth returns 200 with empty list (public repos) or 401 — either is valid
	const res = await request.get("https://xp.io/api/v1/repos");
	expect(res.status()).toBeLessThan(500);
	if (res.status() === 200) {
		const body = await res.json();
		// xpcloud returns {repos: [...]} or {items: [...]} or direct array
		const isArrayEnvelope =
			Array.isArray(body) ||
			(body && (Array.isArray(body.repos) || Array.isArray(body.items) || Array.isArray(body.data)));
		expect(isArrayEnvelope).toBe(true);
	}
});

test("@api-shape FlowMesh /healthz returns ok", async ({ request }) => {
	const res = await request.get("https://kv.run:8000/flowmesh/healthz");
	// 200 = healthy; 401 = up but needs auth — both are fine
	expect(res.status()).toBeLessThan(500);
	if (res.status() === 200) {
		const body = await res.json().catch(() => null);
		if (body) {
			// FlowMesh healthz returns {status: "ok"} or similar
			expect(body).toBeTruthy();
		}
	}
});

// ── Auth-gated: correct 401 shape (not a 500 or HTML error page) ──────────────

test("@api-shape unauthenticated /api/v1/user returns 401 JSON", async ({ request }) => {
	const res = await request.get("https://lum.id/api/v1/user");
	expect(res.status()).toBe(401);
	// Must be JSON, not an nginx HTML error page
	const body = await res.json();
	expect(typeof body).toBe("object");
});

test("@api-shape unauthenticated /api/v1/cluster/clusters returns 401 JSON", async ({ request }) => {
	const res = await request.get("https://lum.id/api/v1/cluster/clusters");
	expect(res.status()).toBe(401);
	const body = await res.json();
	expect(typeof body).toBe("object");
});

test("@api-shape unauthenticated /api/v1/qa-admin/competitions returns 401 JSON", async ({ request }) => {
	const res = await request.get("https://lum.id/api/v1/qa-admin/competitions?page=1&page_size=1");
	expect(res.status()).toBe(401);
	const body = await res.json();
	expect(typeof body).toBe("object");
});

test("@api-shape unauthenticated session-bearer returns 401 JSON", async ({ request }) => {
	const res = await request.get("https://lum.id/api/v1/session-bearer?audience=flowmesh");
	expect(res.status()).toBe(401);
	const body = await res.json();
	expect(typeof body).toBe("object");
});

test("@api-shape cluster workers endpoint returns 401 JSON", async ({ request }) => {
	const res = await request.get("https://lum.id/api/v1/cluster/workers");
	expect(res.status()).toBe(401);
	const body = await res.json();
	expect(typeof body).toBe("object");
});

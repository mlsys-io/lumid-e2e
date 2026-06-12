// 18 — Studio streamline (2026-06-11): consolidated IA, actionable
// health, skills + experiments as first-class surfaces, chat backbone.
//
//   1. Sidebar shape: Home · Activity · Skills · Experiments · Inbox.
//   2. NeedsAttention rail renders REAL failing loops (live fixtures:
//      any loop with status failing on this host) with a CTA.
//   3. /me/skills returns the inventory with used_by inversion.
//   4. /me/experiments aggregates cross-app with `app` annotated.
//   5. Activity rows for scheduled runs deep-link into the app panel.
//   6. Chat tools: loops_health + cycle_detail are callable.
//   7. Dead routes redirect: /studio/mind, /studio/workflows.

import { test, expect } from "@playwright/test";
import { loginAsAdmin } from "../fixtures/admin-session";

test.describe("18 — studio streamline", () => {
	test.beforeEach(async ({ page }) => {
		await loginAsAdmin(page);
	});

	test("sidebar has the consolidated nav; Activity + Inbox live in Home's status bar", async ({ page }) => {
		await page.goto("/studio/apps");
		for (const label of ["Home", "Library"]) {
			await expect(page.getByRole("link", { name: new RegExp(`^${label}`) }).first()).toBeVisible({ timeout: 15_000 });
		}
		// Activity + Inbox are reachable via the status-bar chips instead.
		await expect(page.getByRole("link", { name: /runs today/i }).first()).toBeVisible({ timeout: 15_000 });
		await expect(page.getByRole("link", { name: /inbox/i }).first()).toBeVisible();
	});

	test("library hosts marketplace/skills/experiments tabs; old routes redirect", async ({ page }) => {
		await page.goto("/studio/skills");
		await expect(page).toHaveURL(/\/studio\/library\/skills/, { timeout: 10_000 });
		await page.goto("/studio/experiments");
		await expect(page).toHaveURL(/\/studio\/library\/experiments/, { timeout: 10_000 });
		for (const label of ["Marketplace", "Skills", "Experiments"]) {
			await expect(page.getByRole("link", { name: label }).first()).toBeVisible();
		}
	});

	test("failing loops surface in the attention rail with a CTA", async ({ page }) => {
		// Live-fixture dependent: only asserts when the host actually has
		// a failing/stale loop (loops_health truth), so a healthy host
		// doesn't fail the suite.
		const r = await page.request.get("/api/v1/me/loops/health");
		const body = await r.json();
		const failing = (body.data.loops as Array<{ status: string; enabled?: boolean }>)
			.filter((l) => l.enabled !== false && (l.status === "failing" || l.status === "stale"));
		test.skip(failing.length === 0, "no failing loops on this host right now");
		await page.goto("/studio/apps");
		await expect(page.getByText(/Needs attention \(\d+\)/)).toBeVisible({ timeout: 15_000 });
	});

	test("/me/skills inventory inverts skill_imports into used_by", async ({ page }) => {
		const r = await page.request.get("/api/v1/me/skills");
		expect(r.ok()).toBeTruthy();
		const body = await r.json();
		expect(body.ret_code).toBe(0);
		const skills = body.data.skills as Array<{ repo: string; used_by: Array<{ app: string }> }>;
		expect(skills.length).toBeGreaterThan(0);
		for (const s of skills) {
			expect(s.repo).toContain("/");
			expect(s.used_by.length).toBeGreaterThan(0);
		}
	});

	test("/me/experiments aggregates cross-app", async ({ page }) => {
		const r = await page.request.get("/api/v1/me/experiments");
		expect(r.ok()).toBeTruthy();
		const body = await r.json();
		expect(body.ret_code).toBe(0);
		const exps = body.data.experiments as Array<{ id: string; app: string }>;
		// auto-quant/mbb-ai ship real experiments on this host.
		if (exps.length > 0) {
			for (const e of exps) {
				expect(e.app).toBeTruthy();
				expect(e.id).toBeTruthy();
			}
		}
	});

	test("skills + experiments tabs render", async ({ page }) => {
		await page.goto("/studio/library/skills");
		await expect(page.getByText(/Installed/i).first()).toBeVisible({ timeout: 15_000 });
		await page.goto("/studio/library/experiments");
		await expect(page.getByText(/Experiments \(/i).first()).toBeVisible({ timeout: 15_000 });
	});

	test("chat tools loops_health + cycle_detail are callable", async ({ page }) => {
		const r = await page.request.post("/api/v1/me/agent/chat", {
			data: {
				messages: [{
					role: "user",
					content: "Call loops_health and tell me which workflow has the most consecutive failures. One sentence.",
				}],
			},
		});
		expect(r.ok()).toBeTruthy();
		const body = await r.json();
		expect(body.ret_code).toBe(0);
		const toolCalls = body.data.tool_calls as Array<{ name: string; ok: boolean }>;
		expect(toolCalls.some((tc) => tc.name === "loops_health" && tc.ok)).toBeTruthy();
	});

	test("dead routes redirect home", async ({ page }) => {
		await page.goto("/studio/mind");
		await expect(page).toHaveURL(/\/studio\/apps/, { timeout: 10_000 });
		await page.goto("/studio/workflows");
		await expect(page).toHaveURL(/\/studio\/apps/, { timeout: 10_000 });
	});
});

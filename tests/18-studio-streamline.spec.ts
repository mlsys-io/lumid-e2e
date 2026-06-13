// 18 — Studio streamline (2026-06-11) + claude-style index→chat nav
// (2026-06-13): every nav destination is a light list whose rows open
// the grounded chat; dense panels survive as "details →" escape hatches.
//
//   1. Sidebar shape (claude.ai layout): Apps · Library · Jobs;
//      /studio itself is the AI chat (greeting + composer card).
//   2. Apps is a light index (clickable rows), not a stat-chip dashboard.
//   3. /me/skills returns the inventory with used_by inversion.
//   4. /me/experiments aggregates cross-app with `app` annotated.
//   5. Opening an app row lands in the chat (/studio).
//   6. Chat tools: loops_health + cycle_detail are callable.
//   7. Dead routes redirect: /studio/mind, /studio/workflows.

import { test, expect } from "@playwright/test";
import { loginAsAdmin } from "../fixtures/admin-session";

test.describe("18 — studio streamline", () => {
	test.beforeEach(async ({ page }) => {
		await loginAsAdmin(page);
	});

	test("sidebar has the consolidated nav (Apps · Library · Jobs)", async ({ page }) => {
		await page.goto("/studio/apps");
		for (const label of ["Apps", "Library", "Jobs"]) {
			await expect(page.getByRole("link", { name: new RegExp(`^${label}`) }).first()).toBeVisible({ timeout: 15_000 });
		}
	});

	test("/studio is the AI chat — greeting + composer card", async ({ page }) => {
		await page.goto("/studio");
		await expect(page.getByRole("heading", { name: /^Good (morning|afternoon|evening)/ })).toBeVisible({ timeout: 15_000 });
		await expect(page.getByPlaceholder(/Ask anything/)).toBeVisible();
	});

	test("Apps is a light index whose title is 'Apps' and rows open the chat", async ({ page }) => {
		await page.goto("/studio/apps");
		// Serif page title, not a stat-chip hero.
		await expect(page.getByRole("heading", { name: "Apps" })).toBeVisible({ timeout: 15_000 });
		// First app row → grounded chat (with pref=ask it autosends and lands on /studio).
		const row = page.getByRole("button").filter({ hasText: /healthy|failing|running|idle/ }).first();
		if (await row.count()) {
			await row.click();
			await expect(page).toHaveURL(/\/studio(\?|$)/, { timeout: 10_000 });
		}
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

	test("app surfaces open in chat; ?full=1 is the escape hatch", async ({ page }) => {
		// Opening an app surface drops into the grounded chat (deeper migration).
		await page.goto("/studio/a/mbb-ai");
		await expect(page).toHaveURL(/\/studio(\?|$)/, { timeout: 10_000 });
		// The full standalone page is still reachable explicitly.
		await page.goto("/studio/a/mbb-ai?full=1");
		await expect(page).toHaveURL(/\/studio\/a\/mbb-ai\?full=1/, { timeout: 10_000 });
	});

	test("chat can operate apps: app_read is callable on the standard path", async ({ page }) => {
		// Force a kv.run model so the request uses the me_agent tool path
		// (the claude-code provider bypasses these tools).
		const r = await page.request.post("/api/v1/me/agent/chat", {
			data: {
				model: "kvrun-gemma4",
				messages: [{ role: "user", content: "Call app_read with source me://gpu-rentals and report the count. One sentence." }],
			},
		});
		expect(r.ok()).toBeTruthy();
		const body = await r.json();
		expect(body.ret_code).toBe(0);
		const toolCalls = body.data.tool_calls as Array<{ name: string; ok: boolean }>;
		expect(toolCalls.some((tc) => tc.name === "app_read" && tc.ok)).toBeTruthy();
	});

	test("dead routes redirect home", async ({ page }) => {
		await page.goto("/studio/mind");
		await expect(page).toHaveURL(/\/studio\/apps/, { timeout: 10_000 });
		await page.goto("/studio/workflows");
		await expect(page).toHaveURL(/\/studio\/apps/, { timeout: 10_000 });
	});
});

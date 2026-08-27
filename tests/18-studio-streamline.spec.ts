// 18 — Studio streamline (2026-06-11) + claude-style index→chat nav
// (2026-06-13): every nav destination is a light list whose rows open
// the grounded chat; dense panels survive as "details →" escape hatches.
//
//   1. Sidebar shape (claude.ai layout): Data · Library · Scheduled;
//      /studio itself is the AI chat (greeting + composer card).
//   2. /studio/apps/all is a light index (clickable rows), not a stat-chip
//      dashboard. (/studio/apps is the workspace now, not the index.)
//   3. /me/skills returns the inventory with used_by inversion.
//   4. /me/experiments aggregates cross-app with `app` annotated.
//   5. Opening an app row lands in that app's workspace (/studio/apps/:app).
//   6. Chat tools: loops_health + cycle_detail are callable.
//   7. Dead routes redirect: /studio/mind, /studio/workflows.

import { test, expect } from "@playwright/test";
import { loginAsAdmin } from "../fixtures/admin-session";
import { watchConsole } from "../fixtures/console-watch";
import { ensureSeedApp, skillInventoryPopulated, SEED_APP } from "../fixtures/seed-app";
import { gotoRedirect } from "../fixtures/nav";

test.describe("18 — studio streamline", () => {
	// /me/skills and /me/experiments assert on non-empty collections, which only
	// held for an account that already had apps installed.
	let seeded = false;
	test.beforeEach(async ({ page }, testInfo) => {
		await loginAsAdmin(page);
		if (!seeded) seeded = await ensureSeedApp(page.request);
		if (!seeded) testInfo.skip(true, "could not seed an installed app for this account");
	});

	// Asserted Apps · Library · Jobs; StudioShell's TOP_NAV is Data · Library ·
	// Scheduled. "Apps" left the rail when every installed app got its own
	// folder in the pinned "Your Apps" section — the flat index it used to open
	// now lives at /studio/apps/all, reached from the user menu's "Manage apps".
	// The runs destination is still there, labelled "Scheduled" in the rail;
	// "Jobs" survives only as that page's own IndexList title, which is what
	// this was matching before the rail was relabelled.
	test("sidebar has the consolidated nav (Data · Library · Scheduled)", async ({ page }) => {
		const errors = watchConsole(page);
		await gotoRedirect(page, "/studio/apps");
		for (const label of ["Data", "Library", "Scheduled"]) {
			await expect(page.getByRole("link", { name: new RegExp(`^${label}`) }).first()).toBeVisible({ timeout: 15_000 });
		}
		expect(errors(), `console errors:\n${errors().join("\n")}`).toEqual([]);
	});

	test("/studio is the AI chat — greeting + composer card", async ({ page }) => {
		const errors = watchConsole(page);
		await gotoRedirect(page, "/studio");
		await expect(page.getByRole("heading", { name: /^Good (morning|afternoon|evening)/ })).toBeVisible({ timeout: 15_000 });
		await expect(page.getByPlaceholder(/Ask anything/)).toBeVisible();
		expect(errors(), `console errors:\n${errors().join("\n")}`).toEqual([]);
	});

	// The index moved out from under /studio/apps. That path is now
	// StudioWorkspace (one featured app · details · docked chat) and it
	// replaces itself with /studio/apps/<app> on mount, so the flat list never
	// renders there — it is /studio/apps/all now. The title moved with it:
	// AppsHome renders IndexList title="Agents" after the Phase 4 app→agent
	// rename, so "Apps" matches no heading anywhere.
	test("the agent index is a light list whose rows open the app", async ({ page }) => {
		const errors = watchConsole(page);
		await gotoRedirect(page, "/studio/apps/all");
		// Serif page title, not a stat-chip hero.
		await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 15_000 });
		// A row used to fire the grounded ask and land you on /studio. IndexRow
		// grew a `navTo` that apps set, so the PRIMARY click now opens the app's
		// own workspace and the grounded ask demoted to the hover-only "ask"
		// affordance on the row. Same rows, different destination.
		const row = page.getByRole("button").filter({ hasText: /healthy|failing|running|idle/ }).first();
		if (await row.count()) {
			await row.click();
			await expect(page).toHaveURL(/\/studio\/apps\/(?!all(\?|$))[^/]+/, { timeout: 10_000 });
		}
		expect(errors(), `console errors:\n${errors().join("\n")}`).toEqual([]);
	});

	test("library hosts marketplace/skills/experiments tabs; old routes redirect", async ({ page }) => {
		await gotoRedirect(page, "/studio/skills");
		await expect(page).toHaveURL(/\/studio\/library\/skills/, { timeout: 10_000 });
		await gotoRedirect(page, "/studio/experiments");
		await expect(page).toHaveURL(/\/studio\/library\/experiments/, { timeout: 10_000 });
		for (const label of ["Marketplace", "Skills", "Experiments"]) {
			await expect(page.getByRole("link", { name: label }).first()).toBeVisible();
		}
	});

	test("/me/skills inventory inverts skill_imports into used_by", async ({ page }, testInfo) => {
		// Skipped, not failed, when the inventory is empty: /me/skills walks the
		// filesystem and cannot see a tenant install — the account IS seeded.
		// See fixtures/seed-app.ts::skillInventoryPopulated for the evidence.
		testInfo.skip(
			!(await skillInventoryPopulated(page.request)),
			"/me/skills is blind to tenant installs (filesystem-backed, per-replica)",
		);
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

	test("skills + experiments tabs render", async ({ page }, testInfo) => {
		// "Installed" only renders when the inventory is non-empty, which the
		// filesystem-backed endpoint cannot report for a tenant install.
		testInfo.skip(
			!(await skillInventoryPopulated(page.request)),
			"/me/skills is blind to tenant installs (filesystem-backed, per-replica)",
		);
		await gotoRedirect(page, "/studio/library/skills");
		await expect(page.getByText(/Installed/i).first()).toBeVisible({ timeout: 15_000 });
		await gotoRedirect(page, "/studio/library/experiments");
		// Was /Experiments \(/ — the count in parens went away when the page was
		// ported onto the shared IndexList, which renders a bare `title` heading
		// ("Experiments") and puts the row count nowhere. Assert the heading so
		// this can't pass on the nav tab of the same name.
		// Scoped to main: the shell's banner also renders an h1 "Experiments", so
		// an unscoped role query is a strict-mode violation rather than a missing
		// element -- the page is rendering fine. Same collision class as the
		// "Display name" one in spec 05.
		await expect(
			page.getByRole("main").getByRole("heading", { name: "Experiments" }).first(),
		).toBeVisible({ timeout: 15_000 });
	});

	test("chat tools loops_health + cycle_detail are callable", async ({ page }) => {
		// A real budget, and a pinned model.
		//
		// Playwright's default request timeout is 15s; an agentic turn here
		// legitimately runs 15-170s, so these failed on the harness's clock
		// rather than on anything the product did. 290s stays under nginx's
		// 300s proxy_read_timeout for /api/v1/me/, so a genuine overrun still
		// surfaces as a 504 instead of being masked.
		//
		// The model is pinned because the tool CATALOG depends on the
		// provider: claude-code-* runs the turn as a subprocess in the sandbox
		// with the lumid MCP surface and NONE of the identity-side tools these
		// specs assert on. super_admin's default is claude-code-sonnet, so an
		// unpinned call asks an agent that genuinely lacks the tool to use it.
		const r = await page.request.post("/api/v1/me/agent/chat", {
			timeout: 290_000,
			data: {
				model: "deepseek-v4-flash",
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

	test("app surfaces open in the workspace; ?full=1 is the escape hatch", async ({ page }) => {
		// Opening an app surface used to drop you on /studio with the app stashed
		// as chat grounding. OpenAppRedirect now sends the bare route to the app
		// WORKSPACE instead — same 3-panel destination, and the grounded chat is
		// the docked right rail there rather than the whole page.
		// Uses the SEEDED app, not a hardcoded `mbb-ai`. /studio/apps/<app>
		// self-redirects to /studio when the account does not have that app, so
		// naming someone else's app made this assert on a redirect chain that
		// ends nowhere -- it landed on /studio, which is correct behaviour for an
		// app you have not installed.
		const app = SEED_APP.name;
		await gotoRedirect(page, `/studio/a/${app}`);
		await expect(page).toHaveURL(new RegExp(`/studio/apps/${app}`), { timeout: 10_000 });
		// The full standalone page is still reachable explicitly.
		await gotoRedirect(page, `/studio/a/${app}?full=1`);
		await expect(page).toHaveURL(new RegExp(`/studio/a/${app}\\?full=1`), { timeout: 10_000 });
	});

	test("chat can operate apps: app_read is callable on the standard path", async ({ page }) => {
		// Force a kv.run model so the request uses the me_agent tool path
		// (the claude-code provider bypasses these tools).
		// A real budget, and a pinned model.
		//
		// Playwright's default request timeout is 15s; an agentic turn here
		// legitimately runs 15-170s, so these failed on the harness's clock
		// rather than on anything the product did. 290s stays under nginx's
		// 300s proxy_read_timeout for /api/v1/me/, so a genuine overrun still
		// surfaces as a 504 instead of being masked.
		//
		// The model is pinned because the tool CATALOG depends on the
		// provider: claude-code-* runs the turn as a subprocess in the sandbox
		// with the lumid MCP surface and NONE of the identity-side tools these
		// specs assert on. super_admin's default is claude-code-sonnet, so an
		// unpinned call asks an agent that genuinely lacks the tool to use it.
		const r = await page.request.post("/api/v1/me/agent/chat", {
			// The comment above describes a 290s budget, but this call never set
			// one -- so it failed on Playwright's 15s default rather than on
			// anything the product did. Its sibling agentic tests in this file
			// already pass it; this one was missed.
			timeout: 290_000,
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
		await gotoRedirect(page, "/studio/mind");
		await expect(page).toHaveURL(/\/studio\/apps/, { timeout: 10_000 });
		await gotoRedirect(page, "/studio/workflows");
		await expect(page).toHaveURL(/\/studio\/apps/, { timeout: 10_000 });
	});
});

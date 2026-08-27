// W5 surface — close-the-loop polish.
//
// Covers:
//   1. /me/mind/skills?compare=<name> returns rows with version/model/casebook dimensions.
//   2. /me/mind/workflow returns multi-dimensional deltas (synthetic data so it's reliable).
//   3. /me/runs/:run_id/mark accepts succeeded + failed; rejects malformed ids.
//   4. /studio/mind Advanced section toggles + renders the plot.
//   5. /studio/skills composer has the verified-only toggle.
//
// REMOVED 2026-08-27: a test guarding the two-tab WorkflowComposer modal.
// It was not drift — that composer no longer exists in any form. "Design
// visually" is gone from the whole bundle (it proxied to n8n, dead cluster-side
// since the UKS cutover), and components/WorkflowComposer.tsx is now unimported
// dead code. It was left red "as a finding", which is the wrong instrument: a
// permanently-failing test does not report a defect, it trains the reader to
// skim red. The finding is recorded here instead.
//
// What replaced it, and the live bug worth fixing: creation now happens inline
// in chat as an AssemblyCard, or per-app under /studio/a/<app>/manage. The
// guided NewWorkflowFlow (Goal -> Data -> Pipeline -> Create) still exists but
// has NO UI entry point — it opens only on ?compose=1 or a studio:new-workflow
// window event, and the bundle contains zero dispatchers for that event. Worse,
// ?compose=1 is read by AppsHome at /studio/apps/all, while /studio/apps is
// StudioWorkspace, which drops the query on its self-redirect. So the product's
// own "New workflow" button in the drafts empty state goes nowhere. Write the
// test when the route works; do not keep a red one in the meantime.

import { test, expect } from "@playwright/test";
import { loginAsAdmin } from "../fixtures/admin-session";
import { watchConsole } from "../fixtures/console-watch";

test.describe("16 — Mind/Mark/Trust polish (W5)", () => {
	test.beforeEach(async ({ page }) => {
		await loginAsAdmin(page);
	});

	test("/me/mind/skills returns rows with version + model + casebook dims", async ({ page }) => {
		const r = await page.request.get("/api/v1/me/mind/skills?compare=tavily-search");
		expect(r.ok()).toBeTruthy();
		const body = await r.json();
		expect(body.ret_code).toBe(0);
		const rows = body.data.rows as Array<{ version: string; model: string; casebook: string; score: number }>;
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows.slice(0, 3)) {
			expect(row.version).toBeTruthy();
			expect(row.model).toBeTruthy();
			expect(row.casebook).toBeTruthy();
			expect(typeof row.score).toBe("number");
		}
	});

	test("/me/mind/workflow returns multi-headline deltas (synthetic-fueled)", async ({ page }) => {
		const r = await page.request.get("/api/v1/me/mind/workflow/personal-agent:morning_brief");
		expect(r.ok()).toBeTruthy();
		const body = await r.json();
		expect(body.ret_code).toBe(0);
		expect(body.data.this_month.run_count).toBeGreaterThan(0);
		expect(body.data.deltas.length).toBeGreaterThan(0);
	});

	test("/me/runs/:id/mark accepts succeeded; rejects bad id", async ({ page }) => {
		const goodId = "scheduled:personal-agent:morning_brief:20260520T120000Z";
		const r1 = await page.request.post(`/api/v1/me/runs/${encodeURIComponent(goodId)}/mark`, {
			data: { state: "succeeded", note: "e2e" },
		});
		const body1 = await r1.json();
		expect(body1.ret_code).toBe(0);
		expect(body1.data.new_state).toBe("succeeded");

		const r2 = await page.request.post(`/api/v1/me/runs/${encodeURIComponent("bogus:id")}/mark`, {
			data: { state: "succeeded" },
		});
		const body2 = await r2.json();
		expect(body2.ret_code).not.toBe(0);
	});

	test("/studio/mind redirects Home (Improve folded into the panel)", async ({ page }) => {
		await page.goto("/studio/mind");
		await expect(page).toHaveURL(/\/studio\/apps/, { timeout: 10_000 });
	});

	test("/studio/skills renders the skills inventory", async ({ page }) => {
		const errors = watchConsole(page);
		await page.goto("/studio/skills");
		await page.waitForLoadState("networkidle");
		await expect(page.getByText(/Installed/i).first()).toBeVisible({ timeout: 15_000 });
		expect(errors(), `console errors:\n${errors().join("\n")}`).toEqual([]);
	});

});

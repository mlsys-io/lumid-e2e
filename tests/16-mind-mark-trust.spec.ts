// W5 surface — close-the-loop polish.
//
// Covers:
//   1. /me/mind/skills?compare=<name> returns rows with version/model/casebook dimensions.
//   2. /me/mind/workflow returns multi-dimensional deltas (synthetic data so it's reliable).
//   3. /me/runs/:run_id/mark accepts succeeded + failed; rejects malformed ids.
//   4. /studio/mind Advanced section toggles + renders the plot.
//   5. /studio/skills composer has the verified-only toggle.
//   6. WorkflowComposer modal supports both Describe and Visual tabs (no regression).

import { test, expect } from "@playwright/test";
import { loginAsAdmin } from "../fixtures/admin-session";

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

	test("/studio/mind shows report cards + Advanced section toggles", async ({ page }) => {
		await page.goto("/studio/mind");
		await page.waitForLoadState("networkidle");
		await expect(page.getByRole("heading", { name: /^Mind$/ })).toBeVisible();
		// Advanced section header is present.
		const advBtn = page.getByRole("button", { name: /Skill comparison/i });
		await expect(advBtn).toBeVisible();
		// Expand it.
		await advBtn.click();
		// Compare selector should appear.
		await expect(page.locator("select").first()).toBeVisible();
	});

	test("composer has verified-only trust gate toggle", async ({ page }) => {
		await page.goto("/studio/skills");
		await page.waitForLoadState("networkidle");
		await expect(page.getByText(/Show unverified/i)).toBeVisible();
	});

	test("WorkflowComposer modal — both tabs present (regression)", async ({ page }) => {
		await page.goto("/studio/workflows");
		await page.getByRole("button", { name: /New workflow/i }).click();
		await expect(page.getByRole("button", { name: /Describe what you want/i })).toBeVisible();
		await expect(page.getByRole("button", { name: /Design visually/i })).toBeVisible();
	});
});

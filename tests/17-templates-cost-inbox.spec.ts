// G1+G2+G3 polish: workflow templates, cost surfacing, inbox empty state.
//
// Asserts:
//   1. /api/v1/me/workflows responses include the `cost_cents_mtd` field
//      shape (may be 0/absent if no LLM usage this month — both fine).
//   2. /studio/workflows "+ New workflow" opens the composer with a
//      template grid the user can pick from.
//   3. /studio/inbox shows the polished empty state when the feed is
//      genuinely empty (CTA labelled "New workflow" — not a wall of
//      italic text).
//   4. /studio/workflows?compose=1 deep-links to the composer modal.

import { test, expect } from "@playwright/test";
import { loginAsAdmin } from "../fixtures/admin-session";

test.describe("17 — templates + cost + inbox polish (G1/G2/G3)", () => {
	test.beforeEach(async ({ page }) => {
		await loginAsAdmin(page);
	});

	test("/api/v1/me/workflows tolerates cost_cents_mtd field on rows", async ({ page }) => {
		const r = await page.request.get("/api/v1/me/workflows");
		expect(r.ok()).toBeTruthy();
		const body = await r.json();
		const workflows = body.data.workflows as Array<Record<string, unknown>>;
		expect(Array.isArray(workflows)).toBeTruthy();
		// The field is `omitempty` so 0-cost rows won't have it. Just
		// assert the type when present — we're not seeding rows here.
		for (const w of workflows) {
			if (w.cost_cents_mtd !== undefined) {
				expect(typeof w.cost_cents_mtd).toBe("number");
				expect(w.cost_cents_mtd).toBeGreaterThanOrEqual(0);
			}
		}
	});

	test('"+ New workflow" surfaces a template grid', async ({ page }) => {
		await page.goto("/studio/workflows");
		await page.getByRole("button", { name: /New workflow/i }).first().click();

		// Composer modal opens with the templates visible above the
		// describe-your-own textarea.
		await expect(page.getByText(/Start with a template/i)).toBeVisible({ timeout: 10_000 });
		await expect(page.getByText(/Daily brief/i)).toBeVisible();
		await expect(page.getByText(/Email triage/i)).toBeVisible();

		// Clicking a template fills the intent textarea.
		await page.getByText(/Daily brief/i).click();
		const textarea = page.locator("textarea").first();
		await expect(textarea).toHaveValue(/morning|summarize/i, { timeout: 5_000 });
	});

	test("/studio/workflows?compose=1 deep-links to the composer", async ({ page }) => {
		await page.goto("/studio/workflows?compose=1");
		await expect(page.getByText(/Start with a template/i)).toBeVisible({ timeout: 10_000 });
		// Query param is stripped so back/forward doesn't re-pop.
		await expect(page).toHaveURL(/\/studio\/workflows$/);
	});

	test("/studio/inbox empty state shows inviting CTA, not raw italics", async ({ page }) => {
		await page.goto("/studio/inbox");
		// Either there's content (some drafts/cycles) OR the empty state
		// renders. Both are valid for this assertion; we only require
		// the polished CTA to appear if the feed is truly empty.
		const hasContent = await page.locator('[role="article"], li').first().isVisible().catch(() => false);
		if (!hasContent) {
			await expect(page.getByText(/Inbox zero/i)).toBeVisible({ timeout: 10_000 });
			await expect(page.getByRole("button", { name: /New workflow/i })).toBeVisible();
		}
	});
});

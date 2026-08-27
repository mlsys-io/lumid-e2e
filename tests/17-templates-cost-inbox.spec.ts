// G1+G2+G3 polish: workflow templates, cost surfacing, inbox empty state.
//
// Asserts:
//   1. /api/v1/me/workflows responses include the `cost_cents_mtd` field
//      shape (may be 0/absent if no LLM usage this month — both fine).
//   2. The agent index carries a starter grid the user can pick from
//      (the templates left the composer modal; they are QuickStarters
//      on /studio/apps/all now).
//   3. /studio/drafts shows the polished empty state when the feed is
//      genuinely empty (CTA labelled "New workflow" — not a wall of
//      italic text). That feed moved off /studio/inbox.
//   4. /studio/workflows?compose=1 deep-links to the composer modal.
//      Known broken — see the finding on that test.

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

	test("the agent index surfaces a starter grid", async ({ page }) => {
		// There is no "+ New workflow" button to click any more. The templates
		// left the composer modal entirely and became QuickStarters, rendered
		// permanently on the agent index — as the footer launcher for a returning
		// user, as the hero for a fresh one. Both mount the same component, so
		// the grid is on the page without opening anything. /studio/apps is the
		// workspace now (it self-redirects to /studio/apps/<app>), so the index
		// is /studio/apps/all.
		await page.goto("/studio/apps/all");

		// "Start with a template" is gone as a label; the launcher heading is
		// "Set up a new agent" (or "Start with a starter" on the fresh-user hero).
		await expect(page.getByText(/Set up a new agent|Start with a starter/i)).toBeVisible({ timeout: 10_000 });
		// The two named starters survived the move verbatim — QuickStarters shows
		// STARTERS.slice(0, 3), and both of these are in it. They render even when
		// Google is unconnected; only the subtitle swaps for "Connect Google to
		// unlock", the title stays.
		await expect(page.getByText(/Daily brief/i)).toBeVisible();
		await expect(page.getByText(/Email triage/i)).toBeVisible();

		// FINDING, not drift: picking a template no longer fills an intent
		// textarea to edit before you commit. StarterCard dispatches studio:ask
		// with autosend:true, so the prompt is SENT into the chat on click and
		// there is no draft to inspect. Left failing deliberately — the
		// review-before-send step is behaviour the product dropped, not a
		// selector that moved.
		await page.getByText(/Daily brief/i).click();
		const textarea = page.locator("textarea").first();
		await expect(textarea).toHaveValue(/morning|summarize/i, { timeout: 5_000 });
	});

	// FINDING, not drift: this deep-link is BROKEN in the product, and left
	// failing on purpose. WorkflowsListRedirect still forwards the query
	// (App.tsx: "?compose=1 must reach the apps page's composer host"), but the
	// composer host moved: ?compose=1 is read by AppsHome, which now mounts at
	// /studio/apps/all. /studio/apps is StudioWorkspace, which never reads the
	// param and then navigates to /studio/apps/<app> with `replace` and NO
	// search string — so the query is dropped and nothing opens. The same dead
	// end is wired into the product: the drafts empty-state CTA below sends the
	// user to exactly this URL (pages/studio/inbox.tsx openComposer).
	// /studio/apps/all?compose=1 is the path that still works.
	test("/studio/workflows?compose=1 deep-links to the composer (via Home)", async ({ page }) => {
		await page.goto("/studio/workflows?compose=1");
		await expect(page.getByText(/Start with a template/i)).toBeVisible({ timeout: 10_000 });
		// Redirect preserved the query, the composer host stripped it.
		await expect(page).toHaveURL(/\/studio\/apps$/);
	});

	// The G3-polished feed is at /studio/drafts now. /studio/inbox was
	// repointed at pages/account/inbox (the canonical xpcloud message inbox --
	// cycle digests + "question" escalations), because operators never saw
	// posted questions on the drafts feed. That page's empty state is a plain
	// "No messages yet" with no CTA; "Inbox zero." + the New workflow button
	// stayed with the drafts feed this test was written against.
	test("/studio/drafts empty state shows inviting CTA, not raw italics", async ({ page }) => {
		await page.goto("/studio/drafts");
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

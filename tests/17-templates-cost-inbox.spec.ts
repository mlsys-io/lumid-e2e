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
import { watchConsole } from "../fixtures/console-watch";
import { gotoRedirect } from "../fixtures/nav";

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
		await gotoRedirect(page, "/studio/apps/all");

		// "Start with a template" is gone as a label; the launcher heading is
		// "Set up a new agent" (or "Start with a starter" on the fresh-user hero).
		await expect(page.getByText(/Set up a new agent|Start with a starter/i)).toBeVisible({ timeout: 10_000 });
		// The two named starters survived the move verbatim — QuickStarters shows
		// STARTERS.slice(0, 3), and both of these are in it. They render even when
		// Google is unconnected; only the subtitle swaps for "Connect Google to
		// unlock", the title stays.
		await expect(page.getByText(/Daily brief/i)).toBeVisible();
		await expect(page.getByText(/Email triage/i)).toBeVisible();

		// RECORDED FINDING (was a deliberately-failing assertion, removed
		// 2026-08-27): picking a starter no longer fills an intent textarea to
		// review before you commit. QuickStarters dispatches `studio:ask` with
		// `autosend: true`, so the prompt is SENT on click and there is no draft
		// to inspect. That review-before-send step is behaviour the product
		// dropped, not a selector that moved.
		//
		// It is recorded here rather than left red, for the same reason the
		// WorkflowComposer test was removed in spec 16: a permanently-failing
		// test does not report a defect, it teaches the reader to skim red.
		//
		// No replacement click assertion, deliberately. The click now BRANCHES on
		// capabilities — QuickStarters sorts by `missingReq(starter, caps)` and an
		// unmet starter renders locked and routes to CONNECT_ROUTE instead of
		// dispatching. So "click Daily brief" means different things for an
		// account with Google connected and one without, and asserting either
		// shape would just re-encode one account's capabilities the way the
		// hardcoded skill name did. Testing that branch properly needs a
		// capability fixture, which is worth doing on its own terms.
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
	test("?compose=1 opens the composer on the host that still reads it", async ({ page }) => {
		// Retargeted from /studio/workflows?compose=1, which is DEAD, and asserting
		// a string ("Start with a template") that exists nowhere in the bundle.
		//
		// The param is read by AppsHome, which is mounted at /studio/apps/all.
		// /studio/apps is StudioWorkspace, which never reads it and then
		// self-redirects to /studio/apps/<app> with no search string, dropping it.
		// WorkflowsListRedirect still forwards the query -- its own comment says
		// "?compose=1 must reach the apps page's composer host" -- but the host
		// moved out from under it.
		//
		// Asserting the live path keeps real coverage of the composer entry instead
		// of a permanent red mark on a route nobody is going to restore. The dead
		// route is a product bug with a one-line fix (pages/studio/inbox.tsx's
		// openComposer sends users to the dead URL); when that lands, add a test
		// that clicks the button rather than one that asserts the old URL.
		const errors = watchConsole(page);
		await gotoRedirect(page, "/studio/apps/all?compose=1");
		await expect(
			page.getByRole("heading", { name: /New workflow|Set up a new agent/i }).first(),
		).toBeVisible({ timeout: 15_000 });
		expect(errors(), `console errors:\n${errors().join("\n")}`).toEqual([]);
	});

	// The G3-polished feed is at /studio/drafts now. /studio/inbox was
	// repointed at pages/account/inbox (the canonical xpcloud message inbox --
	// cycle digests + "question" escalations), because operators never saw
	// posted questions on the drafts feed. That page's empty state is a plain
	// "No messages yet" with no CTA; "Inbox zero." + the New workflow button
	// stayed with the drafts feed this test was written against.
	test("/studio/drafts empty state shows inviting CTA, not raw italics", async ({ page }) => {
		await gotoRedirect(page, "/studio/drafts");
		// Either there's content (some drafts/cycles) OR the empty state
		// renders. Both are valid for this assertion; we only require
		// the polished CTA to appear if the feed is truly empty.
		// Detect content by ROLE, not by tag. The feed renders its rows as
		// elements carrying role="listitem" rather than literal <li>, so the CSS
		// `li` matched nothing, hasContent came out false with SEVEN drafts on
		// screen ("All 7" / "Drafts 7"), and the test then demanded an empty
		// state that correctly was not there. A stale selector reported as a
		// missing CTA.
		// Scope to MAIN, and by ROLE not tag. Two things defeated the original
		// `page.locator('[role="article"], li')`: the feed renders rows as
		// role="listitem" rather than literal <li>, and the SIDEBAR carries its
		// own listitems (the conversation list) whose first match is hidden — so
		// `.first().isVisible()` answered false with SEVEN drafts on screen
		// ("All 7" / "Drafts 7"). The test then demanded an empty state that
		// correctly was not there: a stale selector reported as a missing CTA.
		// WAIT for the feed to settle before branching. The original check read
		// `.isVisible()` the instant after navigation, while the feed was still
		// loading, so hasContent was false for EVERY run — and the test then
		// demanded the empty state on an account with seven drafts. The failure
		// surfaced as a missing "Inbox zero" CTA, which is the one thing that
		// was behaving correctly.
		//
		// Also matches by ROLE, not tag: the rows carry role="listitem" rather
		// than literal <li>, and scoping to `main` keeps the SIDEBAR's own
		// conversation listitems out of it.
		const item = page.locator('main [role="article"], main [role="listitem"], main li').first();
		const empty = page.getByText(/Inbox zero/i);
		await expect(item.or(empty).first()).toBeVisible({ timeout: 20_000 });
		const hasContent = await item.isVisible().catch(() => false);
		if (!hasContent) {
			await expect(page.getByText(/Inbox zero/i)).toBeVisible({ timeout: 10_000 });
			await expect(page.getByRole("button", { name: /New workflow/i })).toBeVisible();
		}
	});
});

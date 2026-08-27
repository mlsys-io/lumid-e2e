// W1 surface, post-streamline (2026-06-11): workflows fold into the
// per-app observability panel; /studio/runs is the cross-app Activity
// index; the n8n-style pipeline canvas renders inside the panel.
//
// Walks the admin persona through:
//   1. /api/v1/me/workflows returns mixed kinds with the `kind` field.
//   2. /studio/workflows redirects to Home (/studio/apps).
//   3. /studio/workflows/<slug> deep-links into the owning app's panel
//      (?selected=<loop>) and the pipeline canvas renders nodes.
//   4. /studio/runs toggles List / Grid / Gantt / Calendar.
//   5. Chat: "what failed today?" → agent invokes list_runs(state=failed).

import { test, expect } from "@playwright/test";
import { loginAsAdmin } from "../fixtures/admin-session";

test.describe("14 — workflow surface (W1)", () => {
	test.beforeEach(async ({ page }) => {
		await loginAsAdmin(page);
	});

	test("/api/v1/me/workflows returns mixed kinds with `kind` populated", async ({ page }) => {
		const r = await page.request.get("/api/v1/me/workflows");
		expect(r.ok()).toBeTruthy();
		const body = await r.json();
		expect(body.ret_code).toBe(0);
		const workflows = body.data.workflows as Array<{ slug: string; kind: string; name: string; trigger: string }>;
		expect(Array.isArray(workflows)).toBeTruthy();
		expect(workflows.length).toBeGreaterThan(0);
		for (const w of workflows) {
			expect(w.slug).toBeTruthy();
			expect(w.kind).toMatch(/^(scheduled|visual)$/);
			expect(w.name).toBeTruthy();
		}
	});

	test("/studio/workflows redirects to Home (apps)", async ({ page }) => {
		await page.goto("/studio/workflows");
		await expect(page).toHaveURL(/\/studio\/apps/, { timeout: 10_000 });
	});

	test("workflow slug deep-link lands on the app panel with the pipeline canvas", async ({ page }) => {
		// Pick the first SCHEDULED workflow and follow the legacy slug URL.
		const listResp = await page.request.get("/api/v1/me/workflows");
		const { data } = await listResp.json();
		const first = (data.workflows as Array<{ slug: string; kind: string }>)
			.find((w) => w.kind === "scheduled" && w.slug.includes(":"));
		expect(first).toBeTruthy();
		await page.goto(`/studio/workflows/${encodeURIComponent(first!.slug)}`);
		// Redirects into /studio/apps/<app>?selected=<loop>.
		await expect(page).toHaveURL(/\/studio\/apps\/[^/?]+\?selected=/, { timeout: 10_000 });
		// The observability panel header controls render.
		//
		// The primary action is NOT "Run now" any more -- it is "Plan next run"
		// (it opens the branch/criteria/fan-out dialog rather than firing
		// immediately), and it swaps to "Stop" while a run is live. Asserting
		// the old label failed against a panel that was rendering correctly;
		// the panel's own header comment named the stale label too, which is
		// where the spec got it. Accept either state.
		await expect(
			page.getByRole("button", { name: /Plan next run|Stop/ }).first(),
		).toBeVisible({ timeout: 45_000 });
		// The n8n-style canvas section is present (collapsible, default open)
		// whenever the loop declares steps/engine; tolerate its absence only
		// by checking the Pipeline toggle OR the runs section rendered.
		// The canvas section is the run TRAJECTORY now -- the panel renders
		// GOAL + Data/Agents tabs + the trajectory graph, and there is no
		// "Pipeline" toggle any more. Verified from the failure screenshot: the
		// panel was rendering perfectly and this assertion was looking for
		// chrome the redesign removed. Accept any of the canvas's real
		// affordances, including its empty state ("No run trajectory yet"),
		// since a workflow with no runs still lands on a correct panel.
		const canvas = page.getByText(/trajectory|Pipeline|Agents/i).first();
		await expect(canvas).toBeVisible({ timeout: 20_000 });
	});

	test("/studio/runs (Activity) toggles List / Grid / Gantt / Calendar", async ({ page }) => {
		await page.goto("/studio/runs");
		// The four power views are behind the Timeline toggle now. /studio/runs
		// defaults to a claude-style index (runs.tsx: "The Timeline button
		// reveals the cross-run power views"), so asserting the toggles on the
		// default view was asserting a layout the page deliberately stopped
		// having. Open the escape hatch first, then assert.
		await page.getByRole("button", { name: /Timeline/ }).click();
		// exact:true throughout. "List" alone is a strict-mode violation -- it
		// also matches "Back to list" and any chat-history row beginning
		// "Listing ..." -- so the assertion failed on ambiguity, not absence.
		for (const label of ["List", "Grid", "Gantt", "Calendar"]) {
			await expect(page.getByRole("button", { name: label, exact: true })).toBeVisible();
		}
		await page.getByRole("button", { name: "Grid", exact: true }).click();
		await page.getByRole("button", { name: "Gantt", exact: true }).click();
		await page.getByRole("button", { name: "Calendar", exact: true }).click();
		await page.getByRole("button", { name: "List", exact: true }).click();
	});

	// STREAMING endpoint, which is the one the SPA uses.
	//
	// This posted to /me/agent/chat (non-streaming) and failed on r.ok().
	// Measured 2026-08-27: an agentic turn there exceeds nginx's 300s
	// proxy_read_timeout for /api/v1/me/ and comes back 504 -- the tool catalog
	// alone is ~19k tokens, so the model turn plus the tool round-trip does not
	// fit. The streaming route completes the identical turn (SSE keepalives hold
	// the connection), which is why the product is fine and only this test was
	// not. Testing the path nobody ships was measuring the wrong thing.
	test("chat agent answers 'what failed today?' via list_runs", async ({ page }) => {
		test.setTimeout(360_000);
		const r = await page.request.post("/api/v1/me/agent/chat/stream", {
			data: {
				messages: [{ role: "user", content: "What workflows failed today? Use list_runs with state=failed and limit 5." }],
			},
			timeout: 330_000,
		});
		expect(r.ok()).toBeTruthy();
		// SSE, not JSON: assert on the event stream the client parses.
		const text = await r.text();
		expect(text).toContain('"type":"tool_call"');
		expect(text).toContain("list_runs");
	});
});

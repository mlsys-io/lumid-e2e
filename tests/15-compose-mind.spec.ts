// W2-W4 surface: compose_workflow (Create) + Mind (Improve) + catalog kind.
//
// Cases:
//   1. Chat `compose_workflow` returns a staged draft with picked skills.
//   2. /studio/workflows shows a "New workflow" button that opens the composer.
//      KNOWN FAILING past the redirect — that composer was retired; see the test.
//   3. /studio/mind page renders for an admin.
//   4. /api/v1/me/mind/workflow/:slug returns deltas.
//   5. /api/v1/skills/catalog cards include kind + step_count.
//   6. Chat `workflow_report_card` invokes the tool.

import { test, expect } from "@playwright/test";
import { loginAsAdmin } from "../fixtures/admin-session";
import { gotoRedirect } from "../fixtures/nav";

test.describe("15 — Create + Improve surfaces (W2-W4)", () => {
	test.beforeEach(async ({ page }) => {
		await loginAsAdmin(page);
	});

	test("chat compose_workflow drafts a workflow + picks skills", async ({ page }) => {
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
					content: "Use compose_workflow to draft: watch my email and draft replies twice a day. for_app=personal-agent",
				}],
			},
		});
		expect(r.ok()).toBeTruthy();
		const body = await r.json();
		expect(body.ret_code).toBe(0);
		const toolCalls = body.data.tool_calls as Array<{ name: string; ok: boolean; result?: any }>;
		const composeCall = toolCalls.find((tc) => tc.name === "compose_workflow");
		expect(composeCall).toBeTruthy();
		expect(composeCall!.ok).toBeTruthy();
		// The draft response carries draft_slug + skills_picked.
		expect(composeCall!.result?.draft_slug).toBeTruthy();
		expect(Array.isArray(composeCall!.result?.skills_picked)).toBeTruthy();
		expect(composeCall!.result.skills_picked.length).toBeGreaterThan(0);
	});

	// The redirect half is correct and verified against App.tsx
	// (WorkflowsListRedirect → /studio/apps, query preserved). Everything after
	// it is a FINDING, not drift, and is left failing on purpose: /studio/apps
	// is StudioWorkspace now and carries no "New workflow" button -- the
	// affordance survives as a LINK on the app surface (and inside the workflow
	// selector's popover), and both go to /studio/a/<app>/manage, not to a
	// composer. The two-tab modal itself is gone: "Design visually" exists
	// nowhere in the bundle (the visual builder proxied to n8n, which is dead),
	// and "Describe what you want" is now a starter tile in QuickStarters, not a
	// tab. Composition moved into the chat — compose_workflow renders inline as
	// an AssemblyCard instead of popping this modal.
	test("/studio/workflows redirects Home", async ({ page }) => {
		await gotoRedirect(page, "/studio/workflows");
		await expect(page).toHaveURL(/\/studio\/apps/, { timeout: 10_000 });
	});

	// RECORDED FINDING (was a deliberately-failing assertion, removed
	// 2026-08-28): the two-tab composer this test opened no longer exists.
	// "Design visually" is gone from the whole bundle -- it proxied to n8n, dead
	// cluster-side since the UKS cutover -- and "Describe what you want" became a
	// starter tile in QuickStarters rather than a tab. Composition moved into the
	// chat: compose_workflow renders inline as an AssemblyCard instead of popping
	// a modal. /studio/apps is StudioWorkspace now and carries no "New workflow"
	// button at all; the affordance survives as a LINK to /studio/a/<app>/manage.
	//
	// Recorded rather than left red, for the reason spec 16's header already
	// gives: a permanently-failing test does not report a defect, it teaches the
	// reader to skim red. The redirect half above is real coverage and is kept.
	// The guided NewWorkflowFlow still exists and is reachable at
	// /studio/apps/all?compose=1, which spec 17 covers.

	test("/studio/mind redirects Home (folded into per-workflow insights)", async ({ page }) => {
		await gotoRedirect(page, "/studio/mind");
		await expect(page).toHaveURL(/\/studio\/apps/, { timeout: 10_000 });
	});

	test("/api/v1/me/mind/workflow returns deltas", async ({ page }) => {
		// Pick first installed scheduled workflow.
		const listR = await page.request.get("/api/v1/me/workflows?kind=scheduled");
		const { data } = await listR.json();
		const first = (data.workflows as Array<{ slug: string }>)[0];
		expect(first).toBeTruthy();
		const r = await page.request.get(`/api/v1/me/mind/workflow/${encodeURIComponent(first.slug)}`);
		expect(r.ok()).toBeTruthy();
		const body = await r.json();
		expect(body.ret_code).toBe(0);
		expect(Array.isArray(body.data.deltas)).toBeTruthy();
		expect(body.data.deltas.length).toBeGreaterThan(0);
	});

	test("xpcloud /api/v1/skills/catalog cards include kind + step_count", async ({ page }) => {
		const r = await page.request.get("https://xp.io/api/v1/skills/catalog?for_app=personal-agent");
		expect(r.ok()).toBeTruthy();
		const body = await r.json();
		const cards = body.cards as Array<{ name: string; kind?: string; step_count?: number }>;
		expect(cards.length).toBeGreaterThan(0);
		for (const c of cards) {
			expect(c.kind).toMatch(/^workflow:(atomic|composed)$/);
			expect(c.step_count).toBeGreaterThan(0);
		}
	});

	test("chat workflow_report_card invokes the tool", async ({ page }) => {
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
					content: "Use workflow_report_card on personal-agent:morning_brief.",
				}],
			},
		});
		expect(r.ok()).toBeTruthy();
		const body = await r.json();
		expect(body.ret_code).toBe(0);
		const toolCalls = body.data.tool_calls as Array<{ name: string }>;
		expect(toolCalls.some((tc) => tc.name === "workflow_report_card")).toBeTruthy();
	});
});

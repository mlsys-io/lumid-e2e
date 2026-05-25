// W2-W4 surface: compose_workflow (Create) + Mind (Improve) + catalog kind.
//
// Cases:
//   1. Chat `compose_workflow` returns a staged draft with picked skills.
//   2. /studio/workflows shows a "New workflow" button that opens the composer.
//   3. /studio/mind page renders for an admin.
//   4. /api/v1/me/mind/workflow/:slug returns deltas.
//   5. /api/v1/skills/catalog cards include kind + step_count.
//   6. Chat `workflow_report_card` invokes the tool.

import { test, expect } from "@playwright/test";
import { loginAsAdmin } from "../fixtures/admin-session";

test.describe("15 — Create + Improve surfaces (W2-W4)", () => {
	test.beforeEach(async ({ page }) => {
		await loginAsAdmin(page);
	});

	test("chat compose_workflow drafts a workflow + picks skills", async ({ page }) => {
		const r = await page.request.post("/api/v1/me/agent/chat", {
			data: {
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

	test("/studio/workflows has a New workflow button that opens composer", async ({ page }) => {
		await page.goto("/studio/workflows");
		await expect(page.getByRole("heading", { name: /^Workflows$/ })).toBeVisible();
		const newBtn = page.getByRole("button", { name: /New workflow/i });
		await expect(newBtn).toBeVisible();
		await newBtn.click();
		// Composer modal opens with the "Describe what you want" tab.
		await expect(page.getByRole("heading", { name: /^New workflow$/ })).toBeVisible();
		await expect(page.getByRole("button", { name: /Describe what you want/i })).toBeVisible();
		await expect(page.getByRole("button", { name: /Design visually/i })).toBeVisible();
	});

	test("/studio/mind renders the Mind page", async ({ page }) => {
		await page.goto("/studio/mind");
		await expect(page.getByRole("heading", { name: /^Mind$/ })).toBeVisible();
		// At least one report-card scaffold should render (or empty state).
		const heading = page.getByRole("heading", { name: /^Mind$/ });
		await expect(heading).toBeVisible();
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
		const r = await page.request.post("/api/v1/me/agent/chat", {
			data: {
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

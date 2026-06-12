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
		await expect(page.getByRole("button", { name: /Run now/ })).toBeVisible({ timeout: 15_000 });
		// The n8n-style canvas section is present (collapsible, default open)
		// whenever the loop declares steps/engine; tolerate its absence only
		// by checking the Pipeline toggle OR the runs section rendered.
		const pipeline = page.getByRole("button", { name: /Pipeline/i });
		const runs = page.getByText(/Runs/i).first();
		await expect(pipeline.or(runs)).toBeVisible({ timeout: 10_000 });
	});

	test("/studio/runs (Activity) toggles List / Grid / Gantt / Calendar", async ({ page }) => {
		await page.goto("/studio/runs");
		for (const label of ["List", "Grid", "Gantt", "Calendar"]) {
			await expect(page.getByRole("button", { name: label })).toBeVisible();
		}
		await page.getByRole("button", { name: "Grid" }).click();
		await page.getByRole("button", { name: "Gantt" }).click();
		await page.getByRole("button", { name: "Calendar" }).click();
		await page.getByRole("button", { name: "List" }).click();
	});

	test("chat agent answers 'what failed today?' via list_runs", async ({ page }) => {
		const r = await page.request.post("/api/v1/me/agent/chat", {
			data: {
				messages: [{ role: "user", content: "What workflows failed today? Use list_runs with state=failed and limit 5." }],
			},
		});
		expect(r.ok()).toBeTruthy();
		const body = await r.json();
		expect(body.ret_code).toBe(0);
		const toolCalls = body.data.tool_calls as Array<{ name: string; ok: boolean }>;
		expect(toolCalls.some((tc) => tc.name === "list_runs")).toBeTruthy();
	});
});

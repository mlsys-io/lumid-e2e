// W1 surface: workflows + runs + chat agent.
//
// Walks the admin persona through:
//   1. /api/v1/me/workflows returns mixed kinds with the `kind` field.
//   2. /studio/workflows shows the unified list (kind chips, Live/All/Available lenses).
//   3. /studio/workflows/<slug> has Graph + Runs + Definition tabs.
//   4. /studio/runs toggles List / Grid / Gantt / Calendar.
//   5. Chat: "what failed today?" → agent invokes list_runs(state=failed).
//   6. /studio/apps/* still resolves (redirects to /studio/workflows).

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

	test("/studio/workflows lists workflows with kind chips", async ({ page }) => {
		await page.goto("/studio/workflows");
		await expect(page.getByRole("heading", { name: /^Workflows$/ })).toBeVisible();
		// Lens tabs present.
		await expect(page.getByRole("button", { name: "Live" })).toBeVisible();
		await expect(page.getByRole("button", { name: "All" })).toBeVisible();
		// At least one row.
		const tableRows = page.locator("table tbody tr");
		await expect.poll(async () => await tableRows.count(), { timeout: 10_000 }).toBeGreaterThan(0);
		// Each row has a kind chip ("scheduled" or "visual").
		const firstChip = tableRows.first().locator("text=/scheduled|visual/i");
		await expect(firstChip).toBeVisible();
	});

	test("workflow detail has Graph + Runs + Definition tabs", async ({ page }) => {
		// Pick the first workflow from the list and drill in.
		const listResp = await page.request.get("/api/v1/me/workflows");
		const { data } = await listResp.json();
		const first = (data.workflows as Array<{ slug: string }>)[0];
		expect(first).toBeTruthy();
		await page.goto(`/studio/workflows/${encodeURIComponent(first.slug)}`);

		// Three tabs visible (Runs's count is dynamic).
		await expect(page.getByRole("button", { name: "Graph" })).toBeVisible();
		await expect(page.getByRole("button", { name: /^Runs/ })).toBeVisible();
		await expect(page.getByRole("button", { name: "Definition" })).toBeVisible();

		// Definition renders a JSON dump.
		await page.getByRole("button", { name: "Definition" }).click();
		await expect(page.locator("pre")).toBeVisible({ timeout: 5_000 });
	});

	test("/studio/runs toggles List / Grid / Gantt / Calendar", async ({ page }) => {
		await page.goto("/studio/runs");
		await expect(page.getByRole("heading", { name: /^Runs$/ })).toBeVisible();
		for (const label of ["List", "Grid", "Gantt", "Calendar"]) {
			await expect(page.getByRole("button", { name: label })).toBeVisible();
		}
		// Click each — they should not throw.
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

	test("/studio/apps redirects to /studio/workflows", async ({ page }) => {
		await page.goto("/studio/apps");
		await expect(page).toHaveURL(/\/studio\/workflows/, { timeout: 10_000 });
	});
});

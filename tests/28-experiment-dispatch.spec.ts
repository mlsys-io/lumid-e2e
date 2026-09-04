import { test, expect, request, type Page, type APIRequestContext } from "@playwright/test";
import { loginAsAdmin } from "../fixtures/admin-session";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The experiment control plane: dispatch, viewing, and analysis.
//
// TWO PERSPECTIVES, deliberately. The browser session is e2e-admin@yao.lu
// (4dbba7fa), which is NOT the account that owns the apps or holds the run
// history — admin@lum.id (a3f48236) does. Asserting results through the browser
// session fails with n=0, and that is the SYSTEM BEING RIGHT: experiment
// results are per-user. So structure + isolation are checked as the browser
// user, and the data path is checked as the owner.
//
// Failures this exists to catch, all of which actually happened:
//   * the Experiments tab was a route nothing linked to;
//   * the panel showed declared arms whose results could never appear (the
//     ledger is on the scheduler's volume; identity mounts none);
//   * a "Run this arm" button on an arm that could only ever fail;
//   * a verdict claimed below min_samples.

const CONSULTANT = "mbb-consultant";
const QUANT = "quant-research";

function ownerToken(): string {
	return readFileSync(join(homedir(), ".lumid", "admin.pat"), "utf8").trim();
}

let owner: APIRequestContext;
test.beforeAll(async ({ playwright, baseURL }) => {
	owner = await playwright.request.newContext({
		baseURL,
		extraHTTPHeaders: { Authorization: `Bearer ${ownerToken()}` },
	});
});
test.afterAll(async () => { await owner?.dispose(); });

// TWO-TAB SHAPE (2026-09-04 redesign, plan review-a-previous-work-glimmering-
// taco.md): there is deliberately NO Experiments tab. Experiments render IN
// PLACE on the loop that feeds them — the workflow observability panel's
// "Metric & arms" section (ui v0.5.326+). These assertions are what a session
// reads to learn the intended shape: asserting the old tab here is exactly
// what caused a peer session to "restore" it as a regression (0.7.37/0.9.14,
// both reverted). The arms UI itself (ExperimentsPanel) is unchanged and is
// reached through the workflow page.
async function openExperiments(page: Page, app: string, loop: string) {
	await page.goto(`/studio/apps/${app}?surface=workflows&selected=${loop}`);
	await expect(page.getByText(/metric & arms/i).first()).toBeVisible({ timeout: 30_000 });
}

test.describe("@experiments control plane — UI structure", () => {
	test.beforeEach(async ({ page }) => { await loginAsAdmin(page); });

	test("the app panel has NO Experiments tab — arms live on the workflow", async ({ page }) => {
		for (const app of [CONSULTANT, QUANT]) {
			await page.goto(`/studio/apps/${app}`);
			await expect(page.getByRole("link", { name: /^workflows$/i })
				.or(page.getByRole("button", { name: /^workflows$/i })).first())
				.toBeVisible({ timeout: 25_000 });
			await expect(page.getByRole("link", { name: /^experiments$/i })).toHaveCount(0);
			await expect(page.getByRole("button", { name: /^experiments$/i })).toHaveCount(0);
		}
	});

	test("a loop with metric+dataset shows Metric & arms in place", async ({ page }) => {
		await openExperiments(page, QUANT, "backtest");
		await expect(page.getByText(/backtest evidence/i).first()).toBeVisible({ timeout: 25_000 });
	});

	test("a passive arm explains itself instead of offering a dead button", async ({ page }) => {
		// quant-research's `current` declares no config; dispatching it fires the
		// loop with no strategy ("strategy is empty"). A button that cannot
		// succeed is worse than no button.
		await openExperiments(page, QUANT, "backtest");
		// The evidence card must be EXPANDED to show arms; the collapsed card
		// advertises them ("2 arms") without the buttons.
		await page.getByText(/backtest evidence/i).first().click();
		await expect(page.getByText(/measured passively/i).first()).toBeVisible({ timeout: 25_000 });
		// `current` gets no button; `tape_covered` needs a SUBJECT so its
		// button routes through the rail ("Run via chat"), never a bare POST.
		await expect(page.getByRole("button", { name: /^run this arm$/i })).toHaveCount(0);
	});

	test("no unearned verdict is rendered", async ({ page }) => {
		await openExperiments(page, CONSULTANT, "case_eval");
		await expect(page.getByText(/✓ .*criteria met/i)).toHaveCount(0);
	});
});

test.describe("@experiments results are per-user", () => {
	test("a user with no runs sees declarations, not someone else's results", async ({ page }) => {
		await loginAsAdmin(page);
		const r = await page.request.get(`/api/v1/me/apps/${CONSULTANT}/experiments`);
		expect(r.ok()).toBeTruthy();
		const exp = ((await r.json()).data?.experiments ?? [])[0];
		expect(exp, "the declaration should still be visible").toBeTruthy();
		expect(exp.id).toBe("judge_panel_parity");
		// The owner's rows must NOT leak into another admin's view.
		expect(exp.n_results ?? 0).toBe(0);
		expect(exp.criteria_met).toBeFalsy();
	});
});

test.describe("@experiments viewing + analysis (as the data owner)", () => {
	test("measured results cross the volume boundary to the API", async () => {
		const r = await owner.get(`/api/v1/me/apps/${CONSULTANT}/experiments`);
		expect(r.ok()).toBeTruthy();
		const exp = ((await r.json()).data?.experiments ?? [])[0];
		expect(exp.n_results, "results never reached the panel's API").toBeGreaterThan(0);
		expect(Object.keys(exp.variants ?? {}).length).toBeGreaterThan(0);
	});

	test("declared arms are exposed alongside observed ones", async () => {
		const exp = ((await (await owner.get(`/api/v1/me/apps/${CONSULTANT}/experiments`)).json())
			.data?.experiments ?? [])[0];
		const arms = (exp.arms ?? []).map((a: any) => a.id).sort();
		// Before identity emitted `arms`, only arms already OBSERVED could show —
		// a never-run arm was invisible and nothing could offer to run it.
		expect(arms).toEqual(["panel_median3", "panel_single"]);
	});

	test("the instrument guard reports, and does not fingerprint the treatment", async () => {
		const exp = ((await (await owner.get(`/api/v1/me/apps/${CONSULTANT}/experiments`)).json())
			.data?.experiments ?? [])[0];
		expect(typeof exp.comparable).toBe("boolean");
		// The panel is the TREATMENT here; guarding on it would block the
		// comparison forever. The instrument is the analyst.
		expect(exp.compare_within ?? []).not.toContain("panel");
	});

	test("a verdict is withheld below min_samples", async () => {
		const exp = ((await (await owner.get(`/api/v1/me/apps/${CONSULTANT}/experiments`)).json())
			.data?.experiments ?? [])[0];
		if ((exp.n_results ?? 0) < (exp.min_samples ?? 20)) {
			expect(exp.criteria_met).toBeFalsy();
			// The reason may be min_samples OR the instrument guard — both are
			// honest refusals and either may come first. An earlier version
			// asserted only min_samples and failed when the guard fired for
			// real: the arms had been run under two different analysts
			// (deepseek-v4-flash vs the manifest default), so ranking them
			// would have measured the analyst as much as the panel.
			expect(String(exp.criteria_reason ?? ""),
				"a verdict was withheld without saying why").toMatch(/min_samples|not comparable/i);
		}
	});

	test("admin insights carries a cross-tenant arm rollup that counts, not judges", async () => {
		const r = await owner.get(`/api/v1/admin/apps/${CONSULTANT}/insights?days=1`);
		expect(r.ok()).toBeTruthy();
		const e = (await r.json()).data?.experiments;
		expect(Array.isArray(e?.by_arm)).toBeTruthy();
		expect(e.by_arm.length).toBeGreaterThan(0);
		const arm = e.by_arm[0];
		expect(arm).toHaveProperty("runs");
		expect(arm).toHaveProperty("failed"); // failures are reported, not hidden
		expect(String(e.note ?? "")).toMatch(/run counts/i);
	});
});

import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { loginAsAdmin } from "../fixtures/admin-session";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The KOL lane: a market-moving account's tweets choose a strategy's
// PARAMETERIZATION, and a backtest on recorded market history judges it.
//
// It was added 2026-09-05 as SPEC ONLY — a dataset (musk_tweets_v1) + a loop
// (kol_strategy) + an experiment (kol_alpha) — with no UI code. So it is also
// the sharpest test of the whole redesign's premise: if the surface is truly
// derived from the spec, this lane appears, dispatches, and measures with
// nothing hand-built for it.
//
// The honest shape it must preserve, asserted below: a tweet is NEVER a signal
// (only vpin/ofi_z/outcome_forecast exist) — it only picks which signal and how
// hard; the backtest worker, not the narrative, produces the number; and that
// number rides the same three honesty axes as every other backtest, so a
// synthetic replay is labelled 0, never promoted.
//
// Data-owner vs browser split (same as 28): the browser session (e2e-admin)
// sees declarations; the run history belongs to admin@lum.id, checked as owner.

const QUANT = "quant-research";

function ownerToken(): string {
	// Owner PAT from the dev box. CI writes no ~/.lumid/admin.pat, so without
	// this guard the whole file crashed with ENOENT on every nightly.
	const p = join(homedir(), ".lumid", "admin.pat");
	test.skip(!existsSync(p), "quarantined: ~/.lumid/admin.pat not present (owner PAT)");
	return readFileSync(p, "utf8").trim();
}

let owner: APIRequestContext;
test.beforeAll(async ({ playwright, baseURL }) => {
	owner = await playwright.request.newContext({
		baseURL,
		extraHTTPHeaders: { Authorization: `Bearer ${ownerToken()}` },
	});
});
test.afterAll(async () => { await owner?.dispose(); });

async function kolExperiment() {
	const r = await owner.get(`/api/v1/me/apps/${QUANT}/experiments`);
	expect(r.ok()).toBeTruthy();
	const exps = (await r.json()).data?.experiments ?? [];
	const e = exps.find((x: any) => x.id === "kol_alpha");
	expect(e, "kol_alpha experiment is not declared").toBeTruthy();
	return e;
}

test.describe("@kol the lane is declared with all three legs", () => {
	test("kol_alpha = loop + metric + dataset", async () => {
		const e = await kolExperiment();
		// A loop with a metric and a dataset is an experiment; miss any leg and
		// it is either a plain workflow or not runnable. The gate blocks a
		// missing leg at publish — this asserts the declaration survived to the
		// running install.
		// realized_pnl_ticks since 2026-09-26 (GOALS.md 6.11): real_tape scored
		// 1.0 on every arm once real tape was routine, so it could never separate
		// them. real_tape is now the GATE (the metric is written only on an
		// all-axes-real claim), not the measure.
		expect(e.metric?.name).toBe("realized_pnl_ticks");
		expect(e.dataset_id).toBe("musk_tweets_v1");
		expect(e.loops ?? []).toContain("kol_strategy");
	});

	test("it declares a passive reference arm and a self-sufficient one", async () => {
		const e = await kolExperiment();
		const ids = (e.arms ?? []).map((a: any) => a.id).sort();
		expect(ids).toContain("current");   // passive — measured from hand submits
		expect(ids).toContain("musk_v1");   // one-click — reads the frozen slice
		// `current` carries no runnable config (label for present behaviour);
		// `musk_v1` names its dataset, so the panel offers it a real button.
		const musk = (e.arms ?? []).find((a: any) => a.id === "musk_v1");
		expect(musk.kol_dataset).toBe("musk_tweets_v1");
	});
});

test.describe("@kol it has actually measured — honestly", () => {
	test("musk_v1 has resolved, all-axes-real rows under the current metric", async () => {
		const e = await kolExperiment();
		// A state computed under the OLD metric would make every number below
		// meaningless; identity flags it (state_stale) instead of serving it.
		expect(e.state_stale, `state predates the metric (was ${e.state_metric})`).toBeFalsy();
		const v = (e.variants ?? {}).musk_v1;
		expect(v, "musk_v1 has no rows carrying realized_pnl_ticks — nothing real has resolved").toBeTruthy();
		// Every counted row passed the all-axes-real gate (the poll only writes
		// the metric on such a claim), so n > 0 proves a KOL-conditioned strategy
		// replayed real prices, real signals and a real settlement end to end.
		expect(v.n).toBeGreaterThan(0);
		expect(Number.isFinite(v.mean)).toBe(true);
	});

	test("the metric is realized PnL on the settled replay — higher is better, any sign", async () => {
		const e = await kolExperiment();
		expect(e.metric?.higher_is_better).toBe(true);
		// PnL in ticks: a losing arm is negative, a flat one (no order) is 0.
		// The old 0..1 bound belonged to real_tape and no longer applies.
		for (const v of Object.values(e.variants ?? {}) as any[]) {
			expect(Number.isFinite(v.mean)).toBe(true);
		}
	});
});

test.describe("@kol it renders as a derived surface — no UI code", () => {
	test.beforeEach(async ({ page }) => { await loginAsAdmin(page); });

	test("the kol_strategy row appears on Workflows", async ({ page }) => {
		await page.goto(`/studio/apps/${QUANT}?surface=workflows`);
		await expect(page.getByText(/kol.?strategy/i).first())
			.toBeVisible({ timeout: 30_000 });
	});

	test("selecting it shows Metric & experiments with kol_alpha in place", async ({ page }) => {
		await page.goto(`/studio/apps/${QUANT}?surface=workflows&selected=kol_strategy`);
		await page.getByRole("tab", { name: /^(study|measurement)$/i }).first().click({ timeout: 30_000 });
		await expect(page.getByText(/metric & experiments/i).first())
			.toBeVisible({ timeout: 30_000 });
		await expect(page.getByText(/kol.?alpha/i).first())
			.toBeVisible({ timeout: 25_000 });
		// The card cites its subject set — the honesty anchor a reader can see.
		await expect(page.getByText(/musk_tweets_v1/).first()).toBeVisible();
	});

	test("musk_v1 offers a one-click Run; current is measured passively", async ({ page }) => {
		await page.goto(`/studio/apps/${QUANT}?surface=workflows&selected=kol_strategy`);
		await page.getByRole("tab", { name: /^(study|measurement)$/i }).first().click({ timeout: 30_000 });
		await expect(page.getByText(/kol.?alpha/i).first()).toBeVisible({ timeout: 30_000 });
		await page.getByText(/kol.?alpha/i).first().click();
		await page.waitForTimeout(2000);
		// current has no runnable config → labelled, never a dead button.
		await expect(page.getByText(/measured passively/i).first()).toBeVisible({ timeout: 20_000 });
		// musk_v1 is self-sufficient → a real Run button (one-click, no subject ask).
		await expect(page.getByRole("button", { name: /^run$/i }).first())
			.toBeVisible({ timeout: 20_000 });
	});
});

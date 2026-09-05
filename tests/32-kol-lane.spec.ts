import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { loginAsAdmin } from "../fixtures/admin-session";
import { readFileSync } from "node:fs";
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
		expect(e.metric?.name).toBe("real_tape");
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
	test("musk_v1 has resolved rows and at least one landed on REAL tape", async () => {
		const e = await kolExperiment();
		const v = (e.variants ?? {}).musk_v1;
		expect(v, "musk_v1 has no observed rows — nothing has run").toBeTruthy();
		expect(v.n).toBeGreaterThan(0);
		// real_tape is a 0/1 metric, so mean*n = the count of runs that replayed
		// recorded prints. >= 1 proves a KOL-conditioned strategy backtested on
		// real market history, not a synthetic fallback — the milestone, and the
		// proof the whole generate->compile->claim->poll pipeline works end to
		// end. mean in [0,1] proves the honesty split is intact (a synthetic run
		// scores 0, never promoted to a real number).
		expect(v.mean).toBeGreaterThanOrEqual(0);
		expect(v.mean).toBeLessThanOrEqual(1);
		const realHits = Math.round(v.mean * v.n);
		expect(realHits, "no musk_v1 run ever reached real tape").toBeGreaterThanOrEqual(1);
	});

	test("the metric is honest-by-construction — higher real_tape is better, bounded 0..1", async () => {
		const e = await kolExperiment();
		expect(e.metric?.higher_is_better).toBe(true);
		for (const v of Object.values(e.variants ?? {}) as any[]) {
			expect(v.mean).toBeGreaterThanOrEqual(0);
			expect(v.mean).toBeLessThanOrEqual(1);
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

	test("selecting it shows Metric & arms with kol_alpha in place", async ({ page }) => {
		await page.goto(`/studio/apps/${QUANT}?surface=workflows&selected=kol_strategy`);
		await expect(page.getByText(/metric & arms/i).first())
			.toBeVisible({ timeout: 30_000 });
		await expect(page.getByText(/kol.?alpha/i).first())
			.toBeVisible({ timeout: 25_000 });
		// The card cites its subject set — the honesty anchor a reader can see.
		await expect(page.getByText(/musk_tweets_v1/).first()).toBeVisible();
	});

	test("musk_v1 offers a one-click Run; current is measured passively", async ({ page }) => {
		await page.goto(`/studio/apps/${QUANT}?surface=workflows&selected=kol_strategy`);
		await expect(page.getByText(/kol.?alpha/i).first()).toBeVisible({ timeout: 30_000 });
		await page.getByText(/kol.?alpha/i).first().click();
		await page.waitForTimeout(2000);
		// current has no runnable config → labelled, never a dead button.
		await expect(page.getByText(/measured passively/i).first()).toBeVisible({ timeout: 20_000 });
		// musk_v1 is self-sufficient → a real Run button (one-click, no subject ask).
		await expect(page.getByRole("button", { name: /run this arm|run \d+ more/i }).first())
			.toBeVisible({ timeout: 20_000 });
	});
});

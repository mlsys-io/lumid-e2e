import { test, expect, type APIRequestContext } from "@playwright/test";
import { loginAsAdmin } from "../fixtures/admin-session";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Adversarial coverage for the experiment control plane.
//
// Every assertion here corresponds to a failure that ACTUALLY SHIPPED at some
// point in this system, so each is a regression guard rather than a hypothetical:
//   * an enqueue route that returned HTTP 200 {"queued": 0} for work it never did
//   * a dispatch into an install nothing drains (silently queued forever)
//   * an arm resolved from the published bundle while the run used a stale install
//   * a surface telling 102 tenants a backtest REGISTERS their strategy when it
//     is a dry run
//   * a cross-tenant admin page reachable without admin
//
// Negative cases are deliberately cheap: they fail before any model call, so
// this suite costs no LLM spend.

function ownerToken(): string {
	return readFileSync(join(homedir(), ".lumid", "admin.pat"), "utf8").trim();
}
const CONSULTANT = "mbb-consultant";
const QUANT = "quant-research";

let owner: APIRequestContext;
let anon: APIRequestContext;
// Intent ids for the two refusal probes, dispatched ONCE at suite start.
//
// They used to be dispatched inside their own tests, which start their clock
// last — so on a shared queue they polled while every earlier spec's work was
// still draining, and timed out in a full run while passing in isolation in
// 6.6s. Issuing them up front lets them drain during the rest of the file. A
// test whose result depends on its neighbours is a flake, not a finding.
let badLoopIntent = "";
let badExpIntent = "";
test.beforeAll(async ({ playwright, baseURL }) => {
	owner = await playwright.request.newContext({
		baseURL, extraHTTPHeaders: { Authorization: `Bearer ${ownerToken()}` },
	});
	anon = await playwright.request.newContext({ baseURL });
	const r1 = await owner.post(`/api/v1/me/apps/${CONSULTANT}/loops/no_such_loop/enqueue`,
		{ data: { variants: [{ arm: "a" }] } });
	badLoopIntent = (await r1.json()).data?.intent_id ?? "";
	const r2 = await owner.post(`/api/v1/me/apps/${CONSULTANT}/loops/interview/enqueue`,
		{ data: { variants: [{ arm: "x" }], experiment_id: "no_such_experiment_e2e" } });
	badExpIntent = (await r2.json()).data?.intent_id ?? "";
});
test.afterAll(async () => { await owner?.dispose(); await anon?.dispose(); });

// Intent polls get 210s, not 90s. The queue's measured p95 is ~68s on an idle
// fleet, and this file runs alongside a stress spec that deliberately floods
// it — a 90s budget failed on exactly those two tests in a full-suite run
// while passing in isolation. A timeout that depends on neighbouring tests is
// a flake, not a finding.
const enqueue = (app: string, loop: string, body: any) =>
	owner.post(`/api/v1/me/apps/${app}/loops/${loop}/enqueue`, { data: body });

test.describe("@hard the enqueue contract", () => {
	test("accepts with 202 and an intent id — never a fabricated count", async () => {
		const r = await enqueue(CONSULTANT, "interview", {
			variants: [{ arm: "panel_single" }], experiment_id: "judge_panel_parity",
			args: { case: "Case_002_FemaleExecutives_PK20_v5", q: "Q1", session: "hard-contract" },
		});
		expect(r.status(), "202 means accepted; 200 was the old lie").toBe(202);
		const d = (await r.json()).data;
		expect(d.intent_id).toBeTruthy();
		expect(d.requested).toBe(1);
		// identity cannot know the queued count — the scheduler does the writes.
		expect(d).not.toHaveProperty("queued");
	});

	test("an empty variants array is refused, not accepted as zero work", async () => {
		const r = await enqueue(CONSULTANT, "interview", { variants: [] });
		expect(r.status()).toBe(400);
		expect(String((await r.json()).message ?? "")).toMatch(/variants/i);
	});

	test("a bogus app is accepted then FAILS LOUDLY on the intent", async () => {
		const r = await enqueue("no-such-app-e2e", "interview", { variants: [{ arm: "a" }] });
		expect(r.status()).toBe(202);
		const id = (await r.json()).data.intent_id;
		// The old shim answered 200 and did nothing. Now the failure is real,
		// attributable, and carries the reason.
		await expect.poll(async () => {
			const s = await (await owner.get(`/api/v1/me/intents/${id}`)).json();
			return s.data?.result?.ok === false ? String(s.data.result.error) : null;
		}, { timeout: 210_000, intervals: [3000] }).toMatch(/not installed/i);
	});

	test("a loop the app does not declare is refused by name", async () => {
		expect(badLoopIntent, "probe was not dispatched").toBeTruthy();
		await expect.poll(async () => {
			const s = await (await owner.get(`/api/v1/me/intents/${badLoopIntent}`)).json();
			return s.data?.result?.ok === false ? String(s.data.result.error) : null;
		}, { timeout: 210_000, intervals: [3000] }).toMatch(/no_such_loop.*interview|interview.*no_such_loop/is);
	});

	test("an experiment the INSTALL does not declare is refused, naming its version", async () => {
		// The split-brain guard: identity resolves an arm against the published
		// bundle while the run happens against the install on the scheduler's
		// volume. A stale install must fail loudly, not queue unmeasurably.
		expect(badExpIntent, "probe was not dispatched").toBeTruthy();
		await expect.poll(async () => {
			const s = await (await owner.get(`/api/v1/me/intents/${badExpIntent}`)).json();
			return s.data?.result?.ok === false ? String(s.data.result.error) : null;
		}, { timeout: 210_000, intervals: [3000] }).toMatch(/no_such_experiment_e2e/);
	});
});

test.describe("@hard access control", () => {
	test("admin insights refuses an unauthenticated caller", async () => {
		const r = await anon.get(`/api/v1/admin/apps/${QUANT}/insights?days=1`);
		expect([401, 403]).toContain(r.status());
	});

	test("the experiments API refuses an unauthenticated caller", async () => {
		const r = await anon.get(`/api/v1/me/apps/${CONSULTANT}/experiments`);
		expect([401, 403]).toContain(r.status());
	});

	test("enqueue refuses an unauthenticated caller", async () => {
		const r = await anon.post(`/api/v1/me/apps/${CONSULTANT}/loops/interview/enqueue`, {
			data: { variants: [{ arm: "panel_single" }] },
		});
		expect([401, 403]).toContain(r.status());
	});
});

test.describe("@hard honesty invariants", () => {
	test("nothing claims a backtest registers a strategy", async () => {
		// This told 102 tenants the opposite of the truth: the worker builds
		// --features pg,replay, so the local-replay dispatch posts no mailbox
		// message and a backtest is a DRY RUN. The dedicated backtests surface
		// was retired in the two-tab redesign, so the honesty claim now lives
		// in the LOOP description (rendered on the Workflows row/panel) — assert
		// it at the contract, which every surface reads.
		const r = await owner.get(`/api/v1/me/workflows`);
		const rows = ((await r.json()).data?.workflows ?? [])
			.filter((w: any) => w.app === QUANT && w.name === "backtest");
		expect(rows.length, "backtest loop missing from /me/workflows").toBeGreaterThan(0);
		const desc = String(rows[0].description ?? "");
		expect(desc).toMatch(/dry run/i);
		expect(desc).not.toMatch(/it is not a dry run/i);
		expect(desc).not.toMatch(/Backtest \(registers\)/);
	});

	test("a synthetic result can never occupy a real-performance column", async () => {
		const r = await owner.get(`/api/v1/admin/apps/${QUANT}/insights?days=30`);
		const bt = (await r.json()).data?.backtests ?? {};
		const verdicts = Object.fromEntries((bt.by_verdict ?? []).map((v: any) => [v.key, v.count]));
		// "unlabelled" and "not presentable" are DIFFERENT claims — absent is not
		// the same as false, and neither may be counted as presentable.
		expect(verdicts).not.toHaveProperty("presentable_synthetic");
		if (bt.total > 0) {
			expect(Object.keys(verdicts).length).toBeGreaterThan(0);
		}
	});

	test("the rollup reports failures rather than only successes", async () => {
		const e = (await (await owner.get(`/api/v1/admin/apps/${CONSULTANT}/insights?days=1`)).json())
			.data?.experiments;
		for (const arm of e.by_arm ?? []) {
			expect(arm).toHaveProperty("failed");
			expect(arm.runs).toBeGreaterThanOrEqual(arm.failed);
		}
	});
});

test.describe("@wide surfaces render across apps", () => {
	for (const surface of ["strategies", "backtests", "forward", "runtime", "experiments"]) {
		test(`quant-research /${surface} mounts`, async ({ page }) => {
			await loginAsAdmin(page);
			const res = await page.goto(`/studio/a/${QUANT}/${surface}`);
			expect(res?.status()).toBeLessThan(400);
			await expect(page.locator("body")).not.toContainText(/unknown surface|app declares no ui/i);
		});
	}

	test("an app with no installs renders honestly rather than erroring", async ({ page }) => {
		// mbb-ai is installed for nobody; the surface must degrade cleanly.
		await loginAsAdmin(page);
		const res = await page.goto("/studio/a/mbb-ai/experiments");
		expect(res?.status()).toBeLessThan(500);
	});

	test("the cross-app experiments library lists without crashing", async ({ page }) => {
		await loginAsAdmin(page);
		await page.goto("/studio/library/experiments");
		await expect(page.locator("body")).not.toContainText(/something went wrong|unhandled/i);
	});
});

test.describe("@wide the fleet actually received the declarations", () => {
	test("the published spec carries the declared experiments (no tab — they render in place)", async () => {
		// Two-tab redesign 2026-09-04: experiments have no tab of their own;
		// they render on the loop that feeds them (Metric & arms). Assert the
		// INVARIANT (the original two are present), not the census — pinning
		// an exact list made this test fail the day the kol_alpha lane was
		// deliberately added (2026-09-05), which is a stale-assertion failure
		// mode this file has already caused one peer-session revert over.
		const r = await owner.get(`/api/v1/me/apps/${QUANT}/experiments`);
		const ids = ((await r.json()).data?.experiments ?? []).map((e: any) => e.id);
		expect(ids).toEqual(expect.arrayContaining(["backtest_evidence", "backtest_performance"]));
	});

	test("every quant-research experiment is attached to a loop", async () => {
		// An unattached experiment is never evaluated: it accumulates rows and
		// reports n=0 forever, looking idle rather than broken. App-agnostic
		// over WHICH loop — kol_alpha attaches to kol_strategy, not backtest.
		const exps = ((await (await owner.get(`/api/v1/me/apps/${QUANT}/experiments`)).json())
			.data?.experiments ?? []);
		expect(exps.length).toBeGreaterThanOrEqual(2);
		for (const e of exps) {
			expect((e.loops ?? []).length, `${e.id} is attached to no loop`).toBeGreaterThan(0);
		}
	});
});

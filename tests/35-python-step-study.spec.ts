import { test, expect, type Page } from "@playwright/test";
import { createUser, deleteUser, type TestUser } from "../fixtures/test-user";
import { localOtpEnabled } from "../fixtures/otp-redis";
import { gotoRedirect } from "../fixtures/nav";
import { loginViaUi } from "../fixtures/login-ui";

// User Python in workflows, run by a brand-new non-admin account, end to end.
//
//   §A  a compute graph with a Python step runs on Research Fleet: unified
//       status, the step's metric in the result view, logs, and a row under
//       Research Fleet → Jobs → Your runs.
//   §B  a study whose two experiments run that kind of graph: defined AND run in
//       one call, each experiment records `score` (n >= 1), and the workflow's
//       Study tab shows both — in study/experiment words, not arm/variant.
//
// Non-admin on purpose: an admin reads through ownership checks, so every bug
// this path had (results never reaching the server, a result view that walked
// a field FlowMesh never sends, a read token refused per job) is invisible to
// one. The fixture agent is python-study-e2e (published by the admin account):
// workflow score_graph runs workflows/python_score.yaml, whose Python step
// returns {"metrics": {"score": SCORE_SCALE * mean words}}.

const AGENT = "python-study-e2e";
const AGENT_SLUG = "a3f48236-ffe9-4fb9-9548-6e044d5cd9c7/python-study-e2e";
const WORKFLOW = "score_graph";
const SITE = process.env.E2E_FLEET_SITE || "home";
const LONG_ENABLED = process.env.CI_E2E_LONG === "1";
const REQUIRE = process.env.E2E_FRESH_REQUIRE === "1";

const PYTHON_GRAPH = `apiVersion: flowmesh/v1
kind: Workflow
metadata:
  name: e2e-python-step
spec:
  stages:
    - name: prepare
      spec:
        taskType: echo
        data:
          type: list
          items: [the quick brown fox, jumps over the lazy dog]
    - name: score
      dependsOn: [prepare]
      spec:
        taskType: python
        emits: [mean_words]
        timeoutSeconds: 120
        code: |
          def main(prepare):
              words = [len(str(i["output"]).split()) for i in prepare["items"]]
              return {"metrics": {"mean_words": sum(words) / len(words)}}
`;

// Words the glossary retired from the screen (lumid_ui src/lib/glossary.ts).
const RETIRED_ON_STUDY_SURFACE = /\b(arms?|variants?|attempts?)\b/i;

async function api<T = any>(page: Page, method: "GET" | "POST", url: string, data?: unknown) {
	const r = method === "GET" ? await page.request.get(url) : await page.request.post(url, { data });
	const body = await r.json().catch(() => ({}));
	return { status: r.status(), body: (body?.data ?? body) as T, raw: body };
}

async function poll<T>(fn: () => Promise<T | undefined>, timeoutMs: number, what: string): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = await fn();
		if (v !== undefined) return v;
		if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 5_000));
	}
}

test.describe.configure({ mode: "serial" });

test.describe("35 — user Python in workflows and studies, as a fresh non-admin [long]", () => {
	let user: TestUser | null = null;
	let baseURL = "https://lum.id";

	test.beforeAll(async ({}, testInfo) => {
		const missing = !LONG_ENABLED
			? "CI_E2E_LONG=1 to enable this long e2e"
			: !localOtpEnabled() && !process.env.E2E_GMAIL_APP_PASSWORD
				? "No OTP source: CI_E2E_LOCAL_OTP=1 (LUMID_OTP_TRANSPORT=api|kubectl|docker) or E2E_GMAIL_APP_PASSWORD"
				: !process.env.E2E_INVITATION_CODE
					? "E2E_INVITATION_CODE is required"
					: "";
		if (missing && REQUIRE) throw new Error(`E2E_FRESH_REQUIRE=1 but spec 35 cannot run: ${missing}`);
		if (missing) testInfo.skip(true, missing);
	});

	test.afterAll(async () => {
		if (user) {
			const gone = await deleteUser(baseURL, user.email);
			console.log(`cleanup: ${user.email} ${gone ? "deleted" : "NOT deleted"}`);
		}
	});

	test("a Python step and a two-experiment study, end to end", async ({ browser }, testInfo) => {
		testInfo.setTimeout(20 * 60_000);
		baseURL = testInfo.project.use.baseURL ?? process.env.BASE_URL ?? "https://lum.id";
		user = await createUser(baseURL, {
			tag: `pystudy-${Date.now().toString(36)}`,
			invitationCode: process.env.E2E_INVITATION_CODE,
		});
		const ctx = await browser.newContext({ baseURL });
		const page = await ctx.newPage();
		await loginViaUi(page, user);

		// ── §A — a compute graph with a Python step on Research Fleet ─────────
		const run = await api(page, "POST", "/api/v1/me/fleet/jobs", {
			workflow: PYTHON_GRAPH, site: SITE, name: "e2e-python-step",
		});
		expect(run.status, `fleet run: ${JSON.stringify(run.raw)}`).toBe(202);
		const jobId: string = run.body.id;
		expect(jobId).toMatch(new RegExp(`^${SITE}:fm:wfl-`));

		const final = await poll(async () => {
			const s = await api(page, "GET", `/api/v1/me/fleet/jobs/${encodeURIComponent(jobId)}`);
			return s.body?.terminal ? s.body : undefined;
		}, 5 * 60_000, `job ${jobId} to finish`);
		expect(final.status, `unified status of ${jobId}: ${JSON.stringify(final)}`).toBe("succeeded");

		const result = await api(page, "GET", `/api/v1/me/fleet/jobs/${encodeURIComponent(jobId)}?view=result`);
		expect(result.body?.metrics?.mean_words, `result view: ${JSON.stringify(result.raw).slice(0, 600)}`).toBe(4.5);
		expect((result.body?.outputs ?? []).map((o: any) => o.name)).toEqual(["prepare", "score"]);

		const logs = await api(page, "GET", `/api/v1/me/fleet/jobs/${encodeURIComponent(jobId)}?view=logs`);
		expect(logs.status, `logs view: ${JSON.stringify(logs.raw).slice(0, 300)}`).toBe(200);

		await gotoRedirect(page, "/studio/research-fleet/jobs");
		const row = page.locator("tr", { hasText: jobId });
		await expect(row, "the job is listed under Your runs").toBeVisible({ timeout: 30_000 });
		await expect(row).toContainText("succeeded");

		// ── §B — a study whose experiments run that kind of graph ────────────
		const inst = await api(page, "POST", "/api/v1/me/apps", { slug: AGENT_SLUG });
		expect([200, 201, 202, 409], `install: ${JSON.stringify(inst.raw)}`).toContain(inst.status);
		await poll(async () => {
			const apps = await api(page, "GET", "/api/v1/me/apps");
			const a = (apps.body?.apps ?? []).find((x: any) => x.name === AGENT);
			if (a?.status === "failed") throw new Error(`install failed: ${JSON.stringify(a)}`);
			return a?.status === "ready" ? a : undefined;
		}, 3 * 60_000, `${AGENT} to install`);

		const STUDY = "scale";
		const define = await api(page, "POST", `/api/v1/me/agents/${AGENT}/studies?run=1`, {
			id: STUDY,
			workflow: WORKFLOW,
			hypothesis: "A larger SCORE_SCALE reports a larger score.",
			// A study must name its population (dataset_id or cases[]); a compute
			// graph has no dataset, so the one "case" is the graph's own input.
			cases: ["fox-and-dog"],
			metric: { name: "score", higher_is_better: true },
			experiments: [
				{ id: "small", env: { SCORE_SCALE: "0.1" } },
				{ id: "large", env: { SCORE_SCALE: "0.2" } },
			],
			min_samples: 1,
			samples: 1,
		});
		expect(define.status, `study define+run: ${JSON.stringify(define.raw)}`).toBe(202);
		expect(define.body?.warnings ?? [], "a clean define has no warnings").toEqual([]);

		// For a user's install the per-experiment numbers are the study's reported
		// STATE (the rows live on the scheduler's disk, which identity cannot
		// read); state.variants is what the Study tab renders.
		const variants = await poll(async () => {
			const d = await api(page, "GET", `/api/v1/me/apps/${AGENT}/experiments/${STUDY}`);
			const v: Record<string, { n: number; mean: number }> = d.body?.state?.variants ?? {};
			return v.small?.n >= 1 && v.large?.n >= 1 ? v : undefined;
		}, 12 * 60_000, `both experiments of ${STUDY} to record score (state.variants n >= 1)`);
		expect(variants.small.mean).toBeCloseTo(0.45, 4);
		expect(variants.large.mean).toBeCloseTo(0.9, 4);

		await page.goto(`/studio/apps/${AGENT}?surface=workflows&selected=${WORKFLOW}`);
		await page.getByRole("tab", { name: /^study$/i }).first().click({ timeout: 30_000 });
		await expect(page.getByText(/metric & experiments/i).first()).toBeVisible({ timeout: 30_000 });
		await expect(page.getByText(/2 experiments/i).first()).toBeVisible();
		for (const id of ["small", "large"]) {
			// The card lists each experiment with its run count: "small · 1".
			await expect(page.getByText(new RegExp(`\\b${id}\\s*·\\s*[1-9]`)).first(), `experiment ${id} with n >= 1`).toBeVisible();
		}
		const text = await page.locator("main").innerText();
		expect(text.match(RETIRED_ON_STUDY_SURFACE)?.[0] ?? null, "a retired word on the Study tab").toBeNull();

		await ctx.close();
	});
});

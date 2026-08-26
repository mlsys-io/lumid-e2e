/**
 * @stress
 *
 * Concurrency stress over POST /api/v1/me/data-query — the path behind the
 * Studio SQL console AND behind chat's `data_query` tool.
 *
 * WHY THIS TARGET. Spec 20 stresses the cached read surfaces; this one is the
 * opposite shape. Every call here is uncached and fans out: identity → findata
 * /retrieve → the warehouse → a materialized JSONL blob fetched on a SECOND
 * hop. Two sequential HTTP hops per query, against a single findata shadow, is
 * exactly where a 20-student cohort will serialise — and nothing has ever put
 * more than a couple of concurrent users through it.
 *
 * WHY THE QUERIES ARE TRIVIAL. `SELECT 1` deliberately. The thing under test is
 * the PATH (auth, proxy, two hops, materialization), not warehouse compute.
 * Driving expensive SQL from a load test would measure the warehouse's other
 * tenants' bad luck and could become the incident it is meant to prevent — the
 * same reason spec 20 refuses to stress a Claude turn.
 *
 * OPT-IN, because it generates real load against production:
 *   STRESS=1 E2E_USER_EMAIL=… E2E_USER_PASSWORD=… \
 *     npx playwright test tests/24-stress-data-query.spec.ts
 *
 * Tunables: STRESS_USERS (default 20 — the cohort size), STRESS_ITERS (5).
 */

import { test, expect, request as pwrequest, type APIRequestContext } from "@playwright/test";

const ON = process.env.STRESS === "1";
const USERS = Number.parseInt(process.env.STRESS_USERS || "20", 10);
const ITERS = Number.parseInt(process.env.STRESS_ITERS || "5", 10);
// STRESS_SQL swaps in a REAL-table query. It matters: `SELECT 1` comes back
// inline from findata and never takes the second (materialize-then-fetch) hop,
// so it measures auth + proxy only and flatters the path. A bounded read of an
// actual table is what a student's first query looks like.
const SQL = process.env.STRESS_SQL || "SELECT 1 AS ok";
const EXPECT_ROWS = Number.parseInt(process.env.STRESS_EXPECT_ROWS || "1", 10);

interface Sample { ms: number; status: number; rows: number }

function pct(sorted: number[], p: number): number {
	if (!sorted.length) return 0;
	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function report(name: string, s: Sample[]) {
	const lat = s.map((x) => x.ms).sort((a, b) => a - b);
	const codes = s.reduce<Record<number, number>>((a, x) => ((a[x.status] = (a[x.status] || 0) + 1), a), {});
	// eslint-disable-next-line no-console
	console.log(
		`\n  ${name}\n    n=${s.length}  p50=${pct(lat, 50)}ms  p95=${pct(lat, 95)}ms  ` +
			`p99=${pct(lat, 99)}ms  max=${lat[lat.length - 1]}ms\n    codes=${JSON.stringify(codes)}`,
	);
	return { lat, codes };
}

async function bearerFor(baseURL: string, email: string, password: string): Promise<string> {
	const api = await pwrequest.newContext({ baseURL });
	try {
		const r = await api.post("/api/v1/login", {
			data: { email, password },
			headers: { "Content-Type": "application/json" },
		});
		if (!r.ok()) throw new Error(`login ${r.status()}: ${await r.text()}`);
		return (await r.json())?.data?.token || "";
	} finally {
		await api.dispose();
	}
}

/** ITERS sequential queries per virtual user, USERS users in parallel. */
async function hammer(request: APIRequestContext, bearer: string, sql: string): Promise<Sample[]> {
	const out: Sample[] = [];
	await Promise.all(
		Array.from({ length: USERS }, async () => {
			for (let i = 0; i < ITERS; i++) {
				const t0 = Date.now();
				try {
					const res = await request.post("/api/v1/me/data-query", {
						headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
						data: { sql },
						timeout: 60_000,
					});
					let rows = -1;
					try { rows = (await res.json())?.data?.rows?.length ?? -1; } catch { /* non-JSON */ }
					out.push({ ms: Date.now() - t0, status: res.status(), rows });
				} catch {
					// A transport failure is the worst outcome; record it as 0 so it
					// cannot be silently dropped out of the percentiles.
					out.push({ ms: Date.now() - t0, status: 0, rows: -1 });
				}
			}
		}),
	);
	return out;
}

test.describe("@stress data-query under cohort concurrency", () => {
	test.skip(!ON, "opt-in: set STRESS=1");
	test.describe.configure({ timeout: 600_000, mode: "serial" });

	let bearer = "";

	test.beforeAll(async ({ baseURL }, testInfo) => {
		const email = process.env.E2E_USER_EMAIL;
		const password = process.env.E2E_USER_PASSWORD;
		if (!email || !password) testInfo.skip(true, "needs E2E_USER_EMAIL + E2E_USER_PASSWORD (a role-`user`)");
		bearer = await bearerFor(baseURL!, email!, password!);
		expect(bearer, "login returned no token").toBeTruthy();
	});

	test("@stress cohort-sized concurrency stays correct and 5xx-free", async ({ request }) => {
		const s = await hammer(request, bearer, SQL);
		const { codes } = report(`POST /me/data-query  (${USERS} users x ${ITERS})`, s);

		const bad = s.filter((x) => x.status >= 500 || x.status === 0).length;
		expect(bad, `5xx/transport failures: ${JSON.stringify(codes)}`).toBe(0);

		// A 401 that appears ONLY under concurrency is the signature of shared
		// auth state, which is the bug class worth catching here.
		expect(s.filter((x) => x.status === 401 || x.status === 403).length,
			`auth failures under load: ${JSON.stringify(codes)}`).toBe(0);

		// Correctness under load, not just liveness: a degraded path that returns
		// 200 with an empty body would otherwise pass every latency assertion.
		const wrong = s.filter((x) => x.status === 200 && x.rows !== EXPECT_ROWS).length;
		expect(wrong, `200s that did not return exactly ${EXPECT_ROWS} row(s)`).toBe(0);
	});

	test("@stress the LIMIT guard still bounds under load", async ({ request }) => {
		// Regression cover for the unanchored-limitRe bug, driven concurrently.
		// The inner LIMIT 3 used to convince the guard the query was bounded, so
		// the OUTER query ran with no bound; with limit=2 the fix must cap it at
		// 2 rows. Observable from outside precisely because inner != outer.
		const sql = "SELECT * FROM (SELECT 1 AS x UNION ALL SELECT 2 UNION ALL SELECT 3 LIMIT 3) s";
		const out: number[] = [];
		await Promise.all(
			Array.from({ length: USERS }, async () => {
				const res = await request.post("/api/v1/me/data-query", {
					headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
					data: { sql, limit: 2 },
					timeout: 60_000,
				});
				if (res.status() === 200) out.push((await res.json())?.data?.rows?.length ?? -1);
			}),
		);
		expect(out.length, "no successful responses to judge").toBeGreaterThan(0);
		// eslint-disable-next-line no-console
		console.log(`\n  LIMIT guard under load: row counts = ${JSON.stringify([...new Set(out)])}`);
		expect(out.every((n) => n <= 2), `unbounded rows returned: ${JSON.stringify(out)}`).toBeTruthy();
	});
});

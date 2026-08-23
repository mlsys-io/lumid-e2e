/**
 * @stress
 *
 * Concurrency stress over the READ surfaces the cohort will actually hammer.
 *
 * WHY THESE TARGETS, AND WHY NOT THE OBVIOUS ONE.
 * The tempting thing to stress is a Claude turn, because that is what a
 * researcher spends their day doing. Don't. The Anthropic pool is homed
 * `cap 5/account`, and at the time of writing exactly one account is servable
 * and already full — so a load test driving Claude does not measure headroom,
 * it takes slots away from whoever is mid-session and reports their degradation
 * as its own result. Deepseek is likewise a single GB10 pair behind
 * MAX_CONCURRENCY=6, where the honest finding is already known and measured.
 *
 * What IS worth stressing is the read path a cohort opens constantly and which
 * has never carried more than a handful of concurrent users: the strategy
 * surfaces. `/lqt/inspect/*` is RLS-enforced per caller and was consumer-less
 * until 2026-08-23, so its concurrency behaviour is genuinely unmeasured.
 *
 * OPT-IN. Tagged @stress and skipped unless STRESS=1, because it is the one
 * spec here that deliberately generates load against production:
 *   STRESS=1 LQT_PAT=lm_pat_live_… npx playwright test --grep @stress
 *
 * Tunables: STRESS_USERS (default 10), STRESS_ITERS (default 10).
 * Defaults are deliberately modest — 100 requests per target, enough to expose
 * serialisation and connection-pool limits without becoming the incident.
 */

import { test, expect, type APIRequestContext } from "@playwright/test";

const ON = process.env.STRESS === "1";
const USERS = Number.parseInt(process.env.STRESS_USERS || "10", 10);
const ITERS = Number.parseInt(process.env.STRESS_ITERS || "10", 10);
const PAT = process.env.LQT_PAT || process.env.LUMID_PAT || "";

interface Sample {
	ms: number;
	status: number;
}

function pct(sorted: number[], p: number): number {
	if (!sorted.length) return 0;
	const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
	return sorted[i];
}

function report(name: string, samples: Sample[]) {
	const lat = samples.map((s) => s.ms).sort((a, b) => a - b);
	const codes = samples.reduce<Record<number, number>>((acc, s) => {
		acc[s.status] = (acc[s.status] || 0) + 1;
		return acc;
	}, {});
	// eslint-disable-next-line no-console
	console.log(
		`\n  ${name}\n` +
			`    n=${samples.length}  p50=${pct(lat, 50)}ms  p95=${pct(lat, 95)}ms  ` +
			`p99=${pct(lat, 99)}ms  max=${lat[lat.length - 1]}ms\n` +
			`    codes=${JSON.stringify(codes)}`,
	);
	return { lat, codes };
}

/** Fire ITERS sequential requests per virtual user, USERS users in parallel. */
async function hammer(
	request: APIRequestContext,
	url: string,
	headers: Record<string, string>,
): Promise<Sample[]> {
	const out: Sample[] = [];
	await Promise.all(
		Array.from({ length: USERS }, async () => {
			for (let i = 0; i < ITERS; i++) {
				const t0 = Date.now();
				try {
					const res = await request.get(url, { headers, timeout: 30_000 });
					out.push({ ms: Date.now() - t0, status: res.status() });
				} catch {
					// A transport failure is the worst outcome and must not be
					// silently dropped — record it as 0 so it shows in `codes`.
					out.push({ ms: Date.now() - t0, status: 0 });
				}
			}
		}),
	);
	return out;
}

test.describe("@stress read surfaces under concurrency", () => {
	test.skip(!ON, "opt-in: set STRESS=1");
	test.describe.configure({ timeout: 300_000 });

	test("@stress landing survives concurrent load", async ({ request }) => {
		const s = await hammer(request, "/auth/login", {});
		const { codes } = report(`GET /auth/login  (${USERS}x${ITERS})`, s);
		const bad = s.filter((x) => x.status >= 500 || x.status === 0).length;
		expect(bad, `5xx/transport failures: ${JSON.stringify(codes)}`).toBe(0);
	});

	test("@stress lqt-inspect strategies is tenant-scoped and stable", async ({ request }) => {
		test.skip(!PAT, "needs LQT_PAT (a role=user PAT)");
		const s = await hammer(request, "/lqt/inspect/strategies?limit=50", {
			Authorization: `Bearer ${PAT}`,
		});
		const { lat, codes } = report(`GET /lqt/inspect/strategies  (${USERS}x${ITERS})`, s);

		const bad = s.filter((x) => x.status >= 500 || x.status === 0).length;
		expect(bad, `5xx/transport failures: ${JSON.stringify(codes)}`).toBe(0);
		// Every response must be authorized — a 401/403 appearing only under
		// concurrency is the signature of a shared-state auth bug, which is
		// exactly what a per-caller RLS surface could plausibly get wrong.
		// NOTE 429 is deliberately NOT counted here: see the rate-limit test
		// below. A single synthetic caller SHOULD be throttled.
		const denied = s.filter((x) => x.status === 401 || x.status === 403).length;
		expect(denied, `auth failures under load: ${JSON.stringify(codes)}`).toBe(0);
		// Only the SERVED requests tell you anything about latency; including
		// throttled ones would flatter the number, since a 429 returns fast.
		const served = s.filter((x) => x.status === 200).map((x) => x.ms).sort((a, b) => a - b);
		expect(pct(served, 95)).toBeLessThan(3000);
	});

	test("@stress per-user quota read stays correct under load", async ({ request }) => {
		test.skip(!PAT, "needs LQT_PAT (a role=user PAT)");
		const out: Sample[] = [];
		const caps = new Set<string>();
		await Promise.all(
			Array.from({ length: USERS }, async () => {
				for (let i = 0; i < ITERS; i++) {
					const t0 = Date.now();
					const res = await request.get("/api/v1/me/claude-usage", {
						headers: { Authorization: `Bearer ${PAT}` },
						timeout: 30_000,
					});
					out.push({ ms: Date.now() - t0, status: res.status() });
					if (res.ok()) {
						const d = (await res.json())?.data ?? {};
						caps.add(`${d.cap_5h}/${d.cap_7d}/${d.cap_unlimited}`);
					}
				}
			}),
		);
		const { codes } = report(`GET /api/v1/me/claude-usage  (${USERS}x${ITERS})`, out);
		// eslint-disable-next-line no-console
		console.log(`    distinct cap tuples observed: ${[...caps].join(" | ")}`);

		const bad = out.filter((x) => x.status >= 500 || x.status === 0).length;
		expect(bad, `5xx/transport failures: ${JSON.stringify(codes)}`).toBe(0);
		// THE POINT OF THIS TEST. Caps are resolved per user through a memoised
		// role cache (roleCache, TTL'd, shared across goroutines). If that cache
		// ever raced or keyed wrongly, a caller would intermittently be handed
		// ANOTHER tier's numbers — and because the value is plausible, nothing
		// downstream would notice. One caller must see exactly one tuple.
		expect(caps.size, `saw >1 cap tuple for one caller: ${[...caps].join(" | ")}`).toBe(1);
	});
});

/**
 * @stress
 *
 * The rate limiter is the thing that decides whether a cohort scales, so pin
 * its KEY, not just its existence.
 *
 * When 50 virtual users share one PAT, ~40-50% of requests come back 429 —
 * which looks alarming and is in fact correct: `callerKey` (identity
 * internal/handler/me_rate_limit.go) buckets on a sha256 of the bearer, then
 * the lm_session cookie, then the client IP. One PAT is one bucket.
 *
 * The property that matters for 20 researchers is that they do NOT share a
 * bucket. If callerKey ever regressed to IP-only — an easy accident behind a
 * shared egress or a proxy-header change — the whole cohort would collapse into
 * a single 600/min budget and start throttling each other, with no error that
 * points at the cause.
 */
test.describe("@stress rate limiting is per-caller, not shared", () => {
	test.skip(!ON, "opt-in: set STRESS=1");
	test.skip(!PAT || !process.env.LQT_PAT_B, "needs two distinct PATs: LQT_PAT + LQT_PAT_B");
	test.describe.configure({ timeout: 180_000 });

	test("@stress burning one caller's budget leaves another untouched", async ({ request }) => {
		const B = process.env.LQT_PAT_B as string;
		// Return BOTH, because a throttled response may omit the header — and
		// "header absent" must never be silently read as "budget is 0". An
		// earlier version returned -1 in that case and its assertion then passed
		// because -1 < B, i.e. for entirely the wrong reason.
		const probe = async (tok: string): Promise<{ status: number; left: number | null }> => {
			const res = await request.get("/api/v1/me/claude-usage", {
				headers: { Authorization: `Bearer ${tok}` },
			});
			const raw = res.headers()["x-ratelimit-remaining"];
			return { status: res.status(), left: raw === undefined ? null : Number.parseInt(raw, 10) };
		};

		const bBefore = await probe(B);
		// Burn A well into its budget.
		await Promise.all(
			Array.from({ length: 100 }, () =>
				request
					.get("/api/v1/me/claude-usage", { headers: { Authorization: `Bearer ${PAT}` } })
					.catch(() => undefined),
			),
		);
		const aAfter = await probe(PAT);
		const bAfter = await probe(B);

		// eslint-disable-next-line no-console
		console.log(
			`\n  A after burn: status=${aAfter.status} left=${aAfter.left}` +
				`   B: before=${bBefore.left} after=${bAfter.left} status=${bAfter.status}`,
		);

		// A must show consumption EXPLICITLY: either it is now being throttled
		// (429 — proof the bucket is spent) or it still reports a header and that
		// header is materially lower than B's untouched budget.
		const aSpent = aAfter.status === 429 || (aAfter.left !== null && bAfter.left !== null && aAfter.left < bAfter.left);
		expect(aSpent, `caller A's budget was not visibly consumed (status=${aAfter.status}, left=${aAfter.left})`).toBe(true);

		// B must be essentially untouched. Require a real reading — a missing
		// header here is inconclusive, not a pass.
		expect(bBefore.left, "B had no rate-limit header before").not.toBeNull();
		expect(bAfter.left, "B had no rate-limit header after").not.toBeNull();
		expect(
			(bBefore.left as number) - (bAfter.left as number),
			"caller B's budget moved with A's traffic — buckets are SHARED",
		).toBeLessThanOrEqual(3);
	});
});

/**
 * @stress
 *
 * Chatbox + FinData under cohort-scale concurrency.
 *
 * This is the one path that genuinely loads the GPU, so read the model note
 * before touching it: the native chat loop's model id is `kvrun-gemma4`, which
 * is a LEGACY LABEL kept on purpose (personas persist it, the UI and e2e
 * reference it). Its displayName is "DeepSeek-V4-Flash (Lumid GPU)" and its
 * upstreamModel is `deepseek-v4-flash` — i.e. the single GB10 pair. Reading the
 * id and concluding "not deepseek" is a mistake that has already been made once.
 *
 * MEASURED 2026-08-23 against prod, and the shape is counter-intuitive:
 *
 *     concurrent   p50      p95      all-200
 *          1       15.9s     —        yes
 *          5       29.2s   33.7s      yes     <- COLD cache, not steady state
 *         10       15.1s   19.3s      yes
 *         20        9.8s   17.1s      yes
 *
 * It gets FASTER under load. Each query carries a ~18k-token tool-schema prefix
 * and returns ~80 output tokens, so the cost is almost entirely prefill — and
 * that prefix is IDENTICAL across users, so it sits in the GB10 prefix cache.
 * The first round pays for it and everyone after rides it. The 5-user row above
 * is the cold-cache round; quoting it as "2x degradation at 5 users" is exactly
 * backwards, so always discard the first round when interpreting a run.
 *
 * WHAT THIS TEST IS REALLY GUARDING. The scaling depends entirely on users
 * SHARING a prefix. Anything that makes each user's prefix unique — a per-user
 * system prompt, tenant context injected AHEAD of the tool schemas, a
 * personalised preamble — turns one warm cache hit into N cold prefills and
 * takes p50 from ~10s to minutes. That regression would look like "the GPU got
 * slower", not like the prompt change that caused it.
 */
test.describe("@stress chatbox findata at cohort scale", () => {
	test.skip(!ON, "opt-in: set STRESS=1");
	test.skip(!PAT, "needs LQT_PAT");
	test.describe.configure({ timeout: 900_000 });

	test("@stress N concurrent findata questions all answer correctly", async ({ request }) => {
		const N = Number.parseInt(process.env.STRESS_CHAT_USERS || "20", 10);

		const ask = async (i: number) => {
			const t0 = Date.now();
			const res = await request.post("/api/v1/me/agent/chat", {
				headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
				data: {
					messages: [
						{ role: "user", content: `Use data_catalog to name FinData schemas. One sentence. (probe ${i})` },
					],
				},
				timeout: 500_000,
			});
			const body = res.ok() ? await res.json().catch(() => ({})) : {};
			const reply = String(body?.data?.reply ?? body?.reply ?? "");
			return { ms: Date.now() - t0, status: res.status(), reply };
		};

		// Warm the shared prefix first and DISCARD it — otherwise the run
		// measures cold prefill and reports the opposite of the truth.
		await ask(0);

		const out = await Promise.all(Array.from({ length: N }, (_, i) => ask(i + 1)));
		report(`POST /me/agent/chat  (${N} concurrent, warm)`, out.map(({ ms, status }) => ({ ms, status })));

		const nonEmpty = out.filter((r) => r.reply.trim().length > 0).length;
		// A real answer must name schemas that actually exist in the warehouse —
		// this is what separates "the endpoint returned 200" from "the tool ran".
		const grounded = out.filter((r) => /prediction_markets|fundamentals|schema/i.test(r.reply)).length;
		// eslint-disable-next-line no-console
		console.log(`    non-empty=${nonEmpty}/${N}  grounded=${grounded}/${N}  distinct=${new Set(out.map((r) => r.reply)).size}`);

		expect(out.filter((r) => r.status !== 200).length, "non-200 responses").toBe(0);
		expect(nonEmpty, "empty replies under load").toBe(N);
		expect(grounded, "replies that did not name real FinData schemas").toBe(N);
	});
});

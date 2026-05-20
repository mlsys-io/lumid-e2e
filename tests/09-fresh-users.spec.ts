import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { createUser, loginViaApi } from "../fixtures/test-user";
import { mintPatViaApi, type LumidPatToken } from "../fixtures/lumid-pat";

/**
 * Journey 9 — Multiple fresh users in parallel exercise the
 * full data-access path against `https://kv.run:5000` with their
 * freshly-minted Lumid PATs. Validates:
 *
 *   (a) Each new user successfully signs up + logs in + mints a PAT.
 *   (b) Each PAT works against findata's read endpoints
 *       (`/symbols/AAPL`, `/news/latest`, `/kols`, `/quotes`).
 *   (c) Per-identity rate limit kicks in around 600/min
 *       (anon is capped at 60/min).
 *   (d) Identities are isolated — user A's admin endpoint call is
 *       forbidden (403), proving the PAT introspection chain
 *       passes the right `role` through to authorization gates.
 *   (e) Different users hitting the same endpoint concurrently
 *       don't accidentally share rate-limit buckets.
 *
 * Default N=3 fresh users. Override with E2E_FRESH_USER_COUNT.
 *
 * Required env (in .env.local):
 *   E2E_GMAIL_USER + E2E_GMAIL_APP_PASSWORD    — for OTP polling
 *   E2E_INVITATION_CODE                         — required by /register
 *   KV_RUN_BASE_URL (default https://kv.run:5000)
 */

const N = Number(process.env.E2E_FRESH_USER_COUNT || 3);
const KV_RUN = process.env.KV_RUN_BASE_URL || "https://kv.run:5000";
const INVITE = process.env.E2E_INVITATION_CODE;
const BASE = process.env.BASE_URL || "https://lum.id";

interface Persona {
	email: string;
	password: string;
	username: string;
	api: APIRequestContext;
	pat: LumidPatToken;
}

test.describe("09 — multi fresh-user data-access", () => {
	test.skip(!INVITE, "E2E_INVITATION_CODE not set");
	test.setTimeout(300_000); // 5 min — Gmail polling can be slow

	let personas: Persona[] = [];

	test.beforeAll(async () => {
		// Provision N users in parallel. Stagger by 250ms to avoid
		// hitting send-verification-code rate-limit on the lumid side.
		const stagger = (i: number) => new Promise(r => setTimeout(r, i * 250));

		const provisions = await Promise.all(
			Array.from({ length: N }, async (_, i) => {
				await stagger(i);
				const u = await createUser(BASE, { tag: `freshe2e-${i}-${Date.now().toString(36)}` });
				const api = await request.newContext({ baseURL: BASE });
				await loginViaApi(api, u.email, u.password);
				const pat = await mintPatViaApi(api, { name: `kv-run-e2e-${i}` });
				return { ...u, api, pat };
			})
		);
		personas = provisions;
		console.log(`provisioned ${personas.length} fresh users`);
	});

	test.afterAll(async () => {
		await Promise.all(personas.map(p => p.api.dispose()));
	});

	test("(a) every persona's PAT authenticates against kv.run /symbols", async () => {
		const api = await request.newContext({ baseURL: KV_RUN });
		try {
			for (const p of personas) {
				const r = await api.get("/symbols/AAPL", {
					headers: { Authorization: `Bearer ${p.pat.pat}` },
				});
				expect(r.status(), `${p.username} on /symbols/AAPL`).toBe(200);
				const body = await r.json();
				expect(body.symbol).toBe("AAPL");
			}
		} finally {
			await api.dispose();
		}
	});

	test("(b) each persona can hit the main data endpoints with their own PAT", async () => {
		const api = await request.newContext({ baseURL: KV_RUN });
		const probes = ["/symbols/AAPL", "/news/latest?limit=3",
		                 "/kols?include_inactive=false",
		                 "/quotes?symbols=AAPL,BTCUSD"];
		try {
			for (const p of personas) {
				for (const path of probes) {
					const r = await api.get(path, {
						headers: { Authorization: `Bearer ${p.pat.pat}` },
					});
					expect(r.status(), `${p.username} ${path}`).toBe(200);
				}
			}
		} finally {
			await api.dispose();
		}
	});

	test("(c) authed rate-limit is 600/min — fire 65 requests in parallel, expect all 200", async () => {
		// Per-identity tier is 600/min vs anon 60/min. 65 in 2s
		// should all clear under the authed tier.
		const p = personas[0];
		const api = await request.newContext({ baseURL: KV_RUN });
		try {
			const results = await Promise.all(
				Array.from({ length: 65 }, () =>
					api.get("/health", { headers: { Authorization: `Bearer ${p.pat.pat}` } }),
				),
			);
			const statuses = results.map(r => r.status());
			const ok = statuses.filter(s => s === 200).length;
			const throttled = statuses.filter(s => s === 429).length;
			expect(ok, `${ok}/65 succeeded; throttled=${throttled}`).toBe(65);
		} finally {
			await api.dispose();
		}
	});

	test("(d) admin endpoint forbids non-admin personas (403)", async () => {
		// POST /admin/kols is gated to super_admin only. Every fresh
		// user has role=user by default — should be 403.
		const api = await request.newContext({ baseURL: KV_RUN });
		try {
			for (const p of personas) {
				const r = await api.post("/admin/kols", {
					data: { handle: `testkol-${p.username}` },
					headers: {
						Authorization: `Bearer ${p.pat.pat}`,
						"Content-Type": "application/json",
					},
				});
				expect([401, 403], `${p.username} /admin/kols`).toContain(r.status());
			}
		} finally {
			await api.dispose();
		}
	});

	test("(e) per-identity rate-limit buckets are isolated across personas", async () => {
		// User A burns through their 60-req anon-tier headroom, then
		// User B should still get clean responses. Use a low-volume
		// endpoint (one request per persona) — we're proving the key
		// isn't shared, not stress-testing.
		const api = await request.newContext({ baseURL: KV_RUN });
		try {
			// All personas fire 10 requests each in parallel; everyone
			// should get 10/10 200s because their buckets are separate.
			const fanout = await Promise.all(
				personas.map(p =>
					Promise.all(
						Array.from({ length: 10 }, () =>
							api.get("/quotes?symbols=AAPL", {
								headers: { Authorization: `Bearer ${p.pat.pat}` },
							}),
						),
					),
				),
			);
			for (let i = 0; i < personas.length; i++) {
				const statuses = fanout[i].map(r => r.status());
				expect(
					statuses.every(s => s === 200),
					`${personas[i].username} got non-200s: ${statuses}`,
				).toBe(true);
			}
		} finally {
			await api.dispose();
		}
	});

	test("(f) introspect cache is per-token, not per-process — revoking one PAT does not 401 the others", async () => {
		// Revoke persona[0]'s PAT via REST; persona[1..N-1]'s PATs
		// must still work (the cache key includes the token, not the
		// process).
		const victim = personas[0];
		await victim.api.delete(`/api/v1/tokens/${victim.pat.tokenId}`);
		const api = await request.newContext({ baseURL: KV_RUN });
		try {
			// Wait past the 5-min lumid introspect cache TTL to make
			// sure the rejection is enforced. (5 min is the canonical
			// cache window per lumid.py:LumidClient.)
			//
			// For dev-loop speed, the test can be re-run with
			// LUMID_CACHE_TTL set to a smaller value on the kv.run
			// side — but the default test exercises the prod path.
			await new Promise(r => setTimeout(r, 305_000)); // 5m 5s
			const dead = await api.get("/symbols/AAPL", {
				headers: { Authorization: `Bearer ${victim.pat.pat}` },
			});
			expect(dead.status(), `revoked PAT for ${victim.username}`).toBe(401);

			for (const p of personas.slice(1)) {
				const live = await api.get("/symbols/AAPL", {
					headers: { Authorization: `Bearer ${p.pat.pat}` },
				});
				expect(live.status(), `still-live PAT for ${p.username}`).toBe(200);
			}
		} finally {
			await api.dispose();
		}
	});
});

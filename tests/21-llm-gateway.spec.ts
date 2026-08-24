/**
 * @llm
 *
 * lum.id/llm — the inference gateway, end to end.
 *
 * The gateway's whole contract is its ROSTER: which model ids it will serve,
 * where each one is served from, and — the part that costs money when it is
 * wrong — which ids it refuses outright. Every regression this file guards has
 * actually happened:
 *
 *   • /v1/models merged OpenRouter's entire catalog: 423 ids advertised, ONE
 *     routable. Every other id 503'd as unknown.
 *   • an unconfigured/typo'd id was forwarded to real OpenRouter and BILLED
 *     (llm-0d342a8 closed it; 70fc036 reopened it by accident).
 *   • the landing page served the generic data-service copy, advertising
 *     Catalog/lineage/ingest routes that 401 or 404 here.
 *   • /openapi.json documented 18 paths, none of them LLM.
 *
 * Public checks need no credentials. The routing matrix needs a PAT with the
 * gateway in scope — set E2E_LLM_TOKEN (or LQT_MAILBOX_PAT) or those tests skip
 * rather than fail, so this file stays useful in a credential-free checkout.
 *
 * Run: npx playwright test --grep @llm --project chromium
 */

import { test, expect } from "@playwright/test";

const LLM = "https://lum.id/llm";
const TOKEN = process.env.E2E_LLM_TOKEN || process.env.LQT_MAILBOX_PAT || "";
const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

// A model the gateway serves from OpenRouter, and one it serves in house.
const QWEN = "qwen/qwen3-coder";
const LOCAL = "deepseek-v4-flash";

// ── public: no credentials ────────────────────────────────────────────────────

test("@llm landing describes THIS product, not the platform it is built on", async ({ request }) => {
	const res = await request.get(`${LLM}/`);
	expect(res.status()).toBe(200);
	const html = await res.text();

	expect(html).toContain("<title>Lumid LLM</title>");
	// The landing was a hardcoded &'static str until llm-3a37017, so every app on
	// this platform introduced itself as a data service.
	expect(html).not.toContain("portable data service");
	expect(html).not.toContain("lineage");
	// It must name the actual surface — the page exists to answer "what do I POST?"
	expect(html).toContain("/v1/chat/completions");
	// Copy comes from LUMID_SERVICE_* env; an unsubstituted placeholder means the
	// template and the handler have drifted apart.
	expect(html).not.toMatch(/\{\{[A-Z_]+\}\}/);
});

test("@llm openapi documents the /v1 surface", async ({ request }) => {
	const res = await request.get(`${LLM}/openapi.json`);
	expect(res.status()).toBe(200);
	const doc = await res.json();
	expect(doc.info.title).toBe("Lumid LLM");

	const v1 = Object.keys(doc.paths).filter((p) => p.startsWith("/v1"));
	// Was ZERO: openapi.rs generates from declarative read specs and excludes
	// compiled /v1 routes, so the gateway documented everything except itself.
	expect(v1.length).toBeGreaterThanOrEqual(6);
	for (const p of ["/v1/models", "/v1/chat/completions", "/v1/messages"]) {
		expect(v1).toContain(p);
	}
});

test("@llm rejects an unauthenticated request", async ({ request }) => {
	const res = await request.get(`${LLM}/v1/models`);
	expect(res.status()).toBe(401);
});

// ── roster + routing: needs a token ───────────────────────────────────────────

test.describe("@llm roster", () => {
	test.skip(!TOKEN, "set E2E_LLM_TOKEN or LQT_MAILBOX_PAT to exercise routing");

	test("@llm advertises only what it will actually serve", async ({ request }) => {
		const res = await request.get(`${LLM}/v1/models`, { headers: auth });
		expect(res.status()).toBe(200);
		const ids: string[] = (await res.json()).data.map((m: any) => m.id);

		expect(ids).toContain(LOCAL);
		expect(ids.filter((i) => i.startsWith("qwen")).length).toBeGreaterThan(0);

		// THE regression guard. Merging the upstream catalog verbatim put 423 ids
		// here, 422 of which 503'd. A number in the hundreds means list_models
		// stopped filtering.
		expect(ids.length).toBeLessThan(200);

		// Real models that exist upstream but nobody configured here. If these
		// appear, the catalog is advertising ids resolve() will refuse.
		for (const unconfigured of ["z-ai/glm-5.2", "openai/gpt-4o"]) {
			expect(ids).not.toContain(unconfigured);
		}
	});

	// One turn per model: these are real, billable calls, so keep the budget small
	// and the list short.
	test("@llm serves a configured OpenRouter model", async ({ request }) => {
		test.setTimeout(120_000);
		const res = await request.post(`${LLM}/v1/chat/completions`, {
			headers: auth,
			data: { model: QWEN, max_tokens: 16, messages: [{ role: "user", content: "Reply with exactly: OK" }] },
			timeout: 110_000,
		});
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.model).toContain("qwen");
		expect(body.choices?.length).toBeGreaterThan(0);
	});

	// ── on-prem first, offload second ────────────────────────────────────────
	//
	// deepseek-v4-flash is served on our own GB10 AND mapped to a metered
	// OpenRouter copy. resolve() prefers the local pool and spills to OpenRouter
	// when the backend is at its roof — since a6d2e9f the spill triggers on the
	// backend's REAL engine queue, not merely our own in-flight count, so a GB10
	// already busy with other users spills almost immediately.
	//
	// That makes "this request was served locally" NOT a stable assertion. It was
	// asserted here first, and flaked within minutes: a run came back
	// "deepseek/deepseek-v4-flash-0731", which is the offload working exactly as
	// designed. What IS invariant is that the lane and the id AGREE.
	const LOCAL_MARKERS = ["prompt_logprobs", "kv_transfer_params", "prompt_token_ids"];
	const OR_ID = "deepseek/deepseek-v4-flash-0731"; // LUMID_LLM_OPENROUTER_MODEL_MAP

	function lane(body: any): "local" | "offload" {
		const servedLocally = LOCAL_MARKERS.some((k) => k in body);
		// The pairing is the whole point:
		//   local id + vLLM markers            -> on-prem
		//   rewritten OpenRouter id, no markers -> offload
		// The BARE local id with no markers would mean our short id was forwarded
		// verbatim to OpenRouter, which rejects it — the bug LUMID_LLM_OPENROUTER_
		// MODEL_MAP exists to prevent. Fail loudly rather than classify it.
		if (servedLocally) {
			expect(body.model, "vLLM served the response, so the id must be the local one").toBe(LOCAL);
			return "local";
		}
		expect(body.model, `offloaded response must carry the REWRITTEN OpenRouter id, not our short one`).toBe(OR_ID);
		return "offload";
	}

	test("@llm a single turn is coherently served by exactly one lane", async ({ request }) => {
		test.setTimeout(150_000);
		const res = await request.post(`${LLM}/v1/chat/completions`, {
			headers: auth,
			// deepseek-v4-flash is a REASONING model: with a small budget it spends
			// the whole allowance in `reasoning` and returns content:null with
			// finish_reason "length". Correct behaviour, not an outage — a tight
			// max_tokens here reads as "deepseek returns empty responses".
			data: { model: LOCAL, max_tokens: 300, messages: [{ role: "user", content: "Reply with exactly: OK" }] },
			timeout: 140_000,
		});
		expect(res.status()).toBe(200);
		// Asserted as coherence, not as "local": a busy GB10 may legitimately spill
		// even a lone request, and failing the suite for that would be wrong.
		const where = lane(await res.json());
		console.log(`      single turn served: ${where}`);
	});

	test("@llm offloads to OpenRouter under concurrency, with the id rewritten", async ({ request }) => {
		test.setTimeout(240_000);
		// Enough parallelism to push past the roof. Measured 2026-08-24 against
		// prod: 1 concurrent -> 0 offloads, 4 -> 3, 10 -> 8. Kept small and cheap
		// (max_tokens 12) because every offloaded turn is a real billed call.
		const N = 8;
		const results = await Promise.all(
			Array.from({ length: N }, () =>
				request
					.post(`${LLM}/v1/chat/completions`, {
						headers: auth,
						data: { model: LOCAL, max_tokens: 12, messages: [{ role: "user", content: "say ok" }] },
						timeout: 200_000,
					})
					.then(async (r) => (r.status() === 200 ? lane(await r.json()) : `http_${r.status()}`)),
			),
		);
		const local = results.filter((r) => r === "local").length;
		const offload = results.filter((r) => r === "offload").length;
		console.log(`      ${N} concurrent -> on-prem ${local}, offloaded ${offload}`);

		// The valve must not swallow the request: every turn is answered by one
		// lane or the other. A failure here means saturation produced an ERROR
		// instead of an offload, which is the outage this design exists to avoid.
		expect(local + offload, `all ${N} turns must be served by some lane: ${JSON.stringify(results)}`).toBe(N);
		// Both lanes reachable in principle; under load the offload must engage.
		expect(offload, "concurrency should push at least one turn to the offload lane").toBeGreaterThan(0);
	});

	// The billing property, stated four ways. An id nobody configured must come
	// back as OUR error, never as a forwarded (and invoiced) upstream call.
	for (const [label, model] of [
		["a typo of a configured id", "qwen/qwen3-codr"],
		["a real upstream model we do not carry", "openai/gpt-4o"],
		["a model removed from the roster", "z-ai/glm-5.2"],
	] as const) {
		test(`@llm refuses ${label}`, async ({ request }) => {
			const res = await request.post(`${LLM}/v1/chat/completions`, {
				headers: auth,
				data: { model, max_tokens: 8, messages: [{ role: "user", content: "hi" }] },
			});
			expect(res.status()).toBe(503);
			const detail = (await res.json()).detail ?? "";
			expect(detail).toContain("unknown model");
			expect(detail).toContain(model);
		});
	}

	// Claude is served by the pooled Anthropic accounts via claude-proxy. A
	// claude-* id reaching this gateway must be refused, never routed to the
	// metered OpenRouter copy — that is what was silently billing sonnet.
	test("@llm refuses claude-* outright", async ({ request }) => {
		const res = await request.post(`${LLM}/v1/chat/completions`, {
			headers: auth,
			data: { model: "claude-sonnet-5", max_tokens: 8, messages: [{ role: "user", content: "hi" }] },
		});
		expect(res.status()).toBe(503);
		expect((await res.json()).detail ?? "").toContain("claude-proxy");
	});
});

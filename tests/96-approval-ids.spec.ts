// Which approval_id does the click actually spend?
//
// Runs 20-21 established the failure: exactly one Allow/Always click lands, it
// comes back 404 "already handled or had expired", and the server times the
// LIVE approval out. So the click spends an id the server has already
// discarded. What that evidence does NOT say is which id the chip was
// carrying, and guessing at it is how two UI changes today each traded one
// failure mode for another.
//
// This tees the SSE stream and the approve POST in the page, so the comparison
// is direct: every approval_id the server EMITTED, against every approval_id
// the UI SENT, with the response status. A mismatch names the bug; a match
// means the id was right and the server discarded it for another reason.
//
// Opt-in: E2E_APPROVAL_IDS=1
import { test } from "@playwright/test";
import { createUser } from "../fixtures/test-user";
import { gotoRedirect } from "../fixtures/nav";

const APP = "quant-research";
const APP_SLUG = process.env.E2E_VIBE_APP_SLUG || "a3f48236-ffe9-4fb9-9548-6e044d5cd9c7/quant-research";

test("probe: emitted approval_ids vs the ones the click sends", async ({ page, baseURL }) => {
	test.skip(!process.env.E2E_APPROVAL_IDS, "diagnostic — set E2E_APPROVAL_IDS=1");
	test.setTimeout(420_000);

	// Tee both sides before any app code runs. response.clone() leaves the
	// original stream untouched for the app's own reader.
	await page.addInitScript(() => {
		const w = window as any;
		w.__probe = { emitted: [], posted: [] };
		const orig = window.fetch;
		window.fetch = async function (...args: any[]) {
			const url = String(typeof args[0] === "string" ? args[0] : args[0]?.url ?? "");
			const init = args[1] || {};
			if (url.includes("/tool-approve")) {
				let body: any = null;
				try { body = JSON.parse(String(init.body ?? "{}")); } catch { /* not json */ }
				const res = await orig.apply(this, args as any);
				w.__probe.posted.push({ approval_id: body?.approval_id ?? "(none)", status: res.status });
				return res;
			}
			const res = await orig.apply(this, args as any);
			if (url.includes("/me/agent/chat") && res.body) {
				const clone = res.clone();
				(async () => {
					try {
						const reader = clone.body!.getReader();
						const dec = new TextDecoder();
						let buf = "";
						for (;;) {
							const { done, value } = await reader.read();
							if (done) break;
							buf += dec.decode(value, { stream: true });
							const parts = buf.split("\n");
							buf = parts.pop() ?? "";
							for (const line of parts) {
								if (!line.startsWith("data:")) continue;
								try {
									const evt = JSON.parse(line.slice(5).trim());
									if (evt?.type === "tool_approval_required") {
										w.__probe.emitted.push({ approval_id: evt.approval_id, tool_id: evt.id, name: evt.name, at: Date.now() });
									}
								} catch { /* partial frame */ }
							}
						}
					} catch { /* stream closed */ }
				})();
			}
			return res;
		};
	});

	const user = await createUser(baseURL!, {
		tag: `apid-${Date.now().toString(36)}`,
		invitationCode: process.env.E2E_INVITATION_CODE || "",
	});
	await page.goto("/auth/login");
	await page.locator("#email").fill(user.email);
	await page.locator("#password").fill(user.password);
	await page.locator("#password").press("Enter");
	await page.waitForURL(/\/auth\/redeem-invite|\/studio|\/dashboard|\/account(\/|$)/, { timeout: 60_000 });

	const installed = async () => {
		const r = await page.request.get("/api/v1/me/apps");
		const b = r.ok() ? await r.json().catch(() => null) : null;
		const apps = b?.data?.apps ?? b?.apps ?? [];
		return (Array.isArray(apps) ? apps : []).find((a: any) => a.name === APP);
	};
	if ((await installed())?.status !== "ready") {
		await page.request.post("/api/v1/me/apps", {
			data: { slug: APP_SLUG, runtime: "local" },
			headers: { "Content-Type": "application/json" },
			failOnStatusCode: false,
		});
		for (let i = 0; i < 40 && (await installed())?.status !== "ready"; i++) await page.waitForTimeout(3_000);
	}

	await gotoRedirect(page, `/studio/apps/${APP}`);
	const composer = page.getByPlaceholder(/Ask anything|Type next message/i).first();
	await composer.waitFor({ state: "visible", timeout: 90_000 });
	// TWO submits in one turn — the multi-approval shape the single-approval
	// probe never exercised, and the shape the walk actually produces when the
	// assistant fixes a rejection and resubmits.
	const a = `apid_a_${Date.now().toString(36)}`;
	const b = `apid_b_${Date.now().toString(36)}`;
	await composer.fill(
		`Submit TWO .lqts strategies for me, one after the other. Both buy 25 lots at mid when ofi_z ` +
			`is above 0.15, with threshold and size as params. Name the first ${a} and the second ${b}. ` +
			`Submit them both, and if the compiler rejects one, fix it and submit again.`,
	);
	await composer.press("Enter");

	// Same 1 Hz auto-approver the walk uses, clicking .first() — the behaviour
	// under investigation, reproduced rather than idealised.
	const deadline = Date.now() + 240_000;
	let clicks = 0;
	while (Date.now() < deadline) {
		const btn = page.getByRole("button", { name: /^(Always|Allow)$/i }).first();
		if (await btn.isVisible().catch(() => false)) {
			const chips = await page.getByRole("button", { name: /^Always$/i }).count().catch(() => -1);
			await btn.click().catch(() => {});
			clicks += 1;
			console.log(`[apid] click #${clicks} (chips visible at click: ${chips})`);
		}
		await page.waitForTimeout(1_000);
		const st = await page.evaluate(() => (window as any).__probe ?? { emitted: [], posted: [] });
		if (st.emitted.length >= 2 && st.posted.length >= 2) break;
	}

	const st = await page.evaluate(() => (window as any).__probe ?? { emitted: [], posted: [] });
	console.log(`[apid] EMITTED by server (${st.emitted.length}):`);
	for (const e of st.emitted) console.log(`[apid]   approval_id=${String(e.approval_id).slice(0, 12)}… tool_id=${String(e.tool_id).slice(0, 12)}… name=${e.name}`);
	console.log(`[apid] POSTED by the UI (${st.posted.length}):`);
	for (const p of st.posted) console.log(`[apid]   approval_id=${String(p.approval_id).slice(0, 12)}… → HTTP ${p.status}`);
	const emitted = new Set(st.emitted.map((e: any) => String(e.approval_id)));
	const unmatched = st.posted.filter((p: any) => !emitted.has(String(p.approval_id)));
	const unspent = st.emitted.filter((e: any) => !st.posted.some((p: any) => String(p.approval_id) === String(e.approval_id)));
	console.log(`[apid] VERDICT: posted-but-never-emitted=${unmatched.length}  emitted-but-never-posted=${unspent.length}`);
	for (const u of unspent) console.log(`[apid]   NEVER CLICKED: approval_id=${String(u.approval_id).slice(0, 12)}… name=${u.name}`);
});

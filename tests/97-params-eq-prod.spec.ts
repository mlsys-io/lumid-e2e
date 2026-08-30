// Production proof for lqt#920: `=` inside a `params { }` block compiles.
//
// A green unit test proves the parser; it does not prove the parser that is
// RUNNING. The consumer is a separate image on a separate deploy path, and
// "the tag moved" has been wrong here before. This submits the exact shape a
// student wrote on the 2026-08-30 walk and waits for a program_hash.
//
// Opt-in — it creates a real account and burns an invitation-code use:
//   E2E_DSL_PROD_CHECK=1 npx playwright test 97-params-eq-prod --project=chromium
import { expect, test } from "@playwright/test";
import { createUser } from "../fixtures/test-user";
import { gotoRedirect } from "../fixtures/nav";

const APP = "quant-research";
// Fully-qualified, like the walk. A bare name leaves no owner to recover,
// falls back to the caller's own sub, and every surface then 404s.
const APP_SLUG = process.env.E2E_VIBE_APP_SLUG || "a3f48236-ffe9-4fb9-9548-6e044d5cd9c7/quant-research";

test("prod: `=` inside params { } compiles (lqt#920)", async ({ page, baseURL }) => {
	test.skip(!process.env.E2E_DSL_PROD_CHECK, "prod DSL check — set E2E_DSL_PROD_CHECK=1");
	test.setTimeout(300_000);
	const name = `eqchk_${Date.now().toString(36)}`;
	const user = await createUser(baseURL!, {
		tag: `eqchk-${Date.now().toString(36)}`,
		invitationCode: process.env.E2E_INVITATION_CODE || "",
	});

	await page.goto("/auth/login");
	await page.locator("#email").fill(user.email);
	await page.locator("#password").fill(user.password);
	await page.locator("#password").press("Enter");
	await page.waitForURL(/\/auth\/redeem-invite|\/studio|\/dashboard|\/account(\/|$)/, { timeout: 60_000 });

	// INSTALL FIRST. Skipping this is what made the first attempt at this check
	// fail: the form still rendered, still reported "Queued send_strategy", and
	// nothing ever reached mailbox.lqt_inbox — a submit with no installed app is
	// silently dropped, so the check measured its own missing setup step.
	const installed = async () => {
		const r = await page.request.get("/api/v1/me/apps");
		const b = r.ok() ? await r.json().catch(() => null) : null;
		const apps = b?.data?.apps ?? b?.apps ?? [];
		return (Array.isArray(apps) ? apps : []).find((a: any) => a.name === APP);
	};
	if ((await installed())?.status !== "ready") {
		const r = await page.request.post("/api/v1/me/apps", {
			data: { slug: APP_SLUG, runtime: "local" },
			headers: { "Content-Type": "application/json" },
			failOnStatusCode: false,
		});
		expect(r.ok() || r.status() === 409, `install failed: ${r.status()}`).toBeTruthy();
		await expect.poll(async () => (await installed())?.status ?? "", { timeout: 120_000, intervals: [3_000] }).toBe("ready");
	}

	// `=` where the canonical form uses `:`. Before #920 this was a parse error.
	const src = [
		`strategy ${name} {`,
		"  params { threshold = 0.15, size_lots = 25 }",
		'  when signal("ofi_z") > params.threshold {',
		"    buy params.size_lots lots @ mid",
		"  }",
		"}",
	].join("\n");

	await gotoRedirect(page, `/studio/a/${APP}/strategies`);
	await page.getByLabel(/Strategy Name/i).fill(name);
	await page.getByLabel(/^Version$/i).fill("1.0.0");
	await page.getByLabel(/Strategy Content/i).fill(src);
	await page.getByRole("button", { name: /Submit to Inbox/i }).click();
	await expect(page.getByText(/Queued send_strategy/i).first()).toBeVisible({ timeout: 60_000 });

	// A program_hash is the only proof it COMPILED. Read the rejection ledger
	// too, so a compile failure reports the compiler's words instead of timing
	// out into a shrug.
	let rejection = "";
	await expect
		.poll(
			async () => {
				const r = await page.request.get("/api/v1/me/strategies");
				if (!r.ok()) return "";
				const d = (await r.json().catch(() => null))?.data ?? {};
				const rej = (d.rejected ?? []).find((x: any) => String(x?.name ?? "") === name);
				if (rej) rejection = String(rej.reason ?? "");
				const row = (d.strategies ?? []).find((x: any) => x?.name === name);
				return row ? String(row.program_hash ?? "") : "";
			},
			{
				timeout: 120_000,
				intervals: [3_000],
				// A STRING, not a closure. Playwright prints a function here
				// verbatim, so the first run reported its own source text instead
				// of the compiler's reason. `rejection` is read out of the poll
				// below on failure instead.
				message: `'${name}' never registered with a program_hash — see the rejected list on /me/strategies`,
			},
		)
		.not.toEqual("")
		.catch((e) => {
			// Surface the COMPILER'S words, not just "it never appeared". A
			// rejection and a message that never arrived need different fixes.
			throw new Error(
				rejection
					? `\`=\` in a params block was REJECTED in production: ${rejection}`
					: `'${name}' never registered and left no rejection row — the submit did not reach the compiler. ${String(e).slice(0, 200)}`,
			);
		});
	console.log(`[eqchk] '${name}' compiled in production — \`=\` accepted`);
});

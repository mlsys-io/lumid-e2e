// Diagnostic probe, not a suite member. Answers ONE question: when
// lqt_mailbox_submit raises its approval gate, what does the DOM actually
// render? Identity logs `approval denied/timeout` on every walk, yet the
// walk's approver clicks nothing and the page shows "Running
// lqt_mailbox_submit — 293s" — a string StudioChat renders ONLY when
// approvalRequired is false (StudioChat.tsx:2126). One of those is lying.
//
// Deliberately short: the gate is raised within a turn or two, so 150s is
// enough, and a 17-minute walk to observe a 10-second question is what has
// been making this loop expensive to debug.
import { test } from "@playwright/test";
import { createUser } from "../fixtures/test-user";
import { gotoRedirect } from "../fixtures/nav";

const APP = "quant-research";

test("probe: what does the approval gate render", async ({ page, baseURL }) => {
	// OPT-IN. This creates a real account and burns an invitation-code use, so
	// it must not ride along on a full-suite run. Invoke deliberately:
	//   E2E_APPROVAL_PROBE=1 npx playwright test 98-approval-probe --project=chromium
	test.skip(!process.env.E2E_APPROVAL_PROBE, "diagnostic — set E2E_APPROVAL_PROBE=1 to run");
	test.setTimeout(360_000);
	const inviteCode = process.env.E2E_INVITATION_CODE || "";
	const user = await createUser(baseURL!, { tag: `probe-${Date.now().toString(36)}`, invitationCode: inviteCode });

	await page.goto("/auth/login");
	await page.locator("#email").fill(user.email);
	await page.locator("#password").fill(user.password);
	await page.locator("#password").press("Enter");
	await page.waitForURL(/\/auth\/redeem-invite|\/studio|\/dashboard|\/account(\/|$)/, { timeout: 60_000 });

	await gotoRedirect(page, `/studio/apps/${APP}`);
	const composer = page.getByPlaceholder(/Ask anything|Type next message/i).first();
	await composer.waitFor({ state: "visible", timeout: 90_000 });
	await composer.fill(
		`Submit a .lqts strategy for me: buy 25 lots at mid when the ofi_z signal is above 0.15. ` +
			`Name it probe_${Date.now().toString(36)}.`,
	);
	await composer.press("Enter");

	// Sample the DOM every 3s and print anything that would tell us whether an
	// approval chip exists: every button label on the page, plus whether the
	// gold approval styling (bg-gold-50/80 border-gold-300) is present.
	for (let i = 0; i < 50; i++) {
		const snap = await page.evaluate(() => {
			const btns = Array.from(document.querySelectorAll("button, [role=button]"))
				.map((b) => (b.textContent || "").trim())
				.filter((t) => t && t.length < 24);
			const gold = document.querySelectorAll("[class*='border-gold-300']").length;
			const warn = (document.body.innerText.match(/⚠/g) || []).length;
			const running = /Running\s+\S+/.exec(document.body.innerText)?.[0] ?? "";
			return { btns, gold, warn, running };
		});
		const interesting = snap.btns.filter((t) => /^(Allow|Always|Deny)$/i.test(t));
		console.log(
			`[probe ${String(i * 3).padStart(3)}s] running="${snap.running}" gold=${snap.gold} warn=${snap.warn} ` +
				`approvalBtns=${JSON.stringify(interesting)} allBtns=${JSON.stringify(snap.btns.slice(0, 14))}`,
		);
		if (interesting.length) {
			console.log("[probe] APPROVAL CHIP RENDERED — now testing the walk's exact locators");
			// The walk's three selectors, in its own order. Whichever reports
			// false while the DOM query above reports the button is the bug.
			const always = page.getByRole("button", { name: /^Always$/i }).first();
			const both = page.getByRole("button", { name: /^(Always|Allow)$/i }).first();
			const loose = page.locator("button, [role=button]").filter({ hasText: /^\s*(Always|Allow)\s*$/i }).first();
			for (const [label, loc] of [["getByRole ^Always$", always], ["getByRole ^(Always|Allow)$", both], ["loose filter", loose]] as const) {
				const vis = await loc.isVisible().catch((e) => `THREW: ${String(e).slice(0, 90)}`);
				const cnt = await (loc as any).count?.().catch(() => "n/a");
				console.log(`[probe]   ${label} → isVisible=${vis} count=${cnt}`);
			}
			// HOW MANY chips are on the page. If the live prompt is preceded by a
			// spent one, `.first()` clicks the corpse and the real prompt waits —
			// which is the hypothesis run20 could not distinguish from a hang.
			const chipCount = await page.getByRole("button", { name: /^Always$/i }).count().catch(() => -1);
			console.log(`[probe]   Always-chips on page = ${chipCount}`);
			const clicked = await always.click({ timeout: 5_000 }).then(() => "OK").catch((e) => `FAILED: ${String(e).slice(0, 120)}`);
			console.log(`[probe]   click(Always) → ${clicked}`);
			await page.waitForTimeout(5_000);
			// v0.5.297 emits an info notice on 404. Its presence after the FIRST
			// click is the answer: it means the id we clicked was already spent.
			const notice = await page.evaluate(() =>
				/(already handled or had expired|Could not send that approval)[^\n]{0,120}/.exec(document.body.innerText)?.[0] ?? "(none)");
			const after = await page.evaluate(() => /Running\s+\S+/.exec(document.body.innerText)?.[0] ?? "(none)");
			const stillChips = await page.getByRole("button", { name: /^Always$/i }).count().catch(() => -1);
			console.log(`[probe]   after click: activity="${after}" notice="${notice}" chipsLeft=${stillChips}`);
			break;
		}
		await page.waitForTimeout(3_000);
	}
});

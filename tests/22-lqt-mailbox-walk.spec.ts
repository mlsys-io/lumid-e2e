import { test, expect, request as pwrequest, type Page } from "@playwright/test";
import { createUser, type TestUser } from "../fixtures/test-user";
import { localOtpEnabled } from "../fixtures/otp-redis";

// Journey 22 — the LQT quant-researcher walk, end to end, as a real user.
//
// The automated form of the day-one onboarding instruction for
// onboard-20-quant-researchers: everything a researcher does, in order,
// through the browser only. App state (strategies, runs, chats) is never
// seeded over REST — only *read* over REST, to assert what the UI claims.
//
//   1. fresh signup
//   2. install lqt-mailbox from the marketplace        <- never done by any tenant
//   3. Strategies surface loads
//   4. deploy a strategy through "Deploy a strategy"
//   5. the row appears (a real mailbox ack round-trip, not optimistic render)
//   6. click the row -> the strategy detail surface
//   7. Backtest row action                             <- claim ledger never existed
//   8. Forward test row action (reports; never submits)
//   9. Discuss row action -> a thread bound to this strategy
//  10. reload -> Sessions lists it                     <- UI half never proven
//
// Steps 2, 7 and 10 are the untravelled ones. The rest is scaffolding to
// reach them.
//
// AUTH: needs one of
//   E2E_GMAIL_APP_PASSWORD  (real mailbox OTP — what nightly CI uses), or
//   CI_E2E_LOCAL_OTP=1      (read the OTP out of identity's Redis)
// Skips cleanly when neither is present rather than failing red.

const APP = "lqt-mailbox";
const WALK_ENABLED = process.env.LUMID_E2E_LQT_WALK !== "0";

// Unique per run: concurrent runs must not collide on a strategy name, and
// the Sessions assertion must not pick up somebody else's thread.
const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
// Underscores, not dashes: this name is interpolated into the .lqts source
// as the strategy IDENTIFIER, and `e2e-walk-x` parses as a subtraction.
// `stamp` can also start with a digit, so the name is prefixed.
const STRATEGY_NAME = `e2e_walk_${String(stamp).replace(/[^A-Za-z0-9]/g, "_")}`;

// Minimal .lqts source. Compiled server-side by the mailbox consumer, so
// nothing local is needed to produce it.
// Real .lqts grammar — verified against the compiler 2026-08-26 by deploying
// this exact shape and reading `core.tenant_strategies` for a program_hash.
//
// The previous source could NEVER compile and so this walk could never pass:
//   strategy "name" {  symbol: "BTCUSD"
//                      when price_change(5m) > 0.02 { propose buy size 1 } }
// Four errors in four lines — the name must be a bare IDENTIFIER (a quoted
// string gives `parse error: expected an identifier for the strategy name`),
// and `symbol:`, `price_change()` and `propose buy size` are not in the
// grammar at all. It failed invisibly because a rejected deploy leaves the
// /xpio/strategies record at `sent` (the reject ack carries no `strategy`
// echo, so the ingress never flips it) — the reason lives only in
// mailbox.lqt_outbox. Model new strategies on app/strategies/*.lqts in the
// LQT repo, never on this literal.
//
// STRATEGY_NAME must therefore be identifier-safe: no dashes, no leading digit.
const STRATEGY_SRC = [
	`strategy ${STRATEGY_NAME} {`,
	`  params { band: 50, size_lots: 30, cap: 300 }`,
	`  signal sma20 = sma(market.mid, 20)`,
	`  when market.mid < sma20 - params.band && position.net_lots < params.cap {`,
	`    buy params.size_lots lots @ market.ask`,
	`  }`,
	`}`,
].join("\n");

async function loginViaUi(page: Page, user: TestUser): Promise<void> {
	await page.goto("/auth/login");
	await page.getByLabel(/email/i).fill(user.email);
	await page.getByLabel(/password/i, { exact: false }).first().fill(user.password);
	await page.getByRole("button", { name: /sign in/i }).click();
	await page.waitForURL(/\/dashboard|\/studio|\/account(\/|$)/, { timeout: 20_000 });
}

async function getJson(page: Page, path: string): Promise<any | null> {
	const r = await page.request.get(path);
	if (!r.ok()) return null;
	return r.json().catch(() => null);
}

// The install ledger — /api/v1/me/apps. Reading it is fair game; it is the
// app *content* this spec refuses to seed.
async function installedApps(page: Page): Promise<string[]> {
	const b = await getJson(page, "/api/v1/me/apps");
	const list = b?.data?.apps ?? b?.apps ?? [];
	if (!Array.isArray(list)) return [];
	return list.map((a: any) => String(a?.name ?? a?.app ?? a?.slug ?? "")).filter(Boolean);
}

// Needs no account, so it runs even without an OTP source — the one part of
// this journey that is always exercised.

// Mint a short-lived, multi-use invitation code so the walk needs no
// hand-set env var. Order: an explicit code wins; then an admin PAT;
// then admin email+password. Returns "" when none is available.
async function resolveInviteCode(baseURL: string): Promise<string> {
	if (process.env.E2E_INVITATION_CODE) return process.env.E2E_INVITATION_CODE;
	const pat = process.env.LUMID_PAT || process.env.RUNMESH_PAT || "";
	const api = await pwrequest.newContext({ baseURL });
	try {
		let bearer = pat;
		if (!bearer && process.env.E2E_ADMIN_EMAIL && process.env.E2E_ADMIN_PASSWORD) {
			const login = await api.post("/api/v1/login", {
				data: { email: process.env.E2E_ADMIN_EMAIL, password: process.env.E2E_ADMIN_PASSWORD },
				headers: { "Content-Type": "application/json" },
			});
			if (!login.ok()) throw new Error(`admin login: ${login.status()} ${await login.text()}`);
			bearer = (await login.json())?.data?.token || "";
		}
		if (!bearer) return "";
		const resp = await api.post("/api/v1/admin/invitation-codes", {
			headers: { "Authorization": `Bearer ${bearer}`, "Content-Type": "application/json" },
			// max_uses covers signup retries; ttl_days 1 keeps the blast radius small.
			data: { note: `e2e-lqt-walk-${stamp}`, count: 1, max_uses: 10, ttl_days: 1 },
		});
		if (!resp.ok()) throw new Error(`mint invite: ${resp.status()} ${await resp.text()}`);
		const code = (await resp.json())?.data?.codes?.[0]?.code || "";
		if (!code) throw new Error("mint invite: no code in response");
		return code;
	} finally {
		await api.dispose();
	}
}

/** Open the strategy detail page the way a USER reaches it: from the list.
 *
 * A cold `page.goto('/studio/a/lqt-mailbox/strategy?strategy_id=…')` does NOT
 * work — the page renders its four sections and then reports
 *   "Waiting for a strategy_id — open this page from its parent list"
 * because it takes the id from in-app router state, not from the query string
 * on a fresh load. Arriving via a row click (what step 4-5 does) works, and the
 * resulting URL does carry ?strategy_id=, which is what makes the deep-link
 * look like it should work.
 *
 * Navigating this way is still the faithful journey — it is what a researcher
 * does — so it stays even though lumid-ui v0.5.242 made the direct URL work
 * too (the real defect was AppSurface interpolating only PATH params, which
 * broke the page by every route, not just by deep link).
 */
async function openStrategyDetail(page: Page, strategyId: string): Promise<void> {
	await page.goto(`/studio/a/${APP}/strategies`);
	const row = page.getByRole("row").filter({ hasText: STRATEGY_NAME }).first();
	await expect(row, "strategy row missing from the list").toBeVisible({ timeout: 60_000 });
	await row.getByRole("cell").first().click();
	await expect(page).toHaveURL(
		new RegExp(`/studio/a/${APP}/strategy\\?strategy_id=${strategyId}`),
		{ timeout: 20_000 },
	);
}

test.describe("22 — LQT mailbox: anonymous access", () => {
	test("strategy surfaces require a session", async ({ page }) => {
		await page.context().clearCookies();
		await page.goto(`/studio/a/${APP}/strategies`);
		await expect(page).toHaveURL(/\/auth\/login/, { timeout: 20_000 });
	});
});

test.describe("22 — LQT mailbox: the quant-researcher walk", () => {
	test.describe.configure({ mode: "serial" });

	let user: TestUser;
	let strategyId = "";

	test.beforeAll(async ({}, testInfo) => {
		if (!WALK_ENABLED) testInfo.skip(true, "LUMID_E2E_LQT_WALK=0");

		// An EXISTING account, when one is supplied, beats minting a fresh one.
		//
		// Not a convenience: a strategy deploy is gated by the mailbox
		// consumer's tenant allowlist (`LQT_MAILBOX_TENANT_ID`, Secret
		// `lqt-mailbox-consumer`). A user minted seconds ago is by definition
		// NOT on it, so step 4-5 dies at `auth_denied: tenant … not served by
		// this consumer instance` — and, because a denied deploy leaves the
		// /xpio/strategies record at `sent`, it dies silently and looks like a
		// broken marketplace. Point this at an allowlisted role-`user` account
		// and the walk exercises the path a real cohort member takes.
		const existingEmail = process.env.E2E_USER_EMAIL;
		const existingPassword = process.env.E2E_USER_PASSWORD;
		if (existingEmail && existingPassword) {
			user = {
				email: existingEmail,
				password: existingPassword,
				username: existingEmail.split("@")[0],
			} as TestUser;
			return;
		}

		if (!localOtpEnabled() && !process.env.E2E_GMAIL_APP_PASSWORD) {
			testInfo.skip(
				true,
				"No OTP source: set E2E_GMAIL_APP_PASSWORD in .env.local, " +
					"or CI_E2E_LOCAL_OTP=1 to read the code from identity's Redis.",
			);
		}
		const baseURL = testInfo.project.use.baseURL ?? process.env.BASE_URL ?? "https://lum.id";
		// lum.id is invite-only. Without a code the account registers fine and
		// then parks on the "Enter your invitation code" wall, so every later
		// step fails at its own locator and blames the marketplace — which is
		// exactly the mis-diagnosis this walk exists to avoid. Mint one rather
		// than skipping: an operator PAT (LUMID_PAT / RUNMESH_PAT, or
		// ~/.lumid/credentials.toml exported by the caller) is authorised for
		// POST /api/v1/admin/invitation-codes, and a self-sufficient walk is
		// worth more than one that needs a hand-set env var. Only if there is
		// no credential at all do we skip, and then we say which one is missing.
		const inviteCode = await resolveInviteCode(baseURL);
		if (!inviteCode) {
			testInfo.skip(
				true,
				"No invitation code and no way to mint one: set E2E_INVITATION_CODE, " +
					"or LUMID_PAT/RUNMESH_PAT (an admin PAT), or E2E_ADMIN_EMAIL+E2E_ADMIN_PASSWORD. " +
					"lum.id is invite-only, so without one the account stops at the invitation wall. " +
					"Prefer E2E_USER_EMAIL+E2E_USER_PASSWORD: a fresh user is not on the mailbox " +
					"consumer's tenant allowlist and its deploy will be denied.",
			);
		}
		user = await createUser(baseURL, {
			tag: `lqtwalk-${stamp}`,
			invitationCode: inviteCode,
		});
	});

	test("step 2 — install lqt-mailbox from the marketplace", async ({ page }) => {
		await loginViaUi(page, user);

		// Already installed ⇒ nothing to do. With E2E_USER_EMAIL the account is
		// a real, reused one that very likely already has the app, and the
		// marketplace card then renders no "Add to my account" CTA at all — the
		// click below times out and the whole walk stops at step 2, never
		// reaching the strategy lifecycle it exists to test. Installing is a
		// PRECONDITION here, not the assertion; steps 4-10 are.
		const installed = await getJson(page, "/api/v1/me/apps");
		const apps = installed?.data?.apps ?? installed?.apps ?? [];
		const already =
			Array.isArray(apps) &&
			apps.some((a: any) => (a?.name ?? a?.app) === APP);
		if (already) {
			test.info().annotations.push({
				type: "precondition",
				description: `${APP} was already installed for ${user.email} — marketplace install skipped`,
			});
			return;
		}

		await page.goto("/studio/library/marketplace");

		const search = page.getByPlaceholder(/search/i).first();
		if (await search.count()) await search.fill(APP);

		// TWO public cards share the name AND the display name "LQT Mailbox":
		//   db86775d-…/lqt-mailbox  — the real one (this bundle)
		//   a3f48236-…/lqt-mailbox  — a June snapshot, 3 forks, ships only
		//                             ui/page.yaml, so it has NO Strategies
		//                             surface and the rest of this walk 404s.
		// The card DOM never renders owner_sub (MarketplaceBrowse.tsx:539
		// computes the slug but only uses it for add-skill/subscribe), so the
		// only in-browser discriminator is the summary text.
		//
		// Discriminate by EXCLUDING the stale card, not by matching the real
		// one's summary. app_push auto-syncs `summary` from the bundle, so the
		// real card's text changes at every publish (it reads "LQT research
		// workspace …" today and becomes "Strategy-lifecycle surface for LQT …"
		// after the next push) — an include-filter would fail on one side of
		// that push or the other. The June snapshot's summary, by contrast, is
		// frozen: it still describes the retired kv.run:5012 mailbox.
		const cards = page.locator("article").filter({ hasText: new RegExp(APP) });
		await expect(cards.first(), "lqt-mailbox is not listed in the marketplace").toBeVisible({
			timeout: 30_000,
		});
		const card = cards
			.filter({ hasNotText: /Bidirectional bridge to the LQT mailbox|kv\.run:5012/i })
			.first();
		await expect(
			card,
			`every listed lqt-mailbox card looks like the retired kv.run:5012 snapshot — ` +
				`${await cards.count()} same-named card(s) listed, none of them this bundle`,
		).toBeVisible({ timeout: 15_000 });

		// The CTA reads "Add to my account", NOT "Install" — for kind=agent the
		// card sells the install as "installs into My Agents and runs for you"
		// (MarketplaceBrowse.tsx renders the label from the repo kind). Matching
		// /^install$/ found nothing and fell through to the drawer path, which
		// then timed out on a button that does not exist under that name either.
		const INSTALL_CTA = /add to my account|install/i;
		// Scope the CTA to THAT card — a page-level getByRole would happily
		// click the stale card's button.
		const installBtn = card.getByRole("button", { name: INSTALL_CTA }).first();
		if (await installBtn.count()) {
			await installBtn.click();
		} else {
			// Older card layouts put the CTA only in the detail drawer.
			await card.getByRole("button", { name: /details/i }).first().click();
			await page.getByRole("button", { name: INSTALL_CTA }).first().click();
		}

		// Install is asynchronous — the intent queue materialises the bundle
		// onto the scheduler's PVC. This poll IS step 2's assertion.
		await expect
			.poll(async () => (await installedApps(page)).includes(APP), {
				timeout: 180_000,
				intervals: [3_000],
				message: "lqt-mailbox never appeared in /me/apps — the install stalled",
			})
			.toBe(true);
	});

	test("step 4-5 — deploy a strategy and see it register", async ({ page }) => {
		// The registry row below is given 240s because it waits on a real
		// mailbox round-trip; the suite default is 60s, so without this the
		// test dies at 60s and reports "the strategy never registered" —
		// a budget failure wearing a product failure's error message.
		test.setTimeout(330_000);
		await loginViaUi(page, user);
		await page.goto(`/studio/a/${APP}/strategies`);
		await expect(page.getByRole("heading", { name: /Deploy a strategy/i }).first()).toBeVisible({
			timeout: 30_000,
		});

		await page.getByLabel(/Strategy Name/i).fill(STRATEGY_NAME);
		await page.getByLabel(/^Version$/i).fill("1.0.0");
		// Leave Strategy ID blank — the server mints one. That is the path a
		// researcher actually uses, and the one that stamps source_strategy_id
		// onto later backtests.
		await page.getByLabel(/Strategy Content/i).fill(STRATEGY_SRC);
		await page.getByRole("button", { name: /Submit to Inbox/i }).click();
		await expect(page.getByText(/Queued send_strategy/i).first()).toBeVisible({ timeout: 60_000 });

		// The registry row only appears after the mailbox consumer acks, so this
		// is a real round-trip. The consumer is single-threaded and compiles the
		// .lqts inline, hence the generous ceiling.
		const row = page.getByRole("row").filter({ hasText: STRATEGY_NAME }).first();
		await expect(row, "the strategy never registered — no mailbox ack").toBeVisible({ timeout: 240_000 });

		// Click a cell, not the row centre: the row's right-hand cell holds the
		// action buttons and a centre click could land on one.
		await row.getByRole("cell").first().click();
		await expect(page).toHaveURL(/\/studio\/a\/lqt-mailbox\/strategy\?strategy_id=/, { timeout: 20_000 });
		strategyId = new URL(page.url()).searchParams.get("strategy_id") ?? "";
		expect(strategyId, "row_href carried no strategy_id").not.toBe("");
	});

	test("step 6 — the detail surface renders all four sections, scoped", async ({ page }) => {
		test.skip(!strategyId, "no strategy registered");
		await loginViaUi(page, user);
		await openStrategyDetail(page, strategyId);
		// The `Waiting for a strategy_id` state this used to hit was NOT a
		// deep-link limitation, which is what it looked like at first: AppSurface
		// interpolated only PATH params, so `{strategy_id}` from the row_href
		// QUERY string was never substituted and the page was unusable by ANY
		// route, row click included. Fixed in lumid-ui v0.5.242.
		test.info().annotations.push({
			type: "regression-guard",
			description:
				"Guards lumid-ui v0.5.242: surface specs must interpolate query params, " +
				"not just path params — otherwise every widget here reads " +
				"'Waiting for a strategy_id'.",
		});
		for (const h of [/^Registration$/i, /^Sessions$/i, /Backtests for this strategy/i, /Stop this strategy/i]) {
			await expect(page.getByRole("heading", { name: h }).first()).toBeVisible({ timeout: 30_000 });
		}
		// me://strategies?strategy_id= narrows client-side; prove it narrowed to
		// THIS strategy rather than rendering the whole registry.
		await expect(page.getByText(strategyId).first()).toBeVisible({ timeout: 30_000 });
	});

	test("step 7 — Backtest opens a claim and produces a run row", async ({ page }) => {
		// Claim → scheduler → run row is the slowest hop in the walk (420s poll
		// below); same budget trap as step 4-5.
		test.setTimeout(510_000);
		test.skip(!strategyId, "no strategy registered");
		await loginViaUi(page, user);
		await openStrategyDetail(page, strategyId);

		page.once("dialog", (d) => d.accept()); // confirm: "Submit a backtest for …?"
		await page.getByRole("button", { name: /^Backtest$/ }).first().click();
		// run_loop toasts a.success on success and the error text on failure.
		await expect(page.getByText(/Backtest queued/i).first()).toBeVisible({ timeout: 90_000 });

		// The claim ledger (data/backtest_claims.jsonl) is per-install and has
		// never existed for any tenant. A run row is the proof it does now.
		await expect
			.poll(
				async () => {
					const b = await getJson(
						page,
						`/api/v1/me/apps/${APP}/data?tool=runs&source_strategy_id=${encodeURIComponent(strategyId)}`,
					);
					const runs = b?.data?.runs ?? b?.runs ?? [];
					return Array.isArray(runs) ? runs.length : 0;
				},
				{ timeout: 420_000, intervals: [10_000], message: "no backtest run row ever appeared" },
			)
			.toBeGreaterThan(0);
	});

	test("step 8 — Forward test reports without submitting", async ({ page }) => {
		test.skip(!strategyId, "no strategy registered");
		await loginViaUi(page, user);
		await openStrategyDetail(page, strategyId);
		await page.getByRole("button", { name: /^Forward test$/ }).first().click();
		await expect(page.getByText(/Reading forward-test state/i).first()).toBeVisible({ timeout: 90_000 });
		// Zero scorecards for a minutes-old strategy is the CORRECT outcome —
		// the verb reports, it starts nothing. Only an error toast is a failure.
		await expect(page.getByText(/failed|error/i).first()).toBeHidden({ timeout: 5_000 });
	});

	test("step 9-10 — Discuss starts a session and Sessions lists it", async ({ page }) => {
		test.skip(!strategyId, "no strategy registered");
		await loginViaUi(page, user);
		await openStrategyDetail(page, strategyId);
		await page.getByRole("button", { name: /^Discuss$/ }).first().click();

		// Discuss dispatches studio:ask with autosend — the chat rail opens and
		// sends. The thread is what matters here, not the answer. /me/chats
		// takes no query params; the surface filters client-side, so filter the
		// same way and assert on strategy_id specifically. That field is the one
		// identity v0.5.221 fixed — before it, this stayed 0 forever.
		await expect
			.poll(
				async () => {
					const b = await getJson(page, "/api/v1/me/chats");
					const chats = b?.data?.chats ?? b?.chats ?? [];
					if (!Array.isArray(chats)) return 0;
					return chats.filter(
						(c: any) => String(c?.app ?? "") === APP && String(c?.strategy_id ?? "") === strategyId,
					).length;
				},
				{
					timeout: 240_000,
					intervals: [5_000],
					message:
						"no chat bound to this strategy — the strategy_id round-trip regressed " +
						"(the bug fixed in identity v0.5.221)",
				},
			)
			.toBeGreaterThan(0);

		// The UI half: reload, and Sessions must render the thread rather than
		// its empty state.
		await openStrategyDetail(page, strategyId);
		await expect(
			page.getByText(/No chat threads for this strategy yet/i),
			"Sessions still shows its empty state",
		).toHaveCount(0, { timeout: 30_000 });
	});
});

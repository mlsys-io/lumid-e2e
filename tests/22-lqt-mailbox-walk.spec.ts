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
//   2. install quant-research from the marketplace     <- never done by any tenant
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

// Renamed from `lqt-mailbox` (the bundle this spec was written against).
// The published app is `a3f48236-…/quant-research` and its nav declares four
// surfaces — strategies · backtests · forward · runtime — plus the `strategy`
// detail surface reached by a row click. The legacy `page` overview left
// `ui.nav`, so /studio/a/<app>/page is gone; it is still rendered by
// AppOverview at /studio/apps/<app>, which is where the sidebar entry lands.
// This walk goes to the four named surfaces, not that page.
const APP = "quant-research";
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
	// The login SPA intermittently renders with NO inputs at all — measured
	// 2026-08-26: a direct /auth/login showed `inputs=0` after 60s once, then
	// 2 inputs on every retry seconds later. It is environmental (cold pods
	// after a rollout, or load), not a product break, and it is the single
	// most misleading failure in this file: whichever step happens to own the
	// login dies on `waiting for getByLabel(/email/i)` and gets blamed for a
	// surface it never reached. Seen attributed to step 2, step 4-5 and step 6
	// on consecutive runs of an unchanged app.
	//
	// One reload, then fail with a message that names the real cause.
	await page.goto("/auth/login");
	if (!(await page.getByLabel(/email/i).count().catch(() => 0))) {
		await page.reload();
	}
	await expect(
		page.getByLabel(/email/i).first(),
		"login form never rendered (SPA did not hydrate) — NOT a failure of the step reporting it",
	).toBeVisible({ timeout: 30_000 });
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
 * A cold `page.goto('/studio/a/quant-research/strategy?strategy_id=…')` does NOT
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
/** Reveal the rows the Strategies surface hides by default.
 *
 * quant-research's `ui/strategies.yaml` declares
 *   hide_when: [{key: name, prefix: e2e_}, {prefix: smoke_},
 *               {prefix: verify-}, {prefix: probe-}]
 * because 10 of 17 registry rows were test fixtures and they outnumbered the
 * real strategies on the page. STRATEGY_NAME here is `e2e_walk_…`, so this
 * walk's own row is hidden BY DESIGN — and the row assertions below would
 * time out reporting "strategy row missing from the list", i.e. a rename-era
 * surface feature wearing a registration failure's error message.
 *
 * lumid-ui renders the count as a toggle (`N hidden` / `hide N fixtures`,
 * directives.tsx ~757) precisely so hidden rows stay reachable. Click it.
 * Renaming the strategy to dodge the filter would be the wrong fix: the walk
 * IS a fixture and should be filed as one.
 */
async function revealFixtureRows(page: Page): Promise<void> {
	const toggle = page.getByRole("button", { name: /^\d+ hidden$/ }).first();
	// WAIT for it. The toggle only renders once the table's rows have arrived
	// (`hiddenRows.length ? <button…> : null`), and the caller gets here as soon
	// as the HEADING is visible — which happens first. Checking count()
	// immediately therefore saw 0, skipped the click, and left this walk's own
	// `e2e_walk_…` row filtered out; the row assertion then timed out 60s later
	// saying "strategy row missing from the list", which reads as a
	// registration failure rather than a race against a render.
	//
	// Swallowing the timeout is deliberate: a surface with nothing hidden never
	// renders the toggle, and that is not an error.
	await toggle.waitFor({ state: "visible", timeout: 30_000 }).catch(() => {});
	if (await toggle.count().catch(() => 0)) {
		await toggle.click().catch(() => {});
	}
}

async function openStrategyDetail(page: Page, strategyId: string): Promise<void> {
	await page.goto(`/studio/a/${APP}/strategies`);
	await expect(page.getByRole("heading", { name: /Your strategies/i }).first()).toBeVisible({
		timeout: 45_000,
	});
	await revealFixtureRows(page);
	const row = page.getByRole("row").filter({ hasText: STRATEGY_NAME }).first();
	await expect(row, "strategy row missing from the list").toBeVisible({ timeout: 60_000 });
	await row.getByRole("cell").first().click();
	await expect(page).toHaveURL(
		new RegExp(
			`/studio/(a/${APP}/strategy\\?|apps/${APP}\\?.*surface=strategy.*)strategy_id=${strategyId}`,
		),
		{ timeout: 20_000 },
	);
}

test.describe("22 — quant-research: anonymous access", () => {
	test("strategy surfaces require a session", async ({ page }) => {
		await page.context().clearCookies();
		await page.goto(`/studio/a/${APP}/strategies`);
		await expect(page).toHaveURL(/\/auth\/login/, { timeout: 20_000 });
	});
});

test.describe("22 — quant-research: the quant-researcher walk", () => {
	test.describe.configure({ mode: "serial" });

	let user: TestUser;
	let strategyId = "";
	// ONE page, ONE login for the whole walk.
	//
	// Every step used to call loginViaUi, so a 7-step run did 7 full logins in
	// a couple of minutes. Under that load the login form intermittently had
	// not rendered when `fill` ran, and the step died on
	// `waiting for getByLabel(/email/i)` — reported against whichever step drew
	// the short straw (seen on step 2 and step 6 in consecutive runs), which
	// reads as a product regression in a part of the app the step never
	// reached. Spec 23 hit the identical thing; same fix.
	let page: Page;

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

	test.beforeAll(async ({ browser }, testInfo) => {
		// newContext({baseURL}), NOT browser.newPage(): a bare newPage does not
		// inherit `use.baseURL` from the project, and every helper here navigates
		// with a RELATIVE path ("/auth/login", "/studio/a/..."). Without it the
		// login goto resolves nowhere and the hook dies on
		// `waiting for getByLabel(/email/i)` — reported against the FIRST test in
		// the block, which is why a beforeAll problem looked like step 2 failing.
		const baseURL = testInfo.project.use.baseURL ?? process.env.BASE_URL ?? "https://lum.id";
		const ctx = await browser.newContext({ baseURL });
		page = await ctx.newPage();
		await loginViaUi(page, user);
	});

	test.afterAll(async () => {
		await page?.context().close();
	});

	test("step 2 — install quant-research from the marketplace", async () => {

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

		// The duplicate-card problem this step used to guard against was a
		// `lqt-mailbox` artefact: TWO public cards shared that name (the real
		// bundle under db86775d-… and a frozen June snapshot under a3f48236-…
		// that shipped only ui/page.yaml, so picking it made the rest of the
		// walk 404). Under the new name there is exactly ONE public repo,
		// a3f48236-…/quant-research — confirmed against the marketplace API.
		//
		// The check is kept and INVERTED rather than deleted: assert the name
		// is unambiguous, and say so loudly if a second card ever appears,
		// because the card DOM still never renders owner_sub
		// (MarketplaceBrowse.tsx:539 computes the slug but uses it only for
		// add-skill/subscribe) and a duplicate would again be undetectable
		// from the browser.
		const cards = page
			.locator("article")
			.filter({ hasText: new RegExp(`${APP}|Quant Research`, "i") });
		await expect(cards.first(), "quant-research is not listed in the marketplace").toBeVisible({
			timeout: 30_000,
		});
		const cardCount = await cards.count();
		expect(
			cardCount,
			`${cardCount} marketplace cards match "${APP}". The card DOM carries no owner_sub, so a ` +
				`duplicate cannot be told apart in the browser and this step would install a coin-flip. ` +
				`Re-add an exclusion filter naming the stale bundle's summary before trusting this walk.`,
		).toBe(1);
		const card = cards.first();

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
				message: "quant-research never appeared in /me/apps — the install stalled",
			})
			.toBe(true);
	});

	test("step 4-5 — deploy a strategy and see it register", async () => {
		// The registry row below is given 240s because it waits on a real
		// mailbox round-trip; the suite default is 60s, so without this the
		// test dies at 60s and reports "the strategy never registered" —
		// a budget failure wearing a product failure's error message.
		test.setTimeout(330_000);
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
		//
		// `e2e_`-prefixed names are hidden by this surface's hide_when rules, so
		// the toggle has to be clicked before the row can ever be visible — and
		// it only appears once there IS a hidden row, hence the poll.
		await expect
			.poll(async () => {
				await revealFixtureRows(page);
				return page.getByRole("row").filter({ hasText: STRATEGY_NAME }).count();
			}, {
				timeout: 240_000,
				intervals: [5_000],
				message:
					"the strategy never registered. Two causes, in order of likelihood:\n" +
					"  (1) TENANT ALLOWLIST — the mailbox consumer only serves the tenants listed in " +
					"Secret `lqt-mailbox-consumer` key `tenant_id` (env LQT_MAILBOX_TENANT_ID). A user " +
					"minted seconds ago is not on it, so strategy.deploy is terminally denied with " +
					"`tenant … not served by this consumer instance`. The denial is INVISIBLE here: the " +
					"reject ack carries no `strategy` echo, so /xpio/strategies stays at `sent` and the " +
					"UI has already said `Queued send_strategy`. Set E2E_USER_EMAIL+E2E_USER_PASSWORD to " +
					"an allowlisted account, or append the fresh user's uuid to that secret.\n" +
					"  (2) the .lqts failed to compile — the reason is only in mailbox.lqt_outbox.",
			})
			.toBeGreaterThan(0);
		const row = page.getByRole("row").filter({ hasText: STRATEGY_NAME }).first();
		await expect(row, "the strategy registered but its row is not visible").toBeVisible({ timeout: 30_000 });

		// Click a cell, not the row centre: the row's right-hand cell holds the
		// action buttons and a centre click could land on one.
		await row.getByRole("cell").first().click();
		// TWO shapes are legitimate and the app may use either:
		//   /studio/a/:app/:surface?strategy_id=      (App.tsx:718, full page)
		//   /studio/apps/:app?surface=…&strategy_id=  (App.tsx:770, workspace)
		// This asserted only the first while the row click navigates to the
		// second, so the step failed 20s after a deploy that had SUCCEEDED —
		// the strategy_id was in the received URL all along. Accept either
		// rather than re-pinning to whichever is current; what the step is
		// really checking is that the click carried a strategy_id through.
		await expect(page).toHaveURL(
			new RegExp(
				`/studio/(a/${APP}/strategy\\?|apps/${APP}\\?.*surface=strategy.*)strategy_id=`,
			),
			{ timeout: 20_000 },
		);
		strategyId = new URL(page.url()).searchParams.get("strategy_id") ?? "";
		expect(strategyId, "row_href carried no strategy_id").not.toBe("");
	});

	test("step 6 — the detail surface renders all four sections, scoped", async () => {
		test.skip(!strategyId, "no strategy registered");
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

	test("step 6b — the detail surface's actions and reads target THIS app", async () => {
		test.skip(!strategyId, "no strategy registered");
		// A DOM-invisible regression, which is why it gets its own step.
		//
		// The app was renamed lqt-mailbox → quant-research. `ui/strategies.yaml`
		// was repointed; `ui/strategy.yaml` (the DETAIL surface) was NOT — the
		// published bundle still ships `app: lqt-mailbox` on all four row_actions
		// and on the disable form, and sources its Sessions and Backtests tables
		// from `me://chats?app=lqt-mailbox` / `me://app-data?app=lqt-mailbox`.
		// Confirmed against the served spec, not the local checkout:
		//   GET /api/v1/me/apps/quant-research/ui/strategy
		//
		// Consequences, all of which look like unrelated product faults:
		//   - Backtest / Poll / Forward test on the detail row POST to
		//     /api/v1/me/loops/lqt-mailbox/... — an app the student never
		//     installed, so the button fails or silently does nothing (step 7).
		//   - Sessions never lists the thread Discuss creates, because the chat
		//     is written with app=quant-research and the table asks for
		//     app=lqt-mailbox (step 9-10).
		//
		// Asserted on the SERVED spec so the failure names the cause instead of
		// surfacing as a button timeout two steps later.
		const spec = await getJson(page, `/api/v1/me/apps/${APP}/ui/strategy`);
		const markdown = String(spec?.data?.markdown ?? "");
		expect(markdown, `served surface spec for ${APP}/strategy came back empty`).not.toBe("");
		const stale = markdown.match(/lqt-mailbox/g)?.length ?? 0;
		expect(
			stale,
			`the published quant-research bundle's ui/strategy.yaml still names the OLD app ` +
				`\`lqt-mailbox\` in ${stale} place(s). Fix the bundle (row_actions[].run_loop.app, ` +
				`me://chats?app=, me://app-data?app=, the disable form's app) and republish — ` +
				`steps 7 and 9-10 below cannot pass until it is.`,
		).toBe(0);
	});

	test("step 7 — Backtest opens a claim and produces a run row", async () => {
		// Claim → scheduler → run row is the slowest hop in the walk (420s poll
		// below); same budget trap as step 4-5.
		test.setTimeout(510_000);
		test.skip(!strategyId, "no strategy registered");
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

	test("step 8 — Forward test reports without submitting", async () => {
		test.skip(!strategyId, "no strategy registered");
		await openStrategyDetail(page, strategyId);
		await page.getByRole("button", { name: /^Forward test$/ }).first().click();
		await expect(page.getByText(/Reading forward-test state/i).first()).toBeVisible({ timeout: 90_000 });
		// Zero scorecards for a minutes-old strategy is the CORRECT outcome —
		// the verb reports, it starts nothing. Only an error toast is a failure.
		await expect(page.getByText(/failed|error/i).first()).toBeHidden({ timeout: 5_000 });
	});

	test("step 9-10 — Discuss starts a session and Sessions lists it", async () => {
		test.skip(!strategyId, "no strategy registered");
		// The poll below allows 240s but the SUITE DEFAULT test timeout is 60s,
		// so without this the test dies at 60s and reports "the strategy_id
		// round-trip regressed" — a budget failure wearing a product failure's
		// error message, exactly as step 4-5's comment warns. Discuss autosends a
		// real model turn and the chat row is not persisted until it completes,
		// so 60s was never enough.
		test.setTimeout(330_000);
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
						"no chat bound to this strategy. WHAT THE EVIDENCE SHOWS (2026-09-04, " +
						"after three wrong diagnoses — record them so the next reader skips them): " +
						"(1) NOT the strategy_id round-trip (identity v0.5.221) — quant-research " +
						"chats carrying a strategy_id exist. (2) NOT a missing chat rail: the " +
						"failing page DOES mount one (aria-label 'Message the assistant'; an " +
						"earlier read grepped the placeholder 'Ask anything' and wrongly concluded " +
						"otherwise). (3) NOT the poll budget — verified at 300s, and no row " +
						"appeared afterwards either. What IS observed: identity logs " +
						"`POST /api/v1/me/agent/chat/stream | 200 | 4m0s` for the Discuss turn — " +
						"a clean four-minute boundary, returning 200 — and me_chats gains no row. " +
						"The row is written on COMPLETION, so a turn that hits that ceiling " +
						"persists nothing. Chase the 4m0s ceiling (no explicit 240s cap exists in " +
						"identity or the SPA — suspect the proxy or the model gateway), not this " +
						"assertion."
				},
			)
			.toBeGreaterThan(0);

		// The UI half: reload, and Sessions must render the thread rather than
		// its empty state.
		await openStrategyDetail(page, strategyId);
		await expect(
			page.getByText(/No chat threads for this strategy yet/i),
			"Sessions still shows its empty state. If step 6b also failed, this is the SAME defect: " +
				"the detail surface asks for me://chats?app=lqt-mailbox while Discuss wrote the thread " +
				"with app=quant-research, so no thread can ever match. Fix the bundle, not this assertion.",
		).toHaveCount(0, { timeout: 30_000 });
	});
});

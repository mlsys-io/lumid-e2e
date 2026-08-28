import { test, expect, request as pwrequest, type Page, type Browser } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createUser, type TestUser } from "../fixtures/test-user";
import { localOtpEnabled } from "../fixtures/otp-redis";
import { gotoRedirect } from "../fixtures/nav";

// Journey 26 — the quant-research STUDENT COHORT walk.
//
// 2-3 fresh, NON-OWNER accounts walk the day-one researcher path in parallel:
//
//   land code-less  → bounced to /auth/redeem-invite from /studio/...
//   redeem          → back to the surface they asked for
//   install         → quant-research from the marketplace ledger
//   four surfaces   → strategies · backtests · forward · runtime
//   deploy          → a strategy, then read its program_hash
//   backtest        → the three honesty axes (prices / signals / settlement)
//   forward         → the scorecard read
//   chat            → the grounded rail on /studio/apps/quant-research
//
// WHY THIS EXISTS, given specs 12 and 22 already walk fresh users.
//
// Every Studio surface has only ever been exercised by an OWNER-role account.
// `lumid_ui/src/components/auth-guard.tsx` (~line 120) force-redirects any
// authenticated user with an empty `invitation_code` and a role outside
// {admin, super_admin} to /auth/redeem-invite — from EVERY guarded route.
// Admin bypasses that branch entirely. So the redirect, and every surface's
// behaviour against an EMPTY collection, are both untested by construction:
// the accounts that have run these specs all had rows and all had a code.
//
// The four assertions an owner-role run can never fail, and which are
// therefore the point of this file:
//
//   A. a code-less student IS bounced to /auth/redeem-invite from /studio/...
//   B. after redeeming, every surface RENDERS rather than 403s
//   C. EMPTY-COLLECTION RENDERING — a fresh student has zero strategies, and
//      the surface must say so instead of drawing a headless/misleading table
//   D. a student sees THEIR OWN rows only — the cross-tenant registry stat is
//      non-zero at the same moment their own list is empty
//
// SCOPE MATRIX, and why a 403 here is a deliverable rather than a failure.
// `E2E_INVITATION_CODE` (and the code minted in beforeAll) is a NO-SCOPE code:
// it satisfies the guard and grants nothing. A student minted with it is
// exactly what a real cohort member is on day one, so whichever surface needs
// `lumid:write` or a warehouse role WILL refuse — and which ones those are is
// the onboarding fact we are here to record. Every non-2xx is captured with the
// surface that provoked it and written to /tmp/student-scope-matrix.md.
//
// AUTH: needs CI_E2E_LOCAL_OTP=1 (Redis OTP backdoor) or E2E_GMAIL_APP_PASSWORD.
//
// RUN:
//   CI_E2E_LONG=1 CI_E2E_LOCAL_OTP=1 CI_E2E_LONG_USERS=3 \
//     npx playwright test 26-quant-student-cohort --project=chromium

const APP = "quant-research";
// FULLY QUALIFIED on purpose — see fixtures/seed-app.ts: a bare name leaves the
// install intent with no owner to recover, it falls back to the caller's own
// sub, and the install then reports ready while every surface 404s.
const APP_SLUG = "a3f48236-ffe9-4fb9-9548-6e044d5cd9c7/quant-research";

const LONG_ENABLED = process.env.CI_E2E_LONG === "1";
// 2-3 students. More than 3 buys nothing here (they walk identical paths) and
// costs a marketplace install each.
const NUM_USERS = Math.min(3, Math.max(2, Number.parseInt(process.env.CI_E2E_LONG_USERS || "3", 10) || 3));

// Screenshots are an onboarding-doc deliverable, not debug output: full page,
// deviceScaleFactor 2, stable filenames the doc can inline.
const IMG_DIR = process.env.E2E_SHOT_DIR || "/proj/LQT/docs/researcher-onboarding/img";
const SCOPE_MATRIX = process.env.E2E_SCOPE_MATRIX || "/tmp/student-scope-matrix.md";
const SCOPE_FRAGMENTS = `${SCOPE_MATRIX}.d`;

// Only ONE student captures the PNGs. Three students writing the same seven
// filenames concurrently produces torn files, and the doc wants one coherent
// account anyway. The other students run every assertion, just silently.
const CAPTURING_SLOT = 0;

test.describe.configure({ mode: "parallel" });

// ── observation record ────────────────────────────────────────────────────

interface Refusal {
	surface: string;
	method: string;
	url: string;
	status: number;
}

interface Finding {
	surface: string;
	note: string;
}

// ── helpers ───────────────────────────────────────────────────────────────

/** Wait for `locator` to become visible; false on timeout instead of throwing.
 *
 * NOT `locator.isVisible({timeout})` — that is an IMMEDIATE check whose timeout
 * only bounds resolving the locator, so it answers "is it visible right now",
 * which for a toast that has not rendered yet is always `false`. Using it here
 * reported two gates that did not exist (`Queued send_strategy` and `Queued
 * forward read` both "never confirmed") on a run where both had in fact
 * appeared. Soft by design: these two probes ARE the scope question, so a
 * negative has to be recorded and reasoned about, not thrown.
 */
async function visibleWithin(locator: ReturnType<Page["getByText"]>, timeout: number): Promise<boolean> {
	try {
		await locator.waitFor({ state: "visible", timeout });
		return true;
	} catch {
		return false;
	}
}

function shortPath(u: string): string {
	try {
		const p = new URL(u);
		return p.pathname + (p.search ? p.search.slice(0, 60) : "");
	} catch {
		return u;
	}
}

/** Full-page PNG at deviceScaleFactor 2 into the doc's img/ directory.
 *
 * Best-effort by design: a screenshot that fails must never be the reason a
 * product assertion goes unreported. */
// Full page, but not unboundedly: the Runtime surface's Venue health table
// renders 500 rows (see the finding recorded in step 12), which made its
// full-page PNG 14 176 CSS px tall — 28 000 device px at scale 2, and useless
// as a figure in a document. Clipping to a readable page-and-a-bit keeps every
// artifact inlinable; the row count itself is reported as a finding rather than
// silently cropped away.
const SHOT_MAX_CSS_HEIGHT = 3_200;

async function shot(page: Page, slot: number, name: string): Promise<string | null> {
	if (slot !== CAPTURING_SLOT) return null;
	const file = path.join(IMG_DIR, name);
	try {
		fs.mkdirSync(IMG_DIR, { recursive: true });
		// The surfaces poll (15-60s) and animate their skeletons in; a short
		// settle keeps the artifact from being a page of loading bars.
		await page.waitForTimeout(1_200);
		const full = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => 0);
		const width = page.viewportSize()?.width ?? 1440;
		if (full > SHOT_MAX_CSS_HEIGHT) {
			await page.screenshot({
				path: file,
				fullPage: true,
				clip: { x: 0, y: 0, width, height: SHOT_MAX_CSS_HEIGHT },
			});
		} else {
			await page.screenshot({ path: file, fullPage: true });
		}
		return file;
	} catch {
		return null;
	}
}

/**
 * Capture the artifact BEFORE asserting.
 *
 * "A failed assertion should still write its screenshot so the artifact shows
 * what the assertion saw" — if the shot came after, every red step would leave
 * the doc with a stale or missing image, which is the opposite of useful.
 */
async function shotThenAssert(
	page: Page,
	slot: number,
	name: string,
	assertions: () => Promise<void>,
): Promise<void> {
	await shot(page, slot, name);
	await assertions();
}

/** Log in through the real form. Retries the render once — measured 2026-08-26,
 * a direct /auth/login intermittently paints with zero inputs on a cold pod,
 * and whichever step owns the login then dies on a locator for a surface it
 * never reached. */
async function loginViaUi(page: Page, user: TestUser): Promise<void> {
	await page.goto("/auth/login");
	if (!(await page.locator("#email").count().catch(() => 0))) {
		await page.reload();
	}
	await expect(
		page.locator("#email"),
		"login form never rendered (SPA did not hydrate) — NOT a failure of the step reporting it",
	).toBeVisible({ timeout: 30_000 });
	await page.locator("#email").fill(user.email);
	await page.locator("#password").fill(user.password);
	await page.getByRole("button", { name: /sign in/i }).click();
	// A code-less student lands on /auth/redeem-invite; one WITH a code lands
	// in Studio. Accept either — which one is asserted by the caller.
	await page.waitForURL(/\/auth\/redeem-invite|\/studio|\/dashboard|\/account(\/|$)/, { timeout: 30_000 });
}

async function getJson(page: Page, p: string): Promise<any | null> {
	const r = await page.request.get(p);
	if (!r.ok()) return null;
	return r.json().catch(() => null);
}

/** Installed-app ledger. Reading it is fair game; app CONTENT is never seeded. */
async function installedApps(page: Page): Promise<Array<{ name: string; status?: string }>> {
	const b = await getJson(page, "/api/v1/me/apps");
	const list = b?.data?.apps ?? b?.apps ?? [];
	return Array.isArray(list) ? list : [];
}

/** The student's own strategy registry — `core.tenant_strategies` scoped to the
 * caller's own user id (identity/internal/handler/me_strategies.go). There is
 * no request field that reaches the tenant predicate, which is what makes
 * assertion D meaningful. */
async function myStrategies(page: Page): Promise<any[]> {
	const b = await getJson(page, "/api/v1/me/strategies");
	const list = b?.data?.strategies ?? [];
	return Array.isArray(list) ? list : [];
}

// ── the shared invite code ────────────────────────────────────────────────

test.describe("26 — quant-research student cohort [long]", () => {
	let sharedInviteCode = "";

	test.beforeAll(async ({}, testInfo) => {
		if (!LONG_ENABLED) testInfo.skip(true, "CI_E2E_LONG=1 to enable this long e2e");
		if (!localOtpEnabled() && !process.env.E2E_GMAIL_APP_PASSWORD) {
			testInfo.skip(
				true,
				"No OTP source: set E2E_GMAIL_APP_PASSWORD, or CI_E2E_LOCAL_OTP=1 for the Redis backdoor",
			);
		}
		const baseURL = testInfo.project.use.baseURL ?? process.env.BASE_URL ?? "https://lum.id";

		// One code, minted fresh, shared by every student — same shape as spec
		// 12. Deliberately NOT reusing E2E_INVITATION_CODE by default: that one
		// is long-lived and each student burns a use, and a run that drains the
		// operator's code is a run that breaks the next person's onboarding.
		// E2E_REUSE_INVITE=1 opts back into it.
		if (process.env.E2E_REUSE_INVITE === "1" && process.env.E2E_INVITATION_CODE) {
			sharedInviteCode = process.env.E2E_INVITATION_CODE;
			return;
		}
		const adminEmail = process.env.E2E_ADMIN_EMAIL;
		const adminPassword = process.env.E2E_ADMIN_PASSWORD;
		if (!adminEmail || !adminPassword) {
			if (process.env.E2E_INVITATION_CODE) {
				sharedInviteCode = process.env.E2E_INVITATION_CODE;
				return;
			}
			testInfo.skip(true, "Neither E2E_ADMIN_EMAIL/PASSWORD nor E2E_INVITATION_CODE set — can't get a code");
		}
		const adminApi = await pwrequest.newContext({ baseURL });
		try {
			const loginResp = await adminApi.post("/api/v1/login", {
				data: { email: adminEmail, password: adminPassword },
				headers: { "Content-Type": "application/json" },
			});
			if (!loginResp.ok()) throw new Error(`admin login: ${loginResp.status()} ${await loginResp.text()}`);
			const adminJwt = (await loginResp.json())?.data?.token;
			if (!adminJwt) throw new Error("admin login returned no token");
			const mintResp = await adminApi.post("/api/v1/admin/invitation-codes", {
				headers: { Authorization: `Bearer ${adminJwt}`, "Content-Type": "application/json" },
				// max_uses must cover every student plus signup retries.
				data: {
					note: `e2e-quant-cohort-${Date.now()}`,
					count: 1,
					max_uses: Math.max(NUM_USERS * 2, 10),
					ttl_days: 1,
				},
			});
			if (!mintResp.ok()) throw new Error(`mint invite: ${mintResp.status()} ${await mintResp.text()}`);
			sharedInviteCode = (await mintResp.json())?.data?.codes?.[0]?.code || "";
			if (!sharedInviteCode) throw new Error("mint invite: no code in response");
		} finally {
			await adminApi.dispose();
		}
	});

	for (let i = 0; i < NUM_USERS; i++) {
		const slot = i;

		test(`student_${slot}: code-less bounce → redeem → install → four surfaces → deploy → chat`, async ({
			browser,
			baseURL,
		}, testInfo) => {
			// Marketplace install alone allows 180s, the mailbox round-trip
			// another 240s. The suite default is 60s, and without this the walk
			// dies mid-install and reports whichever locator it was on — a budget
			// failure wearing a product failure's error message.
			test.setTimeout(15 * 60_000);

			const url = baseURL ?? process.env.BASE_URL ?? "https://lum.id";
			const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
			// Identifier-safe AND not fixture-prefixed: the strategies surface
			// declares `hide_when: [{key: name, prefix: e2e_}, {prefix: smoke_},
			// {prefix: verify-}, {prefix: probe-}]`, so a name starting `e2e_`
			// is hidden by default and the row assertion would look like a
			// registration failure. `.lqts` also parses the name as a bare
			// IDENTIFIER, so no dashes and no leading digit.
			const strategyName = `student_${slot}_${stamp}`.replace(/[^A-Za-z0-9_]/g, "_");
			// Real .lqts grammar, verified against the compiler 2026-08-26 (see
			// spec 22's note). `symbol:` / `price_change()` / `propose buy size`
			// are NOT in the grammar; a rejected deploy leaves the record at
			// `sent` and fails invisibly.
			const strategySrc = [
				`strategy ${strategyName} {`,
				`  params { band: 50, size_lots: 30, cap: 300 }`,
				`  signal sma20 = sma(market.mid, 20)`,
				`  when market.mid < sma20 - params.band && position.net_lots < params.cap {`,
				`    buy params.size_lots lots @ market.ask`,
				`  }`,
				`}`,
			].join("\n");

			const refusals: Refusal[] = [];
			const findings: Finding[] = [];
			let currentSurface = "(pre-login)";

			// ── 0) a code-less student. `invitationCode: null` is EXPLICIT —
			//      createUser otherwise defaults it from E2E_INVITATION_CODE and
			//      assertion A would pass for the wrong reason.
			const user = await createUser(url, { tag: `qstu-${slot}-${stamp}`, invitationCode: null });
			testInfo.attach("student", {
				body: JSON.stringify({ slot, email: user.email, strategy: strategyName }, null, 2),
				contentType: "application/json",
			});

			// deviceScaleFactor 2 is the doc requirement, and the project's
			// Desktop Chrome device is 1 — so the shared `page` fixture cannot
			// produce these. Own context, own viewport, explicit baseURL (a bare
			// newPage does not inherit `use.baseURL`, and every navigation below
			// is relative).
			const ctx = await (browser as Browser).newContext({
				baseURL: url,
				viewport: { width: 1440, height: 960 },
				deviceScaleFactor: 2,
			});
			const page = await ctx.newPage();

			// Record every refusal against the surface that provoked it. This IS
			// the scope matrix: a no-scope student is the real day-one shape, so
			// what refuses them is onboarding documentation, not a defect.
			page.on("response", (resp) => {
				const s = resp.status();
				if (s < 400) return;
				const u = resp.url();
				if (!/\/api\/v1\/|\/dataapp-proxy\/|\/findata-cloud\//.test(u)) return;
				// GET /api/v1/user 401 before a session exists is the SPA asking
				// who you are, not a scope refusal. Leaving it in put a row at the
				// top of the matrix that every reader has to learn to ignore,
				// which is how a matrix stops being read.
				if (s === 401 && /\/api\/v1\/user$/.test(new URL(u).pathname) && currentSurface === "login") return;
				refusals.push({ surface: currentSurface, method: resp.request().method(), url: shortPath(u), status: s });
			});

			try {
				// ── 1) log in. A code-less account is bounced straight to the wall.
				currentSurface = "login";
				await loginViaUi(page, user);

				// ── 2) ASSERTION A — the bounce, from a /studio path.
				//      Land on the surface a cohort instruction would send them to.
				currentSurface = "auth-guard bounce";
				const want = `/studio/a/${APP}/strategies`;
				await gotoRedirect(page, want);
				await expect(
					page,
					"a code-less student was NOT bounced to /auth/redeem-invite from a /studio path — " +
						"auth-guard.tsx's invitation gate (the branch admins bypass) has regressed",
				).toHaveURL(/\/auth\/redeem-invite/, { timeout: 30_000 });
				// The bounce must preserve where they were going, or redeeming
				// dumps them somewhere unrelated and the cohort instruction breaks.
				const bounced = new URL(page.url());
				expect(
					bounced.searchParams.get("return_to"),
					"the invite bounce dropped return_to — a student who redeems lands somewhere they did not ask for",
				).toBe(want);
				await expect(page.getByRole("heading", { name: /Enter your invitation code/i })).toBeVisible({
					timeout: 20_000,
				});
				await shotThenAssert(page, slot, "student-redeem-invite.png", async () => {
					// The wall has to tell them where a code comes from, or real
					// accounts sit here for weeks (they did).
					await expect(page.getByText(/Your code comes from whoever invited you/i)).toBeVisible();
					await expect(page.locator("#invite-code")).toBeVisible();
				});

				// ── 3) redeem, and land on the surface originally asked for.
				currentSurface = "redeem-invite";
				await page.locator("#invite-code").fill(sharedInviteCode);
				await page.getByRole("button", { name: /continue/i }).click();
				await expect(
					page,
					`redeeming did not return the student to ${want}`,
				).toHaveURL(new RegExp(want.replace(/\//g, "\\/")), { timeout: 45_000 });

				// ── 4) install quant-research. Same ledger the marketplace card
				//      writes to (POST /api/v1/me/apps); spec 22 covers the card
				//      click itself, so this takes the ledger route and spends the
				//      budget on the surfaces instead.
				currentSurface = "install";
				const already = (await installedApps(page)).find((a) => a.name === APP);
				if (!already) {
					const inst = await page.request.post("/api/v1/me/apps", {
						data: { slug: APP_SLUG, runtime: "local" },
						headers: { "Content-Type": "application/json" },
					});
					expect(
						inst.ok() || inst.status() === 409,
						`install ${APP}: ${inst.status()} ${await inst.text().catch(() => "")} — ` +
							"a no-scope student could not queue an install intent",
					).toBeTruthy();
				}
				await expect
					.poll(async () => (await installedApps(page)).find((a) => a.name === APP)?.status ?? "(absent)", {
						timeout: 240_000,
						intervals: [4_000],
						message: `${APP} never reached status=ready in /me/apps — the install intent stalled`,
					})
					.toBe("ready");

				// ── 5) ASSERTION B — all four surfaces render, none 403s.
				//
				// The nav declares exactly these four (manifest ui.nav). The legacy
				// `page` overview is retired and 404s by design, so it is not walked.
				const SURFACES: Array<{ key: string; heading: RegExp; shot?: string }> = [
					{ key: "strategies", heading: /Your strategies/i },
					{ key: "backtests", heading: /Read this before you believe a number/i },
					{ key: "forward", heading: /There is no forward-test submit/i },
					{ key: "runtime", heading: /This is the funnel, NOT PnL/i },
				];
				for (const s of SURFACES) {
					currentSurface = s.key;
					await gotoRedirect(page, `/studio/a/${APP}/${s.key}`);
					// AppSurface renders exactly this line when me.appUI throws —
					// a 403 on the surface read lands here, so it is the single
					// most informative negative to assert on.
					await expect(
						page.getByText(/Couldn't load this agent's surface/i),
						`surface '${s.key}' failed to load for a no-scope student — see the scope matrix for the refusal`,
					).toHaveCount(0, { timeout: 30_000 });
					await expect(
						page.getByRole("heading", { name: s.heading }).first(),
						`surface '${s.key}' rendered without its '${s.heading}' section`,
					).toBeVisible({ timeout: 45_000 });
				}

				// ── 6) ASSERTION C — EMPTY-COLLECTION RENDERING.
				//
				// The single most valuable check here. A fresh student has zero
				// strategies, and the registry read is per-tenant by construction,
				// so this state is guaranteed and is what every cohort member sees
				// first. It must SAY it is empty. A table drawn with headers and no
				// body, a spinner that never resolves, or a red error chip are all
				// failures — each of them reads as "the product is broken" on day
				// one, which is exactly the impression this walk exists to prevent.
				currentSurface = "strategies (empty)";
				await gotoRedirect(page, `/studio/a/${APP}/strategies`);
				await expect(page.getByRole("heading", { name: /Your strategies/i })).toBeVisible({ timeout: 45_000 });
				const mineBefore = await myStrategies(page);
				expect(
					mineBefore.length,
					`a brand-new student already owns ${mineBefore.length} strategies — ` +
						"the registry read is not scoped to the caller",
				).toBe(0);

				await shotThenAssert(page, slot, "student-strategies-empty.png", async () => {
					// (c1) an explicit empty statement is on the page.
					await expect(
						page.getByText(/^No rows\.$|No strategies yet/i).first(),
						"the strategies surface renders NO empty statement for a student with zero strategies — " +
							"it must say the collection is empty, not leave a blank region",
					).toBeVisible({ timeout: 30_000 });
					// (c2) no data row is drawn. A headerless-but-populated table,
					// or another tenant's rows leaking in, both fail here.
					await expect(
						page.locator("table tbody tr"),
						"rows are rendered for a student who owns none",
					).toHaveCount(0, { timeout: 15_000 });
					// (c3) nothing on the page is claiming an error.
					await expect(
						page.getByText(/Couldn't load|Failed to load|Something went wrong/i),
						"the empty strategies surface renders an ERROR rather than an empty state",
					).toHaveCount(0);
				});

				// (c4) the authored empty copy. The app's YAML declares
				//      `empty: No strategies yet. Deploy one below and it appears
				//      here — then use Backtest, Forward test and Discuss on its
				//      row.` — a next action, which is the whole point of an empty
				//      state. Recorded rather than asserted: whether the renderer
				//      honours `empty:` is a lumid-ui question, and failing here
				//      would stop the walk before the surfaces this file exists to
				//      reach. It is reported in the scope matrix either way.
				const authoredEmpty = await page
					.getByText(/No strategies yet\. Deploy one below/i)
					.count()
					.catch(() => 0);
				if (!authoredEmpty) {
					findings.push({
						surface: "strategies",
						note:
							"The surface's authored `empty:` copy is DROPPED. ui/strategies.yaml declares " +
							'"No strategies yet. Deploy one below and it appears here — then use Backtest, ' +
							'Forward test and Discuss on its row." but the renderer shows the bare string ' +
							'"No rows." — lumid-ui src/components/app-surface/directives.tsx:793 hardcodes it ' +
							"and never reads `body.empty`. Every empty table in every app surface loses its " +
							"author's next-action text. This is the first thing a cohort student sees.",
					});
				}
				testInfo.annotations.push({
					type: "empty-state",
					description: authoredEmpty ? "authored empty: copy rendered" : "authored empty: copy DROPPED (see findings)",
				});

				// ── 7) ASSERTION D — their own rows only.
				//
				// `dataapp://lqt/xpio/stats` is the CROSS-TENANT registry count
				// (nginx injects a shared read-scoped service PAT), while
				// /me/strategies is scoped to the caller's own id. Non-zero there
				// and zero here, at the same instant, is the tenancy proof — and
				// it is a proof only a non-owner account can produce.
				currentSurface = "tenancy";
				const stats = await page.request
					.get("/dataapp-proxy/lqt/xpio/stats")
					.then(async (r) => (r.ok() ? await r.json().catch(() => null) : null))
					.catch(() => null);
				const globalRegistered = Number(stats?.strategies?.total ?? NaN);
				if (Number.isFinite(globalRegistered)) {
					expect(
						globalRegistered,
						"the shared registry reports zero strategies, so 'the student sees only their own' " +
							"cannot be distinguished from 'there are none' — the tenancy assertion is inconclusive",
					).toBeGreaterThan(0);
					expect(
						mineBefore.length,
						`cross-tenant registry holds ${globalRegistered} strategies and this student's own list is ` +
							`${mineBefore.length} — a non-zero own-list would mean the per-tenant scope leaked`,
					).toBe(0);
					testInfo.annotations.push({
						type: "tenancy",
						description: `global registry ${globalRegistered} vs own 0`,
					});
				} else {
					findings.push({
						surface: "strategies (stat tiles)",
						note:
							"dataapp://lqt/xpio/stats did not return readable JSON for a no-scope student — the four " +
							"Overview stat tiles on Strategies have no source, so the tenancy comparison could not " +
							"be made in-browser. Needs the /dataapp-proxy/lqt route to be reachable for role=user.",
					});
				}

				// ── 8) deploy a strategy through the form a researcher uses.
				currentSurface = "deploy";
				await page.getByLabel(/Strategy Name/i).fill(strategyName);
				await page.getByLabel(/^Version$/i).fill("1.0.0");
				// Strategy ID blank — the server mints one. That is the path that
				// stamps source_strategy_id onto later backtests.
				await page.getByLabel(/Strategy Content/i).fill(strategySrc);
				await page.getByRole("button", { name: /Submit to Inbox/i }).click();
				// runLoopNow only ENQUEUES; "Queued" is the honest claim and the
				// registration below is the real proof.
				const queued = await visibleWithin(page.getByText(/Queued send_strategy/i).first(), 60_000);
				if (!queued) {
					// A refusal here is the scope answer for the write path.
					const writeRefusal = refusals.find((r) => /\/me\/loops\//.test(r.url));
					findings.push({
						surface: "strategies → Deploy",
						note: writeRefusal
							? `POST ${writeRefusal.url} returned ${writeRefusal.status} — a no-scope student cannot ` +
								"run an app loop, so `Submit to Inbox` (and every other run_loop button on every " +
								"surface) is inert for them."
							: "the Deploy form never confirmed `Queued send_strategy` and no API refusal was recorded.",
					});
				}
				testInfo.annotations.push({ type: "deploy-queued", description: String(queued) });

				// ── 9) the registration round-trip, and the program_hash.
				//
				// The row only exists once the mailbox consumer compiles the .lqts
				// and writes core.tenant_strategies. The consumer enforces a TENANT
				// ALLOWLIST (`LQT_MAILBOX_TENANT_ID`, Secret lqt-mailbox-consumer):
				// a tenant not on it is terminally denied with "tenant … not served
				// by this consumer instance", and — because the reject ack carries
				// no `strategy` echo — the /xpio/strategies record stays at `sent`,
				// so the DENIAL IS INVISIBLE IN THE UI. A fresh student is by
				// definition not on that list. Bounded poll, then recorded: an
				// operator step a cohort needs is an onboarding fact, and hanging
				// the whole walk on it would hide everything downstream.
				currentSurface = "registration";
				let registered: any = null;
				const regDeadline = Date.now() + 240_000;
				while (Date.now() < regDeadline) {
					const mine = await myStrategies(page);
					registered = mine.find((s: any) => String(s?.name ?? "") === strategyName) ?? null;
					if (registered) break;
					await page.waitForTimeout(8_000);
				}

				await gotoRedirect(page, `/studio/a/${APP}/strategies`);
				await expect(page.getByRole("heading", { name: /Your strategies/i })).toBeVisible({ timeout: 45_000 });
				await shotThenAssert(page, slot, "student-strategies-populated.png", async () => {
					if (!registered) return;
					// The registry table is the UI half of the same fact.
					await expect(
						page.getByRole("row").filter({ hasText: strategyName }).first(),
						"the strategy registered in /me/strategies but the surface's table does not show it",
					).toBeVisible({ timeout: 60_000 });
				});

				if (registered) {
					// program_hash is the compile proof — a registration with an
					// empty hash means the .lqts was accepted but never compiled.
					expect(
						String(registered.program_hash ?? ""),
						`strategy ${strategyName} registered with NO program_hash — accepted but not compiled`,
					).not.toBe("");
					testInfo.annotations.push({
						type: "program_hash",
						description: `${strategyName} → ${String(registered.program_hash).slice(0, 24)}…`,
					});
				} else {
					findings.push({
						surface: "strategies → Deploy → registry",
						note:
							"A deployed strategy NEVER registered within 240s. The mailbox consumer's " +
							"tenant allowlist (Secret lqt-mailbox-consumer key `tenant_id`, env " +
							"LQT_MAILBOX_TENANT_ID) is a finite CSV of tenant uuids and a fresh student's uuid is " +
							"not on it, so strategy.deploy is terminally denied. The denial is INVISIBLE: the " +
							"reject ack carries no `strategy` echo, /xpio/strategies stays at `sent`, and the UI " +
							"has already said `Queued send_strategy`. ONBOARDING PREREQUISITE: a cohort member's " +
							"lum.id user id must be appended to that secret before they can deploy anything.",
					});
					testInfo.annotations.push({
						type: "registration-gate",
						description: `${strategyName} never registered — tenant allowlist (see findings)`,
					});
				}

				// ── 10) the backtest surface and its three honesty axes.
				//
				// A fresh student has zero runs, so the axes are read from the
				// surface's own labelling rather than from a row. That IS what a
				// student hits, and the labelling is the thing the doc teaches:
				// real prices are necessary, not sufficient.
				currentSurface = "backtests";
				await gotoRedirect(page, `/studio/a/${APP}/backtests`);
				await shotThenAssert(page, slot, "student-backtest.png", async () => {
					await expect(page.getByRole("heading", { name: /^Results$/i }).first()).toBeVisible({
						timeout: 45_000,
					});
					// prices · signals · settlement — named independently, which is
					// the whole honesty contract.
					for (const axis of [/\bprices\b/i, /\bsignals\b/i, /\bsettlement\b/i]) {
						await expect(
							page.getByText(axis).first(),
							`the backtest surface does not name the '${axis}' honesty axis`,
						).toBeVisible({ timeout: 20_000 });
					}
					// The fallback label must be stated, or a synthetic run reads
					// as a real one.
					await expect(
						page.getByText(/synthetic_lcg/i).first(),
						"the backtest surface never mentions synthetic_lcg — the fallback would read as a real replay",
					).toBeVisible({ timeout: 20_000 });
				});

				// ── 11) the forward surface. Reads only — deploying IS starting
				//        the paper arm, so there is nothing to start here.
				currentSurface = "forward";
				await gotoRedirect(page, `/studio/a/${APP}/forward`);
				await expect(page.getByRole("heading", { name: /^Reads$/i }).first()).toBeVisible({ timeout: 45_000 });
				// Drive the read verb — the cheapest write-path probe on the app,
				// and the one that answers "can a student run a loop at all".
				await page.getByRole("button", { name: /Read forward state/i }).first().click();
				const forwardQueued = await visibleWithin(page.getByText(/Queued forward read/i).first(), 60_000);
				testInfo.annotations.push({ type: "forward-read-queued", description: String(forwardQueued) });
				if (!forwardQueued) {
					const r = refusals.find((x) => /forward_test\/run/.test(x.url));
					findings.push({
						surface: "forward → Read forward state",
						note: r
							? `POST ${r.url} returned ${r.status} — the read-only forward verb is refused for a no-scope student.`
							: "the forward read never confirmed `Queued forward read` and no API refusal was recorded.",
					});
				}
				// A scorecard read for a minutes-old account correctly returns
				// zero. The surface must SAY that rather than look broken — the
				// same empty-collection rule as the strategies table.
				await shotThenAssert(page, slot, "student-forward.png", async () => {
					await expect(
						page.getByText(/Zero scorecards is not a loss or a failure/i).first(),
						"the forward surface does not explain that zero scorecards is the expected fresh state",
					).toBeVisible({ timeout: 20_000 });
					await expect(
						page.getByText(/Couldn't load|Failed to load/i),
						"the forward surface renders an error rather than an empty read",
					).toHaveCount(0);
				});

				// ── 12) runtime — funnel, not PnL.
				currentSurface = "runtime";
				await gotoRedirect(page, `/studio/a/${APP}/runtime`);
				await shotThenAssert(page, slot, "student-runtime.png", async () => {
					await expect(page.getByRole("heading", { name: /^Decision funnel$/i }).first()).toBeVisible({
						timeout: 45_000,
					});
					await expect(
						page.getByText(/These counts say whether a strategy is/i).first(),
						"the runtime surface does not state that the funnel is not PnL",
					).toBeVisible({ timeout: 20_000 });
					await expect(page.getByRole("heading", { name: /^Venue health$/i }).first()).toBeVisible({
						timeout: 20_000,
					});
				});
				// "Venue health" reads `venue · status · last event` — one row per
				// venue is what those columns promise. The surface declares no
				// limit, so `dataapp://lqt/lqt/venue-health/nyc` returns its full
				// 500-row time series and the table renders every snapshot. Recorded
				// rather than asserted: the row cap belongs in the app's YAML (or
				// the data app), and the walk's job is to say what a student sees.
				const runtimeRows = await page.locator("table tbody tr").count().catch(() => 0);
				if (runtimeRows > 50) {
					findings.push({
						surface: "runtime → Venue health",
						note:
							`The Venue health table renders ${runtimeRows} rows. Its columns are venue / status / ` +
							"last event — a current-state read — but `dataapp://lqt/lqt/venue-health/nyc` returns " +
							"the full 500-row snapshot series and the widget declares no limit, so a student " +
							"scrolls hundreds of repeated venue rows to find the current one. It made the " +
							"full-page screenshot 14 176 CSS px tall.",
					});
				}

				// ── 13) grounded chat. /studio/a/:app has no chat mounted (the
				//        Discuss action dispatches studio:ask into nothing there);
				//        /studio/apps/:app is the workspace that docks ChatRail and
				//        stashes the app so the thread is grounded on it.
				currentSurface = "chat";
				await gotoRedirect(page, `/studio/apps/${APP}`);
				await shotThenAssert(page, slot, "student-chat.png", async () => {
					await expect(
						page.getByPlaceholder(/Ask anything|Type next message/i).first(),
						"the grounded chat composer never mounted on the app workspace — a student has no way to " +
							"discuss what the surfaces show",
					).toBeVisible({ timeout: 60_000 });
					// The workspace must be grounded on THIS app, or the thread is
					// a generic chat wearing the app's URL.
					await expect(page.getByText(new RegExp(APP.replace("-", "[- ]"), "i")).first()).toBeVisible({
						timeout: 30_000,
					});
					// This page IS the student's route to the real surfaces — the
					// sidebar entry lands here, not on /studio/a/<app>/strategies.
					// If the four tabs are not reachable from it, a cohort member
					// never finds the surfaces at all.
					for (const tab of [/^Strategies$/, /Backtest \(registers\)/, /Forward test \(reads\)/, /^Runtime$/]) {
						await expect(
							page.getByRole("link", { name: tab }).first(),
							`the app workspace does not offer a route to the '${tab}' surface`,
						).toBeVisible({ timeout: 20_000 });
					}
				});

				// The RETIRED overview is still the landing page.
				//
				// The manifest moved to four named surfaces (ui.nav) and kept
				// `ui.surface.page: ui/page.yaml` behind them. /studio/a/<app>/page
				// is gone, but AppOverview still renders page.yaml at
				// /studio/apps/<app> — which is exactly where the sidebar entry and
				// a bare /studio/a/<app> both land. So the FIRST thing a student
				// sees of this app is the retired page, and page.yaml has not been
				// maintained alongside the four: its stat tiles source `me://today`
				// / `me://loops/health` paths that do not populate (they render as
				// em-dashes), its tables read `me://workflows` / `me://today` and
				// say "No data.", and its four forms still use the legacy
				// `action:` (POST /me/form-action) contract instead of the
				// `loop:`+`app:` contract the working surfaces use. Recorded, not
				// asserted: which page should be the landing is a product decision,
				// not something a walk gets to declare.
				const deadTiles = await page.getByText(/^—$/).count().catch(() => 0);
				const legacyOverview = await page
					.getByRole("heading", { name: /^LQT Research$/ })
					.count()
					.catch(() => 0);
				if (legacyOverview) {
					findings.push({
						surface: `app workspace (/studio/apps/${APP})`,
						note:
							"The app's LANDING page — where the sidebar entry and a bare /studio/a/<app> both go — " +
							"still renders the RETIRED `ui/page.yaml` overview ('LQT Research'), not one of the four " +
							`nav surfaces. ${deadTiles} of its stat tiles render as an em-dash placeholder because ` +
							"they source `me://today` / `me://loops/health` paths that do not populate for a " +
							"student, and its Dispatch/Analyze/Backtest forms still use the legacy `action:` " +
							"(POST /api/v1/me/form-action) contract rather than the `loop:`+`app:` contract the " +
							"four live surfaces use — so they are not the same buttons that work on Strategies. " +
							"A cohort member's first impression of quant-research is this page.",
					});
				}
			} finally {
				// The matrix is the deliverable — write it even when an assertion
				// above went red, because a red run is exactly when the refusals
				// matter most.
				writeScopeMatrix(slot, user.email, refusals, findings);
				testInfo.attach("scope-observations", {
					body: JSON.stringify({ refusals, findings }, null, 2),
					contentType: "application/json",
				});
				await ctx.close().catch(() => {});
			}
		});
	}
});

// ── the scope matrix ──────────────────────────────────────────────────────

/**
 * Write this student's observations, then re-render the merged matrix.
 *
 * Each test runs in its own worker PROCESS under mode:'parallel', so module
 * state is not shared and there is no cross-worker hook to merge in. Each
 * student therefore drops a JSON fragment and re-renders the whole document
 * from every fragment present — last writer wins with the fullest content,
 * which is the correct outcome without any coordination.
 */
function writeScopeMatrix(slot: number, email: string, refusals: Refusal[], findings: Finding[]): void {
	try {
		fs.mkdirSync(SCOPE_FRAGMENTS, { recursive: true });
		fs.writeFileSync(
			path.join(SCOPE_FRAGMENTS, `${slot}.json`),
			JSON.stringify({ slot, email, refusals, findings }, null, 2),
		);

		const frags = fs
			.readdirSync(SCOPE_FRAGMENTS)
			.filter((f) => f.endsWith(".json"))
			.map((f) => {
				try {
					return JSON.parse(fs.readFileSync(path.join(SCOPE_FRAGMENTS, f), "utf8"));
				} catch {
					return null;
				}
			})
			.filter(Boolean) as Array<{ slot: number; email: string; refusals: Refusal[]; findings: Finding[] }>;

		// Fold identical (surface, method, path, status) tuples across students —
		// three students hitting the same refusal is one fact, not three.
		const byKey = new Map<string, { r: Refusal; n: number }>();
		for (const f of frags) {
			for (const r of f.refusals) {
				const k = `${r.surface}|${r.method}|${r.url}|${r.status}`;
				const cur = byKey.get(k);
				if (cur) cur.n += 1;
				else byKey.set(k, { r, n: 1 });
			}
		}
		const seenNotes = new Set<string>();
		const allFindings: Finding[] = [];
		for (const f of frags) {
			for (const fi of f.findings) {
				const k = `${fi.surface}|${fi.note}`;
				if (seenNotes.has(k)) continue;
				seenNotes.add(k);
				allFindings.push(fi);
			}
		}

		const lines: string[] = [];
		lines.push("# quant-research — student scope matrix");
		lines.push("");
		lines.push(
			"Produced by `tests/26-quant-student-cohort.spec.ts`. Every row is something a **fresh, " +
				"no-scope, non-owner student** hit while walking the quant-research surfaces. The invitation " +
				"code these accounts redeem carries **no access grants**, which is the real day-one shape — so " +
				"a refusal here is an onboarding prerequisite to document, not a defect to fix.",
		);
		lines.push("");
		lines.push(`- run: ${new Date().toISOString()}`);
		lines.push(`- students: ${frags.length} (${frags.map((f) => `student_${f.slot}`).join(", ")})`);
		lines.push("");
		lines.push("## Surface → what refused it");
		lines.push("");
		if (!byKey.size) {
			lines.push(
				"No API refusal was recorded on any surface. Every read and write the walk performed was " +
					"served to a no-scope student.",
			);
		} else {
			lines.push("| Surface | Method | Path | Status | Students |");
			lines.push("|---|---|---|---|---|");
			for (const { r, n } of [...byKey.values()].sort((a, b) => a.r.surface.localeCompare(b.r.surface))) {
				lines.push(`| ${r.surface} | ${r.method} | \`${r.url}\` | ${r.status} | ${n} |`);
			}
		}
		lines.push("");
		lines.push("## Gates and gaps the walk hit");
		lines.push("");
		if (!allFindings.length) {
			lines.push("None — every step of the student walk completed.");
		} else {
			for (const f of allFindings) {
				lines.push(`### ${f.surface}`);
				lines.push("");
				lines.push(f.note);
				lines.push("");
			}
		}
		lines.push("## Reading this");
		lines.push("");
		lines.push(
			"- **403 on a `/api/v1/me/loops/<app>/<loop>/run`** — the student cannot run any app loop. " +
				"Every `run_loop` button on every surface (Backtest, Poll result, Forward test, Deploy, " +
				"Analyze Funnel) is inert until the account holds that grant.",
		);
		lines.push(
			"- **403/404 on `/dataapp-proxy/lqt/...`** — the shared LQT read plane. The Overview stat tiles " +
				"on Strategies and the Venue health table on Runtime source from it.",
		);
		lines.push(
			"- **A surface that renders but stays empty** is usually NOT a scope problem: `/api/v1/me/strategies` " +
				"and `/api/v1/me/apps/<app>/data` are scoped to the caller and answer 200 with an empty list.",
		);
		lines.push("");
		fs.writeFileSync(SCOPE_MATRIX, lines.join("\n"));
	} catch {
		// Never let bookkeeping fail a walk.
	}
}

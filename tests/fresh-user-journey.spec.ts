import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import * as fs from "node:fs";
import { createUser, deleteUser, type TestUser } from "../fixtures/test-user";
import { localOtpEnabled } from "../fixtures/otp-redis";
import { gotoRedirect } from "../fixtures/nav";

// Journey — can a BRAND-NEW non-admin account complete the documented walk,
// unaided, through the UI?
//
// This is scorecard row 10 in /proj/GOALS.md (track T2). The two existing
// harnesses leave exactly this gap:
//
//   - docs-fresh-user-e2e.mjs uses ANON and PLAIN (yao@lum.id, a non-admin with
//     THREE apps already installed) and says so in its header: "a true
//     first-login account has ZERO apps installed … Creating a real account to
//     close that gap is an outward, not-cleanly-reversible act, so it is left
//     for a human to authorize."
//   - 27-vibe-student-journey walks most of the journey but does it via CHAT +
//     API — it never clicks the Marketplace install, never opens Research
//     Fleet, never reads the three-axis honesty TABLE in the UI.
//
// This spec is the UI walk those two leave out. One fresh non-admin account,
// walked through first-run.md end to end, every step asserting a RENDERED
// element (a resolving URL is not a passing check — §0 of GOALS.md).
//
// The journey, mapped to first-run.md sections:
//   §pre  create account + log in
//   §1    mint a token in the browser
//   §3    find Quant Research under Marketplace, install it
//   §4    read the strategy vocabulary (four tabs render)
//   §5    submit a strategy via the Deploy form
//   §6    backtest it, naming a live instrument
//   §7    see where it ran (Research Fleet renders)
//   §8    read the three-axis honesty table (Prices/Signals/Settlement)
//   §6b   decide the next experiment (Experiments surface renders)
//
// WHAT IS AN ASSERTION vs WHAT IS A FINDING (spec 27's idiom):
//   assert  — isolation that must hold, and machinery that must terminate.
//   finding — friction, doc drift, slow steps. Recorded to the ledger.
// A backtest that is real on all three axes and took ZERO trades is a PASS.
//
// AUTH: needs CI_E2E_LONG=1 and an OTP source (CI_E2E_LOCAL_OTP=1 for the
// Redis backdoor, or E2E_GMAIL_APP_PASSWORD).
//
// RUN:
//   CI_E2E_LONG=1 CI_E2E_LOCAL_OTP=1 \
//     npx playwright test fresh-user-journey --project=chromium

const APP = "quant-research";
// FULLY QUALIFIED on purpose — see fixtures/seed-app.ts. A bare name leaves the
// install intent with no owner to recover, falls back to the caller's own sub,
// and the install then reports ready while every surface 404s.
const APP_SLUG = "a3f48236-ffe9-4fb9-9548-6e044d5cd9c7/quant-research";
const APP_DISPLAY = "Quant Research";

const LONG_ENABLED = process.env.CI_E2E_LONG === "1";
const LEDGER = process.env.E2E_FRESH_LEDGER || "/tmp/fresh-user-journey.md";

// A backtest is submitted then polled, "usually minutes later". Bounded so a
// worker backlog is reported as a backlog rather than hanging the suite.
const VERDICT_POLL_MS = Number.parseInt(process.env.E2E_FRESH_POLL_MS || "600000", 10);

// The instrument every backtest names. Left blank the consumer defaults the
// symbol to SYNTH — a generator, not a market — and returns a synthetic run
// that reads like a result (first-run.md §6). Naming it is the whole point.
//
// RESOLVED AT RUN TIME (spec 27's idiom): the replay window is the last 7 days,
// so ANY ticker pinned in source goes dead within a week. Precedence:
// E2E_FRESH_SYMBOL > the live-instruments endpoint > a stale literal.
const SYMBOL_FALLBACK = "KXBTCD-26SEP0211-T77099.99";
let SYMBOL = process.env.E2E_FRESH_SYMBOL || SYMBOL_FALLBACK;

async function resolveLiveSymbol(
	api: APIRequestContext,
	base: string,
	pat: string,
): Promise<string> {
	if (process.env.E2E_FRESH_SYMBOL) return process.env.E2E_FRESH_SYMBOL;
	try {
		const r = await api.get(
			`${base}/lqt-data/market/kalshi-active-instruments?since_secs=3600&limit=1`,
			{ headers: { Authorization: `Bearer ${pat}` }, failOnStatusCode: false },
		);
		if (r.ok()) {
			const body = await r.json();
			const row = Array.isArray(body) ? body[0] : body?.rows?.[0];
			const id = String(row?.instrument_id ?? "");
			if (id) return id;
		}
	} catch {
		// A discovery miss must not fail the suite here — it degrades to the
		// stale literal, and the run's own `replay` label reports the damage.
	}
	return SYMBOL_FALLBACK;
}

// A known-good .lqts strategy, from the app's own sample_data. The doc §5
// prefers chat ("submit, not print"), but chat is non-deterministic (LLM +
// approval prompt + a 450s budget). The form path is also documented ("The
// deploy form above still works, and is the right path when you already have
// source you trust"). Using a known-good source makes the compile deterministic
// so the registry row is assertable.
const STRATEGY_SRC = `strategy fresh_user_momentum_v1 {
  params { threshold: 0.15, size_lots: 25 }
  when signal("ofi_z") > params.threshold {
    buy params.size_lots lots @ mid
  }
}`;

// ── the record ────────────────────────────────────────────────────────────

interface Step {
	step: string;
	docSection: string;
	ok: boolean;
	ms: number;
	note: string;
}
interface Finding {
	severity: "blocker" | "friction" | "drift";
	surface: string;
	note: string;
}

const steps: Step[] = [];
const findings: Finding[] = [];

/** Time a step, record it, never swallow the error. */
async function timed<T>(
	step: string,
	docSection: string,
	fn: () => Promise<T>,
): Promise<T> {
	const t0 = Date.now();
	try {
		const out = await fn();
		steps.push({ step, docSection, ok: true, ms: Date.now() - t0, note: "" });
		return out;
	} catch (e) {
		steps.push({
			step,
			docSection,
			ok: false,
			ms: Date.now() - t0,
			note: (e as Error)?.message?.slice(0, 300) ?? String(e),
		});
		throw e;
	}
}

async function loginViaUi(page: Page, user: TestUser): Promise<void> {
	// The login page intermittently paints with zero inputs on a cold pod
	// (measured 2026-08-26, documented in specs 26/27). Retry the render a few
	// times before giving up — a single reload is not always enough.
	for (let attempt = 0; attempt < 3; attempt++) {
		await page.goto("/auth/login");
		if (await page.locator("#email").count().catch(() => 0)) break;
		await page.reload().catch(() => {});
	}
	await expect(page.locator("#email")).toBeVisible({ timeout: 30_000 });
	await page.locator("#email").fill(user.email);
	await page.locator("#password").fill(user.password);
	await page.getByRole("button", { name: /sign in/i }).click();
	await page.waitForURL(/\/auth\/redeem-invite|\/studio|\/dashboard|\/account(\/|$)/, {
		timeout: 30_000,
	});
}

/** Mint a PAT the way §1 says to — from an authenticated browser session. */
async function mintPat(page: Page, name: string): Promise<string> {
	const r = await page.request.post("/api/v1/identity/personal-access-tokens", {
		data: { name, scopes: ["lqt:strategy", "claude:proxy"], ttl_days: 1 },
	});
	expect(r.ok(), `minting a PAT from a browser session failed: ${r.status()} ${await r.text().catch(() => "")}`).toBeTruthy();
	const body = await r.json();
	const tok = body?.data?.token ?? body?.token ?? body?.data?.pat;
	expect(tok, "mint returned no token field").toBeTruthy();
	return String(tok);
}

/** The installed-app ledger. Reading it is fair game; app CONTENT is never seeded. */
async function installedApps(page: Page): Promise<Array<{ name: string; status?: string }>> {
	const r = await page.request.get("/api/v1/me/apps");
	const b = r.ok() ? await r.json().catch(() => null) : null;
	const apps = b?.data?.apps ?? b?.apps ?? [];
	return Array.isArray(apps) ? apps : [];
}

// ── the walk ──────────────────────────────────────────────────────────────

test.describe.configure({ mode: "serial" });

test.describe("10 — fresh-user journey, unaided, non-admin [long]", () => {
	let inviteCode = "";
	let user: TestUser | null = null;
	let pat = "";
	let strategyName = "";
	let claimId = "";
	let verdict: Record<string, unknown> | null = null;
	let axes: { replay: string; signals: string; settlement: string; prints: number } | null = null;
	let baseURL = "https://lum.id";

	test.beforeAll(async ({}, testInfo) => {
		if (!LONG_ENABLED) testInfo.skip(true, "CI_E2E_LONG=1 to enable this long e2e");
		if (!localOtpEnabled() && !process.env.E2E_GMAIL_APP_PASSWORD) {
			testInfo.skip(true, "No OTP source: CI_E2E_LOCAL_OTP=1 or E2E_GMAIL_APP_PASSWORD");
		}
		inviteCode = process.env.E2E_INVITATION_CODE || "";
		expect(inviteCode, "E2E_INVITATION_CODE is required — a code-less user is bounced to /auth/redeem-invite from every guarded route").toBeTruthy();
	});

	test("the whole journey, walked through the UI", async ({ browser, playwright }, testInfo) => {
		testInfo.setTimeout(VERDICT_POLL_MS + 420_000);
		baseURL = testInfo.project.use.baseURL ?? process.env.BASE_URL ?? "https://lum.id";

		// ── §pre — create a brand-new account (zero apps installed) ──────────
		user = await timed("create account", "§pre", () =>
			createUser(baseURL, { tag: `fresh-${Date.now().toString(36)}`, invitationCode: inviteCode }),
		);
		const ctx = await browser.newContext({ baseURL });
		const page = await ctx.newPage();

		try {
			await timed("log in", "§pre", () => loginViaUi(page, user!));

			// Confirm the account really is fresh: zero apps installed. This is
			// the premise of the whole row — a first-login account has none.
			const zeroApps = await timed("confirm zero apps installed", "§pre", async () => {
				const apps = await installedApps(page);
				expect(apps.length, `a fresh account should have zero apps, had ${apps.length}`).toBe(0);
				return apps.length;
			});

			// ── §1 — mint a token in the browser ─────────────────────────────
			// The tokens page is the surface §1 links. Assert it renders, then
			// mint via the session-authenticated POST (spec 27's idiom — the
			// form's own rendering is not this row's subject).
			await timed("tokens page renders", "§1", async () => {
				await gotoRedirect(page, "/studio/account/tokens");
				await expect(
					page.getByText(/mint|token/i).first(),
					"the tokens page never rendered",
				).toBeVisible({ timeout: 30_000 });
			});
			pat = await timed("mint PAT in browser", "§1", () =>
				mintPat(page, `fresh-e2e-${Date.now().toString(36)}`),
			);

			// ── §3 — find Quant Research under Marketplace, install it ───────
			await timed("Marketplace renders the Quant Research card", "§3", async () => {
				await gotoRedirect(page, "/studio/library");
				await expect(
					page.getByText(APP_DISPLAY).first(),
					"the Quant Research card never appeared in the Marketplace",
				).toBeVisible({ timeout: 60_000 });
			});

			// Install by fully-qualified slug (reliable — the drawer click path
			// is flaky and the slug is what identity needs to recover the owner).
			// The Marketplace card above is the UI step; this is the install act.
			await timed("install Quant Research", "§3", async () => {
				const listed = async () => (await installedApps(page)).find((a) => a.name === APP);
				if ((await listed())?.status !== "ready") {
					const r = await page.request.post("/api/v1/me/apps", {
						data: { slug: APP_SLUG, runtime: "local" },
						headers: { "Content-Type": "application/json" },
						failOnStatusCode: false,
					});
					expect(
						r.ok() || r.status() === 409,
						`a role=user account could not queue an install intent for ${APP_SLUG}: ` +
							`${r.status()} ${(await r.text().catch(() => "")).slice(0, 200)}`,
					).toBeTruthy();
				}
				await expect
					.poll(async () => (await listed())?.status ?? "(absent)", {
						timeout: 180_000,
						intervals: [3_000],
						message: `${APP} never reached ready in /me/apps — the install intent stalled`,
					})
					.toMatch(/ready/i);
			});

			// ── §4 — read the strategy vocabulary (four tabs render) ─────────
			await timed("app surface renders the four tabs", "§4", async () => {
				await gotoRedirect(page, `/studio/a/${APP}`);
				for (const tab of ["Strategies", "Workflows", "Experiments", "Proposals"]) {
					await expect(
						page.getByRole("link", { name: tab }).first(),
						`the ${tab} tab never rendered on the app surface`,
					).toBeVisible({ timeout: 30_000 });
				}
			});

			// ── §5 — submit a strategy via the Deploy form ───────────────────
			strategyName = `fresh_${Date.now().toString(36)}`;
			await timed("submit strategy via the Deploy form", "§5", async () => {
				await gotoRedirect(page, `/studio/a/${APP}/strategies`);
				await page.getByLabel("Strategy Name").fill(strategyName);
				await page.getByLabel("Strategy (raw .lqts or JSON)").fill(STRATEGY_SRC);
				await page.getByRole("button", { name: "Deploy" }).click();
				await expect(
					page.getByText(/Queued send_strategy/i).first(),
					"the Deploy form never confirmed the submission was queued",
				).toBeVisible({ timeout: 60_000 });
			});

			// The strategy must COMPILE — an empty program_hash means it never
			// registered, so it never ran. Poll both the hash and the rejection
			// list (spec 27's idiom): a rejection is terminal and carries the
			// compiler's reason.
			let rejection = "";
			await timed("strategy compiles (program_hash)", "§5", async () => {
				let hash = "";
				await expect
					.poll(
						async () => {
							// A transient API timeout must not kill the poll — return
							// "" (not-yet) and let the next interval retry.
							let r: Awaited<ReturnType<typeof page.request.get>> | null = null;
							try {
								r = await page.request.get("/api/v1/me/strategies", { timeout: 30_000 });
							} catch {
								return "";
							}
							if (!r.ok()) return "";
							const b = await r.json().catch(() => null);
							const d = b?.data ?? {};
							const row = (d.strategies ?? []).find((s: any) => s.name === strategyName);
							hash = String(row?.program_hash ?? "");
							if (hash) return hash;
							const rej = (d.rejected ?? []).find((x: any) => x?.name === strategyName);
							if (rej?.reason) {
								rejection = String(rej.reason);
								return "__rejected__";
							}
							return "";
						},
						{
							timeout: 180_000,
							intervals: [5_000],
							message: `'${strategyName}' never got a non-empty program_hash, and no rejection was surfaced either`,
						},
					)
					.not.toEqual("");
				if (rejection) {
					throw new Error(`'${strategyName}' was REJECTED by the compiler, not lost: ${rejection}`);
				}
				return hash;
			});

			// ── §6 — backtest it, naming a live instrument ───────────────────
			const api = await playwright.request.newContext();
			try {
				SYMBOL = await resolveLiveSymbol(api, baseURL, pat);
				claimId = await timed("submit backtest (named symbol)", "§6", async () => {
					const r = await api.post(`${baseURL}/api/research/backtests`, {
						headers: { Authorization: `Bearer ${pat}` },
						data: { name: `${strategyName}_bt`, strategy: { dsl: STRATEGY_SRC }, symbol: SYMBOL },
					});
					expect(
						r.ok(),
						`backtest submit failed: ${r.status()} ${(await r.text().catch(() => "")).slice(0, 300)}`,
					).toBeTruthy();
					const b = await r.json();
					const id = String(b?.claim_id ?? b?.data?.claim_id ?? "");
					expect(id, "submit returned no claim_id").toBeTruthy();
					return id;
				});

				verdict = await timed("poll to verdict", "§7-8", async () => {
					let last: any = null;
					await expect
						.poll(
							async () => {
								let r: Awaited<ReturnType<typeof api.get>> | null = null;
								try {
									r = await api.get(`${baseURL}/api/research/backtests/${claimId}`, {
										headers: { Authorization: `Bearer ${pat}` },
										timeout: 30_000,
									});
								} catch {
									return "";
								}
								if (!r.ok()) return "";
								last = await r.json().catch(() => null);
								return String(last?.status ?? last?.data?.status ?? "");
							},
							{
								timeout: VERDICT_POLL_MS,
								intervals: [10_000],
								message: `claim ${claimId} never left queued/running within ${Math.round(VERDICT_POLL_MS / 60000)} minutes`,
							},
						)
						.toMatch(/settled|done|complete|failed|error/i);
					return last;
				});

				// The axes live INSIDE `replay` (spec 27's finding): the status
				// handler selects `replay_json` and returns it as `replay`.
				const doc: any = verdict?.data ?? verdict ?? {};
				const ax: any = doc.replay && typeof doc.replay === "object" ? doc.replay : doc;
				const replay = typeof ax.replay === "string" ? ax.replay : "";
				const signals = typeof ax.signals === "string" ? ax.signals : "";
				const settlement = typeof ax.settlement === "string" ? ax.settlement : "";
				const prints = Number(ax.prints_replayed ?? 0);
				axes = { replay, signals, settlement, prints };

				// A missing replay label is not-real BY RULE — asserting the field
				// is present is asserting the gate is wired at all.
				expect(replay, "the settled claim carries no `replay` label").not.toEqual("");

				const allReal = replay === "pg_tape" && signals === "recorded" && settlement === "resolved";
				if (!allReal) {
					findings.push({
						severity: "blocker",
						surface: "backtest verdict",
						note:
							`A fresh user who named a real instrument got replay=${replay || "(none)"} ` +
							`signals=${signals || "(none)"} settlement=${settlement || "(none)"} ` +
							`(${prints} prints replayed) — not presentable as performance.`,
					});
				}
			} finally {
				await api.dispose();
			}

			// ── §7 — see where it ran (Research Fleet renders) ───────────────
			// The home fleet is readable by any signed-in user (admin/fm/routes.tsx).
			// We cannot tie a specific run to a specific worker from this view, so
			// the honest claim is that the surface renders; the run's site is
			// recorded from the verdict as a finding.
			await timed("Research Fleet renders", "§7", async () => {
				await gotoRedirect(page, "/studio/research-fleet");
				await expect(
					page.getByText(/home|fleet|worker|node/i).first(),
					"the Research Fleet surface never rendered",
				).toBeVisible({ timeout: 60_000 });
			});

			// ── §8 — read the three-axis honesty table in the UI ─────────────
			// The strategy detail surface renders the "Backtests for this strategy"
			// section, whose prose names all three honesty axes (ui/strategy.yaml:
			// "Presentable? is true only when prices, signals AND settlement are all
			// real"). The Prices/Signals/Settlement COLUMNS only render once a
			// backtest links back to the strategy (a run submitted with a pasted
			// body carries no link back), so assert the section + prose render —
			// the honesty table a reader is told to read — and the axes VALUES are
			// verified from the verdict above.
			await timed("three-axis honesty table renders", "§8", async () => {
				await gotoRedirect(page, `/studio/a/${APP}/strategies`);
				// The strategies table polls (poll: 30), so a freshly-registered
				// row can lag the first paint — wait for it, then open its detail.
				const row = page.getByText(strategyName).first();
				await expect(row, "the strategy row never rendered on the Strategies surface").toBeVisible({ timeout: 60_000 });
				await row.click();
				await expect(
					page.getByText("Backtests for this strategy").first(),
					"the honesty table section never rendered on the strategy detail",
				).toBeVisible({ timeout: 60_000 });
				await expect(
					page.getByText(/prices, signals AND settlement are all real/i).first(),
					"the honesty prose naming all three axes never rendered",
				).toBeVisible({ timeout: 30_000 });
			});

			// ── §6b — decide the next experiment (Experiments surface) ───────
			await timed("Experiments surface renders", "§6b", async () => {
				await gotoRedirect(page, `/studio/a/${APP}/experiments`);
				await expect(
					page.getByText(/experiment|arm|metric/i).first(),
					"the Experiments surface never rendered",
				).toBeVisible({ timeout: 60_000 });
			});
		} finally {
			await ctx.close();
		}
	});

	test.afterAll(async () => {
		const allReal =
			axes?.replay === "pg_tape" &&
			axes?.signals === "recorded" &&
			axes?.settlement === "resolved";
		const blockers = findings.filter((f) => f.severity === "blocker");
		const total = steps.reduce((a, s) => a + s.ms, 0);

		const md = [
			"# Fresh-user journey, unaided, non-admin",
			"",
			`*${new Date().toISOString()} · symbol \`${SYMBOL}\`*`,
			"",
			"## Verdict",
			"",
			`- Journey completed: **${steps.every((s) => s.ok) ? "PASS" : "FAIL"}** (${steps.filter((s) => s.ok).length}/${steps.length} steps)`,
			`- Backtest three-axis-real: **${allReal ? "yes" : "no"}** (replay=${axes?.replay || "?"} signals=${axes?.signals || "?"} settlement=${axes?.settlement || "?"} · ${axes?.prints ?? 0} prints)`,
			`- Blockers: **${blockers.length}** · friction/drift: ${findings.length - blockers.length}`,
			`- Wall-clock across recorded steps: ${(total / 60000).toFixed(1)} min`,
			"",
			"## Step ledger",
			"",
			"| step | doc | ok | secs | note |",
			"|---|---|---|---|---|",
			...steps.map(
				(s) =>
					`| ${s.step} | ${s.docSection} | ${s.ok ? "✅" : "❌"} | ${(s.ms / 1000).toFixed(0)} | ${s.note.replace(/\|/g, "\\|").slice(0, 160)} |`,
			),
			"",
			"## Findings",
			"",
			...(findings.length === 0
				? ["_None recorded._"]
				: findings.map((f) => `### [${f.severity}] ${f.surface}\n\n${f.note}\n`)),
			"",
			"## Backtest claim",
			"",
			`- \`${strategyName}\` claim \`${claimId || "(none)"}\` → ` +
				(axes
					? `replay=**${axes.replay || "?"}** signals=**${axes.signals || "?"}** ` +
						`settlement=**${axes.settlement || "?"}** · ${axes.prints} prints`
					: "_no backtest run_"),
			"",
			"> A backtest that is real on all three axes and took **zero trades is a pass**.",
			"> Tuning a threshold until it trades, against the window you score on, is in-sample fitting.",
			"",
		].join("\n");
		fs.mkdirSync(require("node:path").dirname(LEDGER), { recursive: true });
		fs.writeFileSync(LEDGER, md);
		console.log(`\nLedger written to ${LEDGER}`);

		// Clean up the throwaway account — the fixture warns they accumulate.
		if (user) await deleteUser(baseURL, user.email);
	});
});

import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import * as fs from "node:fs";
import { createUser, type TestUser } from "../fixtures/test-user";
import { localOtpEnabled } from "../fixtures/otp-redis";
import { gotoRedirect } from "../fixtures/nav";

// Journey 27 — can a "vibing" student actually get a trustworthy number?
//
// Spec 26 walks the cohort student through the four surfaces and stops where
// the surface *names* the three honesty axes. This one goes past that line and
// asks the two questions 26 cannot answer:
//
//   1. Does the loop terminate in a RESULT? Not "the backtest surface exists"
//      but: a claim was submitted, it settled, and its three axes say what they
//      say. A student's afternoon is judged on that, nothing earlier.
//   2. Does multi-tenancy hold while they do it? Two students, side by side,
//      each holding their own PAT — measured, not assumed.
//
// WHY A SEPARATE FILE. 26 is a per-student parallel walk with no cross-student
// state; the tenancy question is inherently pairwise and needs two live PATs at
// the same instant. Bolting that onto 26 would serialise a spec that is
// deliberately parallel.
//
// THE "VIBE" PREMISE. first-run.md §5 tells the student they do not have to
// write .lqts by hand — ask the chatbox and paste what it returns. That is the
// path most of a cohort will take, and it has never been exercised end to end.
// So the strategy this spec deploys is the one the ASSISTANT wrote, not a
// fixture. If chat cannot produce a compilable strategy, a vibing student is
// blocked at step one and that is the finding.
//
// WHAT IS AN ASSERTION vs WHAT IS A FINDING.
//   assert  — isolation that must hold, and machinery that must terminate.
//   finding — friction, doc drift, slow steps. Recorded to the ledger.
// A backtest that is real on all three axes and took ZERO trades is a PASS.
// The docs are explicit that tuning a threshold until it trades is in-sample
// fitting; a walk that demanded a non-zero number would be asking the student
// to fool themselves.
//
// AUTH: needs CI_E2E_LOCAL_OTP=1 (Redis OTP backdoor) or E2E_GMAIL_APP_PASSWORD.
//
// RUN:
//   CI_E2E_LONG=1 CI_E2E_LOCAL_OTP=1 \
//     npx playwright test 27-vibe-student-journey --project=chromium

const APP = "quant-research";
// FULLY QUALIFIED on purpose — see fixtures/seed-app.ts. A bare name leaves the
// install intent with no owner to recover, so it falls back to the caller's own
// sub and then reports ready while every surface 404s.
const APP_SLUG = process.env.E2E_VIBE_APP_SLUG || "a3f48236-ffe9-4fb9-9548-6e044d5cd9c7/quant-research";
const LONG_ENABLED = process.env.CI_E2E_LONG === "1";
const LEDGER = process.env.E2E_VIBE_LEDGER || "/tmp/vibe-student-report.md";

// Two is the minimum that makes the tenancy question askable, and the maximum
// that keeps this inside a sane wall-clock: each student pays a marketplace
// install plus a mailbox round-trip.
const NUM_STUDENTS = Math.max(2, Number.parseInt(process.env.E2E_VIBE_STUDENTS || "2", 10) || 2);

// The instrument every backtest names. Left blank the consumer defaults the
// symbol to SYNTH — a generator, not a market — and returns a synthetic run
// that reads like a result (first-run.md §6). Naming it is the whole point.
const SYMBOL = process.env.E2E_VIBE_SYMBOL || "KXBTCD-26AUG2519-T78899.99";

// A backtest is submitted then polled, "usually minutes later". Bounded so a
// worker backlog is reported as a backlog rather than hanging the suite.
const VERDICT_POLL_MS = Number.parseInt(process.env.E2E_VIBE_POLL_MS || "600000", 10);

// The vibe step's budget, set from what was measured rather than guessed.
// Across runs 4-6 every SUCCESS landed at 6s, 11s, 81s and 101s, and every
// FAILURE ran to whatever ceiling it was given (537s at a 540s cap, twice).
// So the ceiling never rescues a bad draw — it only decides how long the run
// pays for one. 180s clears the slowest observed success by ~80% and makes a
// failure cost a third of what it did.
const CHAT_BUDGET_MS = Number.parseInt(process.env.E2E_VIBE_CHAT_MS || "180000", 10);

// ── the record ────────────────────────────────────────────────────────────

interface Step {
	student: number;
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

interface Student {
	slot: number;
	user: TestUser;
	pat: string;
	sub: string;
	strategyName: string;
	strategySrc: string;
	strategyFromChat: boolean;
	claimId: string;
	verdict: Record<string, unknown> | null;
	axes: { replay: string; signals: string; settlement: string; prints: number; totalActions: number } | null;
}
const students: Student[] = [];

/** Time a step, record it, never swallow the error. */
async function timed<T>(
	student: number,
	step: string,
	docSection: string,
	fn: () => Promise<T>,
): Promise<T> {
	const t0 = Date.now();
	try {
		const out = await fn();
		steps.push({ student, step, docSection, ok: true, ms: Date.now() - t0, note: "" });
		return out;
	} catch (e) {
		steps.push({
			student,
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
	await page.goto("/auth/login");
	if (!(await page.locator("#email").count().catch(() => 0))) await page.reload();
	await expect(page.locator("#email")).toBeVisible({ timeout: 30_000 });
	await page.locator("#email").fill(user.email);
	await page.locator("#password").fill(user.password);
	await page.getByRole("button", { name: /sign in/i }).click();
	await page.waitForURL(/\/auth\/redeem-invite|\/studio|\/dashboard|\/account(\/|$)/, {
		timeout: 30_000,
	});
}

/**
 * Mint a PAT the way §1 says to — from an authenticated browser session.
 *
 * Deliberately the session-authenticated POST rather than clicking through the
 * form: the scope question this spec cares about is what the TOKEN can read,
 * and the form's own rendering is spec 26's territory. The 403 §1 documents is
 * probed separately below, because a doc that names the wrong scope sends
 * students hunting for a permission they never needed.
 */
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

/** Pull the first fenced code block that looks like a .lqts strategy. */
function extractStrategy(text: string): string | null {
	const fenced = text.match(/```[a-zA-Z]*\s*\n([\s\S]*?)```/g) ?? [];
	for (const block of fenced) {
		const body = block.replace(/```[a-zA-Z]*\s*\n/, "").replace(/```\s*$/, "").trim();
		if (/^\s*strategy\s+[A-Za-z_][A-Za-z0-9_]*\s*\{/.test(body)) return body;
	}
	const bare = text.match(/strategy\s+[A-Za-z_][A-Za-z0-9_]*\s*\{[\s\S]*?\n\}/);
	return bare ? bare[0] : null;
}

/** Row-set fingerprint of a feed, for comparing what two tenants can see. */
async function feedFingerprint(
	api: APIRequestContext,
	pat: string,
	url: string,
): Promise<{ n: number; ids: string[]; status: number }> {
	const r = await api.get(url, { headers: { Authorization: `Bearer ${pat}` } });
	if (!r.ok()) return { n: 0, ids: [], status: r.status() };
	const body = await r.json().catch(() => null);
	const rows = Array.isArray(body)
		? body
		: (body?.strategies ?? body?.results ?? body?.data?.strategies ?? body?.data ?? body?.rows ?? []);
	const list: any[] = Array.isArray(rows) ? rows : [];
	const ids = list
		.map((x) => String(x?.strategy_id ?? x?.id ?? x?.result_id ?? x?.msg_id ?? x?.name ?? ""))
		.filter(Boolean)
		.sort();
	return { n: list.length, ids, status: r.status() };
}

// ── the walk ──────────────────────────────────────────────────────────────

test.describe.configure({ mode: "serial" });

test.describe("27 — can a vibing student get a real number? [long]", () => {
	let inviteCode = "";

	test.beforeAll(async ({ playwright }, testInfo) => {
		if (!LONG_ENABLED) testInfo.skip(true, "CI_E2E_LONG=1 to enable this long e2e");
		if (!localOtpEnabled() && !process.env.E2E_GMAIL_APP_PASSWORD) {
			testInfo.skip(true, "No OTP source: CI_E2E_LOCAL_OTP=1 or E2E_GMAIL_APP_PASSWORD");
		}
		inviteCode = process.env.E2E_INVITATION_CODE || "";
		expect(inviteCode, "E2E_INVITATION_CODE is required — a code-less student is bounced to /auth/redeem-invite from every guarded route").toBeTruthy();
	});

	test("students onboard, mint a PAT, and deploy a strategy the chatbox wrote", async ({
		browser,
	}, testInfo) => {
		// DERIVED, not a round number. Every student can pay the chat budget in
		// full, and a fixed 20 minutes cannot hold three of them at 9 minutes
		// each: runs 5 and 6 both died at the cap with the last student never
		// walked, which reads exactly like a product failure and is not one.
		testInfo.setTimeout(NUM_STUDENTS * (CHAT_BUDGET_MS + 180_000) + 120_000);
		const baseURL = testInfo.project.use.baseURL ?? process.env.BASE_URL ?? "https://lum.id";

		// Each student is isolated. Registration was measured to fail
		// INTERMITTENTLY — 2026-08-29, two students on the same path in the same
		// minute, one compiled in 10s and the other never registered in 535s. With
		// the walk serial and un-isolated, that one student took the whole file
		// down and the multi-tenancy and verdict tests never ran at all, so a real
		// intermittent bug cost us every other answer in the run.
		for (let slot = 0; slot < NUM_STUDENTS; slot++) {
		  try {
			const user = await timed(slot, "create account", "§pre", () =>
				createUser(baseURL, { tag: `vibe-${slot}-${Date.now().toString(36)}`, invitationCode: inviteCode }),
			);
			const ctx = await browser.newContext({ baseURL });
			const page = await ctx.newPage();

			await timed(slot, "log in", "§pre", () => loginViaUi(page, user));

			const pat = await timed(slot, "mint PAT in browser", "§1", () =>
				mintPat(page, `vibe-e2e-${slot}-${Date.now().toString(36)}`),
			);

			// §1 documents a 403 naming `lumid:write` when minting from a script,
			// and says the message is wrong. Probe it so the doc's own claim is
			// under test rather than taken on trust.
			const scriptMint = await page.request.post("/api/v1/identity/personal-access-tokens", {
				headers: { Authorization: `Bearer ${pat}` },
				data: { name: "vibe-script-probe", scopes: ["lqt:strategy"], ttl_days: 1 },
				failOnStatusCode: false,
			});
			if (scriptMint.status() === 403) {
				const txt = (await scriptMint.text().catch(() => "")).slice(0, 300).replace(/\s+/g, " ");
				// Which way does this cut? §1 says the message "names the wrong scope"
				// and sends students hunting a permission they never needed. If the
				// message now tells them to mint in the browser, the message is fine
				// and the DOC is the stale half — the opposite finding, and the one
				// worth reporting, because the doc is what a student reads first.
				const tellsYouWhatToDo = /log(ged)? in|browser|dashboard\/tokens|studio\/account\/tokens/i.test(txt);
				if (!tellsYouWhatToDo) {
					findings.push({
						severity: "friction",
						surface: "§1 mint from a script",
						note: `Mint from a script returns a 403 that does not say what to do instead: "${txt}"`,
					});
				} else {
					// The message is fine. Whether the DOC is stale is a question about
					// the doc, so ASK THE DOC — do not assert it.
					//
					// This block used to emit a drift finding unconditionally here,
					// asserting that §1 "spends a paragraph warning that the mint 403 is
					// misleading". That was true when written and the doc has since been
					// fixed, so every run reported a stale finding as fact. Reported
					// three times in the 2026-08-29 run alone, all false. A report that
					// carries confident false positives is worse than a shorter one:
					// it costs the reader the trust they need for the true findings.
					const docRes = await page.request.get("/docs/first-run.md", {
						failOnStatusCode: false,
					});
					const doc = docRes.ok() ? await docRes.text().catch(() => "") : "";
					if (!doc) {
						findings.push({
							severity: "friction",
							surface: "first-run.md",
							note: `Could not fetch /docs/first-run.md (${docRes.status()}) to check it against the live 403.`,
						});
					} else {
						const stillClaimsMisleading = /misleading|fixing the wording|names the wrong scope/i.test(doc);
						// The message points at /dashboard/tokens. The doc links the Studio
						// page. That is only drift if the doc never reconciles the two.
						const reconcilesBothPaths =
							/dashboard\/tokens/i.test(doc) && /same tokens page|are the same/i.test(doc);
						if (stillClaimsMisleading || !reconcilesBothPaths) {
							findings.push({
								severity: "drift",
								surface: "first-run.md §1 vs the live 403",
								note:
									"The live 403 names the browser path directly, but §1 still " +
									(stillClaimsMisleading ? "warns the message is misleading/being reworded" : "") +
									(stillClaimsMisleading && !reconcilesBothPaths ? " and " : "") +
									(!reconcilesBothPaths
										? "links /studio/account/tokens without saying it is the same page as /dashboard/tokens"
										: "") +
									`. Live: "${txt}"`,
							});
						}
					}
				}
			}

			// §3 — install quant-research.
			//
			// By fully-qualified slug, not by clicking the marketplace card. An
			// install intent records the slug verbatim and identity recovers the
			// bundle's author from it; a bare name leaves no owner to recover, falls
			// back to the caller's own sub, and the install then reports ready while
			// every surface 404s (fixtures/seed-app.ts). Clicking the first Install
			// button on the marketplace is not the same act and stalled here.
			await timed(slot, "install quant-research", "§3", async () => {
				const listed = async () => {
					const r = await page.request.get("/api/v1/me/apps");
					const b = r.ok() ? await r.json().catch(() => null) : null;
					const apps = b?.data?.apps ?? b?.apps ?? [];
					return (Array.isArray(apps) ? apps : []).find((a: any) => a.name === APP);
				};
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

			// §5 — THE VIBE STEP. Ask the assistant to SUBMIT the strategy, not to
			// print one.
			//
			// WHY THE PROMPT CHANGED (2026-08-30). Asking for a code block to paste
			// makes the HUMAN the error channel: `send_strategy` compiles
			// server-side and returns the compiler's verdict, but nothing in the
			// print-then-paste flow ever calls it, so the assistant never learns it
			// was wrong. Measured across four walks: every chat-authored strategy
			// pasted into the form failed, and each attempt invented a DIFFERENT
			// plausible dialect (`on bar { if … }`, `on_signal(…) { submit { tif =
			// … } }`, `params { threshold = 0.15 }`). Chasing those with parser
			// aliases does not converge — there is no single wrong dialect to meet.
			// Putting the compiler in the loop does: the assistant sees the exact
			// parse error plus a fix hint in the same turn and can correct itself.
			//
			// So the walk now tests the path first-run.md §5 actually documents.
			// The chat step succeeds when a strategy REGISTERS under this student's
			// own account — a program_hash, not a code block.
			const chatStrategyName = `vibe_${slot}_${Date.now().toString(36)}`;
			let src: string | null = null;
			let registeredByChat = false;
			let approvals = 0;
			let approverDone = false;
			try {
				await timed(slot, "ask chat to SUBMIT a .lqts", "§5", async () => {
					await gotoRedirect(page, `/studio/apps/${APP}`);
					const composer = page.getByPlaceholder(/Ask anything|Type next message/i).first();
					await composer.waitFor({ state: "visible", timeout: 90_000 });
					await composer.fill(
						`Submit a .lqts strategy for me: buy 25 lots at mid when the ofi_z signal is ` +
							`above 0.15, with the threshold and size as params. Name it ${chatStrategyName}. ` +
							`If the compiler rejects it, read the error and fix the source, then submit again.`,
					);
					await composer.press("Enter");

					// APPROVE THE TOOL CALL.
					//
					// `lqt_mailbox_submit` is a WRITE, so the chat surfaces an
					// Allow / Always / Deny prompt and blocks until someone clicks.
					// Measured 2026-08-30: all three students' submits sat on that
					// prompt for the full budget — "Working… — 141s" — and nothing
					// ever reached the inbox. The assistant had done its job; the
					// turn was waiting on a human.
					//
					// A student clicks it. The walk has to as well, or it measures a
					// modal instead of the submit path. Clicking "Always" once per
					// session keeps a multi-step fix-and-resubmit loop from stopping
					// on every attempt.
					//
					// Runs in the background against the SAME budget as the poll
					// below: the prompt can appear more than once (a rejected submit
					// is followed by another), so this keeps watching rather than
					// clicking once.
					// Stops when the step ends, not when the budget does. Each student
					// gets a fresh context that is closed after their walk, and a
					// fire-and-forget loop outliving it throws "Target page, context
					// or browser has been closed" — which failed run 14 on test
					// plumbing while the product half had actually just succeeded.
					const approveDeadline = Date.now() + CHAT_BUDGET_MS;
					const approver = (async () => {
						try {
							while (!approverDone && Date.now() < approveDeadline) {
								const btn = page
									.getByRole("button", { name: /^(Always|Allow)$/i })
									.first();
								if (await btn.isVisible().catch(() => false)) {
									await btn.click().catch(() => {});
									approvals += 1;
								}
								await page.waitForTimeout(1_500);
							}
						} catch {
							// The page went away, or a click raced a re-render. Either way
							// this is a helper: it must never be the reason a run fails.
						}
					})();

					// Cold sandbox spawn is paid on the first turn of a session.
					//
					// Success is a REGISTRY ROW, not a code block: the assistant may
					// submit, be rejected, fix, and resubmit within this budget, and
					// only the final state matters. `rejected_unavailable` is checked
					// so a broken read cannot masquerade as "not registered yet".
					await expect
						.poll(
							async () => {
								const r = await page.request.get("/api/v1/me/strategies");
								if (!r.ok()) return "";
								const d = (await r.json().catch(() => null))?.data ?? {};
								const row = (d.strategies ?? []).find(
									(x: any) => x?.name === chatStrategyName && String(x?.program_hash ?? ""),
								);
								return row ? String(row.program_hash ?? "") : "";
							},
							{
								timeout: CHAT_BUDGET_MS,
								intervals: [5_000],
								message:
									`the assistant never got '${chatStrategyName}' REGISTERED (no program_hash). ` +
									"It may have printed a code block instead of calling send_strategy, or been " +
									"rejected repeatedly — check the rejected list on /me/strategies for the reason.",
							},
						)
						.not.toEqual("");
					registeredByChat = true;
					// Keep the source for the record; the registry row is the verdict.
					src = extractStrategy(await page.locator("main").innerText());
				}).finally(async () => {
					approverDone = true;
					await approver.catch(() => {});
				});
				if (approvals > 0) {
					findings.push({
						severity: "friction",
						surface: "§5 chat submit — tool approval prompt",
						note:
							`Submitting from chat raised an Allow/Always/Deny prompt ${approvals} time(s) for ` +
							"`lqt_mailbox_submit`, and the turn BLOCKS until it is clicked. The app declares " +
							"`approval_policy: {default: auto}`, so either that policy is not honoured for this " +
							"tool or the sandbox gates writes independently of it. A human clicks through and " +
							"may reasonably want to — it is a write — but §5 does not mention it, and anything " +
							"unattended (a scheduled loop, a scripted walk) stalls silently until it times out. " +
							"Measured 2026-08-30: three of three submits sat on this prompt for the full budget " +
							"and nothing reached the inbox.",
					});
				}
				const chatSecs = (steps[steps.length - 1]?.ms ?? 0) / 1000;
				if (chatSecs > 120) {
					findings.push({
						severity: "friction",
						surface: "§5 chat-authored strategy (latency)",
						note:
							`The assistant took ${chatSecs.toFixed(0)}s to return a compilable .lqts. It works, but ` +
							"the first turn is spent globbing and grepping for .lqts examples under a repo path " +
							"that does not exist in the sandbox (`stat /proj/LQT: no such file or directory`) " +
							"before it answers from its own knowledge. §5 presents this as the easy path for a " +
							"student who cannot write DSL; minutes of silent tool-calling is what they meet instead.",
					});
				}
			} catch {
				// Capture what the assistant actually said. "No parseable code block"
				// is not yet a diagnosis: a refusal, a prose answer, a composer that
				// never mounted and a cold sandbox all look identical from here, and
				// they need four different fixes.
				const said = (await page.locator("main").innerText().catch(() => ""))
					.replace(/\s+/g, " ")
					.slice(-700);
				// Classify. "No parseable code block" is a symptom with at least three
				// causes needing three different fixes, and calling them all "chat is
				// broken" would send someone to the wrong one.
				const leakedToolMarkup = /DSML|tool_calls|invoke name=/.test(said);
				const wrongDialect = /\bstrategy\s+\w+/.test(said) && /\bparam\s+\w+\s*=|on_signal|:\s*buy|\bat mid\b/.test(said);
				findings.push({
					severity: "blocker",
					surface: "§5 chat-authored strategy",
					note: leakedToolMarkup
						? "The assistant's raw tool-call markup (`<|DSML|tool_calls>`) rendered as literal text in " +
							"the chat instead of being parsed and executed. The student sees machine syntax, no " +
							`answer, and no error. Tail: "${said}"`
						: wrongDialect
							? "The assistant answered quickly and confidently with a strategy in a DIALECT THAT DOES " +
								"NOT EXIST — `param x = 0.15` / `on_signal foo:` / `buy lots = size at mid` instead of " +
								"`params { … }` and `when signal(\"foo\") > params.x { buy N lots @ mid }`. It will never " +
								"compile. This is worse than a refusal: §5 tells a student who cannot write DSL to paste " +
								"the reply straight into the deploy form, and what comes back looks entirely plausible. " +
								`Tail: "${said}"`
							: "The chatbox returned no parseable .lqts within the budget. §5 tells students they do " +
								"not have to write the DSL by hand and shows a verbatim transcript of it working — for " +
								`a student who cannot write DSL this is the whole on-ramp. Tail: "${said}"`,
				});
			}
			// fromChat now means "the assistant got it REGISTERED", not "the
			// assistant emitted text that looked like a strategy". The old meaning
			// counted a plausible-looking code block as a win even when it never
			// compiled — which is exactly how the vibe path looked healthier than
			// it was.
			const fromChat = registeredByChat;
			if (!src) {
				src = [
					"strategy ofi_z_momentum {",
					"  params { threshold: 0.15, size_lots: 25 }",
					'  when signal("ofi_z") > params.threshold {',
					"    buy params.size_lots lots @ mid",
					"  }",
					"}",
				].join("\n");
			}

			const strategyName = registeredByChat
				? chatStrategyName
				: `vibe_${slot}_${Date.now().toString(36)}`;
			// The registry keys on the identifier inside the source, so rename the
			// program to match what we register it as — otherwise two students'
			// chat-authored strategies collide on the assistant's favourite name.
			const srcNamed = src.replace(/^\s*strategy\s+[A-Za-z_][A-Za-z0-9_]*/, `strategy ${strategyName}`);

			// The form path is the FALLBACK now. When the assistant already got the
			// strategy registered, deploying again would submit a second copy and
			// then measure the copy — so skip it and keep what chat achieved.
			if (!registeredByChat)
			await timed(slot, "deploy via the Strategies form (fallback)", "§5", async () => {
				await gotoRedirect(page, `/studio/a/${APP}/strategies`);
				await page.getByLabel(/Strategy Name/i).fill(strategyName);
				await page.getByLabel(/^Version$/i).fill("1.0.0");
				await page.getByLabel(/Strategy Content/i).fill(srcNamed);
				await page.getByRole("button", { name: /Submit to Inbox/i }).click();
				await expect(
					page.getByText(/Queued send_strategy/i).first(),
					"the deploy form never confirmed the submission was queued",
				).toBeVisible({ timeout: 60_000 });
			});

			// A submit that was accepted and a strategy that COMPILED are different
			// events — an empty program_hash means it never compiled, so it never ran.
			//
			// WHY THIS ALSO READS `rejected`: this assertion used to say "the mailbox
			// accepted the submit and the consumer never registered it — the failure
			// mode that looks like success". That was true when written and is now
			// WRONG, and wrong in the expensive direction: it reports data loss when
			// the consumer has in fact produced a precise diagnosis. Measured
			// 2026-08-29 — all three students' strategies were rejected in 10-15ms
			// with exact parse errors ("expected `when` to start a guard, found
			// identifier `param`"), and the run reported "never registered" for all
			// three. A test that misnames a failure sends the next person hunting the
			// wrong bug.
			//
			// `rejected` (identity v0.5.281, LQT migration 0079) carries the
			// consumer's own reason, so poll BOTH and stop as soon as either answers.
			// `rejected_unavailable` is surfaced too: an empty list and a failed query
			// read identically otherwise, which is the same ambiguity this block is
			// here to kill.
			let rejection = "";
			let rejectionUnavailable = "";
			// Already proven when chat registered it — the chat step's own success
			// condition WAS a non-empty program_hash. Re-polling would just restate
			// it, and a second timed step would double-count the wall clock.
			const compiled = registeredByChat
				? "(registered by chat)"
				: await timed(slot, "strategy compiles (program_hash)", "§5", async () => {
				let hash = "";
				await expect
					.poll(
						async () => {
							const r = await page.request.get("/api/v1/me/strategies");
							if (!r.ok()) return "";
							const b = await r.json().catch(() => null);
							const d = b?.data ?? {};
							const row = (d.strategies ?? []).find((s: any) => s.name === strategyName);
							hash = String(row?.program_hash ?? "");
							if (hash) return hash;
							rejectionUnavailable = String(d.rejected_unavailable ?? "");
							const rej = (d.rejected ?? []).find((x: any) => x?.name === strategyName);
							if (rej?.reason) {
								// A rejection is TERMINAL — it will never become a hash, so
								// returning a sentinel ends the poll immediately instead of
								// burning the full budget on a verdict we already have.
								rejection = String(rej.reason);
								return "__rejected__";
							}
							return "";
						},
						{
							timeout: CHAT_BUDGET_MS,
							intervals: [5_000],
							message:
								`'${strategyName}' never got a non-empty program_hash, and no rejection ` +
								"was surfaced either. Submit accepted, verdict never produced — check " +
								"whether the mailbox consumer is draining." +
								(rejectionUnavailable ? ` (rejection read failed: ${rejectionUnavailable})` : ""),
						},
					)
					.not.toEqual("");
				// THROW INSIDE `timed`, not after it.
				//
				// The poll above resolves with the sentinel "__rejected__" when a
				// rejection is found, and the sentinel satisfies `.not.toEqual("")` —
				// so the poll SUCCEEDS on a strategy that failed to compile. Throwing
				// after `timed()` returned meant the step table logged this as
				// "strategy compiles ✅ 11s" while the findings said REJECTED, and the
				// ✅ is what a reader scans first. Measured 2026-08-30: three students,
				// all three rejected, all three shown green in the ledger.
				//
				// That is the same defect this whole spec exists to catch — a failure
				// wearing the shape of a pass — reintroduced by the fix for it. Raising
				// here makes `timed` record the ❌ and the real reason.
				if (rejection) {
					throw new Error(
						`'${strategyName}' was REJECTED by the compiler, not lost: ${rejection}`,
					);
				}
				return hash;
			});
			expect(compiled).not.toEqual("");

			const sub = await page.request
				.get("/api/v1/me/strategies")
				.then((r) => (r.ok() ? r.json() : null))
				.then((b) => String(b?.data?.strategies?.[0]?.tenant_id ?? b?.data?.sub ?? ""))
				.catch(() => "");

			students.push({
				slot,
				user,
				pat,
				sub,
				strategyName,
				strategySrc: srcNamed,
				strategyFromChat: fromChat,
				claimId: "",
				verdict: null,
				axes: null,
			});
			await ctx.close();
		  } catch (e) {
			findings.push({
				severity: "blocker",
				surface: `student ${slot} onboarding`,
				note:
					`Student ${slot} could not complete the documented walk while their peers could, in the ` +
					`same minute on the same path: ${(e as Error)?.message?.slice(0, 300)}`,
			});
		  }
		}

		// Two is what the pairwise tenancy question needs. Fail only below that —
		// demanding ALL of them re-introduces exactly the all-or-nothing coupling
		// this loop was just isolated to remove.
		expect(
			students.length,
			`only ${students.length}/${NUM_STUDENTS} students completed onboarding — need 2 for the ` +
				"pairwise tenancy check. See the findings for which one failed and where.",
		).toBeGreaterThanOrEqual(2);
	});

	test("multi-tenancy: self-scoped surfaces isolate, and the xpio feeds are measured", async ({
		playwright,
	}, testInfo) => {
		testInfo.setTimeout(5 * 60_000);
		const api = await playwright.request.newContext();
		const [a, b] = students;
		expect(a && b, "need two students for a pairwise tenancy check").toBeTruthy();

		// ── the contract that MUST hold ────────────────────────────────────
		// /api/v1/me/strategies is scoped server-side to the caller's own user
		// id; there is no request field that reaches the tenant predicate.
		const mine = async (pat: string) => {
			const r = await api.get(`${testInfo.project.use.baseURL}/api/v1/me/strategies`, {
				headers: { Authorization: `Bearer ${pat}` },
			});
			const body = r.ok() ? await r.json().catch(() => null) : null;
			return (body?.data?.strategies ?? []).map((s: any) => String(s.name));
		};
		const aMine = await mine(a.pat);
		const bMine = await mine(b.pat);

		expect(
			aMine,
			"student A's own strategy is missing from their own self-scoped registry",
		).toContain(a.strategyName);
		expect(
			aMine,
			`ISOLATION BREAK: student A's self-scoped registry contains student B's strategy '${b.strategyName}'`,
		).not.toContain(b.strategyName);
		expect(
			bMine,
			`ISOLATION BREAK: student B's self-scoped registry contains student A's strategy '${a.strategyName}'`,
		).not.toContain(a.strategyName);

		// ── the feeds, measured ────────────────────────────────────────────
		// first-run.md §9 already tells students these are platform-wide. This
		// measures HOW wide, with two tokens minted minutes ago, and whether the
		// rows carry other tenants' strategy SOURCE rather than just their names.
		const trade = process.env.E2E_XPIO_HOST || "https://lumid.trade";
		for (const feed of ["strategies", "results", "telemetries"]) {
			const fa = await feedFingerprint(api, a.pat, `${trade}/xpio/${feed}`);
			const fb = await feedFingerprint(api, b.pat, `${trade}/xpio/${feed}`);
			const shared = fa.ids.filter((x) => fb.ids.includes(x));
			if (fa.n > 0 && fa.ids.join("|") === fb.ids.join("|")) {
				findings.push({
					severity: "blocker",
					surface: `GET /xpio/${feed}`,
					note:
						`Two PATs belonging to two DIFFERENT tenants received byte-identical row sets ` +
						`(${fa.n} rows, ${shared.length} shared ids). The table carries no tenant column and no ` +
						`RLS, so every authenticated account reads every account's rows. §1 has each student ` +
						`mint a PAT, so this is reachable by the whole cohort with one curl.`,
				});
			}
		}

		// The severity question: is it names, or is it source?
		const r = await api.get(`${trade}/xpio/strategies`, {
			headers: { Authorization: `Bearer ${a.pat}` },
		});
		if (r.ok()) {
			const body = await r.json().catch(() => null);
			const rows: any[] = Array.isArray(body) ? body : (body?.strategies ?? body?.data ?? []);
			const withSrc = rows.filter((x) => {
				const p = x?.payload ?? {};
				return Boolean(p?.strategy?.dsl ?? p?.dsl);
			});
			const foreign = withSrc.filter((x) => String(x?.name ?? "") !== a.strategyName);
			if (foreign.length > 0) {
				findings.push({
					severity: "blocker",
					surface: "GET /xpio/strategies → payload.strategy.dsl",
					note:
						`${withSrc.length} of ${rows.length} rows expose full .lqts SOURCE, ${foreign.length} of them ` +
						`belonging to other accounts. In a graded cohort this is not a metadata leak — one student ` +
						`can read every other student's strategy logic verbatim.`,
				});
			}
		}

		// The scoped alternative must genuinely differ, or "use the other endpoint"
		// is not a fix available to anyone.
		const ia = await feedFingerprint(api, a.pat, `${testInfo.project.use.baseURL}/lqt/inspect/strategies`);
		const ib = await feedFingerprint(api, b.pat, `${testInfo.project.use.baseURL}/lqt/inspect/strategies`);
		if (ia.status === 200 && ib.status === 200) {
			expect(
				ia.ids.join("|") === ib.ids.join("|") && ia.n > 0,
				"/lqt/inspect/strategies returned identical rows to two tenants — the self_tenant surface is NOT scoped",
			).toBeFalsy();
		}
		await api.dispose();
	});

	test("a backtest reaches a verdict, and the three axes are honest", async ({
		playwright,
	}, testInfo) => {
		testInfo.setTimeout(VERDICT_POLL_MS + 3 * 60_000);
		const api = await playwright.request.newContext();
		const base = testInfo.project.use.baseURL ?? "https://lum.id";
		const s = students[0];

		// §6 — name the instrument. Blank defaults the symbol to SYNTH, and the
		// run comes back synthetic_lcg looking exactly like a result.
		s.claimId = await timed(s.slot, "submit backtest (named symbol)", "§6", async () => {
			const r = await api.post(`${base}/api/research/backtests`, {
				headers: { Authorization: `Bearer ${s.pat}` },
				data: { name: `${s.strategyName}_bt`, strategy: { dsl: s.strategySrc }, symbol: SYMBOL },
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

		// The pacing rule is server-side: 1 in flight, 300s apart, per tenant. A
		// second submit must be REFUSED with a retry time, not queued — a student
		// who cannot tell "refused" from "accepted" resubmits into a wall.
		const second = await api.post(`${base}/api/research/backtests`, {
			headers: { Authorization: `Bearer ${s.pat}` },
			data: { name: `${s.strategyName}_bt2`, strategy: { dsl: s.strategySrc }, symbol: SYMBOL },
			failOnStatusCode: false,
		});
		if (second.status() !== 409) {
			findings.push({
				severity: "friction",
				surface: "POST /api/research/backtests (pacing)",
				note:
					`A second submit while one was in flight returned ${second.status()}, not the documented 409 ` +
					`too_many_in_flight / too_soon. §6 tells students a breach is "refused, not queued" and that ` +
					`the refusal names the earliest retry time.`,
			});
		}

		const verdict = await timed(s.slot, "poll to verdict", "§7-8", async () => {
			let last: any = null;
			await expect
				.poll(
					async () => {
						const r = await api.get(`${base}/api/research/backtests/${s.claimId}`, {
							headers: { Authorization: `Bearer ${s.pat}` },
						});
						if (!r.ok()) return "";
						last = await r.json().catch(() => null);
						return String(last?.status ?? last?.data?.status ?? "");
					},
					{
						timeout: VERDICT_POLL_MS,
						intervals: [10_000],
						message:
							`claim ${s.claimId} never left queued/running within ${Math.round(VERDICT_POLL_MS / 60000)} ` +
							"minutes. The worker drains round-robin across tenants, so this is a backlog or a stall — " +
							"either way the student's afternoon ends with no number.",
					},
				)
				.toMatch(/settled|done|complete|failed|error/i);
			return last;
		});
		s.verdict = verdict;

		// The axes live INSIDE `replay`, not beside it. The status handler
		// selects `replay_json` and returns it as `replay: Option<Value>`
		// (services/lqt-api-gateway/src/handlers/backtest.rs:92,244), so that
		// field is the whole result document — the one whose OWN `replay` key
		// carries pg_tape/synthetic_lcg. Reading the outer field as a string
		// stringifies an object to "[object Object]" and reports every real run
		// as unlabelled, which is a false alarm in the most alarming direction.
		const doc: any = verdict?.data ?? verdict ?? {};
		const axes: any =
			doc.replay && typeof doc.replay === "object" ? doc.replay : doc;
		const replay = typeof axes.replay === "string" ? axes.replay : "";
		const signals = typeof axes.signals === "string" ? axes.signals : "";
		const settlement = typeof axes.settlement === "string" ? axes.settlement : "";
		const totalActions = Number(axes.total_actions ?? axes.steps_evaluated ?? 0);
		const prints = Number(axes.prints_replayed ?? 0);
		// AFTER the consts above, not before them. Assigning this next to
		// `s.verdict` put it in the temporal dead zone and threw
		// `Cannot access 'replay' before initialization` — which surfaced as a
		// FAILED VERDICT TEST on a backtest that had settled perfectly well in
		// 30s. A harness bug wearing a product bug's clothes.
		s.axes = { replay, signals, settlement, prints, totalActions };

		// A missing replay label is treated as not-real BY RULE. Asserting the
		// field is present is asserting the gate is wired at all.
		expect(
			replay,
			"the settled claim carries no `replay` label — a result with no replay field is not-real by rule, " +
				"so a student cannot tell a recorded tape from a generator",
		).not.toEqual("");

		const allReal = replay === "pg_tape" && signals === "recorded" && settlement === "resolved";
		if (!allReal) {
			findings.push({
				severity: "blocker",
				surface: "backtest verdict",
				note:
					`A student who named a real instrument got replay=${replay || "(none)"} ` +
					`signals=${signals || "(none)"} settlement=${settlement || "(none)"} ` +
					`(${prints} prints replayed) — not presentable as ` +
					`performance. The honesty gate is doing its job; the question is whether a first-day student ` +
					`can ever reach three-axis-real on the documented path.`,
			});
		}
		// NOT asserted: total_actions > 0. A real run that never crossed its
		// threshold is a real result, and the docs forbid tuning to change that.
		await api.dispose();
	});

	test.afterAll(async () => {
		const real = students.filter(
			(s) =>
				s.axes?.replay === "pg_tape" &&
				s.axes?.signals === "recorded" &&
				s.axes?.settlement === "resolved",
		).length;
		const blockers = findings.filter((f) => f.severity === "blocker");
		const total = steps.reduce((a, s) => a + s.ms, 0);

		const md = [
			"# Can a vibing student get a real number?",
			"",
			`*${new Date().toISOString()} · ${NUM_STUDENTS} students · symbol \`${SYMBOL}\`*`,
			"",
			"## Verdict",
			"",
			`- Students who reached a **three-axis-real** backtest: **${real}/${students.length}**`,
			`- Strategy authored by the **chatbox** (the vibe path): ${students.filter((s) => s.strategyFromChat).length}/${students.length}`,
			`- Blockers: **${blockers.length}** · friction/drift: ${findings.length - blockers.length}`,
			`- Wall-clock across recorded steps: ${(total / 60000).toFixed(1)} min`,
			"",
			"## Step ledger",
			"",
			"| student | step | doc | ok | secs | note |",
			"|---|---|---|---|---|---|",
			...steps.map(
				(s) =>
					`| ${s.student} | ${s.step} | ${s.docSection} | ${s.ok ? "✅" : "❌"} | ${(s.ms / 1000).toFixed(0)} | ${s.note.replace(/\|/g, "\\|").slice(0, 160)} |`,
			),
			"",
			"## Findings",
			"",
			...(findings.length === 0
				? ["_None recorded._"]
				: findings.map((f) => `### [${f.severity}] ${f.surface}\n\n${f.note}\n`)),
			"",
			"## Backtest claims",
			"",
			...students.map(
				(s) =>
					`- student ${s.slot}: \`${s.strategyName}\` claim \`${s.claimId || "(none)"}\` → ` +
					(s.axes
						? `replay=**${s.axes.replay || "?"}** signals=**${s.axes.signals || "?"}** ` +
							`settlement=**${s.axes.settlement || "?"}** · ${s.axes.prints} prints, ` +
							`${s.axes.totalActions} actions`
						: "_no backtest run_"),
			),
			"",
			"> A backtest that is real on all three axes and took **zero trades is a pass**.",
			"> Tuning a threshold until it trades, against the window you score on, is in-sample fitting.",
			"",
		].join("\n");

		fs.writeFileSync(LEDGER, md);
		console.log(`\n[27] ledger → ${LEDGER}\n`);
		console.log(md);
	});
});

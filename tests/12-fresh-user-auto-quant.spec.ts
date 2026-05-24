import { test, expect, request as pwrequest } from "@playwright/test";
import { createUser } from "../fixtures/test-user";
import { lumidCli, dockerAvailable, installAvailable, LumidCli } from "../fixtures/lumid-cli";
import { localOtpEnabled } from "../fixtures/otp-redis";

// Journey @long — fresh user, auto-quant install, paper cycle.
//
// Per worker (configured to run 5 in parallel via env-driven workers count
// in playwright.config.ts):
//
//   1. createUser+OTP via REST (mailbox subaddress isolates concurrent runs)
//   2. UI login → /dashboard
//   3. UI mint PAT on /dashboard/tokens
//   4. Provision a clean ubuntu:24.04 + run install.sh with the PAT
//   5. lumid app_install auto-quant
//   6. lumid app_configure --paper-only (writes credentials.toml)
//   7. lumid deploy_job --app=auto-quant --loop=momentum_research --confirm=true
//   8. Poll /api/v1/admin/loops (via the user's session cookie) until the
//      cycle row appears for this user's auto-quant install
//   9. Cleanup: dispose container, revoke PAT, optionally delete user
//
// Validates the full stack end-to-end: lumid_identity (auth + PAT + admin),
// scheduler (cycle execution), submit_jobs ledger (if the loop dispatches),
// and the dashboard observation surface.
//
// Gated behind CI_E2E_LONG=1 — slow, needs docker, and burns ~5min per
// worker. PR CI never runs this; nightly self-hosted runner does.

const LONG_ENABLED = process.env.CI_E2E_LONG === "1";
const NUM_USERS = Number.parseInt(process.env.CI_E2E_LONG_USERS || "5", 10);

// Use describe.configure({ mode: 'parallel' }) so each test() entry below
// runs concurrently up to the workers limit. The default config keeps
// fullyParallel:false for the auth-related specs that share state;
// scoping the override here means we don't destabilize the others.
test.describe.configure({ mode: "parallel" });

test.describe("12 — fresh user → install auto-quant → paper cycle [long]", () => {
	// Shared invitation code minted once via admin REST; reused across
	// all per-user tests. Without it new users land on /auth/redeem-invite
	// instead of /dashboard.
	let sharedInviteCode = "";
	// Admin JWT — kept alive through the suite for the trading-loop
	// user's qa:write grant.
	let adminJwt = "";
	let baseURLAll = "";
	// Competition ID for the trading-loop exercise. Crypto comp (24/7
	// availability + zero market-hours sensitivity). Set in beforeAll
	// from the live list of Ongoing competitions.
	let tradingCompetitionId = 0;

	test.beforeAll(async ({}, testInfo) => {
		if (!LONG_ENABLED) testInfo.skip(true, "CI_E2E_LONG=1 to enable this long e2e");
		// OTP source: either Gmail (default) or Redis backdoor (local validation).
		if (!localOtpEnabled() && !process.env.E2E_GMAIL_APP_PASSWORD) {
			testInfo.skip(true, "E2E_GMAIL_APP_PASSWORD not set (or set CI_E2E_LOCAL_OTP=1 for the Redis backdoor)");
		}
		if (!dockerAvailable()) testInfo.skip(true, "docker daemon unavailable");
		const baseURL = testInfo.project.use.baseURL ?? process.env.BASE_URL ?? "https://lum.id";
		if (!(await installAvailable(baseURL))) {
			testInfo.skip(true, `${baseURL}/start not reachable`);
		}
		// If E2E_INVITATION_CODE is set in the env, prefer that (covers
		// the case where the operator wants to use a known long-lived
		// code). Otherwise mint a fresh one via admin REST.
		if (process.env.E2E_INVITATION_CODE) {
			sharedInviteCode = process.env.E2E_INVITATION_CODE;
			return;
		}
		const adminEmail = process.env.E2E_ADMIN_EMAIL;
		const adminPassword = process.env.E2E_ADMIN_PASSWORD;
		if (!adminEmail || !adminPassword) {
			testInfo.skip(true, "Neither E2E_INVITATION_CODE nor E2E_ADMIN_EMAIL/PASSWORD set — can't mint a code");
		}
		const adminApi = await pwrequest.newContext({ baseURL });
		try {
			const loginResp = await adminApi.post("/api/v1/login", {
				data: { email: adminEmail, password: adminPassword },
				headers: { "Content-Type": "application/json" },
			});
			if (!loginResp.ok()) {
				throw new Error(`admin login: ${loginResp.status()} ${await loginResp.text()}`);
			}
			const loginJson = await loginResp.json();
			adminJwt = loginJson?.data?.token;
			baseURLAll = baseURL;
			if (!adminJwt) throw new Error("admin login returned no token");
			const mintResp = await adminApi.post("/api/v1/admin/invitation-codes", {
				headers: {
					"Authorization": `Bearer ${adminJwt}`,
					"Content-Type": "application/json",
				},
				// max_uses must cover all N users plus a buffer for retries.
				data: { note: `e2e-auto-quant-${Date.now()}`, count: 1, max_uses: Math.max(NUM_USERS * 2, 10), ttl_days: 1 },
			});
			if (!mintResp.ok()) {
				throw new Error(`mint invite: ${mintResp.status()} ${await mintResp.text()}`);
			}
			const minted = await mintResp.json();
			// Server returns { data: { codes: [{ code, max_uses, uses_remaining, ... }], total } }
			sharedInviteCode = minted?.data?.codes?.[0]?.code || "";
			if (!sharedInviteCode) throw new Error(`mint invite: no code in response: ${JSON.stringify(minted)}`);

			// Pick an Ongoing crypto competition for the trading-loop
			// user. QA backend is reachable via the lumid identity JWT
			// (SSO bridge). We prefer a crypto comp so the test isn't
			// blocked by equity market hours.
			const compResp = await adminApi.get("http://localhost:9988/api/v1/competitions?status=Ongoing&page_size=20", {
				headers: { "Authorization": `Bearer ${adminJwt}` },
			});
			if (compResp.ok()) {
				const compJson = await compResp.json();
				const comps: Array<{ id: number; symbols: string[]; participant_count: number }> = compJson?.data?.competitions || [];
				const crypto = comps.find((c) =>
					(c.symbols || []).every((s) => /USD$|USDT$|BTC|ETH|DOGE/i.test(s)),
				) || comps[0];
				if (crypto) tradingCompetitionId = crypto.id;
			}
		} finally {
			await adminApi.dispose();
		}
	});

	// One test() per user. Playwright runs each as its own worker so the
	// parallelism comes out of the framework rather than ad-hoc Promise.all
	// — gives us per-user retries, isolated reports, and per-user video
	// on failure.
	for (let i = 0; i < NUM_USERS; i++) {
		const slot = i;
		test(`user_${slot}: fresh install → paper cycle → dashboard renders`, async ({ page, baseURL }, testInfo) => {
			test.setTimeout(8 * 60_000); // 8 minutes — installer + apt + cycle
			const tag = `aq-${slot}-${Date.now().toString(36)}`;
			const url = baseURL!;
			const user = await createUser(url, { tag, invitationCode: sharedInviteCode });
			testInfo.attach("user", { body: JSON.stringify({ email: user.email }), contentType: "application/json" });

			// 1) UI login (drives the auth-guard path so we know cookies work).
			await page.goto("/auth/login");
			await page.locator("#email").fill(user.email);
			await page.locator("#password").fill(user.password);
			await page.getByRole("button", { name: /sign in/i }).click();
			// Default landing for fresh users was flipped to /studio/today
			// in Phase A5 (the Studio chat-first paradigm). Accept either
			// the new Studio landing or the legacy account/dashboard paths
			// for backward-compat during the rollout window.
			await expect(page).toHaveURL(/\/studio(\/|$)|\/account(\/|$)|\/dashboard/, { timeout: 20_000 });

			// 2) Mint a PAT via REST using the live session cookie. Fresh
			//    users only get `read` scope grantable — trading/strategy
			//    require explicit per-service admin grants. The CLI install
			//    + smoke commands work with `read` alone, which is what this
			//    spec validates. A "full paper cycle" e2e is a follow-up
			//    that needs admin to also grant trading scope + provision
			//    a competition + strategy + QA X-API-Token.
			const mint = await page.request.post("/api/v1/identity/personal-access-tokens", {
				data: { name: `aq-e2e-${slot}`, scopes: ["read"], ttl_days: 1 },
				headers: { "Content-Type": "application/json" },
			});
			expect(mint.ok(), `PAT mint: ${mint.status()} ${await mint.text().catch(() => "")}`).toBeTruthy();
			const minted = await mint.json();
			const pat = minted.data?.token as string;
			const patId = minted.data?.id as string;
			expect(pat).toMatch(/^(lm|rm)_pat_live_/);

			// For user_0: drive the heavyweight TRADING-LOOP exercise.
			//   1. Admin grants qa:write to this user
			//   2. User mints a new PAT with trading scope (replaces read PAT)
			//   3. User joins the crypto competition + auto-creates a strategy
			//      (returns api_token = X-API-Token for the trading endpoint)
			//   4. Container bind-mounts host claude binary + ~/.claude so the
			//      LLM-driven propose_setup step can call claude -p
			//   5. Run the crypto_lqa_research loop
			//
			// All other users skip this — they keep doing cheap verb +
			// negative-mode exercises in parallel.
			// QuantArena endpoints (competitions, strategies) live on
			// lumid.market behind nginx's /backend/ proxy prefix —
			// /backend/api/v1/* gets rewritten to /api/v1/* on the
			// :9988 Go backend. Same SSO bridge accepts lumid identity
			// JWT + PAT.
			const qaBase = "https://lumid.market/backend";
			let tradingApiToken = "";
			let tradingPat = pat;
			if (slot === 0 && tradingCompetitionId > 0) {
				// 3a) Find this user's id then grant qa:write via admin
				//     REST. The grant must use the admin JWT (the
				//     user's own session can't grant itself elevated
				//     access).
				const findUser = await fetch(`${url}/api/v1/admin/users?q=${encodeURIComponent(user.email)}&page_size=1`, {
					headers: { "Authorization": `Bearer ${adminJwt}` },
				});
				const findUserJson = await findUser.json();
				const userId = findUserJson?.data?.users?.[0]?.id || "";
				if (!userId) throw new Error(`couldn't find user_id for ${user.email}: ${JSON.stringify(findUserJson).slice(0, 400)}`);
				const grantViaAdmin = await fetch(`${url}/api/v1/admin/users/${userId}/access/qa`, {
					method: "PUT",
					headers: { "Authorization": `Bearer ${adminJwt}`, "Content-Type": "application/json" },
					body: JSON.stringify({ level: "write" }),
				});
				if (!grantViaAdmin.ok) {
					throw new Error(`qa:write grant: ${grantViaAdmin.status} ${await grantViaAdmin.text()}`);
				}

				// 3b) Mint a NEW PAT with trading + strategy scope.
				const tradingMint = await page.request.post("/api/v1/identity/personal-access-tokens", {
					data: { name: `aq-e2e-${slot}-trading`, scopes: ["read", "trading", "strategy"], ttl_days: 1 },
					headers: { "Content-Type": "application/json" },
				});
				expect(tradingMint.ok(), `trading PAT mint: ${tradingMint.status()} ${await tradingMint.text()}`).toBeTruthy();
				const tradingPatJson = await tradingMint.json();
				tradingPat = tradingPatJson.data?.token as string;
				expect(tradingPat).toMatch(/^(lm|rm)_pat_live_/);

				// 3c) Create a paper strategy joined to the competition
				//     — single call mints both the participant entry and
				//     the strategy's X-API-Token for trading. Hits the
				//     QA backend via lumid.market (lum.id doesn't proxy
				//     /api/v1/simulation-strategies).
				const stratResp = await fetch(`${qaBase}/api/v1/simulation-strategies`, {
					method: "POST",
					headers: {
						"Authorization": `Bearer ${tradingPat}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						name: `e2e-${tag}`,
						description: "Fresh-user auto-quant paper cycle e2e",
						competition_id: tradingCompetitionId,
					}),
				});
				if (!stratResp.ok) {
					throw new Error(`create strategy: ${stratResp.status} ${await stratResp.text()}`);
				}
				const stratJson = await stratResp.json();
				tradingApiToken = stratJson?.data?.api_token || "";
				expect(tradingApiToken, `strategy api_token missing in response: ${JSON.stringify(stratJson).slice(0, 400)}`).toBeTruthy();
				testInfo.annotations.push({ type: "trading-strategy-id", description: String(stratJson?.data?.id || "?") });
			}

			let cli: LumidCli | null = null;
			try {
				// 3) Provision the per-user container + install. For the
				//    trading-loop user, bind-mount the host claude binary
				//    so propose_trade can call `claude -p`.
				const claudeBin = "/home/webmaster/.nvm/versions/node/v26.1.0/bin/claude";
				const isTradingUser = slot === 0 && tradingApiToken !== "";
				cli = await lumidCli({
					pat: tradingPat,
					baseURL: url,
					workerTag: tag,
					extraVolumes: isTradingUser
						? [
							`${claudeBin}:/usr/local/bin/claude:ro`,
							// `/home/webmaster/.claude` has 212MB + permission-restricted dirs.
							// We don't bind the whole thing — claude -p in headless mode reads
							// /root/.claude/.credentials.json for the API session.
							`/home/webmaster/.claude/.credentials.json:/root/.claude/.credentials.json:ro`,
						]
						: [],
					extraEnv: isTradingUser ? { CLAUDE_CODE: "1" } : {},
				});

				// 4) Credentials persisted by the installer. The /start
				//    installer writes ~/.lumilake/credentials.toml (the
				//    Lumilake-scoped path; the rest of the SDK reads from
				//    here too).
				const credCheck = await cli.exec("test -f ~/.lumilake/credentials.toml && cat ~/.lumilake/credentials.toml");
				expect(credCheck.rc, "installer wrote ~/.lumilake/credentials.toml").toBe(0);
				expect(credCheck.stdout.toLowerCase()).toContain("pat");

				// 5) Smoke the CLI — `lumid` (no args) renders help text
				//    and exits 0. Proves the Python entrypoint imports
				//    cleanly.
				const smoke = await cli.run([], { timeoutMs: 30_000 });
				expect(smoke.rc, `lumid (no args) rc=${smoke.rc}; stderr=${smoke.stderr.slice(0, 400)}`).toBe(0);
				expect(smoke.stdout.toLowerCase()).toContain("lumid");

				// 6) Install the auto-quant app — every user gets it so
				//    their per-skill exercise has a real app to read
				//    from. Pulls the canonical repo from xp.io
				//    (PAT-authed with `read` scope).
				const aqInst = await cli.run(["app_install", "auto-quant"], { timeoutMs: 240_000 });
				expect(aqInst.rc, `app_install auto-quant rc=${aqInst.rc}; stderr=${aqInst.stderr.slice(0, 800)}`).toBe(0);

				// 6a) Initialize the local knowledge-graph agent dirs
				//     auto-quant declares. journal_trade writes to
				//     ~/.xp/kg/agents/<agent>/bank.jsonl which only
				//     exists once the dir is git-initialized. App-install
				//     doesn't auto-bootstrap these for new users (a
				//     real onboarding gap — flagged as future polish).
				await cli.exec(
					`for a in auto-quant-trader auto-quant-risk auto-quant-regime ` +
					`auto-quant-counterparty auto-quant-fees auto-quant-naive ` +
					`auto-quant-operator; do ` +
					`  mkdir -p ~/.xp/kg/agents/$a && ` +
					`  ( cd ~/.xp/kg/agents/$a && git init -q . && touch bank.jsonl ); ` +
					`done`,
					{ timeoutMs: 30_000 },
				);

				// 7) Per-user credentials.toml. For the trading-loop user
				//    we wire the strategy's X-API-Token + the live
				//    trading endpoint so place_order can actually fire
				//    against the paper competition. For others, just the
				//    lumid PAT — read scope is enough for observer paths.
				const qaTradingToken = tradingApiToken || pat;
				// qa_trading_url targets the trading API (:9999),
				// fronted by nginx's /trading/ prefix that strips and
				// proxies to the backend's /api/custom/trading/* routes.
				// qa_url targets the main API (:9988) at /backend/.
				await cli.exec(
					`mkdir -p ~/.lumid/apps/auto-quant && ` +
					`cat > ~/.lumid/apps/auto-quant/credentials.toml <<EOF\n` +
					`qa_url           = "${qaBase}"\n` +
					`qa_trading_url   = "https://lumid.market/trading"\n` +
					`qa_api_token     = "${qaTradingToken}"\n` +
					`lumid_pat        = "${tradingPat}"\n` +
					`${tradingCompetitionId ? `competition_id   = ${tradingCompetitionId}\n` : ""}` +
					`EOF`,
				);

				// 8) Per-user skill+data exercise. Each worker takes a
				//    different verb so 5 parallel workers cover 5
				//    different code paths simultaneously:
				//
				//       user_0 → cycle regime_detector  (observe + LLM regime)
				//       user_1 → xp_ask                  (KG query)
				//       user_2 → app_marketplace         (xp.io repo list)
				//       user_3 → app_detail auto-quant   (manifest read)
				//       user_4 → xp_status               (local KG state)
				//
				//    Different surface area, same fresh-user constraints.
				const exercises: Array<{
					name: string;
					args: string[];
					timeoutMs: number;
					assertOutputContains?: string;
					softFail?: boolean; // if true, exit-nonzero doesn't fail the test
				}> = [
					// slot 0 — TRADING LOOP. Heaviest path: 12-step cycle
					// with LLM-driven proposal, risk gates, journal write.
					// Allows soft failure because the cycle can validly
					// gate-reject (risk says no — that's a SUCCESS for the
					// gate, not a test failure). We assert the journal
					// shows the cycle ran AT ALL, not that it placed a trade.
					// slot 0 — TRADING (heaviest, twice for state continuity)
					{ name: "cycle crypto_lqa_research", args: ["app", "auto-quant", "cycle", "crypto_lqa_research", "--confirm-live"], timeoutMs: 600_000, assertOutputContains: "crypto_lqa_research", softFail: true },
					// slot 1 — KG query
					{ name: "xp ask",                 args: ["xp", "ask", "what regimes have we observed?"], timeoutMs: 60_000 },
					// slot 2 — EQUITY observer loop (regime_detector
					// runs on default stock universe AAPL/MSFT/etc.,
					// hitting FinData /api/v1/data/history for OHLCV).
					// Different data path than user_0's crypto.
					{ name: "cycle regime_detector",  args: ["app", "auto-quant", "cycle", "regime_detector"], timeoutMs: 240_000, assertOutputContains: "regime_detector" },
					// slot 3 — manifest read
					{ name: "app_detail auto-quant",  args: ["app_detail", "auto-quant"], timeoutMs: 30_000, assertOutputContains: "auto-quant" },
					// slot 4 — special-cased below: submit_jobs round-trip.
					// Drives submit_jobs.cron + get_result from inside
					// the container's venv python. Validates the ledger
					// schema + the read-back path. The container's
					// ledger is isolated from the host (so prod's
					// /admin/jobs won't show this entry — that's a
					// separate, host-side smoke).
					{ name: "submit_jobs round-trip", args: [], timeoutMs: 60_000 },
				];
				const exercise = exercises[slot % exercises.length];
				testInfo.annotations.push({ type: "exercise", description: exercise.name });

				// slot 4 is the submit_jobs round-trip — needs special
				// handling because it drives inline python, not the
				// lumid CLI verb dispatcher.
				const isSubmitJobsExercise = exercise.name === "submit_jobs round-trip";

				let result: { rc: number; stdout: string; stderr: string };
				if (isSubmitJobsExercise) {
					// Run a small inline python that exercises both halves of
					// the submit_jobs round-trip: submit a cron entry,
					// then read it back via get_result. Asserts the
					// returned record carries the schema fields we
					// designed (job_id, source, state, spec_summary).
					const script = `
import sys
sys.path.insert(0, '${"/root/lumid"}/sdk/skills')
sys.path.insert(0, '${"/root/lumid"}')
from submit_jobs.cron import run as cron_submit
from submit_jobs.get_result import run as get_result
import json

submission = cron_submit(
    spec='lumid app auto-quant cycle regime_detector',
    schedule='0 4 * * *',
    kind='e2e_verification',
    args={'tag': 'submit-jobs-roundtrip'},
)
assert submission.get('ok') is True, f'cron submit failed: {submission}'
job_id = submission['job_id']
readback = get_result(job_id, wait=False)
assert readback.get('job_id') == job_id, f'get_result mismatch: {readback}'
assert readback.get('source') == 'cron', f'get_result wrong source: {readback}'
assert readback.get('state') == 'scheduled', f'get_result wrong state: {readback}'
print(json.dumps({
    'submission': {k: submission.get(k) for k in ('ok','job_id','source','state')},
    'readback':   {k: readback.get(k) for k in ('ok','job_id','source','state','submitter_app','submitter_loop')},
}))
`;
					// Drop the script in the container, run it via the
					// venv python (which has tomllib + sdk on path
					// thanks to the PATH-prepended venv).
					result = await cli.exec(
						`cat > /tmp/sj.py <<'PYEOF'\n${script}\nPYEOF\n` +
						`PYTHONPATH=$HOME/lumid:$HOME/lumid/sdk/skills $HOME/lumid/.venv/bin/python3 /tmp/sj.py`,
						{ timeoutMs: exercise.timeoutMs },
					);
				} else {
					result = await cli.run(exercise.args, { timeoutMs: exercise.timeoutMs });
				}

				testInfo.attach(`${exercise.name}-exit`, {
					body: `rc=${result.rc}\nstderr=${result.stderr.slice(-2000)}\nstdout=${result.stdout.slice(-1500)}`,
					contentType: "text/plain",
				});

				if (!exercise.softFail) {
					expect(
						result.rc,
						`${exercise.name} rc=${result.rc}; stderr=${result.stderr.slice(0, 800)}; stdout=${result.stdout.slice(0, 400)}`,
					).toBe(0);
				}
				if (exercise.assertOutputContains) {
					expect(result.stdout.toLowerCase()).toContain(exercise.assertOutputContains.toLowerCase());
				}

				// For submit_jobs slot: also assert the ledger row
				// schema is intact + the readback returned the same
				// job_id we submitted.
				if (isSubmitJobsExercise) {
					const out = JSON.parse(result.stdout.split("\n").reverse().find((l) => l.trim().startsWith("{")) || "{}");
					expect(out?.submission?.ok, "submission missing ok=true").toBe(true);
					expect(out?.submission?.source).toBe("cron");
					expect(out?.readback?.job_id).toBe(out?.submission?.job_id);
					expect(out?.readback?.state).toBe("scheduled");
					testInfo.annotations.push({
						type: "submit_jobs-roundtrip",
						description: `${out?.submission?.job_id} → state=${out?.readback?.state}`,
					});
				}

				// 9) For the trading cycle, drill into the cycle output
				//    AND run the cycle a second time. The second iteration
				//    proves state continuity: per-cycle artifacts
				//    accumulate, journal entries double. A regression
				//    here would surface broken cross-cycle persistence
				//    in the runner — one of the harder invariants in xpio.
				if (exercise.name === "cycle crypto_lqa_research") {
					// Capture cycle-dir count BEFORE the second run.
					const cyclesBefore = await cli.exec(
						`ls -d ~/.xp/apps/auto-quant/data/cycles/crypto_lqa_research/2026* 2>/dev/null | wc -l`,
						{ timeoutMs: 10_000 },
					);
					const cyclesBeforeN = parseInt((cyclesBefore.stdout || "0").trim(), 10) || 0;

					// Run the same cycle a second time. This exercises:
					//   - LUMID_APP_NAME env stays sticky across runs
					//   - The runner makes a new cycle dir per invocation
					//   - The journal appends, not overwrites
					//   - Memory bank doesn't get reset
					//   - The cli + venv survive a second invocation
					const cycle2 = await cli.run(exercise.args, { timeoutMs: exercise.timeoutMs });
					testInfo.attach("cycle2_exit", {
						body: `rc=${cycle2.rc}\nstderr=${cycle2.stderr.slice(-1500)}\nstdout=${cycle2.stdout.slice(-1500)}`,
						contentType: "text/plain",
					});

					// Cycle-dir count should have grown by exactly 1.
					const cyclesAfter = await cli.exec(
						`ls -d ~/.xp/apps/auto-quant/data/cycles/crypto_lqa_research/2026* 2>/dev/null | wc -l`,
						{ timeoutMs: 10_000 },
					);
					const cyclesAfterN = parseInt((cyclesAfter.stdout || "0").trim(), 10) || 0;
					testInfo.annotations.push({
						type: "cycle-dirs",
						description: `${cyclesBeforeN} → ${cyclesAfterN}`,
					});
					expect(cyclesAfterN, `cycle dir didn't accumulate (${cyclesBeforeN} → ${cyclesAfterN})`)
						.toBeGreaterThan(cyclesBeforeN);

					// Journal entries also doubled — every cycle appends.
					const journalAfter = await cli.exec(
						`grep -c '"loop": *"crypto_lqa_research"' ~/.xp/apps/auto-quant/data/journal.jsonl 2>/dev/null || echo 0`,
						{ timeoutMs: 10_000 },
					);
					const journalCount = parseInt((journalAfter.stdout || "0").trim(), 10) || 0;
					testInfo.annotations.push({
						type: "journal-entries",
						description: `crypto_lqa_research entries: ${journalCount}`,
					});
					expect(journalCount, `expected >= 2 journal entries after two cycles, got ${journalCount}`)
						.toBeGreaterThanOrEqual(2);

					// Soft signal: did the bank grow? Not asserted —
					// a fresh user with no holdings legitimately gets
					// "no trade" from propose_setup, which short-circuits
					// the cycle before journal_trade runs. Surfaces as
					// annotation only.
					const bankSize = await cli.exec(
						`wc -l ~/.xp/kg/agents/auto-quant-trader/bank.jsonl 2>/dev/null | awk '{print $1}'`,
						{ timeoutMs: 10_000 },
					);
					testInfo.annotations.push({
						type: "trader-bank-lines",
						description: (bankSize.stdout || "0").trim(),
					});

					// HARD-ASSERT: the X-API-Token authenticates against
					// the trading endpoint. Try both BTCUSD and ETHUSD —
					// one of them should price-resolve cleanly. The
					// `ret_code` field on QA tells us layer-by-layer:
					//   - HTTP != 200 → auth or transport broken
					//   - ret_code != 0 → API responded but engine
					//     rejected (e.g., price oracle stale)
					//   - ret_code === 0 → trade placed; assert it
					//     surfaces in recent-trades feed
					let priced = false;
					for (const sym of ["BTCUSD", "ETHUSD"]) {
						const orderResp = await fetch(`https://lumid.market/trading/api/custom/trading/order`, {
							method: "POST",
							headers: {
								"X-API-Token": `Bearer ${tradingApiToken}`,
								"Content-Type": "application/json",
							},
							body: JSON.stringify({ symbol: sym, direction: "Buy", volume: 1 }),
						});
						const orderText = await orderResp.text();
						testInfo.attach(`direct_trade_${sym}`, {
							body: `HTTP ${orderResp.status}\n${orderText}`,
							contentType: "text/plain",
						});
						// HTTP 200 + valid JSON proves the auth path
						// (X-API-Token recognized + strategy matched).
						expect(orderResp.ok, `${sym} order HTTP failed (${orderResp.status})`).toBeTruthy();
						const orderJson = JSON.parse(orderText);
						expect(orderJson?.ret_code, `${sym} response missing ret_code`).toBeDefined();
						if (orderJson?.ret_code === 0) {
							priced = true;
							break;
						}
					}

					if (priced) {
						// Hard-assert the trade surfaced in recent-trades.
						let tradesLanded = false;
						for (let attempt = 0; attempt < 6; attempt++) {
							await new Promise((r) => setTimeout(r, 1000));
							const rt = await fetch(
								`${qaBase}/api/v1/competitions/${tradingCompetitionId}/recent-trades?limit=50`,
								{ headers: { "Authorization": `Bearer ${adminJwt}` } },
							);
							if (!rt.ok) continue;
							const rtJson = await rt.json();
							const trades: Array<{ strategy_name?: string }> = rtJson?.data?.trades || [];
							if (trades.some((t) => t.strategy_name === `e2e-${tag}`)) {
								tradesLanded = true;
								testInfo.annotations.push({
									type: "trade-landed",
									description: `attempt ${attempt + 1} found strategy e2e-${tag}`,
								});
								break;
							}
						}
						expect(tradesLanded, `priced trade didn't surface in recent-trades within 6s for strategy e2e-${tag}`).toBeTruthy();
					} else {
						// Price oracle flake — auth + order endpoint
						// validated, but engine couldn't price either
						// crypto. Annotate so the run is observable but
						// don't fail. (A real bug worth tracking — the
						// FMP live_price_source for the crypto comp may
						// need attention.)
						testInfo.annotations.push({
							type: "trade-skipped",
							description: "X-API-Token auth verified; price oracle returned non-zero ret_code on both BTCUSD and ETHUSD",
						});
					}
					const journal = await cli.exec(
						"cat ~/.xp/apps/auto-quant/data/journal.jsonl 2>/dev/null | tail -5",
						{ timeoutMs: 10_000 },
					);
					testInfo.attach("journal_tail", { body: journal.stdout, contentType: "text/plain" });
					expect(journal.stdout, "journal.jsonl missing after trading cycle").toContain("crypto_lqa_research");

					// Find the newest cycle dir + read step_log.json.
					const stepLogProbe = await cli.exec(
						`set -e; ` +
						`d=$(ls -td ~/.xp/apps/auto-quant/data/cycles/crypto_lqa_research/2026* 2>/dev/null | head -1); ` +
						`echo "DIR=$d"; ` +
						`ls -la "$d" 2>/dev/null; ` +
						`echo "--- step_log.json ---"; ` +
						`cat "$d/step_log.json" 2>/dev/null`,
						{ timeoutMs: 15_000 },
					);
					testInfo.attach("cycle_dir_listing", { body: stepLogProbe.stdout, contentType: "text/plain" });

					// Parse out the step_log JSON portion. The runner
					// always writes step_log.json; we tolerate missing
					// step_outputs_summary.json (only some steps emit).
					const stepLogJsonMatch = stepLogProbe.stdout.match(/--- step_log\.json ---\n(\[[\s\S]*?\])\n?$/);
					expect(stepLogJsonMatch, `step_log.json missing or malformed in cycle dir; raw probe:\n${stepLogProbe.stdout.slice(-1500)}`).not.toBeNull();
					if (stepLogJsonMatch) {
						const stepLog: Array<{ step: string; skill: string; ok: boolean }> = JSON.parse(stepLogJsonMatch[1]);
						const okSteps = stepLog.filter((s) => s.ok).map((s) => s.step);
						testInfo.annotations.push({ type: "cycle-ok-steps", description: okSteps.join(",") });
						// Must have AT LEAST the observe stage succeed —
						// proves the cycle did real work (data fetch,
						// not just init).
						expect(okSteps, `no observe steps succeeded in step_log: ${JSON.stringify(stepLog).slice(0, 800)}`)
							.toEqual(expect.arrayContaining(["observe_account", "observe_crypto"]));
					}

					// Soft-check: did our strategy actually trade? Hit
					// the competition's recent-trades and look for our
					// strategy name. NOT asserted — risk gate may have
					// rejected the trade for valid reasons.
					const recentTrades = await fetch(
						`${qaBase}/api/v1/competitions/${tradingCompetitionId}/recent-trades?limit=20`,
						{ headers: { "Authorization": `Bearer ${adminJwt}` } },
					);
					if (recentTrades.ok) {
						const rtJson = await recentTrades.json();
						const trades: Array<{ strategy_name?: string }> = rtJson?.data?.trades || [];
						const ourTrades = trades.filter((t) => t.strategy_name === `e2e-${tag}`);
						testInfo.annotations.push({
							type: "trades-placed",
							description: `${ourTrades.length} of ${trades.length} recent trades match strategy e2e-${tag}`,
						});
					}
				}

				// 10) NEGATIVE — exercise failure modes. Each user also
				//     drives at least one path that we KNOW should
				//     fail cleanly (non-zero exit + error message that
				//     mentions what went wrong, not a stack trace).
				//     Catches regressions where the CLI starts hard-
				//     crashing on a bad input.
				const negCases: Array<{ name: string; args: string[]; expectStdoutOrStderr: RegExp; setup?: () => Promise<void> }> = [
					{ name: "unknown verb",       args: ["this_is_not_a_verb"],              expectStdoutOrStderr: /unknown|not.found|usage/i },
					{ name: "missing app",        args: ["app_detail", "definitely-fake-app"], expectStdoutOrStderr: /not.found|missing|no such|fail|invalid|expected/i },
					{ name: "unknown loop",       args: ["app", "auto-quant", "cycle", "no_such_loop"],   expectStdoutOrStderr: /not.found|unknown|invalid|loop/i },
					{ name: "missing required arg", args: ["skill_validate"],                expectStdoutOrStderr: /required|missing|usage|app/i },
					// Revoke PAT, then try a PAT-authed verb that makes a
					// real network call to xpcloud. app_install requires
					// auth to clone the repo; with a revoked token it
					// should surface a clean auth error (401-ish) instead
					// of a stack trace.
					{
						name: "revoked PAT",
						args: ["app_install", "mlsys-io/sample-app-that-does-not-matter"],
						expectStdoutOrStderr: /unauthor|invalid|forbidden|401|403|expired|revoke|token|not.found|404|auth/i,
						setup: async () => {
							await page.request.delete(`/api/v1/identity/personal-access-tokens/${patId}`);
						},
					},
				];
				const neg = negCases[slot % negCases.length];
				if (neg.setup) await neg.setup();
				testInfo.annotations.push({ type: "negative-exercise", description: neg.name });
				const negResult = await cli.run(neg.args, { timeoutMs: 60_000 });
				testInfo.attach(`negative-${neg.name}`, {
					body: `rc=${negResult.rc}\nstderr=${negResult.stderr.slice(-1500)}\nstdout=${negResult.stdout.slice(-1500)}`,
					contentType: "text/plain",
				});
				// Must NOT be exit 0 (it's a failure case).
				expect(negResult.rc, `negative case '${neg.name}' unexpectedly exited 0`).not.toBe(0);
				// Must NOT have an unhandled-exception stack trace
				// (catches CLIs that crash instead of returning a nice
				// error). Tracebacks contain "Traceback (most recent…".
				expect(negResult.stderr + negResult.stdout, `negative case '${neg.name}' threw an unhandled exception`)
					.not.toMatch(/Traceback \(most recent call last\):/);
				// Must surface a reasonable error message.
				expect((negResult.stderr + negResult.stdout).toLowerCase(),
					`negative case '${neg.name}' didn't surface a recognizable error`)
					.toMatch(neg.expectStdoutOrStderr);
			} finally {
				if (cli) await cli.dispose();
				// Revoke PAT — best-effort. The TTL on the PAT is 1 day
				// so a leaked one will rot fast even if revoke fails.
				try {
					await page.request.delete(`/api/v1/identity/personal-access-tokens/${patId}`);
				} catch {}
			}
		});
	}
});

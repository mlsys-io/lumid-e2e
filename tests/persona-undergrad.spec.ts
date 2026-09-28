import { test, type Page, type Locator, type BrowserContext } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createUser, deleteUser, type TestUser } from "../fixtures/test-user";
import { localOtpEnabled } from "../fixtures/otp-redis";
import { loginViaUi } from "../fixtures/login-ui";

// Persona journey — a fresh UNDERGRAD who wants to do quant research on lum.id.
//
// GOALS.md row 18, "Undergrad journey stages that fail", J1–J9. This is a
// MEASUREMENT, not a gate: every stage runs (a stage is skipped only when the
// object it needs does not exist, and says so), each records
//
//   ok · why · clicks · px_scrolled (distance the target sat below the fold
//   before any scroll) · url · url_survives_reload · ms · screenshot
//
// and the run writes ONE JSON summary {at, account, stages, failed_count} to
// results/persona-undergrad.json (+ stdout) with screenshots beside it.
//
// UI budget per stage: <= 3 clicks, 0 px scroll to target, survives reload.
// Budget misses are RECORDED on the stage (budget_ok=false); they do not fail
// the run on their own — the stage's `ok` is its own criterion below.
//
// The persona is a throwaway lumid-e2e-…@yao.lu account (the only addresses
// identity's e2e OTP route serves). Paper lane only. Cleanup, always: every
// strategy it created is disabled, every token it holds is revoked, and the
// account is deleted the way fresh-user-journey deletes its own. The admin
// credential (E2E_ADMIN_PAT / ~/.lumid/admin.pat) is used ONLY server-side in
// node, for the OTP read and the account delete — it never enters the
// persona's browser context.
//
// RUN (needs an invitation code; CI mints one per run):
//   E2E_PERSONA=1 CI_E2E_LOCAL_OTP=1 LUMID_OTP_TRANSPORT=api \
//     E2E_INVITATION_CODE=… npx playwright test persona-undergrad --project=chromium

const ENABLED = process.env.E2E_PERSONA === "1";
const APP = "quant-research";
const APP_DISPLAY = "Quant Research";
const OUT_JSON = process.env.E2E_PERSONA_OUT || "results/persona-undergrad.json";
const SHOT_DIR = path.join(path.dirname(OUT_JSON), "persona-undergrad");
const BT_POLL_MS = Number.parseInt(process.env.E2E_PERSONA_POLL_MS || "600000", 10);
const CHAT_MS = Number.parseInt(process.env.E2E_PERSONA_CHAT_MS || "600000", 10);
const VIEWPORT = { width: 1280, height: 800 };

const J4_PROMPT =
	"I'm new to trading. Write me a simple strategy that buys YES when order flow turns strongly positive, " +
	"explain it in plain English, and submit it.";
const J7_PROMPT = "make a v2 with a lower threshold and compare it with v1 on the same market";
// A step's own output. NOT "per-stage output": the Outputs panel says "Open a
// run to see its per-stage output", which is an instruction, not an output.
const STEP_OUTPUT = /\bstdout\b|\bstderr\b|exit (code|status)\b/i;
const JARGON = /lqt_inbox|lqt_outbox|obs plane|tenant/gi;

// ── the record ────────────────────────────────────────────────────────────

interface Stage {
	id: string;
	name: string;
	ok: boolean;
	why: string;
	clicks: number;
	px_scrolled: number | null;
	url: string;
	url_survives_reload: boolean | null;
	ms: number;
	screenshot: string;
	budget_ok: boolean;
	skipped?: boolean;
	details: Record<string, unknown>;
}

const stages: Stage[] = [];

class Meter {
	clicks = 0;
	px: number | null = null;
	survives: boolean | null = null;
	details: Record<string, unknown> = {};
	errors: string[] = [];
	async click(loc: Locator, opts: { measure?: boolean } = {}): Promise<void> {
		if (opts.measure) await this.measure(loc);
		await loc.click();
		this.clicks++;
	}
	/** Distance the target sits outside the viewport BEFORE anything scrolls it. */
	async measure(loc: Locator): Promise<void> {
		const d = await pxToTarget(loc);
		if (d !== null) this.px = Math.max(this.px ?? 0, d);
	}
}

async function pxToTarget(loc: Locator): Promise<number | null> {
	try {
		await loc.waitFor({ state: "attached", timeout: 15_000 });
		return await loc.evaluate((el) => {
			const r = el.getBoundingClientRect();
			const vh = window.innerHeight;
			if (r.top >= 0 && r.bottom <= vh) return 0;
			if (r.top < 0) return Math.round(-r.top);
			return Math.round(r.bottom - vh);
		});
	} catch {
		return null;
	}
}

async function runStage(
	page: Page | null,
	id: string,
	name: string,
	fn: (m: Meter) => Promise<{ ok: boolean; why: string }>,
	opts: { skip?: string } = {},
): Promise<Stage> {
	const t0 = Date.now();
	const m = new Meter();
	let ok = false;
	let why = "";
	const shot = path.join(SHOT_DIR, `${id}.png`);
	const onResp = (r: import("@playwright/test").Response) => {
		const u = r.url();
		if (r.status() >= 400 && u.includes("lum.id") && u.includes("/api/")) {
			m.errors.push(`${r.status()} ${r.request().method()} ${u.replace(/^https?:\/\/[^/]+/, "").slice(0, 140)}`);
		}
	};
	if (opts.skip) {
		why = `SKIPPED: ${opts.skip}`;
	} else {
		page?.on("response", onResp);
		try {
			({ ok, why } = await fn(m));
		} catch (e) {
			ok = false;
			why = `error: ${((e as Error)?.message ?? String(e)).split("\n")[0].slice(0, 300)}`;
		} finally {
			page?.off("response", onResp);
		}
	}
	let screenshot = "";
	if (page && !opts.skip) {
		screenshot = (await page.screenshot({ path: shot }).then(() => shot).catch(() => "")) as string;
	}
	if (m.errors.length) m.details.http_errors = [...new Set(m.errors)].slice(0, 10);
	const s: Stage = {
		id,
		name,
		ok,
		why,
		clicks: m.clicks,
		px_scrolled: m.px,
		url: page && !opts.skip ? page.url() : "",
		url_survives_reload: m.survives,
		ms: Date.now() - t0,
		screenshot,
		budget_ok: !opts.skip && m.clicks <= 3 && (m.px ?? 0) === 0 && m.survives !== false,
		...(opts.skip ? { skipped: true } : {}),
		details: m.details,
	};
	stages.push(s);
	console.log(`[persona] ${id} ${ok ? "PASS" : opts.skip ? "SKIP" : "FAIL"} — ${why.slice(0, 200)}`);
	return s;
}

/** Reload and see whether the same target comes back. */
async function survivesReload(page: Page, target: () => Locator, timeout = 30_000): Promise<boolean> {
	try {
		await page.reload({ waitUntil: "load" });
		await target().first().waitFor({ state: "visible", timeout });
		return true;
	} catch {
		return false;
	}
}

async function bodyText(page: Page): Promise<string> {
	return (await page.locator("body").innerText().catch(() => "")) || "";
}

/** Text of the surface holding `anchor`, excluding the chat rail beside it. */
async function surfaceText(page: Page, anchor: string): Promise<string> {
	return page
		.getByText(anchor)
		.first()
		.evaluate((el) => {
			let cur: HTMLElement = el as HTMLElement;
			while (cur.parentElement && !cur.parentElement.querySelector('textarea[aria-label="Message the assistant"]')) {
				cur = cur.parentElement;
			}
			return cur.innerText;
		})
		.catch(() => "");
}

async function waitVisible(loc: Locator, timeout = 30_000): Promise<boolean> {
	return loc.first().waitFor({ state: "visible", timeout }).then(() => true, () => false);
}

// ── API reads (session-authenticated as the persona, never admin) ─────────

interface StratRow {
	name: string;
	strategy_id: string;
	status: string;
	program_hash: string;
	version?: string;
}

async function myStrategies(page: Page): Promise<{ strategies: StratRow[]; rejected: any[] }> {
	try {
		const r = await page.request.get("/api/v1/me/strategies", { timeout: 30_000 });
		if (!r.ok()) return { strategies: [], rejected: [] };
		const d = (await r.json())?.data ?? {};
		return { strategies: d.strategies ?? [], rejected: d.rejected ?? [] };
	} catch {
		return { strategies: [], rejected: [] };
	}
}

async function appStatus(page: Page): Promise<string> {
	try {
		const r = await page.request.get("/api/v1/me/apps");
		const b = r.ok() ? await r.json() : null;
		const apps = b?.data?.apps ?? b?.apps ?? [];
		return String((apps as any[]).find((a) => a.name === APP)?.status ?? "(absent)");
	} catch {
		return "(error)";
	}
}

// ── chat: send one turn, approve the way a user would, read the stream ────

interface ChatTurn {
	answer: string;
	done: boolean;
	approvals: number;
	tools: string[];
	toolCalls: Array<{ name: string; args: string }>;
	errors: string[];
	ms: number;
}

function parseSse(raw: string): ChatTurn {
	const t: ChatTurn = { answer: "", done: false, approvals: 0, tools: [], toolCalls: [], errors: [], ms: 0 };
	for (const line of raw.split("\n")) {
		if (!line.startsWith("data:")) continue;
		let e: any;
		try {
			e = JSON.parse(line.slice(5).trim());
		} catch {
			continue;
		}
		switch (e?.type) {
			case "text":
				t.answer += String(e.delta ?? e.text ?? "");
				break;
			case "tool_start":
				t.tools.push(String(e.name ?? ""));
				break;
			case "tool_call":
				t.toolCalls.push({ name: String(e.name ?? ""), args: JSON.stringify(e.args ?? e.input ?? e.arguments ?? "") });
				break;
			case "error":
				t.errors.push(String(e.message ?? e.error ?? "error").slice(0, 200));
				break;
			case "done":
				t.done = true;
				break;
		}
	}
	return t;
}

// The captured SSE body comes back double-decoded — UTF-8 bytes read as
// windows-1252, so "—" arrives as "â€”" — although the UI renders it
// correctly. Re-encode as cp1252 and decode as UTF-8 so the recorded answer
// reads as the user saw it; leave it untouched if that does not round-trip.
const CP1252: Record<number, number> = {
	0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
	0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
	0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
	0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};
function unMojibake(s: string): string {
	if (!/â€|Ã.|Ï./.test(s)) return s;
	const bytes: number[] = [];
	for (const ch of s) {
		const c = ch.codePointAt(0)!;
		const b = c <= 0xff ? c : CP1252[c];
		if (b === undefined) return s;
		bytes.push(b);
	}
	const out = Buffer.from(bytes).toString("utf8");
	return out.includes("\uFFFD") ? s : out;
}

async function chatTurn(page: Page, m: Meter, prompt: string, budgetMs: number): Promise<ChatTurn> {
	const chunks: string[] = [];
	const pending: Promise<void>[] = [];
	const onResp = (r: import("@playwright/test").Response) => {
		if (r.url().includes("/agent/chat/stream")) {
			// body() + explicit utf8: the stream carries no charset, and text()
			// decoded it as latin-1 (every em dash came back as mojibake).
			pending.push(r.body().then((b) => void chunks.push(b.toString("utf8")), () => {}));
		}
	};
	page.on("response", onResp);
	const t0 = Date.now();
	let approvals = 0;
	try {
		const box = page.locator('textarea[aria-label="Message the assistant"]').last();
		await box.waitFor({ state: "visible", timeout: 30_000 });
		await m.click(box, { measure: true });
		await box.fill(prompt);
		await page.keyboard.press("Enter");
		let quiet = 0;
		let last = -1;
		while (Date.now() - t0 < budgetMs) {
			await page.waitForTimeout(1_000);
			// A user approves a write the way the chip offers it: Always, so the
			// rest of the turn is not interrupted again (spec 96/98's locator).
			const always = page.getByRole("button", { name: /^Always$/i }).first();
			if (await always.count().catch(() => 0)) {
				await always.click().catch(() => {});
				approvals++;
				m.clicks++;
				quiet = 0;
				continue;
			}
			const joined = chunks.join("\n");
			const txt = await bodyText(page);
			const busy = /Working…|sends when current turn finishes/.test(txt);
			if (/"type"\s*:\s*"done"/.test(joined) && !busy) break;
			const n = joined.length + txt.length;
			if (!busy && n === last) {
				if (++quiet >= 45) break;
			} else {
				quiet = 0;
				last = n;
			}
		}
	} finally {
		await Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, 5_000))]);
		page.off("response", onResp);
	}
	const turn = parseSse(chunks.join("\n"));
	turn.answer = unMojibake(turn.answer);
	turn.approvals = approvals;
	turn.ms = Date.now() - t0;
	return turn;
}

// ── strategy-page backtest table ──────────────────────────────────────────

interface BtRow {
	[col: string]: string;
}

/** Rows of the table whose header carries "Presentable?" (the honesty table). */
async function honestyRows(page: Page): Promise<BtRow[]> {
	return page
		.locator("table")
		.evaluateAll((tables) => {
			const t = tables.find((x) => /Presentable\?/.test(x.querySelector("thead")?.textContent ?? ""));
			if (!t) return [];
			const heads = [...t.querySelectorAll("thead th")].map((h) => (h.textContent ?? "").trim());
			return [...t.querySelectorAll("tbody tr")].map((tr) => {
				const cells = [...tr.querySelectorAll("td")].map((c) => (c.textContent ?? "").trim());
				const row: Record<string, string> = {};
				heads.forEach((h, i) => (row[h] = cells[i] ?? ""));
				return row;
			});
		})
		.catch(() => []);
}

const filled = (v: string | undefined) => !!v && v !== "—" && v !== "-";

function resultRow(rows: BtRow[]): BtRow | undefined {
	return rows.find((r) => !/queued|running|submitted/i.test(r.Status ?? "") && filled(r.Prices));
}

// ── the walk ──────────────────────────────────────────────────────────────

test.describe.configure({ mode: "serial" });

test.describe("persona — undergrad quant-research journey J1–J9 [measurement]", () => {
	test.skip(!ENABLED, "measurement run — set E2E_PERSONA=1");

	test("J1–J9, every stage measured", async ({ browser }, testInfo) => {
		testInfo.setTimeout(CHAT_MS * 2 + BT_POLL_MS + 25 * 60_000);
		const baseURL = testInfo.project.use.baseURL ?? process.env.BASE_URL ?? "https://lum.id";
		fs.mkdirSync(SHOT_DIR, { recursive: true });
		const at = new Date().toISOString();

		let user: TestUser | null = null;
		let ctx: BrowserContext | null = null;
		let page: Page | null = null;
		const created: StratRow[] = [];
		const cleanup: Record<string, unknown> = {};

		try {
			// ── J1 Arrive (logged out) ─────────────────────────────────────
			const anon = await browser.newContext({ baseURL, viewport: VIEWPORT });
			const ap = await anon.newPage();
			await runStage(ap, "J1", "Arrive (logged out)", async (m) => {
				await ap.goto("/", { waitUntil: "load" });
				// Let the SPA settle (and any redirect land) before reading it: a
				// cold pod paints the auth card late.
				await waitVisible(ap.getByRole("button").or(ap.getByRole("link")), 20_000);
				await ap.waitForTimeout(3_000);
				const landing = ap.url();
				const txt = await bodyText(ap);
				const onLogin = /\/auth\/login/.test(landing);
				const explains = /quant(itative)? research|research pipeline|auto research/i.test(txt);
				const signUp = ap.getByRole("link", { name: /sign ?up|create (an )?account|get started/i }).or(
					ap.getByRole("button", { name: /sign ?up|create (an )?account|get started/i }),
				);
				const offersSignup = (await signUp.count()) > 0;
				if (offersSignup) await m.measure(signUp.first());
				m.survives = await survivesReload(ap, () => ap.locator("body"));
				// /auth/signup must show a SIGN-UP form, not the login form.
				await ap.goto("/auth/signup", { waitUntil: "load" });
				await waitVisible(ap.getByRole("button").or(ap.getByRole("link")), 20_000);
				await ap.waitForTimeout(3_000);
				const sTxt = await bodyText(ap);
				const signupUrl = ap.url();
				const signupForm =
					!/\/auth\/login/.test(signupUrl) &&
					/create (your |an )?account|sign up/i.test(sTxt) &&
					!/Welcome Back/i.test(sTxt);
				await ap.screenshot({ path: path.join(SHOT_DIR, "J1-signup.png") }).catch(() => {});
				m.details = {
					landing_url: landing,
					redirected_to_login: onLogin,
					mentions_quant_research: explains,
					offers_signup: offersSignup,
					signup_url_lands_on: signupUrl,
					signup_shows_signup_form: signupForm,
					signup_screenshot: path.join(SHOT_DIR, "J1-signup.png"),
				};
				// Back on / for the stage screenshot.
				await ap.goto("/", { waitUntil: "load" });
				await ap.waitForTimeout(2_000);
				const ok = !onLogin && explains && offersSignup;
				return {
					ok,
					why: ok
						? "landing explains Lumid / quant research and offers sign-up"
						: [
								onLogin ? "/ redirects to /auth/login" : "",
								!explains ? "no explanation of Lumid / quant research" : "",
								!offersSignup ? "no sign-up offer" : "",
								!signupForm ? `/auth/signup shows ${/\/auth\/login/.test(signupUrl) || /Welcome Back/i.test(sTxt) ? "the LOGIN form" : "no sign-up form"}` : "",
							]
								.filter(Boolean)
								.join("; "),
				};
			});
			await anon.close();

			// ── account (not a stage: the fixture signs up via REST) ────────
			// A failure here is recorded, and J2–J9 are recorded as skipped with
			// the reason — the summary is still written.
			let acctErr = "";
			const dialogs: string[] = [];
			try {
				const invite = process.env.E2E_INVITATION_CODE || "";
				if (!invite) throw new Error("E2E_INVITATION_CODE is required (CI mints one per run)");
				if (!localOtpEnabled() && !process.env.E2E_GMAIL_APP_PASSWORD) {
					throw new Error("no OTP source: CI_E2E_LOCAL_OTP=1 LUMID_OTP_TRANSPORT=api (or E2E_GMAIL_APP_PASSWORD)");
				}
				user = await createUser(baseURL, {
					tag: `persona-ug-${Date.now().toString(36)}`,
					invitationCode: invite,
				});
				console.log(`[persona] account ${user.email}`);
				ctx = await browser.newContext({ baseURL, viewport: VIEWPORT });
				page = await ctx.newPage();
				// Native confirm() dialogs (Disable uses one) are ACCEPTED, like a
				// user clicking OK; the text is recorded. Playwright dismisses them
				// by default, which makes Disable look like a dead button.
				page.on("dialog", async (d) => {
					dialogs.push(d.message());
					await d.accept().catch(() => {});
				});
				// The login form sometimes paints late on a cold pod; one more
				// full attempt before calling the persona locked out.
				try {
					await loginViaUi(page, user);
				} catch {
					await loginViaUi(page, user);
				}
				await page.waitForTimeout(3_000);
			} catch (e) {
				acctErr = ((e as Error)?.message ?? String(e)).split("\n")[0].slice(0, 200);
				console.log(`[persona] account/login failed: ${acctErr}`);
			}
			const p = page as Page;
			const need = (cond: unknown, reason: string): { skip?: string } =>
				acctErr ? { skip: `no signed-in persona (${acctErr})` } : cond ? {} : { skip: reason };

			// ── J2 Choose ─────────────────────────────────────────────────
			let installed = false;
			await runStage(
				acctErr ? null : p,
				"J2",
				"Choose (Marketplace → Add to my account)",
				async (m) => {
					const mk = p.getByRole("link", { name: /^Marketplace$/ }).first();
					await m.click(mk, { measure: true });
					const search = p.locator('input[type="search"]').first();
					await search.waitFor({ state: "visible", timeout: 30_000 });
					await m.click(search);
					await search.fill("quant");
					const addBtn = p.getByRole("button", { name: "Add to my account" });
					// The result list re-renders as the search applies; wait until the
					// number of offered cards holds still for 3 s.
					let prev = -1;
					for (let i = 0, still = 0; i < 20 && still < 3; i++) {
						await p.waitForTimeout(1_000);
						const n = await addBtn.count();
						still = n === prev && n > 0 ? still + 1 : 0;
						prev = n;
					}
					// One card per "Add to my account" button: walk up from the button to
					// the nearest ancestor that also holds the card's "Details" link.
					const cards = await addBtn.evaluateAll((btns) =>
						btns.map((b) => {
							let cur: HTMLElement | null = b as HTMLElement;
							while (cur && !/Details/.test(cur.innerText)) cur = cur.parentElement;
							return (cur?.innerText ?? "").replace(/\s+/g, " ").trim();
						}),
					);
					const quantCards = cards.filter((c) => /quant/i.test(c));
					const qrCard = quantCards.find((c) => c.includes(APP_DISPLAY)) ?? "";
					const jargon = [...new Set((qrCard.match(JARGON) ?? []).map((x) => x.toLowerCase()))];
					m.details = {
						cards_offered: quantCards.map((c) => c.slice(0, 60)),
						quant_card_count: quantCards.length,
						quant_research_card_jargon: jargon,
					};
					const card = p
						.locator(":is(div,article,li)")
						.filter({ has: p.getByText(APP_DISPLAY, { exact: true }) })
						.filter({ has: addBtn })
						.last();
					const add = card.getByRole("button", { name: "Add to my account" }).first();
					await m.measure(add);
					await m.click(add);
					const tClick = Date.now();
					// Does the UI itself confirm, without a reload?
					const uiConfirms = await waitVisible(
						p.getByText(/Quant Research looks healthy|Your strategies|Strategies/).first(),
						30_000,
					);
					m.details.ui_after_click_url = p.url();
					m.details.ui_confirms_install_without_reload = uiConfirms;
					if (!uiConfirms) {
						m.details.ui_after_click_says = (await bodyText(p)).match(/No apps installed yet[^\n]*/)?.[0] ?? "";
					}
					let st = "";
					for (let i = 0; i < 60; i++) {
						st = await appStatus(p);
						if (/ready/i.test(st)) break;
						await p.waitForTimeout(3_000);
					}
					installed = /ready/i.test(st);
					m.details.install_status = st;
					m.details.install_ms = Date.now() - tClick;
					if (!uiConfirms && installed) {
						await p.goto(`/studio/apps/${APP}`, { waitUntil: "load" });
						m.details.needed_manual_navigation = true;
					}
					m.survives = await survivesReload(p, () => p.getByText(APP_DISPLAY));
					const exactlyOne = quantCards.length === 1;
					const ok = exactlyOne && jargon.length === 0 && installed;
					return {
						ok,
						why: ok
							? "one quant app, jargon-free card, installed"
							: [
									!exactlyOne ? `${quantCards.length} quant cards offered, not 1` : "",
									jargon.length ? `card jargon: ${jargon.join(", ")}` : "",
									!installed ? `install not ready (${st})` : "",
									!uiConfirms ? "UI did not confirm the install without a reload" : "",
								]
									.filter(Boolean)
									.join("; "),
					};
				},
				need(true, ""),
			);

			// ── J3 Learn ──────────────────────────────────────────────────
			await runStage(
				p,
				"J3",
				"Learn (Reading guide)",
				async (m) => {
					if (!/\/studio\/apps\//.test(p.url())) await p.goto(`/studio/apps/${APP}`, { waitUntil: "load" });
					const guide = p.getByRole("link", { name: /Reading guide/i }).first();
					await waitVisible(guide, 30_000);
					await m.click(guide, { measure: true });
					// The first <h1> in the layout is empty; the doc title is the first
					// one with text.
					const h1 = p.locator("h1").filter({ hasText: /\S/ }).first();
					await waitVisible(h1, 30_000);
					await p.waitForTimeout(1_500);
					const title = (await h1.innerText()).trim();
					const main = await p.locator("main").first().innerText().catch(() => bodyText(p));
					const idx = main.indexOf(title);
					const first = main.slice(idx >= 0 ? idx + title.length : 0).slice(0, 1200);
					const primer = /\bcontracts?\b|\bprices?\b|probabilit/i.test(first);
					const changelogFirst = /Changelog/i.test(first);
					m.details = { doc_url: p.url(), title, first_screen_excerpt: first.slice(0, 300), primer, changelog_before_content: changelogFirst };
					m.survives = await survivesReload(p, () => p.locator("h1").filter({ hasText: /\S/ }));
					const ok = primer && !changelogFirst;
					return {
						ok,
						why: ok
							? "first screen is a plain primer"
							: [changelogFirst ? "Changelog appears in the first screen, before content" : "", !primer ? "no primer (contract/price/probability) in the first ~1200 chars" : ""]
									.filter(Boolean)
									.join("; "),
					};
				},
				need(installed, "Quant Research is not installed (J2)"),
			);

			// ── J4 Generate (chat) ────────────────────────────────────────
			let v1: StratRow | null = null;
			await runStage(
				p,
				"J4",
				"Generate (chat writes + submits a strategy)",
				async (m) => {
					const before = new Set((await myStrategies(p)).strategies.map((s) => s.strategy_id));
					const nav = p
						.getByRole("link", { name: APP_DISPLAY, exact: true })
						.or(p.getByRole("button", { name: APP_DISPLAY, exact: true }))
						.first();
					if (await nav.count()) await m.click(nav);
					else await p.goto(`/studio/apps/${APP}?surface=strategies`);
					await p.waitForTimeout(3_000);
					const turn = await chatTurn(p, m, J4_PROMPT, CHAT_MS);
					// A registered row with a program_hash is the only proof it landed.
					let rows: { strategies: StratRow[]; rejected: any[] } = { strategies: [], rejected: [] };
					for (let i = 0; i < 36; i++) {
						rows = await myStrategies(p);
						v1 = rows.strategies.find((s) => !before.has(s.strategy_id) && s.program_hash) ?? null;
						if (v1) break;
						await p.waitForTimeout(5_000);
					}
					if (v1) created.push(v1);
					const submits = turn.toolCalls.filter((c) => /send_strategy|submit/i.test(`${c.name} ${c.args}`));
					const ans = turn.answer;
					const plain =
						ans.length > 200 &&
						/\bbuy/i.test(ans) &&
						/order flow|buying pressure|buyers|OFI/i.test(ans) &&
						/\b(when|if)\b/i.test(ans);
					m.details = {
						approvals_clicked: turn.approvals,
						compile_attempts: submits.length,
						rejected_rows: rows.rejected.length,
						tools: [...new Set(turn.tools)],
						tool_calls: turn.tools.length,
						stream_done: turn.done,
						stream_errors: turn.errors,
						chat_ms: turn.ms,
						answer_chars: ans.length,
						answer_excerpt: ans.slice(0, 400),
						registered: v1 ? { name: v1.name, strategy_id: v1.strategy_id, status: v1.status } : null,
					};
					m.survives = await survivesReload(p, () => p.getByText(ans.slice(0, 20) || "Your strategies"));
					const ok = turn.done && ans.length > 0 && !!v1 && plain;
					return {
						ok,
						why: ok
							? `registered ${v1!.name}, answer explains the rules (${Math.round(turn.ms / 1000)} s, ${submits.length} submit call(s))`
							: [
									!turn.done ? "stream never reached done" : "",
									!ans ? "no answer text" : "",
									!v1 ? "no new registered strategy in /me/strategies" : "",
									ans && !plain ? "answer does not explain the rules in plain English" : "",
								]
									.filter(Boolean)
									.join("; "),
					};
				},
				need(installed, "Quant Research is not installed (J2)"),
			);

			// ── J5 Test (Backtest → Poll result → strategy page) ──────────
			let result: BtRow | undefined;
			let stratUrl = "";
			await runStage(
				p,
				"J5",
				"Test (Backtest row action)",
				async (m) => {
					await p.goto(`/studio/apps/${APP}?surface=strategies`, { waitUntil: "load" });
					const row = p.locator("main table tbody tr").filter({ hasText: v1!.name }).first();
					await waitVisible(row, 60_000);
					await m.click(row.getByRole("button", { name: "Backtest" }), { measure: true });
					// The dialog: instrument left BLANK (the recommended auto-pick).
					const submit = p.getByRole("button", { name: "Submit", exact: true }).last();
					await waitVisible(submit, 15_000);
					await m.click(submit);
					const tSubmit = Date.now();
					const toast = await waitVisible(p.getByText(/Queued|queued|submitted|claim/i), 8_000);
					m.details.submit_confirmed_in_ui = toast;
					stratUrl = `/studio/apps/${APP}?surface=strategy&strategy_id=${v1!.strategy_id}`;
					// "Poll result" after ~1 minute, then read the strategy's own page.
					let polls = 0;
					let rows: BtRow[] = [];
					while (Date.now() - tSubmit < BT_POLL_MS) {
						await p.waitForTimeout(polls === 0 ? 65_000 : 60_000);
						if (!/surface=strategy&/.test(p.url())) {
							await p.goto(`/studio/apps/${APP}?surface=strategies`, { waitUntil: "load" });
						} else {
							await p.reload({ waitUntil: "load" });
						}
						const pr = p.getByRole("button", { name: "Poll result" }).first();
						if (await waitVisible(pr, 30_000)) {
							await m.click(pr);
							polls++;
						}
						await p.waitForTimeout(20_000);
						if (!/surface=strategy&/.test(p.url())) {
							const link = p.locator("main table tbody tr").filter({ hasText: v1!.name }).getByRole("link", { name: v1!.name }).first();
							if (await link.count()) await m.click(link);
							else await p.goto(stratUrl, { waitUntil: "load" });
						} else {
							await p.reload({ waitUntil: "load" });
						}
						await waitVisible(p.getByText("Backtests for this strategy"), 30_000);
						await p.waitForTimeout(3_000);
						rows = await honestyRows(p);
						result = resultRow(rows);
						if (result) break;
					}
					m.details.polls_clicked = polls;
					m.details.seconds_to_result = result ? Math.round((Date.now() - tSubmit) / 1000) : null;
					m.details.rows_seen = rows.length;
					if (result) {
						await m.measure(p.locator("table").filter({ hasText: "Presentable?" }).locator("tbody tr").filter({ hasText: result.Prices }).first());
						m.survives = await survivesReload(p, () => p.getByText("Backtests for this strategy"));
					}
					const axes = result
						? { prices: result.Prices, signals: result.Signals, settlement: result.Settlement }
						: null;
					m.details.axes = axes;
					m.details.instrument = result?.Instrument ?? null;
					const allStated = !!axes && filled(axes.prices) && filled(axes.signals) && filled(axes.settlement);
					const ok = !!result && allStated;
					return {
						ok,
						why: ok
							? `result on the strategy page in ${m.details.seconds_to_result}s: prices=${axes!.prices} signals=${axes!.signals} settlement=${axes!.settlement}`
							: !result
								? `no result on the strategy page within ${Math.round(BT_POLL_MS / 60000)} min (${polls} poll clicks)`
								: "result row does not state all three axes",
					};
				},
				need(v1, "no strategy was registered in J4"),
			);

			// ── J6 Judge ──────────────────────────────────────────────────
			await runStage(
				p,
				"J6",
				"Judge (is the result any good?)",
				async (m) => {
					const presentable = result!["Presentable?"];
					const why = result!.Why;
					const hasPresentable = filled(presentable);
					const hasWhy = filled(why);
					const quality = /good|bad|profit|loss|beat|baseline|significan|edge|noise|too few|sample/i.test(why ?? "");
					m.details = {
						presentable,
						why_text: why,
						pnl_real: result!["PnL (REAL)"],
						filled_lots: result!["Filled lots"],
						why_speaks_to_performance: quality,
					};
					m.survives = await survivesReload(p, () => p.getByText("Presentable?"));
					const ok = hasPresentable && hasWhy;
					return {
						ok,
						why: ok
							? `Presentable?=${presentable}; Why: "${(why ?? "").slice(0, 120)}"${quality ? "" : " (says whether the data was real, not whether the result is good)"}`
							: `Presentable?/Why not populated for this run (${presentable || "—"} / ${why || "—"})`,
					};
				},
				need(result, "no backtest result (J5)"),
			);

			// ── J7 Iterate / manage ───────────────────────────────────────
			await runStage(
				p,
				"J7",
				"Iterate (source · new version · compare)",
				async (m) => {
					await p.goto(`/studio/apps/${APP}?surface=strategy&strategy_id=${v1!.strategy_id}`, { waitUntil: "load" });
					await waitVisible(p.getByText("Backtests for this strategy"), 30_000);
					await p.waitForTimeout(2_000);
					// The chat rail shares the page, and J4's conversation in it
					// quotes the source — so read only the strategy surface.
					const txt = await surfaceText(p, "Backtests for this strategy");
					const sourceVisible = new RegExp(`strategy\\s+${v1!.name}\\s*\\{`).test(txt) || /\bwhen\s+\w+[^\n]*\{|signal\("/.test(txt);
					const newVersion = (await p.getByRole("button", { name: /new version|edit|fork|duplicate|revise/i }).count()) > 0 ||
						(await p.getByRole("link", { name: /new version|edit|fork|revise/i }).count()) > 0;
					const compare = (await p.getByRole("button", { name: /compare|diff/i }).count()) > 0 ||
						(await p.getByRole("link", { name: /compare|diff/i }).count()) > 0;
					m.survives = await survivesReload(p, () => p.getByText("Backtests for this strategy"));
					m.details = { source_visible: sourceVisible, new_version_in_ui: newVersion, compare_in_ui: compare };
					const uiOk = sourceVisible && newVersion && compare;
					if (!uiOk) {
						// Fall back to chat, from the strategy's own page.
						const before = new Set((await myStrategies(p)).strategies.map((s) => s.strategy_id));
						const turn = await chatTurn(p, m, J7_PROMPT, CHAT_MS);
						let v2: StratRow | null = null;
						for (let i = 0; i < 24 && !v2; i++) {
							v2 = (await myStrategies(p)).strategies.find((s) => !before.has(s.strategy_id) && s.program_hash) ?? null;
							if (!v2) await p.waitForTimeout(5_000);
						}
						if (v2) created.push(v2);
						const compared = /v1[\s\S]{0,400}v2|v2[\s\S]{0,400}v1/i.test(turn.answer) && /compar|vs\.?|versus|same market/i.test(turn.answer);
						m.details.chat = {
							v2_registered: v2 ? v2.name : null,
							answer_compares: compared,
							approvals_clicked: turn.approvals,
							stream_done: turn.done,
							chat_ms: turn.ms,
							tools: [...new Set(turn.tools)],
							answer_excerpt: turn.answer.slice(0, 400),
						};
						m.details.chat_succeeded = !!v2 && compared;
					}
					const missing = [!sourceVisible && "source", !newVersion && "new-version", !compare && "compare"].filter(Boolean);
					return {
						ok: uiOk,
						why: uiOk
							? "source, new-version and compare all in the UI"
							: `UI missing: ${missing.join(", ")}; chat fallback ${m.details.chat_succeeded ? "succeeded" : "did not succeed"} (v2 ${(m.details.chat as any)?.v2_registered ? "registered" : "not registered"}, compare ${(m.details.chat as any)?.answer_compares ? "given" : "not given"})`,
					};
				},
				need(v1, "no strategy was registered in J4"),
			);

			// ── J8 Watch runs ─────────────────────────────────────────────
			await runStage(
				p,
				"J8",
				"Watch runs (Workflows → Backtest → latest run → step output)",
				async (m) => {
					await p.goto(`/studio/apps/${APP}?surface=strategies`, { waitUntil: "load" });
					await p.waitForTimeout(3_000);
					await m.click(p.getByRole("link", { name: /^Workflows$/ }).first(), { measure: true });
					const bt = p.getByRole("button", { name: /^Backtest(?! poll)\b/ }).first();
					await waitVisible(bt, 30_000);
					await m.click(bt, { measure: true });
					await p.waitForTimeout(5_000);
					const nodes = p.locator(".react-flow__node").filter({ hasText: /^v\d+/ });
					await waitVisible(nodes, 30_000);
					const labels = await nodes.evaluateAll((es) => es.map((e) => (e as HTMLElement).innerText.trim().split(/\s+/)[0]));
					let best = 0;
					labels.forEach((l, i) => {
						if (Number(l.slice(1)) > Number(labels[best].slice(1))) best = i;
					});
					const latest = nodes.nth(best);
					m.details.runs_in_tree = labels.length;
					m.details.latest_run = labels[best] ?? null;
					await m.measure(latest);
					await latest.hover();
					const open = latest.locator('button[title^="Open this run"]');
					if (await open.count()) await m.click(open);
					else await m.click(latest);
					await p.waitForTimeout(6_000);
					// A step's OUTPUT, not its declaration: stdout/stderr/log text or an
					// output/result block for a stage of THIS run.
					const out = p.getByText(STEP_OUTPUT).first();
					const reached = await waitVisible(out, 5_000);
					if (reached) {
						await m.measure(out);
						m.survives = await survivesReload(p, () => p.getByText(STEP_OUTPUT));
					} else {
						m.survives = await survivesReload(p, () => p.locator(".react-flow__node").filter({ hasText: labels[best] ?? "v" }));
						m.details.url_after_open = p.url();
						m.details.url_encodes_run = /cycle=|run=/.test(p.url());
					}
					const http = (m.errors ?? []).length;
					const ok = reached && m.clicks <= 3 && http === 0 && (m.px ?? 0) === 0 && m.survives === true;
					return {
						ok,
						why: ok
							? "step output reached within budget"
							: [
									!reached ? "no step output reachable (run pipeline shows the declared DAG, not this run's per-step output)" : "",
									m.clicks > 3 ? `${m.clicks} clicks` : "",
									http ? `${http} HTTP error(s): ${[...new Set(m.errors)].slice(0, 2).join(" | ")}` : "",
									(m.px ?? 0) > 0 ? `run tree ${m.px}px below the fold` : "",
									m.survives === false ? "state lost on reload" : "",
								]
									.filter(Boolean)
									.join("; "),
					};
				},
				need(installed, "Quant Research is not installed (J2)"),
			);

			// ── J9 Stop ───────────────────────────────────────────────────
			await runStage(
				p,
				"J9",
				"Stop (Disable row action)",
				async (m) => {
					await p.goto(`/studio/apps/${APP}?surface=strategies`, { waitUntil: "load" });
					const mine = (await myStrategies(p)).strategies.filter((s) => s.status !== "disabled");
					const confirms: Record<string, string> = {};
					const dialogStart = dialogs.length;
					for (const s of mine) {
						const row = p.locator("main table tbody tr").filter({ hasText: s.name }).first();
						if (!(await waitVisible(row, 60_000))) {
							confirms[s.name] = "row not visible";
							continue;
						}
						await m.click(row.getByRole("button", { name: "Disable" }), { measure: true });
						m.clicks++; // the confirm() OK
						const toastLoc = p.getByText(/Queued strategy\.disable/i).first();
						const toast = await waitVisible(toastLoc, 10_000);
						confirms[s.name] = toast ? ((await toastLoc.innerText().catch(() => "")) || "toast").slice(0, 140) : "no toast";
						await p.waitForTimeout(2_000);
					}
					// Does the row itself show disabled?
					let statusShown = false;
					for (let i = 0; i < 12 && mine.length; i++) {
						await p.reload({ waitUntil: "load" });
						await p.waitForTimeout(5_000);
						const statuses = await p.locator("main table tbody tr").filter({ hasText: mine[0].name }).first().innerText().catch(() => "");
						if (/disabled/i.test(statuses)) {
							statusShown = true;
							break;
						}
					}
					const dialogText = dialogs.slice(dialogStart);
					const explains = dialogText.some((d) => /keeps going|until restart|immediately|will not load|stops/i.test(d));
					const immediate = dialogText.some((d) => /immediately/i.test(d)) && !dialogText.some((d) => /keeps going|until restart/i.test(d));
					const after = (await myStrategies(p)).strategies;
					m.details = {
						disabled: mine.map((s) => s.name),
						toast_on_click: confirms,
						confirm_dialog: dialogText[0] ?? null,
						row_status_shows_disabled: statusShown,
						api_status_after: Object.fromEntries(after.map((s) => [s.name, s.status])),
						stop_is_immediate: immediate,
					};
					m.survives = statusShown;
					const confirmed = mine.length > 0 && statusShown;
					const ok = confirmed && explains;
					return {
						ok,
						why: ok
							? `disabled ${mine.length}; UI says: "${(dialogText[0] ?? "").slice(0, 140)}"`
							: [
									!mine.length ? "nothing to disable" : "",
									!confirmed ? "UI did not confirm disabled" : "",
									!explains ? "UI does not explain what disable does" : "",
								]
									.filter(Boolean)
									.join("; "),
					};
				},
				need(created.length, "the persona created no strategy"),
			);
		} finally {
			// ── cleanup: disable anything still active, revoke tokens, delete ─
			if (page && user) {
				try {
					const left = (await myStrategies(page)).strategies.filter((s) => s.status !== "disabled");
					for (const s of left) {
						await page.goto(`/studio/apps/${APP}?surface=strategies`, { waitUntil: "load" }).catch(() => {});
						const row = page.locator("main table tbody tr").filter({ hasText: s.name }).first();
						if (await waitVisible(row, 60_000)) {
							await row.getByRole("button", { name: "Disable" }).click().catch(() => {});
							await page.waitForTimeout(3_000);
						}
					}
					let active: StratRow[] = [];
					for (let i = 0; i < 12; i++) {
						active = (await myStrategies(page)).strategies.filter((s) => s.status !== "disabled");
						if (!active.length) break;
						await page.waitForTimeout(5_000);
					}
					const all = (await myStrategies(page)).strategies;
					cleanup.strategies = Object.fromEntries(all.map((s) => [s.name, s.status]));
					cleanup.strategies_all_disabled = active.length === 0;
				} catch (e) {
					cleanup.strategies_error = String(e).slice(0, 200);
				}
				try {
					const r = await page.request.get("/api/v1/identity/personal-access-tokens");
					const toks: any[] = (await r.json())?.data?.tokens ?? [];
					let revoked = 0;
					for (const t of toks) {
						const d = await page.request.delete(`/api/v1/identity/personal-access-tokens/${t.id}`);
						if (d.ok()) revoked++;
					}
					cleanup.tokens_revoked = `${revoked}/${toks.length}`;
				} catch (e) {
					cleanup.tokens_error = String(e).slice(0, 200);
				}
			}
			await ctx?.close().catch(() => {});
			if (user) {
				// Server-side, with the admin credential — never in the browser.
				cleanup.account_deleted = await deleteUser(baseURL, user.email);
			}
			const summary = {
				at,
				account: user?.email ?? null,
				stages,
				failed_count: stages.filter((s) => !s.ok).length,
				cleanup,
			};
			fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
			fs.writeFileSync(OUT_JSON, JSON.stringify(summary, null, 2));
			console.log(`\n[persona] summary → ${OUT_JSON}\n${JSON.stringify(summary, null, 2)}`);
		}
	});
});

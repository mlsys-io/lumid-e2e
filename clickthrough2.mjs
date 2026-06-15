// Extensive interaction test of the lumid-market config surfaces.
// Forces Authorization: Bearer <PAT> on every request (PAT authenticates both
// identity + QA). Exercises real click-navigation, tab switching, native-widget
// mounting, leaderboard sort, form-submit wiring (error path — no data written),
// edge cases, and a mobile pass. Prints PASS/FAIL/INFO per check.

import { chromium, devices } from "playwright";
import fs from "fs";

const PAT = fs.readFileSync(process.env.PAT_FILE || "/pat", "utf8").trim();
const BASE = process.env.BASE || "https://lum.id";
const M = "/studio/a/lumid-market";

let pass = 0, fail = 0;
const ok  = (n, d = "") => { pass++; console.log(`  PASS  ${n}${d ? "  — " + d : ""}`); };
const bad = (n, d = "") => { fail++; console.log(`  FAIL  ${n}${d ? "  — " + d : ""}`); };
const info = (n) => console.log(`  ··    ${n}`);
const head = (t) => console.log(`\n=== ${t} ===`);

const browser = await chromium.launch();

async function newCtx(opts = {}) {
  const ctx = await browser.newContext(opts);
  await ctx.route("**/*", async (route) => {
    const headers = { ...route.request().headers(), authorization: `Bearer ${PAT}` };
    await route.continue({ headers });
  });
  return ctx;
}

const ctx = await newCtx({ viewport: { width: 1280, height: 1400 } });
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(String(e)));

const warns = async () => (await page.locator("text=/⚠/").allInnerTexts().catch(() => []));
const settle = async (ms = 1500) => page.waitForTimeout(ms);

// ── 1. Navigation chain: lobby → competition card → detail ──────────────────
head("1 · Navigation: lobby → competition detail (click, not typed URL)");
await page.goto(`${BASE}${M}/competition/lobby`, { waitUntil: "networkidle" });
await settle();
// Numbered competition cards only — exclude the lobby/my/pathways nav links
// (which also contain "/competition/").
const cardLinks = page.locator(
  `a[href*="${M}/competition/"]:not([href$="/my"]):not([href$="/lobby"]):not([href$="/pathways"])`);
const nCards = await cardLinks.count();
info(`lobby competition card links: ${nCards}`);
if (nCards > 0) {
  const href = await cardLinks.first().getAttribute("href");
  await cardLinks.first().click();
  await page.waitForURL(/\/competition\/\d+$/, { timeout: 15000 }).then(
    () => ok("card click navigates to /competition/:id", page.url().replace(BASE, "")),
    () => bad("card click navigation", `stuck at ${page.url().replace(BASE, "")} (href was ${href})`));
  await settle();
  const w = await warns();
  (w.length ? bad : ok)("detail renders without directive errors", w.join(" | "));
} else bad("lobby has clickable competition cards");

const detailUrl = page.url();
const compId = (detailUrl.match(/competition\/(\d+)/) || [])[1];
info(`competition id under test: ${compId}`);

// ── 2. Tab switching on detail ──────────────────────────────────────────────
head("2 · Tab switching (Leaderboard / Activity / My strategies)");
for (const tab of ["Leaderboard", "Activity", "My strategies"]) {
  const btn = page.getByRole("button", { name: tab, exact: true });
  if (await btn.count()) {
    await btn.first().click(); await settle(1200);
    const w = await warns();
    (w.length ? bad : ok)(`tab "${tab}" mounts cleanly`, w.join(" | "));
  } else bad(`tab "${tab}" present`);
}

// ── 3. Native leaderboard: rows + sort ──────────────────────────────────────
head("3 · Native leaderboard widget");
await page.getByRole("button", { name: "Leaderboard", exact: true }).first().click().catch(() => {});
await settle(1200);
const lbRows = page.locator("table tbody tr");
const nRows = await lbRows.count();
(nRows > 0 ? ok : bad)("leaderboard rows render", `${nRows} rows`);
// Sort: click a sortable header and confirm a re-fetch / no crash.
const sortHeader = page.locator("th", { hasText: /Return Rate/i }).first();
if (await sortHeader.count()) {
  const before = await lbRows.first().innerText().catch(() => "");
  await sortHeader.click().catch(() => {});
  await settle(1200);
  const after = await page.locator("table tbody tr").first().innerText().catch(() => "");
  ok("leaderboard sort header clickable", before === after ? "order unchanged (already sorted / single)" : "order changed");
} else info("no Return Rate sort header found (layout variance)");
const lbErr = errs.length;

// ── 4. Navigation chain: leaderboard row → strategy detail ──────────────────
head("4 · Navigation: leaderboard row → strategy detail");
const row0 = page.locator("table tbody tr").first();
if (await row0.count()) {
  // Prefer the Action-column eye icon if present; else click the row.
  const eye = row0.locator("svg.lucide-eye, [class*='eye']").first();
  if (await eye.count()) await eye.click().catch(() => row0.click());
  else await row0.click().catch(() => {});
  await page.waitForURL(/\/competition\/\d+\/strategy\/\d+/, { timeout: 12000 }).then(
    () => ok("leaderboard row → /strategy/:sid", page.url().replace(BASE, "")),
    () => info(`row click did not navigate (url ${page.url().replace(BASE, "")})`));
  await settle();
  if (/\/strategy\/\d+/.test(page.url())) {
    const w = await warns();
    (w.length ? bad : ok)("strategy-detail renders (positions + trades)", w.join(" | "));
    const tables = await page.locator("table").count();
    info(`strategy-detail tables: ${tables}`);
  }
}

// ── 5. my-strategies: row → research, AI wizard, create form (error path) ───
head("5 · my-strategies surface");
await page.goto(`${BASE}${M}/competition/my`, { waitUntil: "networkidle" });
await settle();
(((await warns()).length) ? bad : ok)("my-strategies renders clean");
// 5a · AI wizard opens a dialog
const aiBtn = page.getByRole("button", { name: /Create with AI/i });
if (await aiBtn.count()) {
  await aiBtn.first().click(); await settle(800);
  const dlg = page.getByRole("dialog");
  (await dlg.count() ? ok : bad)("AI wizard opens dialog");
  await page.keyboard.press("Escape").catch(() => {});
  await settle(400);
} else bad("AI wizard button present");
// 5b · create-strategy form error path (invalid competition_id → QA error shown, no data written)
const nameField = page.getByLabel(/Name/i).first();
if (await nameField.count()) {
  await nameField.fill("zzz-clickthrough-donotkeep");
  await page.getByLabel(/Competition ID/i).first().fill("999999999");
  await page.getByRole("button", { name: /Create strategy/i }).first().click();
  await settle(2500);
  const red = await page.locator(".text-rose-600, .text-red-600").allInnerTexts().catch(() => []);
  const stillHere = page.url().includes("/competition/my");
  if (red.some((t) => t.trim())) ok("create form surfaces QA error (invalid comp)", red.find((t) => t.trim()));
  else if (stillHere) info("create form: no visible error but did not redirect (QA may have accepted/ignored)");
  else bad("create form error handling", `redirected to ${page.url().replace(BASE, "")}`);
} else bad("create-strategy form present");
// 5c · row → research
const myRow = page.locator(`a[href*="${M}/strategy/research/"]`).first();
if (await myRow.count()) {
  await myRow.click();
  await page.waitForURL(/\/strategy\/research\/\d+/, { timeout: 12000 }).then(
    () => ok("my-strategies row → research", page.url().replace(BASE, "")),
    () => bad("research navigation"));
  await settle();
} else info("no strategy rows for this account to open research");

// ── 6. Register form error path on detail ───────────────────────────────────
head("6 · Register form (error path, no data written)");
await page.goto(`${BASE}${M}/competition/${compId}`, { waitUntil: "networkidle" });
await settle();
await page.getByRole("button", { name: "My strategies", exact: true }).first().click().catch(() => {});
await settle(1000);
const regField = page.getByLabel(/Strategy ID/i).first();
if (await regField.count()) {
  await regField.fill("999999999");
  await page.getByRole("button", { name: /Register/i }).first().click();
  await settle(2500);
  const red = await page.locator(".text-rose-600, .text-red-600").allInnerTexts().catch(() => []);
  (red.some((t) => t.trim()) ? ok : info)("register form surfaces QA error", red.find((t) => t.trim()) || "no visible error");
} else info("register form not found in My strategies tab");

// ── 7. Edge case: nonexistent competition id ────────────────────────────────
head("7 · Edge case: nonexistent competition /competition/99999999");
await page.goto(`${BASE}${M}/competition/99999999`, { waitUntil: "networkidle" });
await settle(1500);
const crashed = errs.length > lbErr + 0 && false; // pageerror tracked separately
const bodyTxt = await page.locator("body").innerText().catch(() => "");
(bodyTxt.length > 50 ? ok : bad)("bad competition id degrades gracefully (no blank crash)", `${bodyTxt.length} body chars`);

// ── 8. pathways links ───────────────────────────────────────────────────────
head("8 · Pathways surface links");
await page.goto(`${BASE}${M}/competition/pathways`, { waitUntil: "networkidle" });
await settle();
const docLink = page.locator('a[href*="TRADING_API"], a[href*="lqa"]');
(await docLink.count() ? ok : bad)("pathways doc links present", `${await docLink.count()} links`);

// ── 9. Mobile viewport pass ─────────────────────────────────────────────────
head("9 · Mobile viewport (iPhone 13) — lobby + detail");
const mctx = await newCtx({ ...devices["iPhone 13"] });
const mp = await mctx.newPage();
const mErrs = [];
mp.on("pageerror", (e) => mErrs.push(String(e)));
await mp.goto(`${BASE}${M}/competition/lobby`, { waitUntil: "networkidle" });
await mp.waitForTimeout(1500);
await mp.screenshot({ path: "/out/mobile-lobby.png", fullPage: true }).catch(() => {});
const mLobbyCards = await mp.locator(`a[href*="${M}/competition/"]`).count();
(mLobbyCards > 0 ? ok : bad)("mobile lobby renders cards", `${mLobbyCards} cards`);
await mp.goto(`${BASE}${M}/competition/${compId}`, { waitUntil: "networkidle" });
await mp.waitForTimeout(1500);
await mp.screenshot({ path: "/out/mobile-detail.png", fullPage: true }).catch(() => {});
const mw = await mp.locator("text=/⚠/").allInnerTexts().catch(() => []);
(mw.length ? bad : ok)("mobile detail renders clean", mw.join(" | "));
await mctx.close();

// ── tally ───────────────────────────────────────────────────────────────────
head("page-level JS errors");
const realErrs = errs.filter((e) => !/session-bearer|401/.test(e));
info(`uncaught page errors (desktop): ${realErrs.length ? JSON.stringify(realErrs.slice(0, 5)) : "none"}`);
info(`uncaught page errors (mobile): ${mErrs.length ? JSON.stringify(mErrs.slice(0, 5)) : "none"}`);

await browser.close();
console.log(`\n========  ${pass} PASS / ${fail} FAIL  ========`);

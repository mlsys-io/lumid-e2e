// Reachability round: visit every Studio path + click every SAFE clickable,
// capturing console errors, page crashes, directive ⚠ widgets, and 4xx/5xx.
// Authed via operator PAT (forced Bearer). Skips destructive actions.
import { chromium } from "playwright";
import fs from "fs";

const PAT = fs.readFileSync(process.env.PAT_FILE || "/pat", "utf8").trim();
const BASE = process.env.BASE || "https://lum.id";

const SEED = [
  "/studio", "/studio/apps", "/studio/library", "/studio/library/marketplace",
  "/studio/library/skills", "/studio/library/experiments", "/studio/runs",
  "/studio/knowledge", "/studio/inbox", "/studio/settings", "/studio/how", "/studio/manage",
  "/studio/account/profile", "/studio/account/tokens",
  "/studio/apps/mbb-ai?full=1", "/studio/apps/auto-quant?full=1", "/studio/apps/personal-agent?full=1",
  "/studio/a/lumid-gpu-rentals?full=1", "/studio/a/lumid-gpu-rentals/new",
  "/studio/a/auto-quant?full=1", "/studio/a/mbb-ai?full=1", "/studio/a/personal-agent?full=1",
  "/studio/a/lumid-market/competition/lobby", "/studio/a/lumid-market/competition/my",
  "/studio/a/lumid-market/competition/pathways",
  "/dashboard/jobs", "/dashboard/admin", "/dashboard/admin/users", "/dashboard/admin/clusters",
];
const DESTRUCTIVE = /delete|remove|uninstall|run ?now|run cycle|^send$|send |schedule|cancel|pause|resume|install|approve|deny|discard|dismiss|stop|rent|create|submit|revoke|sign ?out|log ?out|disconnect|reset|publish|propose|\bfork\b|retry|generate|connect|edit|save|\bnew\b/i;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.route("**/*", (r) => r.continue({ headers: { ...r.request().headers(), authorization: `Bearer ${PAT}` } }));
const page = await ctx.newPage();

const seen = new Set();
const queue = [...SEED];
const routeReport = [];
const clickIssues = [];

let curBad = [];
page.on("console", (m) => { if (m.type() === "error") curBad.push("console:" + m.text().slice(0, 90)); });
page.on("pageerror", (e) => curBad.push("crash:" + String(e).slice(0, 90)));
page.on("response", (r) => {
  const u = r.url();
  if (/\/api\/v1\//.test(u) && r.status() >= 400 && !/session-bearer|google-access-token/.test(u))
    curBad.push(`http${r.status()}:` + u.replace(BASE, "").slice(0, 70));
});

async function load(path) {
  curBad = [];
  await page.goto(BASE + path, { waitUntil: "domcontentloaded", timeout: 30000 }).catch((e) => curBad.push("goto:" + e.message.slice(0, 50)));
  await page.waitForTimeout(2200);
}

let visited = 0;
while (queue.length && visited < 60) {
  let path = queue.shift();
  if (!path || seen.has(path)) continue;
  seen.add(path); visited++;
  await load(path);
  const warns = await page.locator("text=/⚠/").count().catch(() => 0);
  const url = page.url().replace(BASE, "");
  const loginBounce = url.includes("/auth/login");
  routeReport.push({ path, url, warns, bad: [...new Set(curBad)], loginBounce });
  // discover internal /studio links
  const links = await page.$$eval('a[href^="/studio"], a[href^="/dashboard"]', (as) => as.map((a) => a.getAttribute("href"))).catch(() => []);
  for (const l of links) { const c = (l || "").split("#")[0]; if (c && !seen.has(c) && queue.length < 120) queue.push(c); }
}

// Click phase — safe buttons/tabs/[role=button] on the core studio pages.
const CLICK_PAGES = ["/studio/apps", "/studio/library/marketplace", "/studio/library/skills",
  "/studio/library/experiments", "/studio/runs", "/studio/inbox", "/studio/settings", "/studio/knowledge"];
for (const path of CLICK_PAGES) {
  await load(path);
  const handles = await page.$$('button:not([disabled]), [role="button"], [role="tab"]').catch(() => []);
  let clicked = 0;
  for (let i = 0; i < handles.length && clicked < 22; i++) {
    let label = "";
    try { label = ((await handles[i].innerText().catch(() => "")) || (await handles[i].getAttribute("aria-label").catch(() => "")) || "").trim().slice(0, 40); } catch { continue; }
    if (!label || DESTRUCTIVE.test(label)) continue;
    curBad = [];
    try {
      await handles[i].click({ timeout: 2500, trial: false });
      await page.waitForTimeout(500);
    } catch (e) { /* not clickable / detached — skip */ continue; }
    clicked++;
    const nb = [...new Set(curBad)];
    if (nb.length) clickIssues.push({ page: path, label, bad: nb });
    // If the click navigated away, return to the page to keep clicking it.
    if (!page.url().includes(path.split("?")[0])) await load(path);
  }
}

await browser.close();

// ── Report ──
const badRoutes = routeReport.filter((r) => r.bad.length || r.warns || r.loginBounce);
console.log(`\n=== PATHS: ${routeReport.length} visited, ${badRoutes.length} with issues ===`);
for (const r of routeReport) {
  const flag = r.loginBounce ? "LOGIN-BOUNCE" : r.bad.length ? r.bad.join(" | ") : r.warns ? `${r.warns}⚠` : "ok";
  console.log(`  ${r.path.padEnd(46)} ${flag === "ok" ? "ok" : "✗ " + flag}`);
}
console.log(`\n=== CLICKS: ${clickIssues.length} issues ===`);
for (const c of clickIssues) console.log(`  [${c.page}] "${c.label}" -> ${c.bad.join(" | ")}`);
console.log("\nDONE");

import { chromium } from "@playwright/test";
import { writeFileSync } from "fs";

const BASE_URL = process.env.BASE_URL || "http://localhost:13080";
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL || "admin@lum.id";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD || "admin123";

const PAGES = [
  { path: "/auth/login",              name: "Login page" },
  { path: "/auth/register",           name: "Register page" },
  { path: "/docs/xpio-autoresearch",  name: "XPio docs (public)" },
  { path: "/account",                 name: "Account overview" },
  { path: "/account/profile",         name: "Profile" },
  { path: "/account/tokens",          name: "Tokens / PATs" },
  { path: "/account/connect",         name: "Connect apps" },
  { path: "/account/connect/google",  name: "Connect Google" },
  { path: "/account/inbox",           name: "Inbox" },
  { path: "/dashboard/super-admin",   name: "Super-admin dashboard" },
  { path: "/app/auto-quant",          name: "Auto-quant app" },
  { path: "/dashboard/quant",         name: "Quant dashboard" },
  { path: "/dashboard/competitions",  name: "Competitions" },
  { path: "/dashboard/datasets/findata", name: "FinData datasets" },
  { path: "/account/admin-hub",       name: "Admin hub" },
  { path: "/account/admin/invitations", name: "Admin invitations" },
];

async function scanPage(page, url, name) {
  const result = { name, url, status: "ok", httpErrors: [], consoleErrors: [],
    missingElements: [], visibleErrors: [], failedRequests: [], redirectedTo: null };

  const consoleErrs = [];
  const failedReqs = [];

  const onConsole = (msg) => { if (msg.type() === "error") consoleErrs.push(msg.text().slice(0, 200)); };
  const onFail = (req) => { if (req.url().startsWith("http")) failedReqs.push({ url: req.url().slice(0, 120), failure: req.failure()?.errorText }); };

  page.on("console", onConsole);
  page.on("requestfailed", onFail);

  try {
    await page.goto(url, { timeout: 20000, waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1800);

    const finalUrl = page.url();
    const expectedPath = new URL(url).pathname;
    if (!finalUrl.includes(expectedPath)) {
      result.redirectedTo = finalUrl.replace(BASE_URL, "");
    }

    if (await page.locator("text=/Something went wrong|Unexpected application error|ChunkLoadError/i").count() > 0)
      result.visibleErrors.push("React error boundary triggered");

    const bodyText = await page.locator("body").innerText().catch(() => "");
    if (bodyText.trim().length < 40)
      result.visibleErrors.push("Page appears blank");

    if (await page.locator("text=/Page not found|404 Not Found/i").count() > 0)
      result.visibleErrors.push("404 visible");

    // Page-specific checks
    if (url.includes("/auth/login") && await page.locator("button", { hasText: /sign in/i }).count() === 0)
      result.missingElements.push("Sign in button");
    if (url.includes("/dashboard/super-admin") && await page.locator("text=/super.admin|operational health/i").count() === 0)
      result.missingElements.push("super-admin heading");
    if (url.includes("/app/auto-quant") && await page.locator("text=/auto.quant|strategy|loop/i").count() === 0)
      result.missingElements.push("auto-quant content");
    if (url.includes("/docs/xpio-autoresearch") && await page.locator("text=/Pattern A|Pattern B|autoresearch/i").count() === 0)
      result.missingElements.push("docs content");
    if (url.includes("/account/tokens") && await page.locator("text=/Personal Access|OAuth|token/i").count() === 0)
      result.missingElements.push("token content");
    if (url.includes("/account/connect/google") && await page.locator("text=/Gmail|Google|Calendar/i").count() === 0)
      result.missingElements.push("Google connect content");

    result.consoleErrors = consoleErrs.filter(e => !e.includes("favicon") && !e.includes("gstatic"));
    result.failedRequests = failedReqs.filter(r => !r.url.includes("googleapis") && !r.url.includes("favicon"));

    if (result.visibleErrors.length || result.missingElements.length || result.consoleErrors.length > 1)
      result.status = "issues";
  } catch (err) {
    result.status = "error";
    result.errorMessage = err.message.slice(0, 200);
  }

  page.off("console", onConsole);
  page.off("requestfailed", onFail);
  return result;
}

async function main() {
  console.log(`\n🔍  Lumid Dashboard Scanner\n    Target: ${BASE_URL}\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ baseURL: BASE_URL, ignoreHTTPSErrors: true });
  const page = await context.newPage();

  console.log("🔐  Logging in as admin...");
  try {
    await page.goto("/auth/login", { waitUntil: "domcontentloaded" });
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL);
    await page.getByLabel(/password/i, { exact: false }).first().fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL(/\/(account|dashboard)/, { timeout: 15000 });
    console.log(`    ✅  Logged in — ${page.url().replace(BASE_URL, "")}\n`);
  } catch (err) {
    console.log(`    ❌  Login failed: ${err.message}\n`);
    await browser.close();
    process.exit(1);
  }

  const results = [];
  for (const spec of PAGES) {
    const url = `${BASE_URL}${spec.path}`;
    process.stdout.write(`  ${spec.name.padEnd(35)} `);
    const r = await scanPage(page, url, spec.name);
    results.push(r);

    const icon = r.status === "ok" ? "✅" : r.status === "issues" ? "⚠️ " : "❌";
    let detail = "";
    if (r.redirectedTo) detail += ` → ${r.redirectedTo}`;
    if (r.visibleErrors.length) detail += ` | ${r.visibleErrors.join("; ")}`;
    if (r.missingElements.length) detail += ` | missing: ${r.missingElements.join(", ")}`;
    if (r.consoleErrors.length) detail += ` | ${r.consoleErrors.length} console err(s)`;
    if (r.failedRequests.length) detail += ` | ${r.failedRequests.length} failed req(s)`;
    if (r.errorMessage) detail += ` | ${r.errorMessage}`;
    console.log(`${icon}${detail}`);
  }

  writeFileSync("/tmp/dashboard_scan_report.json", JSON.stringify(results, null, 2));

  const issues = results.filter(r => r.status !== "ok");
  console.log(`\n${"━".repeat(50)}`);
  console.log(`Pages scanned: ${results.length}  |  Issues: ${issues.length}`);
  if (issues.length) {
    console.log("\n🔴  Pages needing attention:");
    for (const r of issues) {
      console.log(`\n  ${r.name} (${r.url.replace(BASE_URL, "")})`);
      if (r.visibleErrors.length) console.log(`    Visible: ${r.visibleErrors.join("; ")}`);
      if (r.missingElements.length) console.log(`    Missing: ${r.missingElements.join(", ")}`);
      r.consoleErrors.slice(0, 4).forEach(e => console.log(`    Console: ${e.slice(0, 160)}`));
      r.failedRequests.slice(0, 3).forEach(req => console.log(`    Failed req: ${req.url} (${req.failure || "net"})`));
      if (r.errorMessage) console.log(`    Error: ${r.errorMessage}`);
    }
  } else {
    console.log("\n✅  All pages loaded without issues.");
  }

  await browser.close();
  process.exit(issues.length > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });

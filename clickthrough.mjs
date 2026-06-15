// Headless click-through of the lumid-market config surfaces.
// Forces Authorization: Bearer <PAT> on every request so both the identity
// calls (/api/v1/user) and the QA data calls (lumid.market/backend/*) auth
// without a session cookie. Reports console errors, failed API responses, and
// rendered directive-error widgets (⚠) per page.

import { chromium } from "playwright";
import fs from "fs";

const PAT = fs.readFileSync(process.env.PAT_FILE || "/pat", "utf8").trim();
const BASE = process.env.BASE || "https://lum.id";

const ROUTES = [
  ["home",                "/studio/a/lumid-market"],
  ["lobby",               "/studio/a/lumid-market/competition/lobby"],
  ["my-strategies",       "/studio/a/lumid-market/competition/my"],
  ["pathways",            "/studio/a/lumid-market/competition/pathways"],
  ["competition-detail",  "/studio/a/lumid-market/competition/28"],
  ["strategy-detail",     "/studio/a/lumid-market/competition/28/strategy/83"],
  ["research",            "/studio/a/lumid-market/strategy/research/83"],
];

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 1400 } });

// Force the PAT onto every request.
await context.route("**/*", async (route) => {
  const headers = { ...route.request().headers(), authorization: `Bearer ${PAT}` };
  await route.continue({ headers });
});

const page = await context.newPage();

for (const [name, path] of ROUTES) {
  const consoleErrors = [];
  const pageErrors = [];
  const badResponses = [];
  const onConsole = (m) => { if (m.type() === "error") consoleErrors.push(m.text()); };
  const onPageErr = (e) => pageErrors.push(String(e));
  const onResp = (r) => {
    const u = r.url();
    if ((u.includes("/api/") || u.includes("/backend/")) && r.status() >= 400 && !u.includes("session-bearer"))
      badResponses.push(`${r.status()} ${u.replace(BASE, "")}`);
  };
  page.on("console", onConsole);
  page.on("pageerror", onPageErr);
  page.on("response", onResp);

  await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 45000 }).catch((e) => pageErrors.push("goto: " + e.message));
  await page.waitForTimeout(1500); // let directives resolve

  // Directive error widgets render "⚠ <msg>"; collect them.
  const warns = await page.locator("text=/⚠/").allInnerTexts().catch(() => []);
  // Did the main content area render anything?
  const h1 = await page.locator("h1").first().innerText().catch(() => "(no h1)");
  const bodyLen = (await page.locator("body").innerText().catch(() => "")).length;
  const loginRedirect = page.url().includes("/auth/login");

  await page.screenshot({ path: `/out/${name}.png`, fullPage: true }).catch(() => {});

  console.log(`\n### ${name}  (${path})`);
  console.log(`   url-after: ${page.url().replace(BASE, "")}${loginRedirect ? "   <-- REDIRECTED TO LOGIN" : ""}`);
  console.log(`   h1: ${JSON.stringify(h1)}   bodyChars: ${bodyLen}`);
  console.log(`   directiveWarnings: ${warns.length ? JSON.stringify(warns) : "none"}`);
  console.log(`   badAPI: ${badResponses.length ? JSON.stringify([...new Set(badResponses)]) : "none"}`);
  console.log(`   pageErrors: ${pageErrors.length ? JSON.stringify(pageErrors.slice(0, 4)) : "none"}`);
  console.log(`   consoleErrors: ${consoleErrors.length ? JSON.stringify([...new Set(consoleErrors)].slice(0, 4)) : "none"}`);

  page.off("console", onConsole);
  page.off("pageerror", onPageErr);
  page.off("response", onResp);
}

await browser.close();
console.log("\nDONE");

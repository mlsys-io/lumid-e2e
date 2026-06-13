// Render the key Studio surfaces (authed via operator PAT) to PNGs for a
// visual review pass. No password needed — we force Authorization: Bearer on
// every request, which satisfies the UI's /api/v1/user guard.
import { chromium } from "playwright";
import fs from "fs";

const PAT = fs.readFileSync(process.env.PAT_FILE || "/pat", "utf8").trim();
const BASE = process.env.BASE || "https://lum.id";
const OUT = process.env.OUT || "/out";

const ROUTES = [
  ["chat-home",   "/studio"],
  ["apps",        "/studio/apps"],
  ["library",     "/studio/library"],
  ["jobs",        "/studio/runs"],
  ["settings",    "/studio/settings"],
  ["app-in-chat", "/studio/a/lumid-gpu-rentals"],
];

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await context.route("**/*", async (route) => {
  const headers = { ...route.request().headers(), authorization: `Bearer ${PAT}` };
  await route.continue({ headers });
});
const page = await context.newPage();

for (const [name, path] of ROUTES) {
  const errs = [];
  page.removeAllListeners("pageerror");
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 45000 }).catch((e) => errs.push("goto: " + e.message));
  await page.waitForTimeout(2500); // let directives/cards resolve
  const warns = await page.locator("text=/⚠/").allInnerTexts().catch(() => []);
  await page.screenshot({ path: `${OUT}/${name}.png` }).catch((e) => errs.push("shot: " + e.message));
  console.log(`${name.padEnd(14)} url=${page.url().replace(BASE, "")} warns=${warns.length} errs=${errs.length}${errs.length ? " :: " + errs.slice(0,2).join(" | ") : ""}`);
}
await browser.close();

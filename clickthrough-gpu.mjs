// Extensive interaction test of the lumid-gpu-rentals config surfaces.
import { chromium, devices } from "playwright";
import fs from "fs";

const PAT = fs.readFileSync(process.env.PAT_FILE || "/pat", "utf8").trim();
const BASE = process.env.BASE || "https://lum.id";
const G = "/studio/a/lumid-gpu-rentals";

let pass = 0, fail = 0;
const ok  = (n, d = "") => { pass++; console.log(`  PASS  ${n}${d ? "  — " + d : ""}`); };
const bad = (n, d = "") => { fail++; console.log(`  FAIL  ${n}${d ? "  — " + d : ""}`); };
const info = (n) => console.log(`  ··    ${n}`);
const head = (t) => console.log(`\n=== ${t} ===`);

const browser = await chromium.launch();
async function newCtx(opts = {}) {
  const ctx = await browser.newContext(opts);
  await ctx.route("**/*", async (r) => r.continue({ headers: { ...r.request().headers(), authorization: `Bearer ${PAT}` } }));
  return ctx;
}
const ctx = await newCtx({ viewport: { width: 1280, height: 1400 } });
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(String(e)));
const warns = async () => (await page.locator("text=/⚠/").allInnerTexts().catch(() => []));
const settle = (ms = 1500) => page.waitForTimeout(ms);

// 1 · home renders: pricing cards + your-rentals table
head("1 · home surface (pricing + your rentals)");
await page.goto(`${BASE}${G}`, { waitUntil: "networkidle" }); await settle();
let w = await warns();
(w.length ? bad : ok)("home renders without directive errors", w.join(" | "));
const priceCards = await page.locator("text=/Price \\/ hr/i").count();
(priceCards > 0 ? ok : bad)("GPU pricing cards present", `${priceCards} 'Price/hr' labels`);
await page.screenshot({ path: "/out/gpu-home.png", fullPage: true }).catch(() => {});

// 2 · home → new (Provision link)
head("2 · Provision link → new surface");
const provision = page.getByRole("link", { name: /Provision a GPU/i }).first();
if (await provision.count()) {
  await provision.click();
  await page.waitForURL(/\/lumid-gpu-rentals\/new$/, { timeout: 12000 }).then(
    () => ok("Provision → /new", page.url().replace(BASE, "")),
    () => bad("Provision navigation", page.url().replace(BASE, "")));
  await settle();
  w = await warns();
  (w.length ? bad : ok)("new surface renders create form", w.join(" | "));
  // form fields present + associated labels
  const nameF = page.getByLabel(/Rental name/i);
  const sshF = page.getByLabel(/SSH public key/i);
  ((await nameF.count()) && (await sshF.count()) ? ok : bad)("create-form fields have associated labels",
    `name=${await nameF.count()} ssh=${await sshF.count()}`);
  await page.screenshot({ path: "/out/gpu-new.png", fullPage: true }).catch(() => {});
} else bad("Provision link present on home");

// 3 · create-form validation: submit empty → HTML5 required blocks (stays on /new)
head("3 · create-form required-field validation");
await page.getByRole("button", { name: /Create rental/i }).first().click().catch(() => {});
await settle(1200);
(page.url().includes("/new") ? ok : bad)("empty submit blocked by required fields (no navigation)", page.url().replace(BASE, ""));

// 4 · your-rentals table → detail console (if any rentals exist)
head("4 · rental row → detail console (native embed)");
await page.goto(`${BASE}${G}`, { waitUntil: "networkidle" }); await settle();
const rentalLink = page.locator(`a[href*="${G}/"]:not([href$="/new"])`).first();
if (await rentalLink.count()) {
  const href = await rentalLink.getAttribute("href");
  await rentalLink.click();
  await page.waitForURL(new RegExp(`${G}/[^/]+$`), { timeout: 12000 }).catch(() => {});
  await settle(2000);
  const isDetail = !page.url().endsWith("/new") && new RegExp(`${G}/.+`).test(page.url());
  (isDetail ? ok : bad)("rental row → detail surface", page.url().replace(BASE, ""));
  // native console mounted: look for GPU-rentals detail chrome (Connect/SSH/Logs/Cancel) or a back link
  const chrome = await page.locator("text=/GPU rentals|Connect|SSH|Logs|Cancel|Rental/i").count();
  (chrome > 0 ? ok : bad)("native detail console mounted", `${chrome} console markers`);
  await page.screenshot({ path: "/out/gpu-detail.png", fullPage: true }).catch(() => {});
} else info("no existing rentals on this account — testing detail via direct task id");

// 5 · detail surface with a synthetic id degrades gracefully (no crash/blank)
head("5 · detail surface direct-load (synthetic id)");
await page.goto(`${BASE}${G}/task-does-not-exist-123`, { waitUntil: "networkidle" }); await settle(2500);
const body = await page.locator("body").innerText().catch(() => "");
(body.length > 50 ? ok : bad)("detail with bad id degrades gracefully", `${body.length} body chars`);
const detErrs = errs.filter((e) => !/session-bearer|401/.test(e));
(detErrs.length === 0 ? ok : bad)("no uncaught error on detail load", detErrs.slice(0, 3).join(" | "));

// 6 · legacy /dashboard/gpu-rentals → studio redirect
head("6 · legacy /dashboard/gpu-rentals redirect");
await page.goto(`${BASE}/dashboard/gpu-rentals`, { waitUntil: "networkidle" }); await settle(1200);
(page.url().includes("/studio/a/lumid-gpu-rentals") ? ok : bad)("dashboard → studio redirect", page.url().replace(BASE, ""));

// 7 · mobile
head("7 · mobile (iPhone 13) — home + new");
const mctx = await newCtx({ ...devices["iPhone 13"] });
const mp = await mctx.newPage();
const mErrs = []; mp.on("pageerror", (e) => mErrs.push(String(e)));
await mp.goto(`${BASE}${G}`, { waitUntil: "networkidle" }); await mp.waitForTimeout(1500);
await mp.screenshot({ path: "/out/gpu-mobile-home.png", fullPage: true }).catch(() => {});
const mw = await mp.locator("text=/⚠/").allInnerTexts().catch(() => []);
(mw.length ? bad : ok)("mobile home renders clean", mw.join(" | "));
await mctx.close();

head("page-level JS errors");
info(`uncaught (desktop): ${detErrs.length ? JSON.stringify(detErrs.slice(0, 5)) : "none"}`);
info(`uncaught (mobile): ${mErrs.length ? JSON.stringify(mErrs.slice(0, 5)) : "none"}`);

await browser.close();
console.log(`\n========  ${pass} PASS / ${fail} FAIL  ========`);

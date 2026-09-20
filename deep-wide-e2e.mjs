// Deep + wide browser pass over everything shipped 2026-09-20.
//
// Written because today produced two failures that EVERY non-browser check
// passed: the compute-workflow directive imported the wrong canvas and crashed
// a whole app page while its API half served correctly and tsc was clean; and
// X-Permission-Mode was dropped by the gateway one hop from where identity
// read it. A chain of strong single-hop checks is not an end-to-end check.
//
// Each check is a property a USER would notice, not an implementation detail.
// Exits non-zero if any fails, and says which.
//
//   node deep-wide-e2e.mjs
//   PAT_FILE=/path/to/pat OUTDIR=/tmp/dw node deep-wide-e2e.mjs
import { chromium } from "playwright";
import fs from "fs";

// TWO credentials, because the checks need different roles and mixing them
// produces false failures — it produced three on this harness's first run.
//
//   APP pages  -> the app OWNER (yao). resolveAppDir only finds an app the
//                 caller has; admin got "app not found" for vla-curation.
//   CHAT       -> super_admin. The router only routes a turn AWAY from the
//                 claude-code lane, and only super_admin defaults to that lane
//                 — a `user` role is already served a tool-capable provider,
//                 so auto_routed is correctly FALSE and plan mode never
//                 reaches a sandbox at all (requesting claude-code-sonnet as a
//                 user still yields deepseek-v4-flash). Asserting either as a
//                 user tests the credential, not the product.
const PAT = fs.readFileSync(process.env.PAT_FILE
  || `${process.env.HOME}/.lumid/lumilake-demo.pat`, "utf8").trim();
const ADMIN_PAT = fs.readFileSync(process.env.ADMIN_PAT_FILE
  || `${process.env.HOME}/.lumid/admin.pat`, "utf8").trim();
const OUT = process.env.OUTDIR || "/tmp/dw";
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail && !ok ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
await ctx.route("**/*", (r) =>
  r.continue({ headers: { ...r.request().headers(), authorization: `Bearer ${PAT}` } }));
await ctx.addInitScript(() => {
  try { localStorage.setItem("studio_view_mode", "simple"); } catch { /* private */ }
});

const adminCtx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
await adminCtx.route("**/*", (r) =>
  r.continue({ headers: { ...r.request().headers(), authorization: `Bearer ${ADMIN_PAT}` } }));
await adminCtx.addInitScript(() => {
  try { localStorage.setItem("studio_view_mode", "simple"); } catch { /* private */ }
});

// ─── 1. app pages render, and their DECLARED DAG draws ───────────────
//
// 5d: identity v0.5.396 serves me://app-data?tool=workflows, ui v0.5.435
// renders it. Before v0.5.435 this page crashed outright, so "no error
// boundary" is itself a regression check.
// `draws` = this app's SURFACE uses the lumid:compute-workflow directive, so
// the graph should appear on the page. Only vla-curation does today —
// mbb-consultant and quant-research declare a DAG and serve it over app-data,
// but their surfaces have not been pointed at it. Asserting a drawn graph for
// them would be asserting a feature nobody wired, and a red check for that is
// noise, not a finding.
const APPS = [
  { app: "vla-curation", draws: true,
    ops: ["Episode Frames", "Keyframe", "Caption", "Normalized Instruction"] },
  { app: "mbb-consultant", draws: false, ops: [] },
  { app: "quant-research", draws: false, ops: [] },
];

for (const { app, ops, draws } of APPS) {
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 120)));
  let served = null;
  page.on("response", async (r) => {
    if (r.url().includes("/data?tool=workflows")) {
      try { served = (await r.json())?.data ?? null; } catch { /* non-JSON */ }
    }
  });
  await page.goto(`https://lum.id/studio/apps/${app}`, { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(9000);
  const body = (await page.locator("body").innerText().catch(() => "")) || "";
  await page.screenshot({ path: `${OUT}/${app}.png`, fullPage: true }).catch(() => {});

  check(`${app}: page renders without the error boundary`,
    !body.includes("This page hit a snag"), body.slice(0, 80));
  // Only asserted where the surface actually uses the directive: a page that
  // does not mount it never makes the call, and a red check for that is noise.
  if (draws) {
    check(`${app}: app-data workflows served`,
      served !== null && (served.count ?? 0) >= 1, `count=${served?.count}`);
  }
  if (draws) {
    const found = ops.filter((o) => body.includes(o));
    check(`${app}: declared DAG draws its ops (${found.length}/${ops.length})`,
      found.length === ops.length, `missing ${ops.filter((o) => !found.includes(o))}`);
  }
  check(`${app}: no uncaught page errors`, errs.length === 0, errs[0] || "");
  await page.close();
}

// ─── 2. the chat router keeps its lanes ──────────────────────────────
//
// identity v0.5.395. A named-app install must leave the claude-code lane (it
// has no install_app); a coding turn must stay. Both directions, because a
// positive alone cannot tell "the fix works" from "everything routes".
async function routeOf(prompt) {
  const page = await adminCtx.newPage();
  let body = "";
  page.on("response", (r) => {
    if (r.url().includes("/agent/chat/stream")) {
      r.text().then((t) => { body = t; }, () => {});
    }
  });
  await page.goto("https://lum.id/studio", { waitUntil: "load", timeout: 60000 });
  const box = page.locator('textarea[aria-label="Message the assistant"]');
  await box.waitFor({ state: "visible", timeout: 30000 });
  await box.click();
  await box.fill(prompt);
  await page.keyboard.press("Enter");
  for (let i = 0; i < 45 && !body; i++) await page.waitForTimeout(1000);
  await page.close();
  return (body.match(/"auto_routed":(true|false)/) || [])[1] ?? null;
}

check("router: a named-app install leaves the code lane",
  (await routeOf("install the zzz-nonexistent-probe app")) === "true");
check("router: a framework 'app' turn keeps the code lane",
  (await routeOf("install the app router in next.js")) === "false");

// ─── 3. plan mode still arms and is echoed back ──────────────────────
//
// The X-Permission-Mode relay: the child sets it, the gateway must relay it,
// identity must read it. It was silently dropped once and told every plan-mode
// user their turn ran unrestricted.
{
  const page = await adminCtx.newPage();
  let sent = null, body = "";
  page.on("request", (r) => {
    if (r.url().includes("/agent/chat/stream") && r.method() === "POST") {
      try { sent = JSON.parse(r.postData() || "{}").permission_mode ?? null; } catch { /* keep */ }
    }
  });
  page.on("response", (r) => {
    if (r.url().includes("/agent/chat/stream")) r.text().then((t) => { body = t; }, () => {});
  });
  await page.addInitScript(() => {
    try { localStorage.setItem("studio_chat_model_v1", "claude-code-sonnet"); } catch { /* */ }
  });
  await page.goto("https://lum.id/studio", { waitUntil: "load", timeout: 60000 });
  const box = page.locator('textarea[aria-label="Message the assistant"]');
  await box.waitFor({ state: "visible", timeout: 30000 });
  let armed = false;
  try {
    await page.locator('button:has(svg.lucide-plus)').first().click({ timeout: 10000 });
    await page.getByText("Plan first", { exact: false }).first().click({ timeout: 8000 });
    await page.keyboard.press("Escape");
    armed = true;
  } catch { /* reported below */ }
  check("plan mode: the toggle is offered", armed);
  if (armed) {
    await box.click();
    await box.fill("Plan a one-line change to a python script. Briefly.");
    await page.keyboard.press("Enter");
    for (let i = 0; i < 90 && !body; i++) await page.waitForTimeout(1000);
    check('plan mode: the UI sends permission_mode "plan"', sent === "plan", `sent ${sent}`);
    check("plan mode: the sandbox echoes it back through the gateway",
      /"permission_mode"[\s\S]{0,80}"plan"/.test(body),
      body ? "no plan echo in the stream" : "no stream body");
  }
  await page.screenshot({ path: `${OUT}/plan-mode.png` }).catch(() => {});
  await page.close();
}

// ─── verdict ─────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? "FAIL" : "PASS"} — ${results.length - failed.length}/${results.length} checks`);
failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ""}`));
fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
await browser.close();
process.exit(failed.length ? 2 : 0);

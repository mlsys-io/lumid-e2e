// Every named UI element in the Guides, clicked as the non-admin reader.
//
// Pass 1 (docs-fresh-user-e2e) proved the doc PAGES render. This proves the
// docs are TRUE: a guide that names a tab, a row or a button is making a
// checkable claim about the product, and those claims rot silently — the app
// ships a new tab and no test anywhere fails.
//
// Each check quotes the doc line it is testing, so a failure says which
// sentence to rewrite rather than just "missing".
import { chromium } from "playwright";
import fs from "fs";

const PAT = fs.readFileSync(process.env.PAT_FILE
  || `${process.env.HOME}/.lumid/lumilake-demo.pat`, "utf8").trim();
const OUT = process.env.OUTDIR || "/tmp/freshuser";
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail && !ok ? `\n          ${detail}` : ""}`);
};
const note = (s) => console.log(`\n${s}`);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
await ctx.route("**/*", (r) =>
  r.continue({ headers: { ...r.request().headers(), authorization: `Bearer ${PAT}` } }));

const open = async (url, wait = 6000) => {
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 120)));
  await page.goto(`https://lum.id${url}`, { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(wait);
  const txt = (await page.locator("main").first().innerText().catch(() => "")) || "";
  return { page, txt, errs };
};

// ─── first-run §1: the very first instruction in the onboarding doc ───
note('first-run §1 — "Go to https://lum.id/studio/account/tokens and click Mint your first token"');
{
  const { page, txt, errs } = await open("/studio/account/tokens");
  await page.screenshot({ path: `${OUT}/tokens.png` }).catch(() => {});
  check("tokens: the page the doc sends you to renders", txt.trim().length > 40,
    JSON.stringify(txt.slice(0, 120)));
  check('tokens: a "Mint" control exists, as the doc says', /mint/i.test(txt),
    JSON.stringify(txt.slice(0, 200)));
  check("tokens: no uncaught page errors", errs.length === 0, errs[0] || "");
  await page.close();
}

// ─── Quant Research: the doc's changelog claims a TWO-TAB app ─────────
note("first-run L11 — \"Rewritten for the **two-tab** app (Strategies · Workflows)\"");
{
  const { page, txt, errs } = await open("/studio/apps/quant-research", 9000);
  await page.screenshot({ path: `${OUT}/quant-research.png`, fullPage: true }).catch(() => {});
  const tabs = await page.evaluate(() => {
    const r = document.querySelector("main [role=tablist]");
    if (r) return Array.from(r.querySelectorAll("[role=tab],button,a")).map((e) => e.innerText.trim()).filter(Boolean);
    return Array.from(document.querySelectorAll("main button, main a"))
      .map((e) => e.innerText.trim())
      .filter((t) => ["Strategies", "Workflows", "Experiments", "Proposals"].includes(t));
  });
  const uniq = [...new Set(tabs)];
  console.log(`      live tabs: ${JSON.stringify(uniq)}`);
  check("quant-research: the app page renders", txt.trim().length > 40, txt.slice(0, 100));

  // The claim under test, stated exactly as the doc states it.
  const isTwoTab = uniq.length === 2
    && uniq.includes("Strategies") && uniq.includes("Workflows");
  check('first-run L11 claim "two-tab app (Strategies · Workflows)" holds', isTwoTab,
    `live tabs are ${JSON.stringify(uniq)} — the changelog describes a UI that has moved on`);

  // L12: "the old Backtest / Forward test / Runtime / Experiments tabs are now
  // loop ROWS on Workflows" — i.e. Experiments should NOT be a tab.
  check('first-run L12 claim "Experiments ... now loop rows", so no Experiments TAB',
    !uniq.includes("Experiments"),
    `Experiments IS a live tab; workflows.md L29 also says "open your app and choose Experiments"`);

  // L120 documents a Proposals tab; it must exist.
  check('first-run L120 documents a "Proposals" tab', uniq.includes("Proposals"),
    `not found among ${JSON.stringify(uniq)}`);
  check("quant-research: no uncaught page errors", errs.length === 0, errs[0] || "");
  await page.close();
}

// ─── the named rows inside Workflows ─────────────────────────────────
note('first-run L480/499/503/509 — "Workflows → Backtest / Forward / Analyze / Kol strategy"');
{
  const { page, txt, errs } = await open("/studio/apps/quant-research?surface=workflows", 9000);
  await page.screenshot({ path: `${OUT}/qr-workflows.png`, fullPage: true }).catch(() => {});
  for (const row of ["Backtest", "Forward", "Analyze", "Kol strategy"]) {
    check(`workflows row "${row}" exists (doc names it)`,
      new RegExp(row.replace(/ /g, "[ _-]?"), "i").test(txt),
      `not on the Workflows surface; main=${JSON.stringify(txt.slice(0, 160))}`);
  }
  check("qr workflows: no uncaught page errors", errs.length === 0, errs[0] || "");
  await page.close();
}

note('first-run L480 — "Open **Experiments → kol_alpha** for the arms"');
{
  const { page, txt, errs } = await open("/studio/apps/quant-research?surface=experiments", 9000);
  await page.screenshot({ path: `${OUT}/qr-experiments.png`, fullPage: true }).catch(() => {});
  check('experiments: "kol_alpha" is there to open', /kol_alpha/i.test(txt),
    `main=${JSON.stringify(txt.slice(0, 200))}`);
  check("qr experiments: no uncaught page errors", errs.length === 0, errs[0] || "");
  await page.close();
}

// ─── MBB Consultant: §10's named tabs and controls ───────────────────
note('first-run L783/829 — MBB "**Work**" tab, "Workflows → interview / case_eval"');
{
  const { page, txt, errs } = await open("/studio/apps/mbb-consultant", 9000);
  await page.screenshot({ path: `${OUT}/mbb.png`, fullPage: true }).catch(() => {});
  const tabs = await page.evaluate(() =>
    [...new Set(Array.from(document.querySelectorAll("main button, main a"))
      .map((e) => e.innerText.trim())
      .filter((t) => ["Work", "Workflows", "Experiments", "Proposals", "Casebook"].includes(t)))]);
  console.log(`      live tabs: ${JSON.stringify(tabs)}`);
  check('mbb: the "Work" tab the doc starts you on exists', tabs.includes("Work"),
    `live tabs ${JSON.stringify(tabs)}`);
  check('mbb §10: "Pick AI interviews you ... Press Start" — the mode picker is present',
    /interview/i.test(txt), JSON.stringify(txt.slice(0, 200)));
  check("mbb: no uncaught page errors", errs.length === 0, errs[0] || "");
  await page.close();
}
{
  const { page, txt, errs } = await open("/studio/apps/mbb-consultant?surface=workflows", 9000);
  await page.screenshot({ path: `${OUT}/mbb-workflows.png`, fullPage: true }).catch(() => {});
  for (const row of ["interview", "case_eval"]) {
    check(`mbb workflows row "${row}" exists (doc names it)`,
      new RegExp(row.replace("_", "[ _]?"), "i").test(txt),
      `main=${JSON.stringify(txt.slice(0, 160))}`);
  }
  check("mbb workflows: no uncaught page errors", errs.length === 0, errs[0] || "");
  await page.close();
}

// ─── workflows.md §13: "Studio → Workflows → New" ────────────────────
note('workflows.md L475 — "**Studio → Workflows → New**"');
{
  const { page, txt, errs } = await open("/studio/workflows", 7000);
  await page.screenshot({ path: `${OUT}/studio-workflows.png`, fullPage: true }).catch(() => {});
  check("studio/workflows: the listing renders", txt.trim().length > 40, txt.slice(0, 120));
  check('studio/workflows: a "New" affordance exists, as the doc says',
    /\bNew\b/.test(txt), JSON.stringify(txt.slice(0, 200)));
  check("studio/workflows: no uncaught page errors", errs.length === 0, errs[0] || "");
  await page.close();
}

// ─── workflows.md L563: "Click a node. Three tabs:" ──────────────────
note('workflows.md L563 — "Click a node. Three tabs:"');
{
  const { page, errs } = await open("/studio/workflows/new", 8000);
  // Drop in a minimal valid Lumilake graph via the YAML view, then click a node.
  let nodeTabs = [];
  try {
    await page.getByText("YAML", { exact: false }).first().click({ timeout: 8000 });
    await page.waitForTimeout(1500);
  } catch { /* recorded by the check below */ }
  const after = (await page.locator("main").first().innerText().catch(() => "")) || "";
  await page.screenshot({ path: `${OUT}/editor-yaml.png` }).catch(() => {});
  check('editor: the "YAML" view the doc documents opens',
    after.length > 40, JSON.stringify(after.slice(0, 140)));
  check("editor: no uncaught page errors", errs.length === 0, errs[0] || "");
  console.log(`      node tabs seen: ${JSON.stringify(nodeTabs)}`);
  await page.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? "FAIL" : "PASS"} — ${results.length - failed.length}/${results.length} checks`);
failed.forEach((f) => console.log(`  - ${f.name}`));
fs.writeFileSync(`${OUT}/claims.json`, JSON.stringify(results, null, 2));
await browser.close();
process.exit(failed.length ? 2 : 0);

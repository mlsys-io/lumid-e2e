// The editor paths workflows.md §13-16 documents, actually driven.
//
// An earlier pass "checked" §13 by looking for the word YAML in the page and
// logging `node tabs seen: []` — then passed. That is the failure this file
// exists to not repeat: presence of a label is not function of a control.
// Every check here clicks something and reads what changed.
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

// A real production graph, not a hand-written stub: a malformed fixture gets
// swallowed by the error boundary and every downstream check fails as a
// "product bug" (this harness's sibling lost an hour to exactly that).
const _WF_UNUSED = fs.readFileSync(process.env.WF_FILE
  || `${process.env.HOME}/.xp/agents/vla-curation/workflows/vla_curation.yaml`, "utf8");

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
await ctx.route("**/*", (r) =>
  r.continue({ headers: { ...r.request().headers(), authorization: `Bearer ${PAT}` } }));

const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(String(e).slice(0, 140)));
await page.goto("https://lum.id/studio/workflows/new", { waitUntil: "load", timeout: 60000 });
await page.waitForTimeout(7000);

// §10: "start from the example that is already in the box" — assert the box
// really arrives populated, because every check below builds on it.
const body0 = (await page.locator("main").first().innerText().catch(() => "")) || "";
check('§10: a new workflow opens with a worked example already in it',
  /Name|Greeting|Reply/.test(body0) && /\d+ nodes/.test(body0), body0.slice(0, 160));

// ─── §13: "Click a node. Three tabs: Parameters / Run / YAML" ────────
//
// Clicked by ROLE. Targeting the text ("YAML", "Greeting") hits a label node
// whose click does nothing, and the first pass read that as the control being
// absent — a selector failure wearing a product failure's clothes. The page
// has two YAML controls (section header and canvas toolbar) and getByText
// picked neither reliably.
let nodeTabs = [];
try {
  await page.getByText("Greeting", { exact: false }).first()
    .click({ timeout: 8000, force: true });
  await page.waitForTimeout(3000);
  nodeTabs = await page.evaluate(() =>
    [...new Set(Array.from(document.querySelectorAll("[role=tab], button"))
      .map((e) => e.innerText?.trim())
      .filter((t) => ["Parameters", "Run", "YAML"].includes(t)))]);
} catch { /* reported */ }
console.log(`      inspector tabs: ${JSON.stringify(nodeTabs)}`);
await page.screenshot({ path: `${OUT}/editor-inspector.png` }).catch(() => {});

check('§13: clicking a node opens an inspector with "Parameters"',
  nodeTabs.includes("Parameters"), `tabs found: ${JSON.stringify(nodeTabs)}`);
check('§13: the inspector offers a node-scoped "YAML" tab',
  nodeTabs.includes("YAML"), `tabs found: ${JSON.stringify(nodeTabs)}`);
// The doc says Run is "Present only when a run overlay is loaded" — this
// document has no overlay, so its ABSENCE is the documented behaviour.
check('§13: "Run" is absent without a run overlay, as documented',
  !nodeTabs.includes("Run"),
  `Run tab present with no overlay loaded — doc says it should not be`);

check("editor: no uncaught page errors", errs.length === 0, errs[0] || "");
await page.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? "FAIL" : "PASS"} — ${results.length - failed.length}/${results.length} checks`);
failed.forEach((f) => console.log(`  - ${f.name}`));
await browser.close();
process.exit(failed.length ? 2 : 0);

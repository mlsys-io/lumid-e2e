// A fresh user walks the docs, and every UI element the docs name gets clicked.
//
// The question this answers is not "do the pages return 200" — the SPA returns
// 200 for every route, including ones that do not exist, and lumid-landing
// returns the HTML shell for a missing .md. curl cannot tell a doc from a
// typo here. So every assertion below reads RENDERED CONTENT.
//
// Two identities, because "fresh user" is two different people and they fail
// differently:
//
//   ANON   nobody, no account. first-run.md opens by assuming exactly this
//          reader ("your first token"), so if the docs are behind the login
//          wall the guide can only be read by people who no longer need it.
//
//   PLAIN  yao@lum.id — a real NON-admin (verified: 403 on every Admin+ .md).
//          This is the identity the Guides are written for. Running these as
//          the admin account is what made the last screenshot batch wrong:
//          an admin sees cards, tabs and docs a reader never will.
//
// What it cannot cover, stated rather than faked: a true first-login account
// has ZERO apps installed, and yao has three. Any step whose instruction is
// "install the app" is therefore exercised as "open the app". Creating a real
// account to close that gap is an outward, not-cleanly-reversible act, so it
// is left for a human to authorize.
import { chromium } from "playwright";
import fs from "fs";

const PAT = fs.readFileSync(process.env.PAT_FILE
  || `${process.env.HOME}/.lumid/lumilake-demo.pat`, "utf8").trim();
const OUT = process.env.OUTDIR || "/tmp/freshuser";
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail && !ok ? ` — ${detail}` : ""}`);
};
const note = (s) => console.log(`\n${s}`);

// The docs index as it ships (origin/dev src/pages/studio/docs.tsx).
// `md` matters: after the consolidation three slugs share workflows.md and
// four share lumilake-flowmesh.md, so a broken alias shows up as the SAME
// page failing under a different name rather than as a missing file.
const VISIBLE = [
  { slug: "first-run", md: "first-run.md" },
  { slug: "workflows", md: "workflows.md" },
  { slug: "coding", md: "coding.md" },
  { slug: "lqt-strategies", md: "lqt-strategies.md" },
  { slug: "lqt-signals", md: "lqt-signals.md" },
  { slug: "sandboxes", md: "sandboxes.md" },
  { slug: "findata-sql", md: "findata-sql.md" },
  { slug: "flowmesh-ssh", md: "flowmesh-ssh.md" },
];
// Retired slugs kept as aliases. These are the ones with links already in the
// wild — including inside our own markdown — so a dead alias is a dead link
// for everyone who bookmarked the pre-consolidation page.
const ALIASES = ["experiments", "workflow-editor", "mbb-consultant", "deepseek", "trading-api"];
// Admin+ docs. A plain user must be turned away, and must not be shown the card.
const ADMIN_ONLY = ["compute", "operations", "plugin-image-cd", "claude",
  "infrastructure-setup", "lumilake-flowmesh", "fm-ll-queries"];

const NOT_A_DOC = /Unknown doc/i;
const BOOM = /This page hit a snag|Something went wrong/i;

const mainText = async (page) =>
  (await page.locator("main").first().innerText().catch(() => "")) || "";

const browser = await chromium.launch();

// ─── 0. ANONYMOUS: can a person who has not signed up read the guide? ──
note("ANONYMOUS — nobody, no account");
{
  const anon = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  const page = await anon.newPage();

  await page.goto("https://lum.id/studio/docs", { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(4000);
  const idxUrl = page.url();
  const idx = await mainText(page);
  await page.screenshot({ path: `${OUT}/anon-docs-index.png` }).catch(() => {});
  // Not asserting which way this goes — recording it, because both are
  // defensible and only one matches what the doc says about itself.
  check("anon: /studio/docs does not error",
    !BOOM.test(idx), idx.slice(0, 120));
  console.log(`      anon landed on: ${idxUrl}`);
  console.log(`      main: ${JSON.stringify(idx.slice(0, 110))}`);

  await page.goto("https://lum.id/studio/docs/first-run", { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(4000);
  const fr = await mainText(page);
  const bounced = page.url().includes("/auth/login");

  // The login bounce is CORRECT, and this check asserts that rather than the
  // opposite — which is what it asserted when first written, off the index's
  // code comment calling this "the only doc that assumes you have never logged
  // in". The doc's own second line says "Assumes you are signed in." and its
  // first instruction is to mint a token, which needs an account. The comment
  // is what is wrong; believing it produced a confident false finding.
  check("anon: /studio/docs/first-run sends you to sign in, as the doc assumes",
    bounced, `landed on ${page.url()} len=${fr.length}`);

  // Recorded, not asserted: nginx serves the non-admin .md to anyone (200),
  // while every rendered route needs a session. Two layers, two different
  // answers about the same content. Harmless in this direction — public
  // content behind a private renderer — but it is the shape that bites when
  // the gate is later assumed to be in the other layer.
  const raw = await fetch("https://lum.id/docs/first-run.md")
    .then((r) => r.status).catch(() => "ERR");
  console.log(`      raw markdown to an anonymous fetch: HTTP ${raw}`
    + `  (rendered route: ${bounced ? "login" : "served"})`);
  await page.screenshot({ path: `${OUT}/anon-first-run.png` }).catch(() => {});
  await page.close();
  await anon.close();
}

// ─── the plain, non-admin user ────────────────────────────────────────
const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
await ctx.route("**/*", (r) =>
  r.continue({ headers: { ...r.request().headers(), authorization: `Bearer ${PAT}` } }));

note("PLAIN USER (non-admin) — the docs index");
{
  const page = await ctx.newPage();
  await page.goto("https://lum.id/studio/docs", { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(4500);
  const txt = await mainText(page);
  await page.screenshot({ path: `${OUT}/docs-index.png`, fullPage: true }).catch(() => {});

  check("index: renders", txt.includes("Documentation") && !BOOM.test(txt), txt.slice(0, 100));

  // An Admin+ card on a non-admin's index is a promise the click cannot keep.
  const leaked = ["Operations runbook", "Plugin-image CD", "Claude account pool",
    "Onboarding a GPU box", "Lumilake + FlowMesh"].filter((t) => txt.includes(t));
  check("index: no Admin+ cards shown to a non-admin", leaked.length === 0,
    `leaked: ${leaked.join(", ")}`);

  // The consolidation's whole point: fewer, bigger pages.
  const cards = await page.locator("main a[href^='/studio/docs/']").count();
  console.log(`      cards on the index: ${cards}`);
  check("index: the consolidated set is present",
    ["Quant Research Onboarding", "Workflows and experiments"].every((t) => txt.includes(t)),
    txt.slice(0, 200));
  await page.close();
}

note("PLAIN USER — every visible doc renders with content and images");
for (const { slug } of VISIBLE) {
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 120)));
  await page.goto(`https://lum.id/studio/docs/${slug}`, { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(3500);
  const txt = await mainText(page);
  check(`doc ${slug}: renders real content`,
    txt.length > 500 && !NOT_A_DOC.test(txt) && !BOOM.test(txt),
    `len=${txt.length} ${JSON.stringify(txt.slice(0, 90))}`);

  // An <img> that 404s still occupies the DOM; naturalWidth is the only way to
  // tell "rendered" from "broken icon".
  const imgs = await page.evaluate(() =>
    Array.from(document.querySelectorAll("main img")).map((i) => ({
      src: i.getAttribute("src") || "", ok: i.complete && i.naturalWidth > 0 })));
  const broken = imgs.filter((i) => !i.ok);
  if (imgs.length) {
    check(`doc ${slug}: all ${imgs.length} images render`, broken.length === 0,
      broken.map((b) => b.src).join(", "));
  }
  check(`doc ${slug}: no uncaught page errors`, errs.length === 0, errs[0] || "");
  await page.close();
}

note("PLAIN USER — retired slugs still resolve (links in the wild)");
for (const slug of ALIASES) {
  const page = await ctx.newPage();
  await page.goto(`https://lum.id/studio/docs/${slug}`, { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(3000);
  const txt = await mainText(page);
  check(`alias ${slug}: still resolves`,
    txt.length > 500 && !NOT_A_DOC.test(txt),
    NOT_A_DOC.test(txt) ? "Unknown doc — a link in the wild is now dead" : `len=${txt.length}`);
  await page.close();
}

note("PLAIN USER — Admin+ docs are refused, and say so");
for (const slug of ADMIN_ONLY) {
  const page = await ctx.newPage();
  await page.goto(`https://lum.id/studio/docs/${slug}`, { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(3000);
  const txt = await mainText(page);
  const url = page.url();
  // Refused = bounced away, or told. What must NOT happen is the body
  // rendering: that is the Admin+ content reaching a non-admin.
  const bounced = !url.includes(`/docs/${slug}`) || NOT_A_DOC.test(txt) || txt.length < 500;
  check(`admin-only ${slug}: a non-admin does not get the content`, bounced,
    `url=${url} len=${txt.length} ${JSON.stringify(txt.slice(0, 80))}`);
  await page.close();
}

note("PLAIN USER — every link the docs point at");
// Extracted from the LIVE markdown, so this tracks what readers can actually
// click rather than what the repo happens to contain.
const LINKS = [
  "/studio", "/studio/workflows/new", "/studio/account/findata-sql",
  "/studio/docs/coding", "/studio/docs/compute", "/studio/docs/findata-sql",
  "/studio/docs/lqt-signals", "/studio/docs/lqt-strategies", "/studio/docs/workflows",
  "/studio/library/marketplace",
];
for (const href of LINKS) {
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 100)));
  await page.goto(`https://lum.id${href}`, { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(3500);
  const txt = await mainText(page);
  const dead = NOT_A_DOC.test(txt) || BOOM.test(txt) || txt.trim().length < 40;
  check(`link ${href}: lands on something real`, !dead,
    `len=${txt.trim().length} ${JSON.stringify(txt.slice(0, 80))} err=${errs[0] || "-"}`);
  await page.close();
}

note("PLAIN USER — the UI elements the docs tell you to click");
{
  const page = await ctx.newPage();
  await page.goto("https://lum.id/studio", { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(5000);
  const nav = (await page.locator("nav, aside").first().innerText().catch(() => "")) || "";
  await page.screenshot({ path: `${OUT}/sidebar.png` }).catch(() => {});

  // Every sidebar destination the Guides name by label must BE a label in the
  // sidebar. A reader navigates by the words they were given, so a renamed nav
  // entry breaks the instruction even while the URL still resolves — which is
  // exactly what "Library → Marketplace" did: /studio/library/marketplace
  // loads fine, and there has been no "Library" in the sidebar to click.
  const NAMED_IN_DOCS = ["Marketplace"];
  for (const label of NAMED_IN_DOCS) {
    check(`sidebar: the docs send you to "${label}", and it is there`,
      new RegExp(label, "i").test(nav),
      `sidebar reads: ${JSON.stringify(nav.replace(/\n+/g, " | ").slice(0, 150))}`);
  }
  // Guard the regression directly, against the DEPLOYED markdown rather than a
  // local copy: the bug is a doc that is live and a sidebar that is live
  // disagreeing, so both sides of the comparison have to come off the server.
  const md = await fetch("https://lum.id/docs/first-run.md")
    .then((r) => r.text()).catch(() => "");
  check('no Guide routes readers through a nav entry that is gone ("Library")',
    md.length > 0 && (!/Library\s*→/.test(md) || /Library/i.test(nav)),
    md.length === 0 ? "could not fetch the live doc"
      : 'the live first-run.md says "Library → …" and the sidebar has no Library');
  await page.close();
}
{
  // workflows.md §13-16 documents this toolbar element by element.
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 120)));
  await page.goto("https://lum.id/studio/workflows/new", { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(6000);
  const txt = await mainText(page);
  await page.screenshot({ path: `${OUT}/workflow-editor.png` }).catch(() => {});
  for (const el of ["Add", "Undo", "Redo", "YAML"]) {
    check(`editor: the doc's "${el}" control exists`, txt.includes(el), txt.slice(0, 120));
  }
  check("editor: no uncaught page errors", errs.length === 0, errs[0] || "");
  await page.close();
}
{
  // first-run.md §"Mint a token" — the very first thing a new reader does.
  const page = await ctx.newPage();
  await page.goto("https://lum.id/studio/account/findata-sql", { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(4500);
  const txt = await mainText(page);
  await page.screenshot({ path: `${OUT}/findata-mint.png` }).catch(() => {});
  check("findata: the mint surface the doc links to actually offers a credential",
    /mint|credential|password|dsn/i.test(txt), txt.slice(0, 140));
  await page.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? "FAIL" : "PASS"} — ${results.length - failed.length}/${results.length} checks`);
failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ""}`));
fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
await browser.close();
process.exit(failed.length ? 2 : 0);

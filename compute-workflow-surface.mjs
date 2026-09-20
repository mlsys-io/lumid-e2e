// Does an app's DECLARED compute DAG actually render on its own page?
//
// Stage 5d shipped in two halves — identity v0.5.396 serves
// me://app-data?tool=workflows, lumid-auth-ui v0.5.434 adds the
// `lumid:compute-workflow` directive — and neither half proves the other. The
// API answering correctly says nothing about whether the canvas draws, and
// tsc passing says nothing about whether the data arrives. Only the page does.
//
// Before this, LumilakeWorkflowCanvas mounted solely from StudioWorkflowPanel
// on a chat tool-call event, so a published graph was viewable only if a human
// happened to ask chat to optimize it.
//
// Asserts the OP NAMES from the real graph appear. A canvas that rendered an
// empty frame, or the directive's own "declares no compute workflow" empty
// state, would pass a mere "did it mount" check — which is the failure mode
// this repo has shipped before.
import { chromium } from "playwright";
import fs from "fs";

const PAT = fs.readFileSync(process.env.PAT_FILE
  || `${process.env.HOME}/.lumid/lumilake-demo.pat`, "utf8").trim();
const APP = process.env.APP || "vla-curation";
const OUT = process.env.OUTDIR || "/tmp/cwf";
fs.mkdirSync(OUT, { recursive: true });

// The four ops in workflows/vla_curation.yaml. Node labels come from op ids.
const WANT = (process.env.WANT || "Episode Frames,Keyframe,Caption,Normalized Instruction")
  .split(",").map((s) => s.trim());

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
await ctx.route("**/*", (r) =>
  r.continue({ headers: { ...r.request().headers(), authorization: `Bearer ${PAT}` } }));
await ctx.addInitScript(() => {
  try { localStorage.setItem("studio_view_mode", "simple"); } catch { /* private */ }
});

const page = await ctx.newPage();
let served = null;
page.on("response", async (r) => {
  if (r.url().includes("/data?tool=workflows")) {
    try { served = await r.json(); } catch { /* non-JSON */ }
  }
});

const url = `https://lum.id/studio/apps/${APP}`;
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForTimeout(6000);

// The surface may be behind a nav tab; click one named like the pipeline.
for (const label of ["Pipeline", "pipeline"]) {
  const tab = page.getByRole("tab", { name: label }).or(page.getByRole("link", { name: label }));
  if (await tab.count()) { await tab.first().click().catch(() => {}); break; }
}
await page.waitForTimeout(6000);
await page.screenshot({ path: `${OUT}/app-page.png`, fullPage: true }).catch(() => {});

const body = (await page.locator("body").innerText().catch(() => "")) || "";
const found = WANT.filter((w) => body.includes(w));
const emptyState = body.includes("declares no compute workflow");
const loading = body.includes("Loading graph");

const ok = found.length === WANT.length && !emptyState;
console.log(`app:            ${APP}`);
console.log(`app-data served: ${served ? `count=${served?.data?.count ?? served?.count}` : "NOT OBSERVED"}`);
console.log(`op labels found: ${found.length}/${WANT.length}  ${JSON.stringify(found)}`);
if (emptyState) console.log(`  empty state rendered — the directive got no workflows`);
if (loading) console.log(`  still "Loading graph…" — data never arrived`);
console.log(ok ? "PASS — the declared DAG renders on the app page"
               : "FAIL — see /tmp/cwf/app-page.png");
await browser.close();
process.exit(ok ? 0 : 2);

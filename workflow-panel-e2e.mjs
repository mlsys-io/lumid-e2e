// Deep + wide browser pass over the compute-job work shipped 2026-09-20.
//
// Everything below was verified by curl during development and every one of
// those checks passed while the FEATURE was still broken at least once today:
// the phase strip rendered `batch_progress` as a sixth lifecycle phase, the
// panel imported the wrong canvas and crashed an app page, and `arm`/`workers`
// were silently dropped on write by a version that answered 200 to everything.
// An API that responds correctly says nothing about what a user sees.
//
// So this drives the real component in a real browser against real rows.
//
// TWO JOBS, chosen because they exercise opposite halves:
//
//   req-FQ89FpUz6jnoyYyyjoPxxX  office  a REAL completed Lumilake job, claimed
//                                       by this user. Status returns 200, so it
//                                       exercises polling, the status dot and
//                                       the job-phase strip. Claimed rather
//                                       than reported, so it is a run of ONE
//                                       and must show NO switcher.
//
//   req-SELFTESTaaaa01          office  a REPORTED two-arm run (baseline on
//   req-SELFTESTbbbb02          home    office, variant on home). The job ids
//                                       are synthetic, so upstream status 404s
//                                       — which is the point: it exercises the
//                                       switcher, the worker badges, the
//                                       split-sites note AND the error path,
//                                       where a failed status must SAY so
//                                       rather than spin.
//
// The panel mounts on a `studio:workflow-open` CustomEvent. Dispatching it
// directly is deliberate: it is the component's real public contract (chat
// fires exactly this), and going through a chat turn would make the test
// measure the router and a model's willingness to call a tool instead of the
// panel.
//
//   node workflow-panel-e2e.mjs
//   PAT_FILE=/path/to/pat OUTDIR=/tmp/wp node workflow-panel-e2e.mjs
import { chromium } from "playwright";
import fs from "fs";

const PAT = fs.readFileSync(process.env.PAT_FILE
  || `${process.env.HOME}/.lumid/lumilake-demo.pat`, "utf8").trim();
const OUT = process.env.OUTDIR || "/tmp/wp";
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail && !ok ? ` — ${detail}` : ""}`);
};

// A REAL production graph (vla-curation's), not a hand-written stub.
//
// The stub this harness started with was malformed, and the panel's error
// boundary swallowed it: the drawer rendered NOTHING, with no page error and
// no message, so eight checks failed and looked like product bugs. A fixture
// the product cannot parse tests the fixture.
//
// It is also the right shape for the job-phases assertion: five lifecycle
// phases sitting above FIVE graph nodes would be ambiguous, so the label
// "job phases:" is what has to distinguish them — and this graph's node names
// (Episode Frames, Keyframe, Caption...) share no text with any phase name.
const WF_PATH = process.env.WF_FILE
  || `${process.env.HOME}/.xp/agents/vla-curation/workflows/vla_curation.yaml`;
const WF = fs.readFileSync(WF_PATH, "utf8");

// Opening the panel is TWO steps, because that is the real contract.
// `studio:workflow-open` stores the workflow and deliberately does NOT pop the
// drawer — the compact inline chat card is the default surface, and the user
// opens the full graph from the composer's Workflow button, which fires
// `studio:workflow-panel-toggle`. Firing only the first leaves the panel
// mounted with its effects running and nothing rendered, which is what this
// harness did on its first run and misread as eight product failures.
//
// The toggle is CLICKED rather than dispatched, so the test exercises the path
// a person actually takes, and then WAITS for the drawer instead of sleeping:
// a fixed sleep turns a slow render into a product failure.
const openPanel = async (page, detail) => {
  await page.evaluate((d) => {
    window.dispatchEvent(new CustomEvent("studio:workflow-open", { detail: d }));
  }, detail);
  await page.getByRole("button", { name: "Workflow visualization" }).first().click();
  await page.locator('[aria-label="Close workflow panel"]')
    .waitFor({ state: "visible", timeout: 20000 });
};

// Read the DRAWER's text, not the document's. document.body.innerText picks up
// the whole shell — nav, chat history, every other panel — so an assertion
// against it can pass on text that is nowhere near the graph.
const panelText = async (page) => {
  // Scoped to the drawer ELEMENT, not to an ancestor index.
  //
  // This first read `ancestor::div[3]` from the close button, which worked
  // until the drawer was portalled to document.body to fix a stacking bug —
  // then the depth changed and every text assertion silently read the wrong
  // node, failing six checks that had just been passing. A locator that counts
  // levels is a locator that breaks when the tree is rearranged, which is
  // exactly what a fix for a stacking bug does.
  const el = page.locator('aside:has([aria-label="Close workflow panel"])');
  return (await el.innerText().catch(() => "")) || "";
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
await ctx.route("**/*", (r) =>
  r.continue({ headers: { ...r.request().headers(), authorization: `Bearer ${PAT}` } }));
await ctx.addInitScript(() => {
  try { localStorage.setItem("studio_view_mode", "simple"); } catch { /* private */ }
});

// ─── 1. a REAL job: polling, status, phases, and NO switcher ─────────
{
  const page = await ctx.newPage();
  const errs = [];
  const calls = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 140)));
  page.on("response", (r) => {
    const u = r.url();
    if (u.includes("/me/compute/jobs/")) calls.push(`${r.status()} ${u.split("/me")[1]}`);
  });

  await page.goto("https://lum.id/studio", { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(4000);
  await openPanel(page, {
    workflow_yaml: WF, job_id: "req-FQ89FpUz6jnoyYyyjoPxxX", site: "office",
    title: "Panel e2e · real job",
  });
  await page.waitForTimeout(7000);   // let at least one poll land
  const body = await panelText(page);
  await page.screenshot({ path: `${OUT}/real-job.png`, fullPage: false }).catch(() => {});

  check("real job: the panel opens and the DAG draws",
    ["Episode Frames", "Keyframe", "Caption"].every((o) => body.includes(o)),
    body.slice(0, 100));

  // The route is site-scoped; the panel must address the job it was given.
  check("real job: it polls the site-scoped status route",
    calls.some((c) => c.includes("/compute/jobs/office/req-FQ89")),
    `calls=${JSON.stringify(calls.slice(0, 3))}`);

  check("real job: the status route answers 200 (gate + token both working)",
    calls.some((c) => c.startsWith("200") && c.includes("req-FQ89")),
    `calls=${JSON.stringify(calls.slice(0, 3))}`);

  check("real job: the status reaches the UI", body.includes("completed"),
    "no status text on screen");

  // The five lifecycle phases, LABELLED as job phases. Four graph nodes sit
  // right above them; without the label the strip reads as per-op state, which
  // this API cannot provide (/jobs/<id>/workflows returns []).
  check("real job: job phases render, and are labelled as job phases",
    body.includes("job phases:") && body.includes("execution") && body.includes("outputs"),
    "phase strip missing or unlabelled");

  // The regression that shipped in v0.5.438 and was fixed in v0.5.439:
  // batch_progress has a `completed` key too, but it is a COUNT.
  check("real job: batch_progress is NOT rendered as a phase",
    !body.includes("batch_progress"),
    "a count is being drawn as a lifecycle state");

  // A claimed job is a run of one. A chooser with a single option is noise.
  check("real job: no arm switcher on a run of one",
    !body.includes("arm:"), "a switcher appeared for a single job");

  check("real job: no uncaught page errors", errs.length === 0, errs[0] || "");
  await page.close();
}

// ─── 2. a REPORTED fan-out: the switcher, workers, split sites ───────
{
  const page = await ctx.newPage();
  const errs = [];
  const calls = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 140)));
  page.on("response", (r) => {
    const u = r.url();
    if (u.includes("/me/compute/jobs/")) calls.push(`${r.status()} ${u.split("/me")[1]}`);
  });

  await page.goto("https://lum.id/studio", { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(4000);
  await openPanel(page, {
    workflow_yaml: WF, job_id: "req-SELFTESTaaaa01", site: "office",
    title: "Panel e2e · fan-out",
  });
  await page.waitForTimeout(7000);
  let body = await panelText(page);
  await page.screenshot({ path: `${OUT}/fanout.png`, fullPage: false }).catch(() => {});

  check("fan-out: the siblings route is called",
    calls.some((c) => c.includes("/siblings")),
    `calls=${JSON.stringify(calls.slice(0, 4))}`);

  // The point of the whole switcher: it must NAME what it draws. An unlabelled
  // overlay across parallel arms is worse than no overlay.
  check("fan-out: both arms appear, by NAME",
    body.includes("baseline") && body.includes("variant"),
    "arm labels missing — the switcher cannot say what it is drawing");

  // Worker placement: "it's slow" vs "three arms queued behind one card".
  check("fan-out: the arm's worker placement is shown",
    body.includes("w-1") || body.includes("2 workers"),
    "no placement on the chips");

  // Only when the arms really ARE split — office + home here.
  check("fan-out: a cross-site fan-out says so",
    body.includes("split across sites"),
    "office+home not flagged");

  // A synthetic job id 404s upstream. The panel must SAY so, not spin: the
  // first draft of this poll stopped dead on any error and left a live job
  // looking frozen.
  check("fan-out: an unreadable status is reported, not spun on",
    /compute service returned 404|not configured|404/i.test(body),
    "no error surfaced for a job whose status cannot be read");

  // Selecting the other arm must re-point the poll at ITS job+site. The two
  // arms are on different sites, so a switcher that kept the old site would
  // poll office for a job that ran on home.
  const before = calls.length;
  const clicked = await page.getByRole("button", { name: /variant/ }).first()
    .click({ timeout: 8000 }).then(() => true, () => false);
  await page.waitForTimeout(6000);
  body = await panelText(page);
  await page.screenshot({ path: `${OUT}/fanout-switched.png` }).catch(() => {});

  check("fan-out: the other arm is selectable", clicked);
  if (clicked) {
    check("fan-out: selecting an arm re-points the poll at ITS site+job",
      calls.slice(before).some((c) => c.includes("/home/req-SELFTESTbbbb02")),
      `after-click calls=${JSON.stringify(calls.slice(before, before + 3))}`);
  }

  check("fan-out: no uncaught page errors", errs.length === 0, errs[0] || "");
  await page.close();
}

// ─── 3. the gate, from the browser ───────────────────────────────────
//
// The security property, exercised the way a user's browser would hit it
// rather than by curl: a job this caller does not own must not be readable.
{
  const page = await ctx.newPage();
  await page.goto("https://lum.id/studio", { waitUntil: "load", timeout: 60000 });
  const probe = await page.evaluate(async () => {
    const r = await fetch(
      "/api/v1/me/compute/jobs/cloud/req-oWtEyYgUnGVBbWsZhuT6Dd", { credentials: "include" });
    return { status: r.status, body: (await r.text()).slice(0, 120) };
  });
  check("gate: an unowned job is refused in-browser",
    probe.status === 404 && /no such job for this user/.test(probe.body),
    `HTTP ${probe.status} ${probe.body}`);

  // 404 not 403: a 403 would confirm the job exists to someone with no
  // business knowing, making the route an oracle for job ids.
  check("gate: the refusal does not confirm the job exists",
    !/forbidden|403/i.test(probe.body), probe.body);
  await page.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? "FAIL" : "PASS"} — ${results.length - failed.length}/${results.length} checks`);
failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ""}`));
fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
await browser.close();
process.exit(failed.length ? 2 : 0);

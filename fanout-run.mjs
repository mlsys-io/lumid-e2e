// Drive one chatbox turn and report what ACTUALLY happened to it.
//
// Every fix here is a failure this harness produced earlier:
//
//  1. A wait just under the server's 900s ceiling killed my own turn — the
//     runner logged "client gone". HOLD_MS is checked against it and the log
//     says plainly whether the hold outlasts the ceiling or not (an earlier
//     version printed "> the 900s ceiling" while holding 600s).
//  2. console.log to a pipe is buffered and invisible until exit. Every step is
//     appended to a file with fs.appendFileSync.
//  3. `page.on("request")` fires on DISPATCH, not success — an "it posted"
//     assert passed while nothing reached the server.
//  4. THE ONE THIS VERSION FIXES: response *headers* status=200 is not
//     evidence the turn ran. identity returns 200 and THEN streams the body,
//     so a turn that fails in its first second is indistinguishable from one
//     doing ten minutes of work. A turn is only reported as successful when a
//     TERMINAL EVENT has been seen and named.
//
// The stream body cannot be read progressively — response.text() resolves only
// when the body closes — so the hold is RACED against it. Whichever wins
// determines the verdict, and "still streaming at cutoff" is reported as its
// own outcome rather than being dressed up as success.
//
// Usage: node fanout-run.mjs
//        PLAN=0 HOLD_MS=600000 MODEL=claude-code-sonnet node fanout-run.mjs
//        PROMPT_FILE=/path/to/prompt.txt node fanout-run.mjs
import { chromium } from "playwright";
import fs from "fs";

const LOG = process.env.LOG || "/tmp/fanout/fanout-run.log";
const OUTDIR = LOG.replace(/\/[^/]+$/, "");
fs.mkdirSync(OUTDIR, { recursive: true });   // screenshots + log land here
const step = (m) => fs.appendFileSync(LOG, `${new Date().toISOString()}  ${m}\n`);
fs.writeFileSync(LOG, "");

// Default to the operator PAT, not a scratch path: /tmp/planspike was this
// feature's build directory and is shredded after use, so a committed harness
// defaulting there fails on a missing file and reads like an auth problem.
const PAT = fs.readFileSync(process.env.PAT_FILE || `${process.env.HOME}/.lumid/admin.pat`, "utf8").trim();
const USE_PLAN = process.env.PLAN !== "0";
const HOLD_MS = Number(process.env.HOLD_MS || 1_020_000);
const MODEL = process.env.MODEL || "claude-code-sonnet";
const OUT = process.env.OUT || "/tmp/fanout/fanout-result.json";

// The server kills a turn at SESSION_TIMEOUT_SEC. Holding for less than that
// means a turn still running at cutoff was killed by US, not by the server —
// which is exactly how two earlier runs were misread as failures.
const SERVER_CEILING_MS = 900_000;

const DEFAULT_PROMPT = `For the app quant-research: I think the SYMBOL we pick, not the KOL signal, is what decides whether a backtest lands on real tape.

Use mcp__lumid__app_detail with slug "quant-research" to read its declared experiments and the metric names already in use.

Then dispatch FOUR Task subagents in parallel, one per seat:
- advocate: design the experiment that best CONFIRMS my intuition
- adversary: design the one most likely to FALSIFY it
- economist: the cheapest decisive test
- archivist: ignore my intuition entirely, follow what the ledger shows

Each returns ONE candidate: {seat, id, kind:"arms", hypothesis, metric:{name}, dataset_id, baseline:{arm}, arms, success_criteria, min_samples, compare_within, dispatch:{loop}, est_runs}.
Reuse a metric name that already exists. Guard n on BOTH sides (best_n and baseline_n).

Finally call mcp__lumid__stage_proposals with app="quant-research" and the four candidates.`;

const PROMPT = process.env.PROMPT_FILE
  ? fs.readFileSync(process.env.PROMPT_FILE, "utf8")
  : DEFAULT_PROMPT;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.route("**/*", (r) =>
  r.continue({ headers: { ...r.request().headers(), authorization: `Bearer ${PAT}` } }));

const page = await ctx.newPage();
page.on("pageerror", (e) => step(`PAGEERROR ${String(e).slice(0, 140)}`));

let streamStatus = null;
let sentMode = "(none)";
let bodyPromise = null;

page.on("request", (r) => {
  if (r.url().includes("/agent/chat/stream") && r.method() === "POST") {
    try { sentMode = JSON.parse(r.postData() || "{}").permission_mode ?? "(absent)"; } catch { /* keep */ }
    step(`request dispatched permission_mode=${sentMode}`);
  }
});
page.on("response", (r) => {
  if (r.url().includes("/agent/chat/stream")) {
    streamStatus = r.status();
    step(`response HEADERS status=${streamStatus} — not yet evidence the turn ran`);
    // Resolves when the body CLOSES. That is the only moment the full event
    // sequence is readable, so it is raced against the hold below.
    bodyPromise = r.text().then(
      (t) => ({ ok: true, body: t }),
      (e) => ({ ok: false, body: "", err: String(e).slice(0, 120) }),
    );
  }
});
page.on("requestfailed", (r) => {
  if (r.url().includes("/agent/chat/stream")) step(`REQUEST FAILED ${r.failure()?.errorText}`);
});

await ctx.addInitScript(([model]) => {
  try {
    localStorage.setItem("studio_view_mode", "simple");
    localStorage.setItem("studio_chat_model_v1", model);
  } catch { /* private mode */ }
}, [MODEL]);

step(`goto /studio model=${MODEL} plan=${USE_PLAN} hold=${Math.round(HOLD_MS / 1000)}s`);
await page.goto("https://lum.id/studio", { waitUntil: "load", timeout: 60000 });
const box = page.locator('textarea[aria-label="Message the assistant"]');
await box.waitFor({ state: "visible", timeout: 30000 });
step("composer visible");

let planArmed = false;
if (USE_PLAN) {
  try {
    await page.locator('button:has(svg.lucide-plus)').first().click({ timeout: 10000 });
    await page.getByText("Plan first", { exact: false }).first().click({ timeout: 8000 });
    await page.keyboard.press("Escape");
    planArmed = true;
  } catch (e) {
    step(`plan toggle FAILED: ${String(e.message).slice(0, 90)}`);
  }
  step(`plan armed=${planArmed}`);
}

await box.click();
await box.fill(PROMPT);
step(`composer filled (${PROMPT.length} chars)`);
await page.keyboard.press("Enter");

for (let i = 0; i < 60 && streamStatus === null; i++) await page.waitForTimeout(1000);
if (streamStatus === null) {
  await page.screenshot({ path: `${OUTDIR}/fanout-nosend.png` }).catch(() => {});
  step("NO STREAM RESPONSE — the turn never reached the server");
  fs.writeFileSync(OUT, JSON.stringify({ verdict: "not_dispatched" }, null, 2));
  await browser.close();
  process.exit(1);
}

step(HOLD_MS >= SERVER_CEILING_MS
  ? `holding ${Math.round(HOLD_MS / 1000)}s — OUTLASTS the ${SERVER_CEILING_MS / 1000}s server ceiling, so a cutoff is the server's doing`
  : `holding ${Math.round(HOLD_MS / 1000)}s — SHORTER than the ${SERVER_CEILING_MS / 1000}s server ceiling, so a cutoff here is OURS, not a turn failure`);

// Race the body against the hold, screenshotting as we go.
const started = Date.now();
let settled = null;
// Ticks every 5s so a settled turn is reported promptly; screenshots once a
// minute. An earlier version slept 60s per tick and was AWAITED, which delayed
// every verdict by up to a minute and made the log timestamps misleading.
let lastShot = 0;
const ticker = (async () => {
  while (Date.now() - started < HOLD_MS && settled === null) {
    await new Promise((r) => setTimeout(r, 5000));
    if (settled !== null) break;
    const mins = Math.floor((Date.now() - started) / 60000);
    if (mins > lastShot) {
      lastShot = mins;
      await page.screenshot({ path: `${OUTDIR}/fanout-t${mins}.png` }).catch(() => {});
      step(`t+${mins}m still streaming`);
    }
  }
})();
settled = await Promise.race([
  bodyPromise,
  new Promise((res) => setTimeout(() => res(null), HOLD_MS)),
]);
await ticker.catch(() => {});

// A terminal event is the ONLY thing that says how a turn ended. Order
// matters: an error anywhere outranks a later `done`, because identity emits
// `done` after an error too — treating `done` as success is how a failed turn
// reads as a successful one.
function terminalOf(body) {
  const lines = body.split("\n").filter((l) => l.startsWith("data:"));
  let err = null, stopped = false, stats = null, done = false;
  for (const l of lines) {
    let j; try { j = JSON.parse(l.replace(/^data:\s*/, "")); } catch { continue; }
    if (j.type === "error") err ??= String(j.message ?? "").slice(0, 300);
    if (j.type === "stopped") stopped = true;
    if (j.type === "turn_stats") stats = { num_turns: j.num_turns, cost_usd: j.cost_usd };
    if (j.type === "done") done = true;
  }
  if (err) return { verdict: "error", error: err, done };
  if (stopped) return { verdict: "stopped", done };
  if (stats) return { verdict: "completed", turn_stats: stats, done };
  if (done) return { verdict: "done_without_stats", done };
  return { verdict: "no_terminal_event", done };
}

let result;
if (settled === null) {
  // Say what this is: we stopped watching. NOT a failure, NOT a success.
  result = {
    verdict: "still_streaming_at_cutoff",
    note: HOLD_MS >= SERVER_CEILING_MS
      ? "Outlasted the server ceiling — the turn should have been terminated server-side; investigate."
      : "The hold was shorter than the server ceiling, so WE cut it off. Raise HOLD_MS before concluding anything.",
    held_s: Math.round(HOLD_MS / 1000),
  };
} else if (!settled.ok) {
  result = { verdict: "body_unreadable", error: settled.err };
} else {
  const body = settled.body;
  result = {
    ...terminalOf(body),
    bytes: body.length,
    elapsed_s: Math.round((Date.now() - started) / 1000),
    turn_id: (body.match(/"turn_id":"([^"]+)"/) || [])[1] ?? null,
    sandbox_cwd: (body.match(/"cwd":"([^"]+)"/) || [])[1] ?? null,
    mcp_tools: new Set(body.match(/mcp__lumid__[a-z_]+/g) || []).size,
    subagents_started: (body.match(/"subagent_start"/g) || []).length,
    subagents_done: (body.match(/"subagent_done"/g) || []).length,
    // Field order is "name":...,"type":"tool_start" — NAME COMES FIRST. An
    // earlier version searched for the name AFTER the type, matched nothing,
    // and reported "no tools called" on turns that called plenty. Anchor on
    // the name and keep the type out of the pattern.
    tools_called: [...new Set(body.match(/"name":"(?:mcp__[a-z0-9_]+__[a-z0-9_]+|[A-Z][A-Za-z]+)"/g) || [])]
      .map((m) => (m.match(/"name":"([^"]+)"/) || [])[1]).filter(Boolean),
  };
  fs.writeFileSync(OUT.replace(/\.json$/, ".sse"), body);
}

result.permission_mode_sent = sentMode;
result.stream_http_status = streamStatus;
step(`VERDICT ${result.verdict}${result.error ? " — " + result.error : ""}`);
fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
await page.screenshot({ path: `${OUTDIR}/fanout-final.png` }).catch(() => {});
await browser.close();
// Exit non-zero on anything that is not a clean completion, so a caller that
// only checks the exit code cannot mistake a failure for a pass.
process.exit(result.verdict === "completed" ? 0 : 2);

// End-to-end proof of Studio chatbox plan mode, in a real browser.
//
// Deliberately run in SIMPLE view mode (the product default), because that is
// where the plan panel would have been collapsed to a "Worked on it" pill —
// testing only in Advanced would pass while the thing the user actually sees
// stays broken.
//
// WHY A BROWSER. The X-Permission-Mode regression this guards was invisible to
// every single-hop check: the runner was tested against a local container
// (header present), the CLI locally (mode correct), the translator by offline
// replay (events handled). The gateway relays response headers by ALLOWLIST and
// dropped it one hop from where identity reads it, so identity told every
// plan-mode user "the sandbox ran this turn unrestricted — it may have changed
// files" while plan mode worked perfectly. A chain of strong single-hop checks
// is not an end-to-end check.
//
// TWO TURNS, because plan mode has two separable behaviours and the second was
// discovered only after the first was already "verified":
//
//   A. posture — the toggle exists, the UI sends permission_mode:"plan", the
//      SANDBOX ECHOES it back (assertion 3 is the one with teeth: it is the
//      posture the turn RAN under, not what we asked for), and the transcript
//      renders the plan rather than a quiet pill.
//
//   B. reach — plan mode denies EVERY mcp__* tool, reads included. Measured
//      2026-09-19: the same fan-out prompt with plan ON called 0 tools and
//      staged nothing, with plan OFF called 41 and staged 4. The denial string
//      is the CLI's own (`Cannot call ${e.name} while in plan mode`, in its
//      binary), so no server-side allowlist reaches it. This failure is SILENT
//      — the turn returns `completed` in ~35s having written a plan that
//      describes the work — which is how a shipped brief came to instruct
//      operators to run a tool-dependent fan-out in plan mode.
//
// Exits non-zero if any assertion fails. An earlier version only printed JSON
// and always exited 0, which made it a probe wearing a test's name.
//
// Usage: node plan-mode-e2e.mjs
//        MODEL=claude-code-qwen38 PAT_FILE=/path/to/pat node plan-mode-e2e.mjs
import { chromium } from "playwright";
import fs from "fs";

const B = "https://lum.id";
const MODEL = process.env.MODEL || "claude-code-sonnet";
const OUTDIR = process.env.OUTDIR || "/tmp/planmode";
fs.mkdirSync(OUTDIR, { recursive: true });

// Not a scratch path: the build directory this was written in gets shredded,
// and a missing PAT file reads like an auth failure rather than a setup one.
const PAT = fs.readFileSync(
  process.env.PAT_FILE || `${process.env.HOME}/.lumid/admin.pat`, "utf8").trim();

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 980 } });
await ctx.route("**/*", (r) =>
  r.continue({ headers: { ...r.request().headers(), authorization: `Bearer ${PAT}` } }));
await ctx.addInitScript(([model]) => {
  try {
    localStorage.setItem("studio_view_mode", "simple");
    localStorage.setItem("studio_chat_model_v1", model);
  } catch { /* private mode */ }
}, [MODEL]);

const failures = [];
const check = (name, cond, detail = "") => {
  if (!cond) failures.push(`${name}${detail ? " — " + detail : ""}`);
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${detail && !cond ? " — " + detail : ""}`);
  return cond;
};

// Arms plan mode, sends `prompt`, returns what the wire and the page show.
async function planTurn(tag, prompt) {
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 160)));

  let sentBody = null;
  page.on("request", (r) => {
    if (r.url().includes("/me/agent/chat/stream") && r.method() === "POST") {
      try { sentBody = JSON.parse(r.postData() || "{}"); } catch { sentBody = { _unparsed: true }; }
    }
  });
  let ssePromise = null;
  page.on("response", (r) => {
    if (r.url().includes("/me/agent/chat/stream")) {
      // Resolves when the body CLOSES, which is when the turn ends.
      ssePromise = r.text().then((t) => t, () => "");
    }
  });

  await page.goto(B + "/studio", { waitUntil: "load", timeout: 45000 });
  const box = page.locator('textarea[aria-label="Message the assistant"]');
  await box.waitFor({ state: "visible", timeout: 30000 });

  let toggleFound = false;
  try {
    await page.locator('button:has(svg.lucide-plus)').first().click({ timeout: 8000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUTDIR}/${tag}-popover.png` }).catch(() => {});
    toggleFound = (await page.getByText("Plan first", { exact: false }).count()) > 0;
    if (toggleFound) await page.getByText("Plan first", { exact: false }).first().click();
    await page.keyboard.press("Escape");
  } catch (e) { errs.push("popover:" + String(e.message).slice(0, 90)); }

  await box.click();
  await box.fill(prompt);
  await page.keyboard.press("Enter");

  // The response listener may not have fired yet, so wait for the promise to
  // EXIST, then race the body against a ceiling. Reading it any earlier gives
  // headers, and headers are not evidence the turn ran: identity returns 200
  // and streams afterwards.
  for (let i = 0; i < 90 && !ssePromise; i++) await page.waitForTimeout(1000);
  const body = ssePromise
    ? await Promise.race([ssePromise, new Promise((r) => setTimeout(() => r(""), 420000))])
    : "";

  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${OUTDIR}/${tag}-result.png` }).catch(() => {});
  const out = {
    toggleFound, sentBody, body, errs,
    planPanel: await page.getByText("read-only turn, nothing was changed", { exact: false }).count(),
    quietPill: await page.getByText("Worked on it", { exact: false }).count(),
  };
  fs.writeFileSync(`${OUTDIR}/${tag}-sse.txt`, body);
  await page.close();
  return out;
}

// ---- A. posture -----------------------------------------------------------
console.log(`A. posture (${MODEL})`);
const a = await planTurn("a-posture",
  process.env.PROMPT || "Add a --loud flag to a small python script. Plan it first, briefly.");
check("plan toggle is offered on a claude-code model", a.toggleFound);
check('UI sends permission_mode:"plan"', a.sentBody?.permission_mode === "plan",
  `sent ${JSON.stringify(a.sentBody?.permission_mode)}`);
check("stream is non-empty", a.body.length > 0, `${a.body.length} bytes`);
// The sandbox's OWN echo — the assertion the gateway header-drop defeated.
const permEvt = a.body.split("\n").filter((l) => l.startsWith("data:") && l.includes('"permission_mode"'));
check("sandbox echoes permission_mode back as plan",
  permEvt.some((l) => /"mode":"plan"/.test(l)),
  permEvt.length ? permEvt[0].slice(5, 160).trim() : "no permission_mode event at all");
check("plan is rendered, not collapsed to a quiet pill",
  a.planPanel > 0 || a.quietPill === 0, `panel=${a.planPanel} pill=${a.quietPill}`);
check("no page errors", a.errs.length === 0, a.errs.slice(0, 2).join(" | "));

// ---- B. reach -------------------------------------------------------------
console.log("\nB. reach — MCP tools in plan mode");
const b = await planTurn("b-mcp",
  'Call mcp__lumid__app_detail with slug "quant-research" and tell me its declared experiments.');
const denied = /while in plan mode|no approval surface/.test(b.body);
// The model ATTEMPTS the call — a tool_start is emitted and then refused — so
// "no tool_start" is the wrong assertion and passed for the wrong reason when
// a mis-ordered regex made it look true. What must hold is that no mcp__ tool
// SUCCEEDS. Note the field order: "name":...,"ok":... — name comes first.
const mcpSucceeded = /"name":"mcp__[^"]+","ok":true/.test(b.body);
const mcpAttempted = /"name":"mcp__[^"]+"/.test(b.body);
check("an mcp__ call in plan mode is DENIED by the CLI", denied,
  denied ? "" : "no denial in the stream — if plan mode now PERMITS MCP, that is a real capability change: re-measure, then fix the briefs that tell operators to avoid it");
check("the call was genuinely attempted (else the denial proves nothing)", mcpAttempted);
check("and no mcp__ tool succeeded", !mcpSucceeded);

console.log(`\n${failures.length === 0 ? "PASS" : "FAIL"} — ${failures.length} failed assertion(s)`);
failures.forEach((f) => console.log(`  - ${f}`));
await browser.close();
process.exit(failures.length === 0 ? 0 : 2);

// Doc screenshots, reproducibly: every image under lumid-ui public/docs/img that
// shows a live surface is taken here, against production, as the account the
// doc is written for (the non-admin reader for the Guides; the operator for an
// Admin+ page). Run: node docs-shots.mjs [name ...]   → $OUT/<name>.png
//
// Each shot waits for the text that proves the surface loaded, never a fixed
// sleep alone: an image of a spinner documents nothing. A shot whose proof
// text never appears is reported and NOT written, so a stale image stays
// visibly stale rather than being replaced by a broken one.
import { chromium } from "playwright";
import fs from "fs";

const home = process.env.HOME;
const READER = fs.readFileSync(process.env.PAT_FILE || `${home}/.lumid/lumilake-demo.pat`, "utf8").trim();
const OPERATOR = process.env.OPERATOR_PAT_FILE ? fs.readFileSync(process.env.OPERATOR_PAT_FILE, "utf8").trim() : "";
const OUT = process.env.OUTDIR || "/tmp/docs-shots";
fs.mkdirSync(OUT, { recursive: true });
const only = new Set(process.argv.slice(2));

const browser = await chromium.launch();
const ctxFor = async (pat) => {
  const c = await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2 });
  await c.route("**/*", (r) => r.continue({ headers: { ...r.request().headers(), authorization: `Bearer ${pat}` } }));
  await c.addInitScript(() => { try { localStorage.setItem("studio_view_mode", "simple"); } catch {} });
  return c;
};
const ctx = { reader: await ctxFor(READER), operator: OPERATOR ? await ctxFor(OPERATOR) : null };

const waitText = async (page, re, ms = 45000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const t = (await page.locator("main").first().innerText().catch(() => "")) || "";
    if (re.test(t) && !/Loading…|Loading\.\.\./.test(t.slice(0, 400))) return true;
    await page.waitForTimeout(1000);
  }
  return false;
};
const results = [];
async function shot(name, { as = "reader", url, proof, act, full = false, settle = 1500 }) {
  if (only.size && !only.has(name)) return;
  const c = ctx[as];
  if (!c) { results.push({ name, ok: false, why: `no ${as} credential` }); return; }
  const page = await c.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 140)));
  try {
    await page.goto(`https://lum.id${url}`, { waitUntil: "load", timeout: 90000 });
    let ok = await waitText(page, proof.before || proof);
    if (ok && act) ok = (await act(page)) !== false;
    if (ok && proof.after) ok = await waitText(page, proof.after);
    await page.waitForTimeout(settle);
    if (!ok) { results.push({ name, ok: false, why: "proof text never appeared", errs }); return; }
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });
    results.push({ name, ok: true, errs });
  } catch (e) {
    results.push({ name, ok: false, why: String(e).slice(0, 160), errs });
  } finally { await page.close(); }
}
const clickText = (text, opts = {}) => async (page) => {
  await page.getByText(text, { exact: true, ...opts }).first().click({ timeout: 15000 });
  await page.waitForTimeout(2500);
};

// ── first-run.md ──────────────────────────────────────────────────────
await shot("first-run-mint-token", { url: "/studio/account/tokens", proof: /New token/ });
await shot("first-run-strategies-2", { url: "/studio/apps/quant-research?surface=strategies", proof: /Your strategies/ });
// The registered rows, as a reader sees them by default. NOT with "N hidden"
// expanded: that shows the e2e suite's fixtures, not the reader's strategies.
await shot("first-run-strategies-view-2", { url: "/studio/apps/quant-research?surface=strategies",
  proof: { before: /Your strategies/, after: /Your strategies/ },
  act: async (p) => { await p.getByText("Your strategies", { exact: true }).first().scrollIntoViewIfNeeded(); await p.mouse.wheel(0, 380); await p.waitForTimeout(1000); } });
await shot("first-run-strategy-detail-2", { url: "/studio/apps/quant-research?surface=strategies",
  proof: { before: /Your strategies/, after: /Backtests|Sessions|Registration/i },
  act: async (p) => { await p.locator("main table tbody tr td").first().click({ timeout: 10000 }); await p.waitForTimeout(6000); } });
for (const [name, row, after] of [["first-run-backtest-result-2", "Backtest", /metric & arms|outputs/i],
                                  ["first-run-forward-result-2", "Forward test", /outputs|runs/i],
                                  ["first-run-runtime-2", "Analyze", /not an experiment|outputs/i]])
  await shot(name, { url: "/studio/apps/quant-research?surface=workflows",
    proof: { before: new RegExp(row), after }, act: clickText(row), settle: 4000 });
await shot("first-run-marketplace", { url: "/studio/library/marketplace", proof: /Quant Research/ });
const pickInterviewCase = async (p) => {
  await p.locator("main button", { hasText: /^AI interviews you/ }).first().click({ timeout: 8000 });
  await p.waitForTimeout(800);
  await p.locator("main button", { hasText: /·\s*(Easy|Medium|Hard)/ }).first().click({ timeout: 8000 });
  await p.waitForTimeout(1500);
  return p.locator("main button").filter({ hasText: /^Interview me$/ }).first();
};
const openTab = (tab, after) => async (p) => {
  await p.getByText(tab, { exact: true }).first().click({ timeout: 10000 });
  return await waitText(p, after);
};

// ── mbb-consultant.md (AI Consulting Onboarding) ─────────────────────
// Its own images since the guide was split out of first-run (2026-09-28).
await shot("mbb-marketplace", { url: "/studio/library/marketplace?q=mbb",
  proof: { before: /Marketplace/, after: /MBB Consultant/ }, settle: 4000,
  act: async (p) => { await p.getByText("MBB Consultant", { exact: true }).first().scrollIntoViewIfNeeded({ timeout: 30000 }); } });
await shot("mbb-modes", { url: "/studio/apps/mbb-consultant", proof: /AI interviews you/ });
await shot("mbb-interview-me", { url: "/studio/apps/mbb-consultant",
  proof: { before: /AI interviews you/, after: /Interview me/i },
  act: async (p) => {
    // The start control, not the chat's "interview me" chip: bring it into
    // frame, so the image shows mode + case + the button that begins it.
    const start = await pickInterviewCase(p);
    await start.scrollIntoViewIfNeeded({ timeout: 8000 });
    await p.mouse.wheel(0, 200);
    await p.waitForTimeout(800);
    return await start.isVisible();
  } });
await shot("mbb-review-queue", { url: "/studio/apps/mbb-consultant",
  proof: { before: /AI interviews you/, after: /Waiting on you/ },
  act: async (p) => {
    await p.getByText("Waiting on you", { exact: true }).first().scrollIntoViewIfNeeded({ timeout: 10000 });
    await p.mouse.wheel(0, -160);
    await p.waitForTimeout(800);
  } });
await shot("mbb-workflows", { url: "/studio/apps/mbb-consultant",
  proof: { before: /AI interviews you/, after: /Case eval/ }, act: openTab("Workflows", /Case eval/), settle: 3000 });
// An interview run opened: which case, what it scored, and the Mode (casebook
// vs open) the guide says to read first. Needs a run the reader owns.
await shot("mbb-interview-runs", { url: "/studio/apps/mbb-consultant",
  proof: { before: /AI interviews you/, after: /casebook|open|avg.question.score/i },
  act: async (p) => {
    if (!(await openTab("Workflows", /Case eval/)(p))) return false;
    await p.getByText("Interview", { exact: true }).first().click({ timeout: 10000 });
    await p.waitForTimeout(6000);
  }, settle: 3000 });
await shot("mbb-experiments", { url: "/studio/apps/mbb-consultant",
  proof: { before: /AI interviews you/, after: /judge panel parity/i }, act: openTab("Experiments", /judge panel parity/i), settle: 3000 });

// ── workflows.md ──────────────────────────────────────────────────────
await shot("experiments-surface", { url: "/studio/apps/quant-research?surface=experiments", proof: /kol.alpha|backtest.evidence/i });
await shot("experiments-kol", { url: "/studio/apps/quant-research?surface=experiments",
  proof: { before: /kol.alpha/i, after: /realized|musk/i }, act: clickText("kol alpha") });
await shot("experiments-workflows", { url: "/studio/apps/quant-research?surface=workflows",
  proof: { before: /KOL strategy/i, after: /metric & arms/i }, act: clickText("KOL strategy"), settle: 4000 });

// ── workflows.md §10–15: the canvas at /studio/workflows/new ─────────
// The documents are the ones the doc's prose describes (the filing workflow
// in §10; the fixtures in src/workflow/__dev__/mount.tsx for §14–16).
const FILING = `name: filing-summary
inputs:
  Ticker: [AAPL]
outputs:
  - name: summary
    ref: Summarise
ops:
  - id: Fetch
    op: HttpOp
    inputs: [Ticker]
    url: "https://api.example.com/filings/{ticker}"
    format_kwargs: {ticker: Ticker}
  - id: Extract
    op: FormatOp
    inputs: [Fetch]
    template: "Filing text: {doc}"
    format_kwargs: {doc: Fetch}
  - id: Summarise
    op: LLMChatOp
    inputs: [Extract]
    messages:
      - {role: system, content: "Summarise the filing in three bullets."}
      - {role: user, content: Extract}
    config: {model: Qwen/Qwen2.5-7B-Instruct, max_tokens: 256, temperature: 0.2}
`;
const XPIO = `name: lumid-research-digest
kind: autoresearch
loops:
  - name: daily_digest
    schedule: '20 4 * * *'
    knowledge_agent: research-digest-analyst
    steps:
      - id: observe_papers
        stage: observe
        skill: arxiv/fetch
        args: {query: 'cat:cs.LG', max_results: 15}
        required: true
      - id: analyze_papers
        stage: analyze
        skill: analyze_papers
        experiment: e1
        required: true
      - id: learn_ingest
        stage: learn
        skill: learn/ingest_memories
        required: false
`;
const FM_DAG = `apiVersion: flowmesh/v1
kind: InferenceTask
metadata:
  name: dag-two-branch-demo
spec:
  taskType: inference
  resources:
    hardware: {cpu: 4, memory: 16GiB}
  model:
    source: {type: huggingface, identifier: TinyLlama/TinyLlama-1.1B-Chat-v1.0}
  graph:
    nodes:
      - name: branch-a
        spec: {taskType: inference, data: {type: list, items: ['a']}}
      - name: branch-b
        spec: {taskType: inference, data: {type: list, items: ['b']}}
      - name: synthesis
        dependsOn: [branch-a, branch-b]
        spec: {taskType: inference, data: {type: graph_template}}
`;
// The canvas card: the element holding the Add/Undo/YAML toolbar and the graph.
const canvasCard = (p) => p.locator("div:has(> div button:text-is('Add')):has(.react-flow)").last();
const loadDoc = async (p, doc) => {
  await p.getByRole("button", { name: "YAML", exact: true }).last().click({ timeout: 10000 });
  await p.waitForTimeout(800);
  await p.locator("textarea").first().fill(doc);
  await p.waitForTimeout(800);
};
const toCanvas = async (p) => {
  await p.getByRole("button", { name: /^(YAML|Design|Canvas)$/ }).last().click({ timeout: 10000 });
  await p.waitForTimeout(2500);
};
async function canvasShot(name, doc, { select, yaml = false, proof }) {
  if (only.size && !only.has(name)) return;
  const page = await ctx.reader.newPage();
  try {
    await page.goto("https://lum.id/studio/workflows/new", { waitUntil: "load", timeout: 90000 });
    await waitText(page, /Workflow definition/);
    await loadDoc(page, doc);
    if (!yaml) await toCanvas(page);
    if (select) { await page.locator(".react-flow__node", { hasText: select }).first().click({ timeout: 10000 }); await page.waitForTimeout(1500); }
    const ok = await waitText(page, proof, 20000);
    if (!ok) { results.push({ name, ok: false, why: "proof text never appeared" }); return; }
    const card = yaml ? page.locator("textarea").first() : canvasCard(page);
    await card.screenshot({ path: `${OUT}/${name}.png` });
    results.push({ name, ok: true });
  } catch (e) { results.push({ name, ok: false, why: String(e).slice(0, 160) }); }
  finally { await page.close(); }
}
await canvasShot("workflow-editor", FILING, { select: "Extract", proof: /4 nodes/ });
await canvasShot("workflow-yaml", FILING, { yaml: true, proof: /Workflow definition/ });
await canvasShot("workflow-xpio", XPIO, { proof: /xpio loop/i });
await canvasShot("workflow-flowmesh", FM_DAG, { proof: /FlowMesh/ });

// ── lumilake-flowmesh.md (Admin+) ─────────────────────────────────────
// The demo app is installed on the reader account (not the operator's).
for (const [name, surface, proof] of [["lumilake-flowmesh-pipeline", "pipeline", /Fifteen raw robot episodes/],
                                      ["lumilake-flowmesh-episodes", "episodes", /Fifteen episodes/],
                                      ["lumilake-flowmesh-manifest", "manifest", /One record per episode/]])
  await shot(name, { url: `/studio/apps/vla-curation?surface=${surface}`, proof });

// ── chat turns ────────────────────────────────────────────────────────
// Each is the prompt the doc quotes, asked from where the doc says to stand.
// Proof is the tool the caption names appearing in the stream, then the
// stream going quiet. Writes are never approved: a shot whose turn pauses on
// the Allow/Always/Deny prompt is taken AT the prompt, and the page is closed
// unanswered.
async function chatShot(name, { as = "reader", url, say, tool, pre, fresh = true, settleQuiet = 8, awaitReply = false, maxWait = 240, doneWhen = null }) {
  if (only.size && !only.has(name)) return;
  const c = ctx[as];
  if (!c) { results.push({ name, ok: false, why: `no ${as} credential` }); return; }
  const page = await c.newPage();
  let stream = "";
  page.on("response", (r) => { if (r.url().includes("/agent/chat/stream")) r.text().then((t) => { stream += t; }, () => {}); });
  try {
    await page.goto(`https://lum.id${url}`, { waitUntil: "load", timeout: 90000 });
    await page.waitForTimeout(6000);
    // A fresh thread, so the image shows this prompt and not the last shot's.
    if (fresh && (say || awaitReply)) {
      const nc = page.getByRole("button", { name: "New conversation" }).last();
      if (await nc.count()) { await nc.click().catch(() => {}); await page.waitForTimeout(1500); }
    }
    if (pre && (await pre(page)) === false) { results.push({ name, ok: false, why: "pre-step failed" }); return; }
    const box = page.locator('textarea[aria-label="Message the assistant"]').last();
    await box.waitFor({ state: "visible", timeout: 30000 });
    if (say) { await box.click(); await box.fill(say); await page.keyboard.press("Enter"); }
    let last = -1, stable = 0, sawApproval = false;
    for (let i = 0; i < maxWait; i++) {
      await page.waitForTimeout(1000);
      sawApproval = (await page.getByRole("button", { name: /^Always$/ }).count().catch(() => 0)) > 0;
      if (sawApproval) break;
      // A pre-step that starts a turn itself (a button, not a typed prompt)
      // waits for its reply exactly like a typed one.
      if (!say && !awaitReply) { if (i > 4) break; continue; }
      // Finished = the rail no longer says Working… AND nothing has changed
      // for settleQuiet seconds. Quiet alone fires between two tool calls.
      const txt = await page.locator("body").innerText().catch(() => "");
      // doneWhen: a reply that goes quiet for minutes mid-turn (judges scoring)
      // is not finished until the text AFTER the prompt shows the result. The
      // rest of the page (a case panel, say) must not satisfy it.
      if (doneWhen && say) {
        const tail = txt.slice(Math.max(0, txt.lastIndexOf(say.slice(0, 40))));
        if (!doneWhen.test(tail.slice(say.length))) { stable = 0; last = -1; continue; }
      }
      const busy = /Working…|sends when current turn finishes/.test(txt);
      const n = stream.length + txt.length;
      if (!busy && n === last) { if (++stable >= settleQuiet) break; } else { stable = 0; last = n; }
    }
    // Land the rail on the newest message, so the image is the reply and not
    // a "Jump to latest" pill over the prompt.
    const jump = page.getByText(/Jump to latest/).first();
    if (await jump.count().catch(() => 0)) await jump.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const body = (await page.locator("body").innerText().catch(() => "")) || "";
    // The caption names a chip, so the chip must be ON SCREEN; the stream
    // mentions every tool in the catalogue and proves nothing.
    const ok = !tool || (tool instanceof RegExp ? tool.test(body) : body.includes(tool));
    fs.writeFileSync(`${OUT}/${name}.stream.txt`, stream.slice(-400000));
    if (!ok) { results.push({ name, ok: false, why: `tool ${tool} never appeared`, approval: sawApproval }); return; }
    await page.screenshot({ path: `${OUT}/${name}.png` });
    results.push({ name, ok: true, approval: sawApproval });
  } catch (e) { results.push({ name, ok: false, why: String(e).slice(0, 160) }); }
  finally { await page.close(); }
}
await chatShot("first-run-chat", { url: "/studio",
  say: "What were the top news headlines about Bitcoin in the last day? Use the news feed.", tool: "query_findata" });
await chatShot("first-run-chat-strategy", { url: "/studio/apps/quant-research?surface=strategies",
  say: "Submit a .lqts strategy for me: buy 25 lots at mid when the ofi_z signal is above 0.15, with the threshold and size as params. Name it ofi_z_momentum_docshot.", settleQuiet: 15 });
await chatShot("first-run-discuss-2", { url: "/studio/apps/quant-research?surface=strategies",
  pre: async (p) => {
    if (!(await waitText(p, /Your strategies/))) return false;
    await p.locator("main table tbody tr").first().getByRole("button", { name: /Discuss/ }).first().click({ timeout: 10000 })
      .catch(() => p.getByRole("button", { name: /^Discuss$/ }).first().click({ timeout: 10000 }));
    await p.waitForTimeout(4000);
  } });
await chatShot("first-run-chat-analytics", { url: "/studio/apps/quant-research?surface=strategies",
  say: "Look at the backtest results on the feed. How many are real on all three honesty axes, how many took zero trades, and what is the outcome breakdown? Then tell me which of them are mine.",
  tool: "lqt_mailbox_read", settleQuiet: 12 });
await chatShot("experiments-chat-results", { as: process.env.EXP_AS || "reader", url: "/studio/apps/mbb-consultant",
  say: "how did the analyst_local_gpu experiment turn out? give me the numbers per arm", tool: /list_experiments|experiment_status/, settleQuiet: 12 });
await chatShot("experiments-chat-controlplane", { url: "/studio/apps/quant-research?surface=experiments",
  say: "add an arm to kol_alpha called musk_v1_docshot that uses the musk_v1 strategy", tool: "add_experiment_arm", settleQuiet: 12 });

// Interview me opens the chat grounded in the case and the AI poses the first
// question. Starts a real (unscored) session on the reader's install.
await chatShot("mbb-chat-start", { url: "/studio/apps/mbb-consultant", awaitReply: true, settleQuiet: 12,
  pre: async (p) => {
    if (!(await waitText(p, /AI interviews you/))) return false;
    const start = await pickInterviewCase(p);
    await start.click({ timeout: 8000 });
    await p.waitForTimeout(3000);
  } });

// One SCORED turn: start the interview, wait for the opening, answer it. The
// image is the judges' verdict in the chat; it also gives the reader a scored
// interview run, which mbb-interview-runs needs (run that shot AFTER this one).
// A real, graded answer on the reader's install; the judges take minutes.
const waitIdle = async (p, quiet = 10, max = 300) => {
  let last = "", stable = 0;
  for (let i = 0; i < max; i++) {
    await p.waitForTimeout(1000);
    // Relative timestamps ("live · 42s ago", "1m") tick every second and
    // would keep the page from ever looking still.
    const raw = await p.locator("body").innerText().catch(() => "");
    const t = raw.replace(/\b\d+\s*(s|m|h|d|w)\b( ago)?|\bnow\b/g, "");
    if (!/Working…/.test(t) && t === last) { if (++stable >= quiet) return true; } else { stable = 0; last = t; }
  }
  return false;
};
await chatShot("mbb-chat-scored", { url: "/studio/apps/mbb-consultant", settleQuiet: 15, maxWait: 900,
  // The verdict in the reply ("5 of 13 keypoints"), not the app_judge chip
  // name, which appears mid-turn.
  doneWhen: /\d+\s+of\s+\d+\s+keypoints|keypoints covered/i,
  pre: async (p) => {
    if (!(await waitText(p, /AI interviews you/))) return false;
    const start = await pickInterviewCase(p);
    await start.click({ timeout: 8000 });
    await p.waitForTimeout(3000);
    return await waitIdle(p);
  },
  say: "I'd structure it in four parts. 1) Market attractiveness: size and growth of the e-truck segment by class (last-mile vans vs heavy-duty), adoption drivers such as fleet ESG targets, fuel and maintenance savings, subsidies and emissions rules, and charging infrastructure. 2) Customer needs: what 3PLs, carriers and private fleets like Amazon require on range, payload, total cost of ownership and uptime, and how their buying cycles work. 3) Competition: incumbents' EV programs (Daimler, Volvo, PACCAR), EV-native entrants like Tesla Semi and Rivian, and likely share and margins. 4) Our capabilities and economics: battery sourcing, powertrain know-how, plant retooling cost, dealer and service network, cannibalization of diesel sales, and the investment case (NPV and breakeven). The go / no-go rests on whether we can win a profitable share in the classes where TCO already beats diesel." });

// ── workflows.md §16: importing an n8n export ────────────────────────
const N8N_DOC = JSON.stringify({
  name: "research assistant",
  nodes: [
    { name: "When clicking Execute", type: "n8n-nodes-base.manualTrigger", parameters: {}, position: [0, 0] },
    { name: "Prompt", type: "n8n-nodes-base.set", parameters: { mode: "raw", value: "Summarise {{ $json.text }}" }, position: [220, 0] },
    { name: "OpenAI Chat Model", type: "@n8n/n8n-nodes-langchain.lmChatOpenAi", parameters: { model: "gpt-4o-mini" }, position: [220, 170],
      credentials: { openAiApi: { id: "1", name: "key" } } },
    { name: "Chain", type: "@n8n/n8n-nodes-langchain.chainLlm", parameters: { text: "Summarise this" }, position: [460, 0] },
    { name: "Slack", type: "n8n-nodes-base.slack", parameters: { channel: "#general" }, position: [700, 0] },
  ],
  connections: {
    "When clicking Execute": { main: [[{ node: "Prompt" }]] },
    Prompt: { main: [[{ node: "Chain" }]] },
    "OpenAI Chat Model": { ai_languageModel: [[{ node: "Chain" }]] },
    Chain: { main: [[{ node: "Slack" }]] },
  },
}, null, 2);
// A pasted export renders as a read-only preview at once — no toggle; the
// banner and its Import… button sit above the graph.
for (const name of ["workflow-import-preview", "workflow-import-dialog"]) {
  if (only.size && !only.has(name)) continue;
  const page = await ctx.reader.newPage();
  try {
    await page.goto("https://lum.id/studio/workflows/new", { waitUntil: "load", timeout: 90000 });
    await waitText(page, /Workflow definition/);
    await loadDoc(page, N8N_DOC);
    await page.waitForTimeout(2000);
    if (name === "workflow-import-preview") {
      await page.locator("div.overflow-hidden.rounded-md:has(.react-flow)").last().screenshot({ path: `${OUT}/${name}.png` });
      results.push({ name, ok: true });
      continue;
    }
    await page.getByRole("button", { name: /^Import…/ }).first().click({ timeout: 10000 });
    // No role="dialog" on this modal (a11y finding) — select its panel by shape.
    const dlg = page.locator("div.fixed.inset-0 > div.rounded-2xl:has(h2)").last();
    await dlg.waitFor({ state: "visible", timeout: 15000 });
    await page.waitForTimeout(2500);
    await dlg.screenshot({ path: `${OUT}/${name}.png` });
    results.push({ name, ok: true });
  } catch (e) { results.push({ name, ok: false, why: String(e).slice(0, 160) }); }
  finally { await page.close(); }
}

// ── workflows.md: the workflow panel drawing one arm of a two-arm run ─
if (!only.size || only.has("workflows-panel-arms")) {
  const name = "workflows-panel-arms";
  const WF = fs.readFileSync(process.env.VLA_WF || `${home}/.xp/agents/vla-curation/workflows/vla_curation.yaml`, "utf8");
  const page = await ctx.reader.newPage();
  try {
    await page.goto("https://lum.id/studio", { waitUntil: "load", timeout: 90000 });
    await page.waitForTimeout(6000);
    await page.evaluate((d) => window.dispatchEvent(new CustomEvent("studio:workflow-open", { detail: d })),
      // A real two-arm run the reader owns (_selftest-compute fanout: baseline on 2
      // workers, variant on w-5090-3). A made-up id draws "no such job for this user".
      { workflow_yaml: WF, job_id: process.env.ARMS_JOB || "req-5UgV3Qgdqb6shnethiQhCt", site: "office", title: "VLA curation · fan-out" });
    await page.waitForTimeout(1200);
    await page.getByRole("button", { name: "Workflow visualization" }).first().click();
    await page.locator('[aria-label="Close workflow panel"]').waitFor({ state: "visible", timeout: 20000 });
    // Proof: the job's status resolved into the phase strip. A site that is
    // down renders the chips over "compute service returned 502" — not the
    // figure the caption describes, so it is refused rather than written.
    const panel = page.locator('aside:has([aria-label="Close workflow panel"])').first();
    const t0 = Date.now(); let ok = false;
    while (!ok && Date.now() - t0 < 30000) { ok = /job phases/.test(await panel.innerText().catch(() => "")); if (!ok) await page.waitForTimeout(1500); }
    if (!ok) { results.push({ name, ok: false, why: "no job phases: " + (await panel.innerText().catch(() => "")).split("\n").slice(0, 6).join(" | ") }); }
    else { await panel.screenshot({ path: `${OUT}/${name}.png` }); results.push({ name, ok: true }); }
  } catch (e) { results.push({ name, ok: false, why: String(e).slice(0, 160) }); }
  finally { await page.close(); }
}

console.log(JSON.stringify(results, null, 1));
fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 1));
await browser.close();

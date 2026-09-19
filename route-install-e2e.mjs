// Regression: controlIntent must route "install the <name> app" to a provider
// that HAS install_app, without stealing coding turns from the claude-code lane.
//
// Guards lumid-identity v0.5.395 (PR #70). Before it, app installs were matched
// with the strings.Contains literals "install the app" / "install app", which
// were wrong in both directions at once:
//
//   too narrow — a real install names what to install, so the name sits between
//     the article and the noun and the substring is gone. "install the
//     quant-research app" stayed on claude-code, whose CLI toolset has no
//     install_app, and the user got "I don't have a tool for that".
//   too broad  — the same literal is inside "install the app dependencies" and
//     "install the app router in next.js", and bare "uninstall" took
//     "uninstall numpy". Coding turns were silently pulled off the coding lane.
//
// WHY A BROWSER. curl can read the route decision, but every hop between the
// composer and the model — UI dispatch, ingress, identity, the sandbox gateway
// — sits between them, and this stack has already shipped a user-visible false
// alarm that every single-hop check passed (X-Permission-Mode, dropped by the
// gateway's header allowlist). A chain of strong single-hop checks is not an
// end-to-end check.
//
// WHY THREE CASES, NOT ONE. A positive alone cannot tell "the fix works" from
// "everything routes" — which is precisely what the old literal did. And the
// first negative here is not sufficient on its own: the sandbox declines it for
// having no Next.js project, so it proves routing without proving the lane
// still functions. The third case asks something the sandbox can act on, and
// asserts it actually reaches for a tool.
//
// The positive names an app that DOES NOT EXIST, deliberately. Routing is
// proven the moment the turn reaches a provider holding install_app; naming a
// real app would perform an install on a production tenant as a side effect of
// a test.
//
// Usage: node route-install-e2e.mjs        (exit 0 = all cases as expected)
//        PAT_FILE=/path/to/pat node route-install-e2e.mjs
import { chromium } from "playwright";
import fs from "fs";

const LOG = process.env.LOG || "/tmp/route-e2e.log";
const OUT = process.env.OUT || "/tmp/route-e2e.json";
const step = (m) => fs.appendFileSync(LOG, `${new Date().toISOString()}  ${m}\n`);
fs.writeFileSync(LOG, "");

const PAT = fs.readFileSync(process.env.PAT_FILE || `${process.env.HOME}/.lumid/admin.pat`, "utf8").trim();
const MODEL = process.env.MODEL || "claude-code-sonnet";

const CASES = [
  {
    key: "platform",
    prompt: "install the zzz-nonexistent-probe app",
    wantRouted: true,
    // ANY platform tool, not install_app specifically. Whether the model goes
    // on to call install_app after list_marketplace returns nothing is its
    // judgement, and it legitimately differs run to run — observed both ways.
    // What routing actually guarantees is that the REGISTRY is reachable, and
    // list_marketplace proves that on its own: the claude-code lane has none of
    // these. Asserting the specific call would be a flake, not a check.
    wantTool: /"name":"(install_app|list_marketplace|list_apps)"/,
    why: "a named-app install must reach the lane that holds the app registry",
  },
  {
    key: "framework",
    prompt: "install the app router in next.js",
    wantRouted: false,
    why: '"app" in its framework sense is not an xpio app — keep the coding lane',
  },
  {
    key: "realcode",
    prompt: 'in the lumid_identity repo, where is the "install the app" button rendered?',
    wantRouted: false,
    // Contains the exact old literal, and must STILL stay on claude-code.
    wantTool: /"name":"(Bash|Grep|Glob|Read)"/,
    why: "a coding turn quoting the old literal must keep the lane AND do real work",
  },
];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.route("**/*", (r) =>
  r.continue({ headers: { ...r.request().headers(), authorization: `Bearer ${PAT}` } }));
await ctx.addInitScript(([m]) => {
  try {
    localStorage.setItem("studio_view_mode", "simple");
    localStorage.setItem("studio_chat_model_v1", m);
  } catch { /* private mode */ }
}, [MODEL]);

const results = [];

for (const c of CASES) {
  const page = await ctx.newPage();
  let bodyPromise = null;
  let httpStatus = null;
  page.on("response", (r) => {
    if (r.url().includes("/agent/chat/stream")) {
      httpStatus = r.status();
      // Resolves when the body CLOSES — the only moment the full event
      // sequence is readable. Response HEADERS status=200 is NOT evidence the
      // turn ran: identity returns 200 and streams afterwards.
      bodyPromise = r.text().then((t) => t, () => "");
    }
  });

  await page.goto("https://lum.id/studio", { waitUntil: "load", timeout: 60000 });
  const box = page.locator('textarea[aria-label="Message the assistant"]');
  await box.waitFor({ state: "visible", timeout: 30000 });
  await box.click();
  await box.fill(c.prompt);
  step(`[${c.key}] sending: ${c.prompt}`);
  await page.keyboard.press("Enter");

  for (let i = 0; i < 60 && httpStatus === null; i++) await page.waitForTimeout(1000);
  const body = bodyPromise
    ? await Promise.race([bodyPromise, new Promise((r) => setTimeout(() => r(""), 240000))])
    : "";

  const routed = (body.match(/"auto_routed":(true|false)/) || [])[1] ?? null;
  const used = (body.match(/"model_used":"([^"]+)"/) || [])[1] ?? null;
  let visible = "";
  try {
    visible = (await page.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 600);
  } catch { /* layout changed */ }

  await page.screenshot({ path: `/tmp/route-${c.key}.png` }).catch(() => {});
  const routeOK = routed === String(c.wantRouted);
  const toolOK = !c.wantTool || c.wantTool.test(body);
  results.push({
    ...c, wantTool: String(c.wantTool ?? ""), routed, used,
    routeOK, toolOK, ok: routeOK && toolOK, http: httpStatus, visible, bytes: body.length,
  });
  step(`[${c.key}] auto_routed=${routed} model=${used} routeOK=${routeOK} toolOK=${toolOK}`);
  await page.close();
}

fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.key.padEnd(10)} auto_routed=${String(r.routed).padEnd(5)} -> ${r.used}`);
  if (!r.routeOK) console.log(`      ROUTE want=${r.wantRouted} got=${r.routed} — ${r.why}`);
  if (!r.toolOK) console.log(`      TOOL  expected ${r.wantTool} in the stream; the lane was kept but did no work`);
  console.log(`      says: ${r.visible.slice(0, 180)}`);
}
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 2);

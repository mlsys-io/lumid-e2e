// workflows.md §5 "The chatbox as control plane" makes 12 checkable promises:
// a phrase, and the verb it must reach. This drives them in the real chatbox.
//
// Only the non-destructive half is exercised. conclude / archive / checkpoint /
// fork / remove_arm all mutate a live experiment, and the doc itself records
// why that matters ("a re-bind of a finished 52-row experiment erased both its
// arms" — 2026-09-13). Testing a destructive verb by firing it is how you find
// out it worked.
//
// The failure this is really watching for is the one the doc describes: "A
// request the router does not recognise falls through to the general
// assistant, which cannot see the experiment registry. You will know: it
// answers that it has no numbers rather than inventing any." A fallthrough
// that ANSWERS is the dangerous case, because it reads like success.
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

// phrase → the verb workflows.md §5 says it reaches
const CASES = [
  { say: "list the experiments on this app", verb: "list_experiments" },
  { say: "how did kol_alpha turn out", verb: "experiment_status" },
  { say: "run the musk_v1 arm on kol_alpha", verb: "dispatch_experiment_arm" },
];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
await ctx.route("**/*", (r) =>
  r.continue({ headers: { ...r.request().headers(), authorization: `Bearer ${PAT}` } }));

for (const { say, verb } of CASES) {
  const page = await ctx.newPage();
  let stream = "";
  page.on("response", (r) => {
    if (r.url().includes("/agent/chat/stream")) {
      r.text().then((t) => { stream += t; }, () => {});
    }
  });
  // From the APP page, so the turn has app context — the same place a reader
  // would be standing when they ask.
  await page.goto("https://lum.id/studio/apps/quant-research?surface=experiments",
    { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(9000);

  const box = page.locator('textarea[aria-label="Message the assistant"]').first();
  const have = await box.count();
  if (!have) {
    check(`"${say}" — a composer is present on the app page`, false, "no composer found");
    await page.close();
    continue;
  }
  await box.click();
  await box.fill(say);
  await page.keyboard.press("Enter");

  // Wait for the stream to go quiet rather than for a fixed time.
  let last = 0, stable = 0;
  for (let i = 0; i < 110; i++) {
    await page.waitForTimeout(1000);
    if (stream.length === last && stream.length > 0) { if (++stable >= 6) break; }
    else { stable = 0; last = stream.length; }
  }

  const calledTools = [...new Set(
    [...stream.matchAll(/"(?:name|tool|tool_name)"\s*:\s*"([a-z0-9_]+)"/g)].map((m) => m[1]))];
  const reachedVerb = stream.includes(verb);
  const answer = (await page.locator("main").first().innerText().catch(() => "")) || "";

  console.log(`\n  "${say}"`);
  console.log(`      tools seen: ${JSON.stringify(calledTools.slice(0, 8))}`);
  check(`"${say}" reaches ${verb}`, reachedVerb,
    `stream never mentions ${verb}; tools=${JSON.stringify(calledTools.slice(0, 8))}`);

  // The documented safe-failure: if it did NOT route, it must decline rather
  // than answer from nothing.
  if (!reachedVerb) {
    const declined = /no numbers|cannot see|don't have access|not able to|no experiment/i.test(answer);
    check(`"${say}" — an unrouted turn declines instead of inventing`, declined,
      "it answered without reaching the registry — the dangerous case");
  }
  await page.screenshot({ path: `${OUT}/chat-${verb}.png` }).catch(() => {});
  fs.writeFileSync(`${OUT}/stream-${verb}.txt`, stream.slice(0, 20000));
  await page.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? "FAIL" : "PASS"} — ${results.length - failed.length}/${results.length} checks`);
failed.forEach((f) => console.log(`  - ${f.name}`));
await browser.close();
process.exit(failed.length ? 2 : 0);

import { chromium } from "playwright";
import fs from "fs";
const PAT = fs.readFileSync(process.env.PAT_FILE || "/pat", "utf8").trim();
const BASE = process.env.BASE || "https://lum.id";
const OUT = process.env.OUT || "/out";
const ROUTES = [
  ["chat-home","/studio"], ["apps","/studio/apps"], ["library","/studio/library"],
  ["jobs","/studio/runs"], ["settings","/studio/settings"],
  ["app-overview","/studio/apps/mbb-ai?full=1"], ["knowledge","/studio/knowledge"],
  ["inbox","/studio/inbox"], ["surface-auto-quant","/studio/a/auto-quant?full=1"],
  ["lib-skills","/studio/library/skills"], ["lib-experiments","/studio/library/experiments"],
];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.route("**/*", (r)=>r.continue({ headers: { ...r.request().headers(), authorization: `Bearer ${PAT}` }}));
const page = await ctx.newPage();
for (const [name, path] of ROUTES) {
  const errs=[]; page.removeAllListeners("pageerror"); page.on("pageerror",e=>errs.push(String(e).slice(0,120)));
  await page.goto(BASE+path,{waitUntil:"domcontentloaded",timeout:30000}).catch(e=>errs.push("goto:"+e.message.slice(0,60)));
  await page.waitForTimeout(2800);
  const warns = await page.locator("text=/⚠/").allInnerTexts().catch(()=>[]);
  await page.screenshot({path:`${OUT}/${name}.png`}).catch(()=>{});
  console.log(`${name.padEnd(20)} url=${page.url().replace(BASE,"")} warns=${warns.length} errs=${errs.length}${errs.length?" :: "+errs[0]:""}`);
}
await browser.close();

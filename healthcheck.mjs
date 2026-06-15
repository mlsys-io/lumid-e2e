import { chromium } from "playwright";
import fs from "fs";
const PAT = fs.readFileSync("/work/.pat-tmp","utf8").trim();
const BASE="https://lum.id";
const browser = await chromium.launch();
for (const [label,path] of [["/studio/apps","/studio/apps"],["/studio/library","/studio/library"]]) {
  const ctx = await browser.newContext();  // fresh = no cache, fresh bucket
  await ctx.route("**/*",(r)=>r.continue({headers:{...r.request().headers(),authorization:`Bearer ${PAT}`}}));
  const page = await ctx.newPage();
  let me=0,r429=0;
  page.on("request",rq=>{ if(/\/api\/v1\/me\//.test(rq.url())) me++; });
  page.on("response",rs=>{ if(/\/api\/v1\/me\//.test(rs.url())&&rs.status()===429) r429++; });
  const t0=Date.now();
  await page.goto(BASE+path,{waitUntil:"load"}).catch(()=>{});
  await page.waitForTimeout(4000);
  // real content present (not just skeleton)?
  const cards = await page.locator("text=/Systems Optimizer|MBB Coach|Auto-Quant|Personal Agent|healthy|workflows|marketplace|Skills|Experiments/i").count().catch(()=>0);
  console.log(`${label.padEnd(18)} load=${Date.now()-t0}ms  meReqs=${me}  429s=${r429}  contentMatches=${cards}`);
  await ctx.close();
}
await browser.close();

import { chromium } from "playwright";
import fs from "fs";
const PAT = fs.readFileSync("/work/.pat-tmp","utf8").trim();
const BASE="https://lum.id";
const browser = await chromium.launch();
for (const [label,path] of [["/studio/apps","/studio/apps"],["/studio (chat)","/studio"]]) {
  const ctx = await browser.newContext();
  await ctx.route("**/*",(r)=>r.continue({headers:{...r.request().headers(),authorization:`Bearer ${PAT}`}}));
  const page = await ctx.newPage();
  const js=[]; const errs=[];
  page.on("response", r=>{ const u=r.url(); if(u.endsWith(".js")&&u.includes("/assets/")) js.push(u.split("/assets/")[1]); });
  page.on("pageerror", e=>errs.push(String(e).slice(0,140)));
  const t0=Date.now();
  await page.goto(BASE+path,{waitUntil:"load"}).catch(e=>errs.push("goto:"+e.message.slice(0,60)));
  await page.waitForTimeout(2500);
  // did the app actually render (not a white screen)?
  const hasContent = await page.locator("text=/Apps|Good (morning|afternoon|evening)|Ask anything/i").count().catch(()=>0);
  console.log(`\n## ${label}  load=${Date.now()-t0}ms  chunks=${js.length}  rendered=${hasContent>0?"YES":"NO"}  errors=${errs.length}`);
  console.log("   JS chunks: "+js.sort().join(", "));
  if(errs.length) console.log("   ERR: "+errs[0]);
  await ctx.close();
}
await browser.close();
